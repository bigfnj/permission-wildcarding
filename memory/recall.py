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
    RECALL_MEMORY_DIR   corpus to index      (default: the ~/.claude/projects/*/memory
                                             holding the most memory files)
    RECALL_MODEL_DIR    bge-small.onnx dir   (default ./models, then desktopPet's copy)
"""
import os, sys, re, json, argparse, hashlib, unicodedata

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


# Claude Code derives the project slug from the working directory, so the corpus moves
# whenever the working root is renamed (D:\.claude -> D:\.ai-work did exactly that on
# 2026-08-20 and left the old default pointing at a deleted directory). Discover the
# store instead of hardcoding one slug: pick the ~/.claude/projects/*/memory holding the
# most memory files, and only fall back to a literal when nothing is found.
def _discover_memory_dir():
    root = os.path.expanduser(r"~/.claude/projects")
    best, best_count = None, 0
    try:
        for slug in os.listdir(root):
            candidate = os.path.join(root, slug, "memory")
            if not os.path.isdir(candidate):
                continue
            count = len([f for f in os.listdir(candidate) if f.endswith(".md")])
            if count > best_count:
                best, best_count = candidate, count
    except OSError:
        pass
    return best or os.path.join(root, "d---ai-work", "memory")


MEMORY_DIR = os.environ.get("RECALL_MEMORY_DIR") or _discover_memory_dir()
INDEX_PATH = os.path.join(MEMORY_DIR, "recall_index.json")
EMBED_CHAR_CAP = 8000          # per-file text handed to the tokenizer
EXCLUDE = {"MEMORY.md"}        # the index is just hooks; skip it as a search target
EMBED_ID = "bge-small-onnx"    # cache identity; bump to force a full re-embed
LINT_LINE_WARN = 300           # chars; a dense one-line hook ceiling -- over this is drifting to changelog
LINT_TOTAL_WARN = 12000        # bytes; whole always-loaded index getting heavy
LINT_ENTRY_WARN = 16           # resident entries. Attention dilutes per-entry, not per-byte: 3k
                               # tokens costs nothing, 50 entries competing for relevance does.
                               # Set from the real floor after the 2026-08-24 diet (52 -> 11:
                               # 7 recall triggers + 4 entries nothing else can trigger), with
                               # headroom for a few triggers. 0 would mean report-only.
GATE_BEGIN = "<!-- gate -->"   # a scope:global memory's resident lines, lifted verbatim into
GATE_END = "<!-- /gate -->"    # the managed CLAUDE.md block so the compiler needs no judgement
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


def _fm(text, key):
    """One frontmatter scalar. Shapes vary across the corpus -- some files nest under
    `metadata:`, older ones are flat -- so match the key at any indent instead of parsing
    YAML. `^\\s*type:` cannot collide with `node_type:`: only whitespace may precede it."""
    m = re.search(rf'^\s*{key}:\s*(.+)$', text[:400], re.MULTILINE)
    return m.group(1).strip().strip('"').strip("'") if m else ""


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
    index = os.path.join(MEMORY_DIR, "MEMORY.md")
    if not os.path.exists(index):
        print(f"\n  no MEMORY.md at {index} -- nothing to lint\n")
        return
    mem = open(index, encoding="utf-8", errors="replace").read()
    total = len(mem.encode("utf-8"))
    print(f'\n  MEMORY.md: {total} bytes (~{total // 4} tokens loaded every session), '
          f'target < {LINT_TOTAL_WARN}')
    if total > LINT_TOTAL_WARN:
        print(f"  ! index is {total - LINT_TOTAL_WARN} bytes over budget")
    print()

    valid, stems, meta, texts = set(), [], {}, {}
    for name in os.listdir(MEMORY_DIR):
        if not name.endswith(".md"):
            continue
        stem = name[:-3]
        stems.append(stem)
        text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()
        texts[stem] = text
        valid.add(_norm(stem)); valid.add(_norm(_fm(text, "name") or stem))
        # Frontmatter reads stay capped at the head, but a gate block can sit anywhere in
        # the body, so that one looks at the whole file.
        meta[stem] = (_fm(text, "type"), _fm(text, "scope"), GATE_BEGIN in text)

    entries = [ln for ln in mem.splitlines() if ln.startswith("- ")]
    print(f"  {len(entries)} resident index entries" +
          (f", target < {LINT_ENTRY_WARN}" if LINT_ENTRY_WARN else " (no ceiling set yet)"))
    if LINT_ENTRY_WARN and len(entries) > LINT_ENTRY_WARN:
        print(f"  ! {len(entries) - LINT_ENTRY_WARN} entries over the attention ceiling")
    print()

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

    # Standing orders have to be resident: a gate you must remember to go look up never
    # fires, because nothing triggers the lookup. These two checks are what the gate
    # compiler needs before it can run unattended -- `scope:` says which instruction file a
    # rule belongs in, the gate block says which of its lines to lift out.
    feedback = sorted(s for s in stems if meta[s][0] == "feedback")
    no_scope = [s for s in feedback if not meta[s][1]]
    if no_scope:
        print("  type: feedback with no `scope:` -- compiler cannot place these:")
        for s in no_scope:
            print(f"    {s}")
        print()

    no_gate = [s for s in stems if meta[s][1] == "global" and not meta[s][2]]
    if no_gate:
        print(f"  scope: global with no {GATE_BEGIN} block -- resident-eligible, not compiled:")
        for s in no_gate:
            print(f"    {s}")
        print()

    # Reference material wearing a standing order's clothes. These only matter once you are
    # already on the subject, so they belong behind a recall query. Reported and never
    # acted on: demoting a memory with no trigger pointing at it makes it invisible rather
    # than merely quiet, and invisible is the one failure you cannot see happening.
    demote = []
    for ln in entries:
        m = re.search(r'\]\(([^)#]+)\.md', ln)
        if m and meta.get(m.group(1), ("",))[0] in ("project", "reference"):
            demote.append((meta[m.group(1)][0], m.group(1), len(ln) + 1))
    if demote:
        print(f"  {len(demote)} demotion candidate(s), ~{sum(n for _, _, n in demote)} bytes "
              f"-- lookup-on-demand, not standing orders:")
        for t, stem, n in sorted(demote, key=lambda r: -r[2])[:8]:
            print(f"    {n:4d} ch  {t:9s} {stem}")
        if len(demote) > 8:
            print(f"    ... and {len(demote) - 8} more")
        print()

    # Staleness against SOURCE, not against the compiled artifact. Editing the text inside a
    # gate block without recompiling leaves the resident CLAUDE.md block out of date, and
    # `--gates status` cannot see it: status compares installed to gates.generated.md, so
    # when both are stale together it reports "current". The extension's watcher recompiles
    # on edit, but a CLI-only user, or one with the extension closed, has no other signal.
    # This is the one place the source is compared to what a recompile would produce.
    stale_gates = _gates_are_stale()
    if stale_gates:
        print("  gates.generated.md is STALE: a gate block changed since the last compile.")
        print("    run `recall.py --gates-compile` (or `wildcard-perms --gates refresh`) "
              "to update it.\n")

    unresolved = sorted({l for l in re.findall(r'\[\[([^\]]+)\]\]',
                                               _strip_code(mem + "".join(texts.values())))
                         if _norm(l) not in valid})
    if unresolved:
        print("  unresolved [[links]] (typo, or a forward-link not written yet):")
        for l in unresolved:
            print(f"    [[{l}]]")
        print()

    # `demote` is deliberately NOT a condition here, though it is still printed
    # above. Every other finding is actionable -- over budget, a link to a missing
    # file, a feedback with no scope, a scope:global with no gate block, a gate
    # edited without a recompile -- and each names a fix. A demotion candidate
    # names none: the comment where it is collected says it is "Reported and never
    # acted on", because demoting a memory nothing points at makes it invisible
    # rather than quiet. Including it made `clean:` unreachable for any corpus
    # holding a single project or reference memory, which is every real one, and
    # it contradicted this very message -- which claims budget, links and standing
    # orders, and says nothing about residency advice.
    if not (over or broken or no_scope or no_gate or stale_gates):
        print("  clean: index within budget, links resolve, every standing order compiled.\n")


GATES_OUT = os.path.expanduser(r"~/.claude/gates.generated.md")


def _compile_gates_text():
    """The compiled gates file as bytes, WITHOUT writing it. Pure over the corpus, so both
    the compiler and the lint drift-check produce identical output from the same memories --
    which is the whole point: lint can ask "would a recompile change the file?" without a
    second, divergent implementation. Returns (text, [names]); text is "" for no gates.

    Selected on scope, not type. Residency is a question of reach, and a `reference` can be
    every bit as resident-worthy as a `feedback` when its failure is silent -- a heredoc
    eating backslashes raises nothing, so no trigger ever fires. The gate block is the opt-in.
    Sorted by filename and hashed so a re-run is byte-identical."""
    blocks = []
    for name in sorted(os.listdir(MEMORY_DIR)):
        if not name.endswith(".md") or name in EXCLUDE:
            continue
        text = open(os.path.join(MEMORY_DIR, name), encoding="utf-8", errors="replace").read()
        if _fm(text, "scope") != "global":
            continue
        m = re.search(re.escape(GATE_BEGIN) + r"(.*?)" + re.escape(GATE_END), text, re.DOTALL)
        if m:
            blocks.append((name, m.group(1).strip()))

    body = "\n".join(b for _, b in blocks)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]
    # No gates means "" (write NOTHING), not a header over an empty body. The installer's
    # "refuse to install an empty block" guard tests file content, and a file that always
    # carried a header would sail past it and fence off a heading with no rules under it.
    out = ("" if not blocks else
           f"<!-- generated by recall.py --gates-compile; sha {digest} -->\n"
           f"## Standing gates ({len(blocks)} memories, managed)\n\n{body}\n")
    return out, [name for name, _ in blocks]


