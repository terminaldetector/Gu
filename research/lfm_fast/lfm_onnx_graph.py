"""Track A, item 6: the minimal LFM vision graph as a standalone ONNX file, and what it
really costs to run - latency AND peak process memory, measured, not read from the
file size (a Q4/Q8 file size is not the RAM of the running session).

  export   FastVision (lfm_fast_vision.py) for one console grid and one exit
           (proj / lm2 / lm4, optional vision depth) -> fp32 ONNX; checked against
           torch on the same patches; then int8 weight quantisation (dynamic,
           MatMul) -> checked by cosine similarity to fp32.
  measure  a FRESH process loads only the ONNX file into onnxruntime (CPU EP) and
           runs N frames: p50/p95 latency and peak RSS (ru_maxrss) of that
           process. Nothing of transformers or the full checkpoint is in it.

Host-only research tool: weights from a local directory, outputs to a directory
the caller names (scratch, never the repository).
"""
import argparse, json, os, subprocess, sys, time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def export(weights, out_dir, name, rows, cols, vision_layers, exit_layers, frames=None):
    import torch
    sys.path.insert(0, HERE)
    from lfm_fast_vision import FastVision, load, patchify
    _, model, start, end = load(weights)
    fv = FastVision(model, rows, cols, vision_layers=vision_layers, exit_layers=exit_layers,
                    image_start=start, image_end=end).eval()
    del model
    patches = torch.randn(1, rows * cols, 768)
    real = patchify(torch.from_numpy(frames), rows, cols) if frames is not None else None
    path = os.path.join(out_dir, name + ".onnx")
    with torch.no_grad():
        reference = fv(patches).numpy()
        torch.onnx.export(fv, (patches,), path, input_names=["patches"], output_names=["features"],
                          dynamo=True, external_data=True, optimize=True)
    import onnxruntime as ort
    from onnxruntime.quantization import QuantType, quantize_dynamic
    s = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    got = s.run(None, {"patches": patches.numpy()})[0]
    q_path = os.path.join(out_dir, name + ".int8.onnx")
    quantize_dynamic(path, q_path, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"],
                     use_external_data_format=True)
    q = ort.InferenceSession(q_path, providers=["CPUExecutionProvider"]).run(None, {"patches": patches.numpy()})[0]
    def cos(a, b):
        return float(np.mean(np.sum(a * b, -1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-9)))
    drift = {}
    if real is not None:  # int8 against fp32 on real game frames, the inputs that matter
        fs = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        qs = ort.InferenceSession(q_path, providers=["CPUExecutionProvider"])
        a = np.concatenate([fs.run(None, {"patches": real[i:i + 1].numpy()})[0] for i in range(len(real))])
        b = np.concatenate([qs.run(None, {"patches": real[i:i + 1].numpy()})[0] for i in range(len(real))])
        drift = {"realFrames": int(len(real)), "int8CosineToFp32RealFrames": cos(b, a),
                 "int8PooledCosineRealFrames": cos(b.mean(1), a.mean(1))}
    return {**drift, "name": name, "grid": [rows, cols], "visionLayers": vision_layers, "exitLayers": exit_layers,
            "fp32": path, "int8": q_path, "onnxVsTorchMaxAbs": float(np.abs(got - reference).max()),
            "referenceAbsMean": float(np.abs(reference).mean()), "int8CosineToFp32": cos(q, got),
            "fileMiB": {"fp32": round(file_bytes(path) / 2**20, 1), "int8": round(file_bytes(q_path) / 2**20, 1)}}


def file_bytes(onnx_path):
    """the .onnx file plus its external-data file(s)"""
    import onnx
    m = onnx.load(onnx_path, load_external_data=False)
    total, seen = os.path.getsize(onnx_path), set()
    for t in m.graph.initializer:
        for e in t.external_data:
            if e.key == "location" and e.value not in seen:
                seen.add(e.value)
                total += os.path.getsize(os.path.join(os.path.dirname(onnx_path), e.value))
    return total


def status_kib(key):
    """VmHWM / VmRSS of this process. Not ru_maxrss: on Linux that survives exec and would
    report the parent's (transformers + full checkpoint) peak."""
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith(key + ":"):
                return int(line.split()[1])
    return None


def measure(path, patches_n, threads, repeats):
    """runs in a fresh process: only onnxruntime and the graph file"""
    import onnxruntime as ort
    base = status_kib("VmHWM")
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    t0 = time.perf_counter()
    s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - t0) * 1000
    after_load = status_kib("VmRSS")
    x = np.random.default_rng(0).standard_normal((1, patches_n, 768)).astype(np.float32)
    times = []
    for i in range(repeats + 3):
        t = time.perf_counter()
        s.run(None, {"patches": x})
        if i >= 3:
            times.append((time.perf_counter() - t) * 1000)
    peak = status_kib("VmHWM")
    return {"threads": threads, "loadMs": round(load_ms), "p50": round(float(np.percentile(times, 50)), 1),
            "p95": round(float(np.percentile(times, 95)), 1),
            "peakRssMiB": round(peak / 1024), "hwmBeforeLoadMiB": round(base / 1024), "rssAfterLoadMiB": round(after_load / 1024)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("out_dir")
    ap.add_argument("--threads", default="1,2,4")
    ap.add_argument("--repeats", type=int, default=20)
    ap.add_argument("--report")
    ap.add_argument("--frames-from", help="record_play prefix: real keyframes for the int8 drift check")
    ap.add_argument("--measure-only", nargs=4, metavar=("PATH", "PATCHES", "THREADS", "REPEATS"))
    a = ap.parse_args()
    if a.measure_only:
        p, n, t, r = a.measure_only
        print(json.dumps(measure(p, int(n), int(t), int(r))))
        return
    os.makedirs(a.out_dir, exist_ok=True)
    variants = [("nes-proj", 16, 16, 12, 0), ("nes-lm2", 16, 16, 12, 2), ("nes-lm4", 16, 16, 12, 4), ("nes-proj-v6", 16, 16, 6, 0)]
    report = {"type": "gu-lfm-fast-vision-onnx", "schema": 1, "host": "x86 CPU, onnxruntime CPU EP - NOT Android",
              "note": "peakRssMiB is measured in a fresh process holding only onnxruntime and the graph; file size is reported apart and is not RAM",
              "variants": []}
    frames = None
    if a.frames_from:
        import zlib
        meta = json.load(open(a.frames_from + ".meta.json"))
        k = np.frombuffer(zlib.decompress(open(a.frames_from + ".rgb.u8.z", "rb").read()), np.uint8).reshape(-1, meta["height"], meta["width"], 3)
        frames = k[np.linspace(len(k) // 4, len(k) - 1, 16).astype(int)].copy()
    for name, rows, cols, vl, ex in variants:
        info = export(a.weights, a.out_dir, name, rows, cols, vl, ex, frames)
        print(json.dumps(info), flush=True)
        info["runs"] = {}
        for kind in ("fp32", "int8"):
            info["runs"][kind] = []
            for t in [int(x) for x in a.threads.split(",")]:
                out = subprocess.run([sys.executable, "-I", os.path.abspath(__file__), a.weights, a.out_dir, "--measure-only",
                                      info[kind], str(rows * cols), str(t), str(a.repeats)], capture_output=True, text=True, check=True)
                info["runs"][kind].append(json.loads(out.stdout.strip().splitlines()[-1]))
                print(name, kind, info["runs"][kind][-1], flush=True)
        report["variants"].append(info)
        if a.report:
            with open(a.report, "w") as f:
                json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
