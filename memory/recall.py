#!/usr/bin/env python3
"""recall.py -- semantic search + hygiene lint over the Claude Code file-memory dir.

The always-loaded MEMORY.md index is deliberately thin (one-line hooks). This is the
on-demand second layer: ask a plain-language question and it finds the memory *files*
that mean the same thing, so "have I solved X before?" works across projects even when
the words differ from the hook. `--lint` audits the index for bloat and broken links.

Embeddings run on the CPU via a local bge-small-en-v1.5 ONNX model (the same asset
desktopPet ships) -- always available, no GPU, no Ollama, no MCP, no hooks, so it runs
untouched under the corporate managed policy. Vectors are cached and only changed files
re-embed on the next run.

Usage (from anywhere):
    python recall.py "how do I push git from the agent shell"
    python recall.py -k 10 "run admin tasks without a UAC prompt"
    python recall.py --lint            # audit index bloat + links (no model needed)
    python recall.py --rebuild         # force re-embed every file
    python recall.py --list            # show what's indexed
    python recall.py --selftest        # verify the embedder reproduces its reference cosines

Config via env:
    RECALL_MEMORY_DIR   corpus to index      (default ~/.claude/projects/d---claude/memory)
    RECALL_MODEL_DIR    bge-small.onnx dir   (default ./models, then desktopPet's copy)
"""
import os, sys, re, json, argparse, unicodedata

# --- runtime shim: onnxruntime + numpy live in the DevToolbox venv, not system python.
# Re-run under the venv python via subprocess (NOT os.execv -- Windows detaches the
# execv'd process from the parent's stdio, so its output would be lost). ---
def _ensure_runtime():
    try:
        import onnxruntime, numpy  # noqa: F401
        return
    except ImportError:
        pass
    if os.environ.get("RECALL_REEXEC") == "1":
        sys.exit("[recall] needs onnxruntime + numpy. In the DevToolbox venv:\n"
                 "  & \"$env:LOCALAPPDATA\\DevToolbox\\python\\.venv\\Scripts\\python.exe\" -m pip install onnxruntime numpy")
    base = os.environ.get("CODEX_TOOLBOX") or os.path.expandvars(r"%LOCALAPPDATA%\DevToolbox")
    py = os.path.join(base, "python", ".venv", "Scripts", "python.exe")
    if os.path.exists(py) and os.path.abspath(py) != os.path.abspath(sys.executable):
        import subprocess
        env = dict(os.environ, RECALL_REEXEC="1")
        sys.exit(subprocess.run([py, os.path.abspath(__file__)] + sys.argv[1:], env=env).returncode)
    sys.exit("[recall] needs onnxruntime + numpy and the DevToolbox venv was not found.")


_ensure_runtime()
import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MEMORY_DIR = os.environ.get("RECALL_MEMORY_DIR",
                            os.path.expanduser(r"~/.claude/projects/d---claude/memory"))
INDEX_PATH = os.path.join(MEMORY_DIR, "recall_index.json")
EMBED_CHAR_CAP = 8000          # per-file text handed to the tokenizer
EXCLUDE = {"MEMORY.md"}        # the index is just hooks; skip it as a search target
EMBED_ID = "bge-small-onnx"    # cache identity; bump to force a full re-embed
LINT_LINE_WARN = 300           # chars; a dense one-line hook ceiling -- over this is drifting to changelog
LINT_TOTAL_WARN = 12000        # bytes; whole always-loaded index getting heavy
UNK, CLS, SEP = "[UNK]", "[CLS]", "[SEP]"


def _model_dir():
    for d in (os.environ.get("RECALL_MODEL_DIR"),
              os.path.join(HERE, "models")):
        if d and os.path.exists(os.path.join(d, "bge-small.onnx")):
            return d
    sys.exit("[recall] bge-small.onnx not found. Put it in ./models or set RECALL_MODEL_DIR "
             "(copy from desktopPet/src/Models, or export BAAI/bge-small-en-v1.5 to ONNX).")


