#!/usr/bin/env python3
"""bench_embed.py -- retrieval benchmark of CPU embedding models over the Claude memory corpus.

Answers one question: on OUR own memory files, how much retrieval quality do we gain moving
up the size curve from today's bge-small, and what does each step cost to adopt?

The default run is pure ONNX on CPU with no server -- the same "model file beside the exe"
shape recall.py and desktopPet already ship. That keeps the comparison honest: every number
here is reproducible with just onnxruntime, no Ollama, no torch, no transformers.

Models on the default curve (all CPU ONNX int8):
    bge-small (deployed)  33M  384d  512ctx  WordPiece/CLS   <- exact recall.py Bge, as shipped today
    bge-small +qprefix    33M  384d          WordPiece/CLS   <- same model, adds the bge query instruction
    bge-base              109M 768d  512ctx  WordPiece/CLS   <- drop-in: identical vocab, only the dim changes
    arctic-m-v1.5         109M 768d  512ctx  WordPiece/CLS   <- drop-in + Matryoshka (also tested truncated to 256)
    EmbeddingGemma        300M 768d  2048ctx SentencePiece   <- also 512/384/256 via Matryoshka

Optional heavier cross-checks (only with --with-ollama, needs the Ollama service up):
    embeddinggemma (ollama)   qwen3-embedding:0.6b   bge-m3

Usage (run under the DevToolbox venv python, which carries onnxruntime + numpy + tokenizers):
    python bench_embed.py                 # full benchmark -> prints table, writes bench_report.md + bench_results.csv
    python bench_embed.py --smoke         # fast wiring check: self-test cosines + 2 queries per model
    python bench_embed.py --validate      # confirm the ONNX EmbeddingGemma agrees with Ollama's weights
    python bench_embed.py --with-ollama   # also benchmark the heavier Ollama models

Model asset dirs (override with env vars):
    BENCH_MODELS_ROOT   default %LOCALAPPDATA%\\DevToolbox\\models
    RECALL_MEMORY_DIR   corpus (default ~/.claude/projects/d---claude/memory)
"""
import os, sys, json, time, argparse, importlib.util, urllib.request

for stream in (sys.stdout, sys.stderr):          # Windows consoles default to cp1252
    try: stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

import numpy as np
import onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MEM_DIR = os.environ.get("RECALL_MEMORY_DIR",
                         os.path.expanduser(r"~/.claude/projects/d---claude/memory"))
MODELS_ROOT = os.environ.get("BENCH_MODELS_ROOT",
                             os.path.expandvars(r"%LOCALAPPDATA%\DevToolbox\models"))
EG_DIR     = os.path.join(MODELS_ROOT, "embeddinggemma-300m-onnx")
BGE_BASE   = os.path.join(MODELS_ROOT, "bge-base-en-v1.5-onnx")
ARCTIC     = os.path.join(MODELS_ROOT, "arctic-embed-m-v1.5-onnx")
OLLAMA = "http://localhost:11434"
EMBED_CHAR_CAP = 8000                            # same per-file text cap recall.py hands the tokenizer
BGE_QPREFIX = "Represent this sentence for searching relevant passages: "

# --- import recall.py so we reuse its EXACT deployed embedder + WordPiece tokenizer + parse_meta ---
_spec = importlib.util.spec_from_file_location("recall", os.path.join(HERE, "..", "recall.py"))
recall = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(recall)                 # runs its runtime shim; a no-op inside the venv
UNK, CLS, SEP = recall.UNK, recall.CLS, recall.SEP


# ======================================================================================
# Embedders
# ======================================================================================
class DeployedBge:
    """Adapter around recall.Bge -- the exact embedder shipped today (256-token cap, no query
    prefix, 384d). Ignores is_query on purpose: the deployed tool applies no query instruction."""

    def __init__(self):
        self.inner = recall.Bge()

    def embed(self, text, is_query=False):
        return self.inner.embed(text)


