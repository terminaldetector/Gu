# LFM fast decision — research tools (host only)

Not part of the APK and not run by CI: they need the official LFM2.5-VL-450M
weights in a local directory and, for the play data, cartridges that are never
committed. Results land in the directory given on the command line (scratch);
only aggregate numbers go to `docs/architecture-reset/`.

| file | what |
|---|---|
| `lfm_fast_vision.py` | the minimal visual graph: frame → patches (no processor, no padding) → SigLIP2 → projector [→ LFM2 decoder layers 0..k−1]; no token table, no LM head, no generation. Checked against transformers on the same frame; torch latency bench. |
| `lfm_onnx_graph.py` | that graph as a standalone ONNX file (fp32 and int8), checked against torch; latency and **peak memory of a fresh process holding only onnxruntime and the graph** (`VmHWM`, not the file size). |
| `record_play.cjs` | Frame(t) → Action(t) → Frame(t+1) sequences from the real GU cores (jsnes, Snes9x, Genesis Plus GX via the AGOD platform driver) with a seeded exploratory policy; no RAM, no oracle. Private output. |
| `extract_features.py` | slow-path features of recorded keyframes for the compared variants `proj` / `lm2` / `lm4` in one pass. Private output. |

Typical run (paths are examples):

```
W=$SCRATCH/lfm/LFM2.5-VL-450M
python -I research/lfm_fast/lfm_fast_vision.py $W --report $SCRATCH/bench_torch.json
python -I research/lfm_fast/lfm_onnx_graph.py $W $SCRATCH/onnx --frames-from $SCRATCH/play/contra-s1 --report $SCRATCH/bench_onnx.json
node research/lfm_fast/record_play.cjs --platform nes --rom $ROMS/contra.nes --out $SCRATCH/play/contra-s1 --frames 6000 --every 8 --seed 1
python -I research/lfm_fast/extract_features.py $W $SCRATCH/play/contra-s1 ...
```
