"""Track A: slow-path visual features for recorded play (record_play.cjs output).

One pass per keyframe through the minimal graph (lfm_fast_vision.FastVision with 4
decoder layers) yields the three compared variants at once:
  proj  projector output (no language model at all)
  lm2   hidden state after LFM2 decoder layers 0-1 (conv, conv)
  lm4   hidden state after layers 0-3 (conv, conv, attention, conv)
Each is stored as a 4x4 average-pooled token grid (16 x 1024) plus a summary vector
(proj: token mean; lm*: the image_end position, which sees every image token), fp16.
The per-keyframe compute time of the whole pass is recorded too.

PRIVATE OUTPUT: features of commercial-game frames stay in the directory given
(scratch); the repository receives only aggregate results.

usage: python -I extract_features.py WEIGHTS RECORD_PREFIX [RECORD_PREFIX ...] [--threads 4]
"""
import argparse, json, os, sys, time, zlib

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lfm_fast_vision import FastVision, grid, load, patchify  # noqa: E402

VARIANTS = ("proj", "lm2", "lm4")


def pooled(tokens, rows, cols):
    """(B, T, 1024) image tokens on a (rows/2, cols/2) grid -> (B, 16, 1024)"""
    b = tokens.shape[0]
    g = tokens.reshape(b, rows // 2, cols // 2, -1).permute(0, 3, 1, 2)
    return F.adaptive_avg_pool2d(g, (4, 4)).flatten(2).transpose(1, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("records", nargs="+")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--batch", type=int, default=4)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    _, model, start, end = load(a.weights)
    graphs = {}
    for prefix in a.records:
        meta = json.load(open(prefix + ".meta.json"))
        h, w = meta["height"], meta["width"]
        rows, cols = grid(h, w)
        if (rows, cols) not in graphs:
            graphs[(rows, cols)] = FastVision(model, rows, cols, exit_layers=4, image_start=start, image_end=end).eval()
        fv = graphs[(rows, cols)]
        frames = np.frombuffer(zlib.decompress(open(prefix + ".rgb.u8.z", "rb").read()), np.uint8).reshape(-1, h, w, 3)
        n = len(frames)
        out = {v: np.zeros((n, 16, 1024), np.float16) for v in VARIANTS}
        summary = {v: np.zeros((n, 1024), np.float16) for v in VARIANTS}
        times = []
        with torch.no_grad():
            for i in range(0, n, a.batch):
                x = torch.from_numpy(frames[i:i + a.batch].copy())
                t0 = time.perf_counter()
                tokens = fv.vision(patchify(x, rows, cols))
                exits = fv.language(tokens)
                times.append((time.perf_counter() - t0) * 1000 / len(x))
                for v, t in (("proj", tokens), ("lm2", exits[2][:, 1:-1]), ("lm4", exits[4][:, 1:-1])):
                    out[v][i:i + len(x)] = pooled(t, rows, cols).numpy().astype(np.float16)
                summary["proj"][i:i + len(x)] = tokens.mean(1).numpy().astype(np.float16)
                summary["lm2"][i:i + len(x)] = exits[2][:, -1].numpy().astype(np.float16)
                summary["lm4"][i:i + len(x)] = exits[4][:, -1].numpy().astype(np.float16)
        np.savez(prefix + ".features.npz", **{v + "_grid": out[v] for v in VARIANTS}, **{v + "_summary": summary[v] for v in VARIANTS})
        info = {"record": os.path.basename(prefix), "keyframes": n, "grid": [rows, cols], "tokens": (rows // 2) * (cols // 2),
                "msPerKeyframe_p50_allExitsBatch": round(float(np.percentile(times, 50)), 1), "threads": a.threads, "batch": a.batch}
        json.dump(info, open(prefix + ".features.json", "w"))
        print(json.dumps(info), flush=True)


if __name__ == "__main__":
    main()