def _gates_are_stale():
    """True when a recompile would change gates.generated.md -- i.e. someone edited a gate
    block in a memory but never ran --gates-compile. This is the failure the whole feature
    exists to prevent, one level up: a standing order silently out of date. Only meaningful
    once gates have been compiled at least once, so a never-compiled corpus is not 'stale'."""
    if not os.path.isdir(MEMORY_DIR) or not os.path.exists(GATES_OUT):
        return False
    fresh, _ = _compile_gates_text()
    on_disk = open(GATES_OUT, encoding="utf-8", errors="replace").read()
    return fresh != on_disk


def compile_gates():
    """Lift every scope:global gate block into one block for the installer to drop into
    CLAUDE.md, and write it. The judgement happened when the memory was written, which is
    what lets this run unattended."""
    # A missing memory dir is a normal state (a fresh machine, a mocked HOME), not a crash.
    # This can run from a hook, where an unhandled traceback would land in the agent's face.
    if not os.path.isdir(MEMORY_DIR):
        print(f"\n  no memory dir at {MEMORY_DIR} -- nothing to compile\n")
        return

    out, names = _compile_gates_text()
    # newline="\n" on purpose: a CRLF translation on Windows would change the bytes and
    # make the hash useless as a "has anything actually changed" signal.
    os.makedirs(os.path.dirname(GATES_OUT), exist_ok=True)
    with open(GATES_OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)

    if not names:
        print(f"\n  no scope:global gate blocks found -- wrote 0 bytes to {GATES_OUT}")
        print("  (the installer will refuse rather than fence off an empty block)\n")
        return

    print(f"\n  compiled {len(names)} gate(s), {len(out)} bytes\n  -> {GATES_OUT}\n")
    for name in names:
        print(f"    {name}")
    print()


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
    ap.add_argument("--gates-compile", action="store_true",
                    help="lift scope:global gate blocks into ~/.claude/gates.generated.md")
    ap.add_argument("--selftest", action="store_true", help="verify the embedder's reference cosines")
    args = ap.parse_args()

    if args.lint:
        lint(); return
    if args.gates_compile:
        compile_gates(); return
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