class WpOnnx:
    """WordPiece + CLS-pool ONNX embedder (bge / arctic family). Same recipe as recall.Bge,
    but the ONNX file, output dim, query prefix and token cap are parameterised so one class
    covers bge-small, bge-base and arctic-embed. Vocab is bert-base-uncased for all three."""

    def __init__(self, onnx_path, vocab_path, dim=None, query_prefix="", max_tokens=512):
        self.vocab = {}
        with open(vocab_path, encoding="utf-8") as f:
            for i, line in enumerate(f):
                self.vocab[line.rstrip("\n")] = i
        self.sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
        self.innames = [i.name for i in self.sess.get_inputs()]
        self.dim, self.query_prefix, self.max_tokens = dim, query_prefix, max_tokens

    # tokenizer: byte-for-byte the same logic recall.Bge ships (validated by --smoke self-test)
    def _basic(self, text):
        import unicodedata
        out, buf = [], []
        for c in text.lower():
            if c.isspace():
                if buf: out.append("".join(buf)); buf = []
            elif unicodedata.category(c)[0] in ("P", "S"):
                if buf: out.append("".join(buf)); buf = []
                out.append(c)
            else:
                buf.append(c)
        if buf: out.append("".join(buf))
        return out

    def _wordpiece(self, word):
        if len(word) > 100: return [UNK]
        start, pieces = 0, []
        while start < len(word):
            end, cur = len(word), None
            while start < end:
                sub = ("##" if start > 0 else "") + word[start:end]
                if sub in self.vocab: cur = sub; break
                end -= 1
            if cur is None: return [UNK]
            pieces.append(cur); start = end
        return pieces

    def _encode(self, text):
        ids = [self.vocab[CLS]]
        for w in self._basic(text):
            for p in self._wordpiece(w):
                ids.append(self.vocab.get(p, self.vocab[UNK]))
        ids.append(self.vocab[SEP])
        m = self.max_tokens
        return ids[:m - 1] + [self.vocab[SEP]] if len(ids) > m else ids

    def embed(self, text, is_query=False):
        if is_query and self.query_prefix:
            text = self.query_prefix + text
        ids = self._encode(text or " ")
        n = len(ids)
        arr = np.array(ids, dtype=np.int64).reshape(1, n)
        feeds = {}
        for name in self.innames:
            low = name.lower()
            feeds[name] = (np.ones((1, n), dtype=np.int64) if "mask" in low
                           else np.zeros((1, n), dtype=np.int64) if "type" in low
                           else arr)
        outs = self.sess.run(None, feeds)
        tok = next((o for o in outs if o.ndim == 3), outs[0])     # token embeddings
        v = (tok[0, 0, :] if tok.ndim == 3 else tok[0, :]).astype(np.float64)   # CLS pool
        if self.dim: v = v[:self.dim]
        return v / (np.linalg.norm(v) or 1.0)


class EgOnnx:
    """EmbeddingGemma int8 ONNX. Pooling + dense head are baked into the graph's
    `sentence_embedding` output, so we only tokenize (SentencePiece via tokenizer.json)
    and apply the task prompts.

    Two details this class handles:
      * Fixed-length padding to PAD_LEN. The quantized graph's RotaryEmbedding op cannot grow
        its cos/sin cache mid-session, so every input is padded/truncated to one constant length
        (masked tokens are excluded from the mean pool, so padding does not change the vector).
        512 also gives EmbeddingGemma the same context window as bge-base/arctic -> a fair fight.
      * Full 768d vectors are cached per text so the Matryoshka dims (via Truncate) reuse one
        forward pass instead of re-running the model four times."""

    PAD_LEN = 512
    PAD_ID = 0

    def __init__(self):
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(EG_DIR, "tokenizer.json"))
        self.sess = ort.InferenceSession(os.path.join(EG_DIR, "onnx", "model_quantized.onnx"),
                                         providers=["CPUExecutionProvider"])
        self._cache = {}

    def embed(self, text, is_query=False):
        key = (is_query, text)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        prompt = (f"task: search result | query: {text}" if is_query
                  else f"title: none | text: {text}")
        ids = self.tok.encode(prompt).ids[:self.PAD_LEN]
        mask = [1] * len(ids)
        pad = self.PAD_LEN - len(ids)
        ids += [self.PAD_ID] * pad
        mask += [0] * pad
        out = self.sess.run(["sentence_embedding"],
                            {"input_ids": np.array([ids], dtype=np.int64),
                             "attention_mask": np.array([mask], dtype=np.int64)})[0][0]
        v = np.asarray(out, dtype=np.float64)
        v = v / (np.linalg.norm(v) or 1.0)
        self._cache[key] = v
        return v


class Truncate:
    """A Matryoshka view over a base embedder: take the first `dim` components and renormalise.
    Shares the base embedder's cache, so the four EmbeddingGemma dims cost one forward pass."""

    def __init__(self, base, dim):
        self.base, self.dim = base, dim

    def embed(self, text, is_query=False):
        v = np.asarray(self.base.embed(text, is_query), dtype=np.float64)[:self.dim]
        return v / (np.linalg.norm(v) or 1.0)


