# Memory tool

Hygiene + semantic recall for the Claude Code file-memory system (the `MEMORY.md` index +
per-fact `*.md` files under `~/.claude/projects/<proj>/memory/`).

Two layers:

- **Thin index.** `MEMORY.md` is loaded into every session, so each entry stays a one-line
  hook (what it is + repo + one status word + key links). Running status/changelogs live in
  the memory file or the project's own repo, not the index.
- **On-demand recall.** `recall.py` embeds every memory file and finds the ones that *mean*
  the same thing as a query, so "have I solved X before?" works across projects even when the
  wording differs from the hook.

## Usage

```
python recall.py "how do I push git from the agent shell"
python recall.py -k 10 "run admin tasks without a UAC prompt"
python recall.py --lint          # audit index bloat + broken links (no model needed)
python recall.py --rebuild       # force re-embed everything
python recall.py --list          # show what's indexed
python recall.py --selftest      # verify the embedder's reference cosines
```

Ranked output is `cosine  file  description  > best-matching line`. ~0.5+ is a real hit,
0.7+ is strong.

## How it works

- **CPU embeddings.** `bge-small-en-v1.5` ONNX (the same asset desktopPet ships): BERT-uncased
  WordPiece, CLS-pool, L2-norm, 384-dim. Runs on the CPU via `onnxruntime` — always available,
  no GPU, no Ollama, no MCP, no Claude Code hook, so it runs untouched under the corporate
  managed policy. Verified to reproduce desktopPet's self-test cosines (0.72 / 0.44).
- **Incremental cache.** One vector per file, cached in `recall_index.json` **in the memory
  dir** (not this repo); only changed files re-embed. Bump `EMBED_ID` in `recall.py` to force
  a full rebuild.
- **Runtime.** Needs `onnxruntime` + `numpy` (present in the DevToolbox venv). If launched
  under a Python without them, `recall.py` re-execs itself under the DevToolbox venv, so plain
  `python recall.py ...` works from anywhere.

## Config (env)

| var | default | meaning |
|---|---|---|
| `RECALL_MEMORY_DIR` | `~/.claude/projects/d---claude/memory` | corpus to index |
| `RECALL_MODEL_DIR`  | `./models`, then desktopPet's copy | where `bge-small.onnx` lives |

## Model asset

`models/bge-small.vocab.txt` is committed; `models/bge-small.onnx` (~32 MB) is gitignored.
To restore it on a fresh clone, copy `bge-small.onnx` from `desktopPet/src/Models/`, or export
`BAAI/bge-small-en-v1.5` to ONNX. The tool degrades with a clear message if the model is absent
(`--lint` still works without it).