class Bge:
    """bge-small-en-v1.5 ONNX embedder: BERT-uncased WordPiece, CLS-pool, L2-norm (384-dim)."""

    def __init__(self):
        d = _model_dir()
        self.vocab = {}
        with open(os.path.join(d, "bge-small.vocab.txt"), encoding="utf-8") as f:
            for i, line in enumerate(f):
                self.vocab[line.rstrip("\n")] = i
        for t in (UNK, CLS, SEP):
            if t not in self.vocab:
                sys.exit("[recall] vocab is missing a required special token.")
        self.sess = ort.InferenceSession(os.path.join(d, "bge-small.onnx"),
                                         providers=["CPUExecutionProvider"])
        self.innames = [i.name for i in self.sess.get_inputs()]

    def _basic(self, text):
        out, buf = [], []
        for c in text.lower():
            if c.isspace():
                if buf:
                    out.append("".join(buf)); buf = []
            elif unicodedata.category(c)[0] in ("P", "S"):
                if buf:
                    out.append("".join(buf)); buf = []
                out.append(c)
            else:
                buf.append(c)
        if buf:
            out.append("".join(buf))
        return out

    def _wordpiece(self, word):
        if len(word) > 100:
            return [UNK]
        start, pieces = 0, []
        while start < len(word):
            end, cur = len(word), None
            while start < end:
                sub = ("##" if start > 0 else "") + word[start:end]
                if sub in self.vocab:
                    cur = sub; break
                end -= 1
            if cur is None:
                return [UNK]
            pieces.append(cur); start = end
        return pieces

    def _encode(self, text):
        ids = [self.vocab[CLS]]
        for w in self._basic(text):
            for p in self._wordpiece(w):
                ids.append(self.vocab.get(p, self.vocab[UNK]))
        ids.append(self.vocab[SEP])
        return ids[:255] + [self.vocab[SEP]] if len(ids) > 256 else ids

    def embed(self, text):
        ids = self._encode(text or " ")
        n = len(ids)
        arr = np.array(ids, dtype=np.int64).reshape(1, n)
        feeds = {}
        for name in self.innames:
            low = name.lower()
            feeds[name] = (np.ones((1, n), dtype=np.int64) if "mask" in low
                           else np.zeros((1, n), dtype=np.int64) if "type" in low
                           else arr)
        out = self.sess.run(None, feeds)[0]
        v = (out[0, 0, :] if out.ndim == 3 else out[0, :]).astype(np.float64)
        return (v / (np.linalg.norm(v) or 1.0)).tolist()


def parse_meta(text):
    """Return (description, body). description from YAML frontmatter if present."""
    desc, body = "", text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm, body = text[3:end], text[end + 4:]
            m = re.search(r'^\s*description:\s*(.+)$', fm, re.MULTILINE)
            if m:
                desc = m.group(1).strip().strip('"').strip("'")
    return desc, body.strip()


def load_index():
    if os.path.exists(INDEX_PATH):
        try:
            return json.load(open(INDEX_PATH, encoding="utf-8"))
        except Exception:
            pass
    return {"embed": EMBED_ID, "files": {}}


def build_or_update(force=False, quiet=False):
    idx = load_index()
    if force or idx.get("embed") != EMBED_ID:
        idx = {"embed": EMBED_ID, "files": {}}

    on_disk = {n: os.stat(os.path.join(MEMORY_DIR, n))
               for n in os.listdir(MEMORY_DIR) if n.endswith(".md") and n not in EXCLUDE}
    for gone in [n for n in idx["files"] if n not in on_disk]:
        del idx["files"][gone]

    todo = [n for n, st in on_disk.items()
            if n not in idx["files"]
            or idx["files"][n].get("mtime") != st.st_mtime
            or idx["files"][n].get("size") != st.st_size]

    if todo:
        if not quiet:
            print(f"[recall] embedding {len(todo)} file(s) on CPU (bge-small) ...", file=sys.stderr)
        emb = Bge()
        for n in todo:
            raw = open(os.path.join(MEMORY_DIR, n), encoding="utf-8", errors="replace").read()
            desc, body = parse_meta(raw)
            st = on_disk[n]
            idx["files"][n] = {"mtime": st.st_mtime, "size": st.st_size, "desc": desc,
                               "vec": emb.embed((desc + "\n" + body)[:EMBED_CHAR_CAP])}
        json.dump(idx, open(INDEX_PATH, "w", encoding="utf-8"))
    return idx


def best_line(query, name):
    terms = {w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2}
    if not terms:
        return ""
    best, score = "", 0
    for ln in open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace"):
        ln = ln.strip()
        if len(ln) < 25 or ln.startswith(("---", "name:", "metadata:", "#")):
            continue
        hits = sum(1 for t in terms if t in ln.lower())
        if hits > score:
            best, score = ln, hits
    return (best[:200] + "...") if len(best) > 200 else best


def search(query, k):
    idx = build_or_update()
    if not idx["files"]:
        sys.exit("[recall] nothing indexed.")
    q = Bge().embed(query)
    scored = sorted(((sum(a * b for a, b in zip(q, m["vec"])), name, m["desc"])
                     for name, m in idx["files"].items()), reverse=True)
    print(f'\n  recall: "{query}"   (bge-small CPU, {len(idx["files"])} memories)\n')
    for score, name, desc in scored[:k]:
        print(f"  {score:5.3f}  {name}")
        if desc:
            print(f"         {desc[:150]}")
        hit = best_line(query, name)
        if hit:
            print(f"         > {hit}")
        print()


