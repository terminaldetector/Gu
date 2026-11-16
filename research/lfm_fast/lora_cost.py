"""Track D: measured limits for LoRA on the visual blocks and the projector.

LoRA (peft) on the minimal graph (lfm_fast_vision.FastVision, no LM): rank r on the
SigLIP2 attention q_proj/v_proj of every vision layer and on the projector's two
linears. Measures, on the host, what one training step costs - forward + backward +
AdamW over a batch of keyframes - and how much memory training adds on top of the
built graph. The objective is a stand-in (regress pooled features toward a fixed
random target): this measures COST, not quality.

Also reports the inference cost of the LoRA graph once merged (merge_and_unload):
merged LoRA has exactly the base graph's shape, so its latency is the base latency.

usage: python -I lora_cost.py WEIGHTS [RECORD_PREFIX] [--ranks 8,16] [--batch 8] [--steps 6]
       without a record, random 240x256 frames are used (cost does not depend on content)
"""
import argparse, json, os, sys, time, zlib

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lfm_fast_vision import FastVision, grid, load, patchify  # noqa: E402


def status_kib(key):
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("record", nargs="?")
    ap.add_argument("--ranks", default="8,16")
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--report")
    a = ap.parse_args()
    torch.manual_seed(0)
    torch.set_num_threads(a.threads)
    from peft import LoraConfig, get_peft_model
    if a.record:
        meta = json.load(open(a.record + ".meta.json"))
        h, w = meta["height"], meta["width"]
        frames = np.frombuffer(zlib.decompress(open(a.record + ".rgb.u8.z", "rb").read()), np.uint8).reshape(-1, h, w, 3)
    else:
        h, w = 240, 256
        frames = (np.random.default_rng(0).random((64, h, w, 3)) * 255).astype(np.uint8)
    rows, cols = grid(h, w)
    report = {"type": "gu-lfm-lora-cost", "schema": 1, "host": "x86 CPU fp32, torch - NOT Android",
              "objective": "stand-in (cost only, not quality)", "batch": a.batch, "threads": a.threads,
              "grid": [rows, cols], "runs": []}
    for r in [int(x) for x in a.ranks.split(",")]:
        _, model, _, _ = load(a.weights)  # fresh modules per rank: peft wraps them in place
        fv = FastVision(model, rows, cols).train()
        del model
        for p in fv.parameters():
            p.requires_grad_(False)
        cfg = LoraConfig(r=r, lora_alpha=2 * r, lora_dropout=0.0,
                         target_modules=r".*vision_layers\.\d+\.self_attn\.(q_proj|v_proj)|.*projector\.linear_[12]")
        pm = get_peft_model(fv, cfg)
        trainable = sum(p.numel() for p in pm.parameters() if p.requires_grad)
        opt = torch.optim.AdamW([p for p in pm.parameters() if p.requires_grad], 1e-4)
        target = torch.randn(a.batch, 1024)
        rss0 = status_kib("VmRSS")
        try:  # reset the peak (Linux >= 4.0) so VmHWM below is the training peak, not the checkpoint load
            with open("/proc/self/clear_refs", "w") as f:
                f.write("5")
            hwm_reset = True
        except OSError:
            hwm_reset = False
        times = []
        for s in range(a.steps + 1):
            idx = np.random.default_rng(s).choice(len(frames), a.batch, replace=False)
            x = patchify(torch.from_numpy(frames[idx].copy()), rows, cols)
            t0 = time.perf_counter()
            y = pm.base_model.model.vision(x).mean(1)
            loss = ((y - target) ** 2).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            if s:
                times.append(time.perf_counter() - t0)
        peak_delta = status_kib("VmHWM") - rss0
        merged = pm.merge_and_unload().eval()
        with torch.no_grad():
            x = patchify(torch.from_numpy(frames[:1].copy()), rows, cols)
            for _ in range(2):
                merged.vision(x)
            t0 = time.perf_counter()
            for _ in range(5):
                merged.vision(x)
            infer = (time.perf_counter() - t0) / 5
        run = {"rank": r, "trainableParams": trainable, "stepSeconds_p50": round(float(np.median(times)), 2),
               "keyframesPerHour": round(3600 * a.batch / float(np.median(times))),
               "trainingPeakOverRssBeforeMiB": round(max(peak_delta, 0) / 1024), "peakResetBeforeTraining": hwm_reset,
               "mergedInferenceMs": round(infer * 1000, 1)}
        report["runs"].append(run)
        print(json.dumps(run), flush=True)
        del pm, merged, opt
    if a.report:
        json.dump(report, open(a.report, "w"), indent=1)


if __name__ == "__main__":
    main()