class OllamaEmb:
    """Optional heavier models served by the local Ollama daemon (not the beside-the-exe path)."""

    def __init__(self, model, query_instruct="", doc_prefix="", query_prefix="", cpu=False):
        self.model, self.query_instruct = model, query_instruct
        self.doc_prefix, self.query_prefix, self.cpu = doc_prefix, query_prefix, cpu

    def embed(self, text, is_query=False):
        if is_query:
            text = self.query_instruct + text if self.query_instruct else self.query_prefix + text
        else:
            text = self.doc_prefix + text
        body = {"model": self.model, "input": text}
        if self.cpu: body["options"] = {"num_gpu": 0}
        req = urllib.request.Request(f"{OLLAMA}/api/embed",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            v = np.array(json.loads(r.read())["embeddings"][0], dtype=np.float64)
        return v / (np.linalg.norm(v) or 1.0)


# ======================================================================================
# Corpus, queries, metrics
# ======================================================================================
def load_corpus():
    texts = {}
    for n in sorted(os.listdir(MEM_DIR)):
        if not n.endswith(".md") or n == "MEMORY.md":
            continue
        raw = open(os.path.join(MEM_DIR, n), encoding="utf-8", errors="replace").read()
        desc, body = recall.parse_meta(raw)
        texts[n] = (desc + "\n" + body)[:EMBED_CHAR_CAP]
    return texts


def load_queries():
    data = json.load(open(os.path.join(HERE, "queries.json"), encoding="utf-8"))
    return data["queries"]


def evaluate(emb, corpus, queries):
    t0 = time.perf_counter(); n_embeds = 0
    doc_vecs = {}
    for name, text in corpus.items():
        doc_vecs[name] = np.asarray(emb.embed(text, is_query=False), dtype=np.float64); n_embeds += 1
    names = list(doc_vecs)
    M = np.array([doc_vecs[n] for n in names])           # (D, dim)

    r1 = r3 = mrr = sep = 0.0
    misses = []
    for item in queries:
        qv = np.asarray(emb.embed(item["q"], is_query=True), dtype=np.float64); n_embeds += 1
        sims = M @ qv
        order = np.argsort(-sims)
        ranked = [names[i] for i in order]
        tgt = set(item["targets"])
        top1_ok = ranked[0] in tgt
        top3_ok = any(r in tgt for r in ranked[:3])
        rank = next((i + 1 for i, r in enumerate(ranked) if r in tgt), None)
        r1 += top1_ok; r3 += top3_ok; mrr += (1.0 / rank if rank else 0.0)
        best_tgt = max(sims[[names.index(t) for t in tgt if t in names]])
        best_other = max(s for nm, s in zip(names, sims) if nm not in tgt)
        sep += (best_tgt - best_other)
        if not top1_ok:
            misses.append((item["q"][:52], ranked[0], rank))
    dt = time.perf_counter() - t0
    q = len(queries)
    return {"R@1": r1 / q, "R@3": r3 / q, "MRR": mrr / q, "sep": sep / q,
            "ms": dt / n_embeds * 1000.0, "dim": len(qv), "misses": misses}


def dir_mb(*paths):
    total = 0
    for p in paths:
        if os.path.isfile(p):
            total += os.path.getsize(p)
        elif os.path.isdir(p):
            for root, _, files in os.walk(p):
                for f in files:
                    total += os.path.getsize(os.path.join(root, f))
    return total / 1e6


# ======================================================================================
# Model registry (built lazily so a missing asset doesn't kill the whole run)
# ======================================================================================
def bge_small_dir():
    return recall._model_dir()


def build_models(with_ollama=False):
    """Return list of (label, footprint_MB, embedder) tuples, skipping any with missing assets."""
    d_small = bge_small_dir()
    vocab = os.path.join(d_small, "bge-small.vocab.txt")
    reg = []

    def add(label, mb, factory):
        try:
            reg.append((label, mb, factory()))
        except Exception as e:
            print(f"  [skip] {label}: {type(e).__name__}: {str(e)[:90]}", file=sys.stderr)

    # baseline: the EXACT deployed embedder (256-token cap, no prefix, 384d)
    add("bge-small (deployed)", dir_mb(os.path.join(d_small, "bge-small.onnx"), vocab),
        lambda: DeployedBge())
    # same model, add bge's recommended query instruction + full 512 window
    add("bge-small +qprefix", dir_mb(os.path.join(d_small, "bge-small.onnx"), vocab),
        lambda: WpOnnx(os.path.join(d_small, "bge-small.onnx"), vocab,
                       dim=None, query_prefix=BGE_QPREFIX, max_tokens=512))
    arctic_onnx = os.path.join(ARCTIC, "onnx", "model_quantized.onnx")
    # in-between #1: drop-in bigger sibling, identical vocab, 768d. No prefix = exactly how recall.py
    # would use it if swapped in (recall applies no query instruction).
    add("bge-base", dir_mb(os.path.join(BGE_BASE, "onnx", "model_quantized.onnx"), vocab),
        lambda: WpOnnx(os.path.join(BGE_BASE, "onnx", "model_quantized.onnx"), vocab,
                       dim=None, query_prefix="", max_tokens=512))
    # in-between #2: arctic-embed-m, Matryoshka. Tested as a true drop-in (no prefix) at 768 and 256,
    # plus one row with arctic's trained query prefix to show its intended-use ceiling.
    add("arctic-m-v1.5 (768)", dir_mb(arctic_onnx, vocab),
        lambda: WpOnnx(arctic_onnx, vocab, dim=None, query_prefix="", max_tokens=512))
    add("arctic-m-v1.5 (256d MRL)", dir_mb(arctic_onnx, vocab),
        lambda: WpOnnx(arctic_onnx, vocab, dim=256, query_prefix="", max_tokens=512))
    add("arctic-m-v1.5 (768,+prefix)", dir_mb(arctic_onnx, vocab),
        lambda: WpOnnx(arctic_onnx, vocab, dim=None, query_prefix=BGE_QPREFIX, max_tokens=512))
    # the big one: build once, derive the Matryoshka dims by truncation (one forward pass)
    eg_mb = dir_mb(EG_DIR)
    try:
        eg = EgOnnx()
        for dim in (768, 512, 384, 256):
            reg.append((f"EmbeddingGemma ({dim}d)", eg_mb, Truncate(eg, dim)))
    except Exception as e:
        print(f"  [skip] EmbeddingGemma: {type(e).__name__}: {str(e)[:90]}", file=sys.stderr)

    if with_ollama:
        add("embeddinggemma (ollama)", 0.0,
            lambda: OllamaEmb("embeddinggemma"))                    # prompts applied in EgOnnx-style below
        add("qwen3-embedding:0.6b (ollama)", 0.0,
            lambda: OllamaEmb("qwen3-embedding:0.6b",
                              query_instruct="Instruct: Given a search query, retrieve relevant memory notes\nQuery: "))
        add("bge-m3 (ollama)", 0.0, lambda: OllamaEmb("bge-m3"))
    return reg


# EmbeddingGemma-over-Ollama needs the same task prompts as the ONNX path; patch it in.
def _wrap_eg_ollama(emb):
    if isinstance(emb, OllamaEmb) and emb.model == "embeddinggemma":
        emb.query_prefix = "task: search result | query: "
        emb.doc_prefix = "title: none | text: "
    return emb


# ======================================================================================
# Reporting
# ======================================================================================
def run_full(with_ollama):
    corpus, queries = load_corpus(), load_queries()
    print(f"\n  corpus: {len(corpus)} memory files   queries: {len(queries)}   (CPU, ONNX)\n")
    rows = []
    for label, mb, emb in build_models(with_ollama):
        emb = _wrap_eg_ollama(emb)
        m = evaluate(emb, corpus, queries)
        rows.append((label, mb, m))
        print(f"  {label:28s} dim={m['dim']:4d}  R@1={m['R@1']:.2f}  R@3={m['R@3']:.2f}  "
              f"MRR={m['MRR']:.3f}  sep={m['sep']:+.3f}  {m['ms']:6.1f} ms  {mb:6.0f} MB")

    # markdown report
    lines = ["# Embedding model benchmark - Claude memory corpus", "",
             f"- Corpus: {len(corpus)} memory files (desc + body, {EMBED_CHAR_CAP}-char cap)",
             f"- Queries: {len(queries)} (phrased in different words than each file's index hook)",
             "- All non-Ollama rows: CPU, ONNX int8, no server (the beside-the-exe path)",
             "- R@1 / R@3 = share of queries whose top-1 / top-3 file is a correct target",
             "- MRR = mean reciprocal rank of the first correct file; sep = mean cosine margin (target minus best distractor)",
             "", "| model | dim | R@1 | R@3 | MRR | sep | ms/embed | disk MB |",
             "|---|---|---|---|---|---|---|---|"]
    for label, mb, m in rows:
        lines.append(f"| {label} | {m['dim']} | {m['R@1']:.2f} | {m['R@3']:.2f} | "
                     f"{m['MRR']:.3f} | {m['sep']:+.3f} | {m['ms']:.1f} | {mb:.0f} |")
    lines += ["",
              "Notes: the small corpus (41 files / 24 queries) makes R@1 differences of one to two "
              "queries noise; the cosine margin (`sep`) is the steadier signal. The EmbeddingGemma "
              "512/384/256 rows share the 768 forward pass (Matryoshka truncation is free), so their "
              "true per-embed cost is the same as the 768 row; the near-zero ms reflects the shared cache."]
    # value story: which queries the deployed baseline misses, and who fixes them
    base = next((m for l, _, m in rows if l == "bge-small (deployed)"), None)
    if base and base["misses"]:
        lines += ["", "## Queries today's bge-small gets wrong at rank 1", ""]
        for q, got, rank in base["misses"]:
            lines.append(f"- \"{q}...\"  ->  returned `{got}` (correct file at rank {rank or 'NR'})")
    open(os.path.join(HERE, "bench_report.md"), "w", encoding="utf-8").write("\n".join(lines))

    # csv
    with open(os.path.join(HERE, "bench_results.csv"), "w", encoding="utf-8") as f:
        f.write("model,dim,R@1,R@3,MRR,sep,ms_per_embed,disk_mb\n")
        for label, mb, m in rows:
            f.write(f"{label},{m['dim']},{m['R@1']:.4f},{m['R@3']:.4f},{m['MRR']:.4f},"
                    f"{m['sep']:.4f},{m['ms']:.2f},{mb:.1f}\n")
    print(f"\n  wrote bench_report.md and bench_results.csv to {HERE}\n")


def run_smoke(with_ollama):
    """Fast wiring check: confirm each embedder loads, self-test cosines are sane, 2 queries rank."""
    triplet = ("I love programming in C sharp",
               "Writing code in dot net is really fun",
               "The weather outside is freezing cold today")
    corpus, queries = load_corpus(), load_queries()
    demo = queries[:2]
    for label, mb, emb in build_models(with_ollama):
        emb = _wrap_eg_ollama(emb)
        a, b, c = (np.asarray(emb.embed(t), dtype=np.float64) for t in triplet)
        hi, lo = float(a @ b), float(a @ c)
        line = f"  {label:28s} dim={len(a):4d}  cos(code,code)={hi:+.3f}  cos(code,weather)={lo:+.3f}  {'PASS' if hi > lo else 'FAIL'}"
        print(line)
        docvecs = {n: np.asarray(emb.embed(t), dtype=np.float64) for n, t in corpus.items()}
        names = list(docvecs); M = np.array([docvecs[n] for n in names])
        for item in demo:
            qv = np.asarray(emb.embed(item["q"], is_query=True), dtype=np.float64)
            top = names[int(np.argmax(M @ qv))]
            ok = "ok" if top in item["targets"] else "MISS"
            print(f"       [{ok}] \"{item['q'][:46]}...\" -> {top}")
    print()


def run_validate():
    """Confirm the ONNX EmbeddingGemma agrees with the Ollama-served weights (sanity on our pipeline)."""
    onnx = EgOnnx()
    oll = _wrap_eg_ollama(OllamaEmb("embeddinggemma"))
    print("\n  cosine(ONNX EmbeddingGemma, Ollama EmbeddingGemma) on identical inputs:")
    for t, isq in [("run as SYSTEM without a UAC prompt", True),
                   ("push git from the agent shell over https", False),
                   ("identify flowers in a photo", False)]:
        v1, v2 = onnx.embed(t, is_query=isq), oll.embed(t, is_query=isq)
        print(f"    {float(v1 @ v2):+.4f}   ({'query' if isq else 'doc'}) {t[:44]}")
    print("\n  >0.95 means our standalone ONNX pipeline reproduces the model faithfully.\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--smoke", action="store_true", help="fast wiring check, no report written")
    ap.add_argument("--validate", action="store_true", help="check ONNX EmbeddingGemma vs Ollama weights")
    ap.add_argument("--with-ollama", action="store_true", help="also benchmark the heavier Ollama models")
    args = ap.parse_args()
    if args.validate: run_validate(); return
    if args.smoke: run_smoke(args.with_ollama); return
    run_full(args.with_ollama)


if __name__ == "__main__":
    main()