def _norm(s):
    return s.strip().lower().replace("-", "_")


def _strip_code(text):
    """Blank out fenced + inline code spans so example [[links]] written inside
    backticks (e.g. `[[...]]`) aren't counted as real wiki-links."""
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"~~~.*?~~~", " ", text, flags=re.DOTALL)
    text = re.sub(r"``[^`]*``", " ", text)
    text = re.sub(r"`[^`]*`", " ", text)
    return text


def lint():
    """Audit the always-loaded index for bloat and broken links. No model needed."""
    mem = open(os.path.join(MEMORY_DIR, "MEMORY.md"), encoding="utf-8", errors="replace").read()
    total = len(mem.encode("utf-8"))
    print(f'\n  MEMORY.md: {total} bytes (~{total // 4} tokens loaded every session), '
          f'target < {LINT_TOTAL_WARN}')
    if total > LINT_TOTAL_WARN:
        print(f"  ! index is {total - LINT_TOTAL_WARN} bytes over budget")
    print()

    valid, stems, mem_norm = set(), [], _norm(mem)
    for name in os.listdir(MEMORY_DIR):
        if not name.endswith(".md"):
            continue
        stem = name[:-3]
        stems.append(stem)
        head = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()[:400]
        m = re.search(r'^\s*name:\s*(.+)$', head, re.MULTILINE)
        slug = m.group(1).strip().strip('"').strip("'") if m else stem
        valid.add(_norm(stem)); valid.add(_norm(slug))

    over = [(len(ln), i, ln) for i, ln in enumerate(mem.splitlines(), 1)
            if ln.startswith("- ") and len(ln) > LINT_LINE_WARN]
    if over:
        print(f"  {len(over)} index line(s) over {LINT_LINE_WARN} chars "
              f"-- move detail into the file/repo, leave a hook:")
        for length, i, ln in sorted(over, reverse=True):
            print(f"    {length:4d} ch  L{i}  {ln[2:72]}...")
        print()

    broken = sorted({t for t, _ in re.findall(r'\]\(([^)]+\.md)(#[^)]*)?\)', mem)
                     if not os.path.exists(os.path.join(MEMORY_DIR, t))})
    if broken:
        print("  index links to MISSING files:")
        for t in broken:
            print(f"    {t}")
        print()

    alltext = mem + "".join(open(os.path.join(MEMORY_DIR, s + ".md"), encoding="utf-8",
                                 errors="replace").read() for s in stems)
    unresolved = sorted({l for l in re.findall(r'\[\[([^\]]+)\]\]', _strip_code(alltext))
                         if _norm(l) not in valid})
    if unresolved:
        print("  unresolved [[links]] (typo, or a forward-link not written yet):")
        for l in unresolved:
            print(f"    [[{l}]]")
        print()

    if not (over or broken):
        print("  clean: every index line within budget, all index links resolve.\n")


def selftest():
    e = Bge()
    a, b, c = (np.array(e.embed(t)) for t in
               ("I love programming in C sharp",
                "Writing code in dot net is really fun",
                "The weather outside is freezing cold today"))
    hi, lo = float(a @ b), float(a @ c)
    print(f"  dim={len(a)}  cos(code,code)={hi:.4f} (HIGH)  cos(code,weather)={lo:.4f} (LOW)")
    print("  RESULT:", "PASS" if hi > lo else "FAIL")


def main():
    for stream in (sys.stdout, sys.stderr):        # Windows consoles default to cp1252
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Semantic search + hygiene lint over the Claude memory dir.")
    ap.add_argument("query", nargs="*", help="what you're trying to recall")
    ap.add_argument("-k", type=int, default=6, help="how many results (default 6)")
    ap.add_argument("--rebuild", action="store_true", help="force re-embed every file")
    ap.add_argument("--list", action="store_true", help="show what's indexed and exit")
    ap.add_argument("--lint", action="store_true", help="audit index bloat + links (no model)")
    ap.add_argument("--selftest", action="store_true", help="verify the embedder's reference cosines")
    args = ap.parse_args()

    if args.lint:
        lint(); return
    if args.selftest:
        selftest(); return
    if args.rebuild:
        build_or_update(force=True)
        print("[recall] rebuilt.", file=sys.stderr)
        if not args.query:
            return
    if args.list:
        idx = build_or_update()
        for name in sorted(idx["files"]):
            print(f"  {name}  --  {idx['files'][name]['desc'][:90]}")
        return
    if not args.query:
        ap.print_help(); return
    search(" ".join(args.query), args.k)


if __name__ == "__main__":
    main()
