# Embedding model benchmark

Compares CPU embedding models on **our own memory corpus** (the 40-odd `*.md` files in this
directory), to decide whether it is worth moving recall.py / desktopPet off today's
`bge-small-en-v1.5`. Everything on the default curve runs as a plain ONNX file on CPU with no
server, matching the "model beside the exe" shape we actually ship.

## Run it

```powershell
.\run.ps1                 # full benchmark -> prints a table, writes bench_report.md + bench_results.csv
.\run.ps1 --smoke         # fast wiring check (self-test cosines + 2 queries per model)
.\run.ps1 --validate      # confirm the standalone ONNX EmbeddingGemma matches Ollama's weights
.\run.ps1 --with-ollama   # also benchmark the heavier Ollama models (qwen3-embedding, bge-m3)
```

`run.ps1` just invokes `bench_embed.py` under the DevToolbox venv python (onnxruntime + numpy +
tokenizers). Runtime for the default curve is well under a minute.

## What is compared (all CPU ONNX int8)

| row | what it isolates |
|---|---|
| bge-small (deployed) | today's exact recall.py embedder (256-token cap, no prefix, 384d) |
| bge-small +qprefix | same model, does the bge query instruction help? (on this corpus: no) |
| bge-base | drop-in bigger sibling, identical vocab, no prefix (as recall would use it) |
| arctic-m-v1.5 (768 / 256d) | drop-in + Matryoshka, no prefix |
| arctic-m-v1.5 (768,+prefix) | arctic with its trained query prefix (intended use) |
| EmbeddingGemma (768/512/384/256) | 300M model, Matryoshka dims (one shared forward pass) |

## Reading the numbers

- **R@1 / R@3**: share of queries whose top-1 / top-3 file is a correct target.
- **MRR**: mean reciprocal rank of the first correct file.
- **sep**: mean cosine margin between the best correct file and the best wrong file. With only
  24 queries, R@1 swings of one or two queries are noise; **sep is the steadier signal.**
- **ms/embed**: CPU latency. EmbeddingGemma's truncated dims share the 768 forward pass, so their
  near-zero ms is a caching artifact, not a real cost.

## Assets

Model files live outside the repo under `%LOCALAPPDATA%\DevToolbox\models\` (bge-base, arctic,
embeddinggemma-300m-onnx). bge-small is found the same way recall.py finds it. Override the model
root with `BENCH_MODELS_ROOT` and the corpus with `RECALL_MEMORY_DIR`.

## Tuning

- Edit `queries.json` to add/adjust the eval queries (each has an acceptable-target set).
- To test other candidates, download their int8 ONNX + `vocab.txt` and add a `WpOnnx(...)` row
  in `build_models()` (any bert-base-uncased / WordPiece model reuses the existing tokenizer).
