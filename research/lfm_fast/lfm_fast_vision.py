"""Track A: LFM2.5-VL-450M visual features for game control WITHOUT the language model.

A separate inference graph built from the official weights and holding only what
a controller needs:
  console frame (RGB) -> resize/normalise/patchify (no processor, no padding)
  -> SigLIP2 vision encoder (12 layers, or fewer) -> post-norm
  -> projector (2x2 pixel-unshuffle, MLP) = 'proj' features (T x 1024)
  -> optionally LFM2 decoder layers 0..k-1 over [image_start, image tokens, image_end]
     = early exits 'lm2' / 'lm4' (hidden state after 2 / 4 decoder layers)
No token embedding table (two special-token rows kept), no LM head, no vocabulary
projection, no text generation, no KV cache. Positional embeddings (vision) and
rotary tables (LM) are constants for a fixed console grid, so the graph has only
matmul / layernorm / rmsnorm / gelu / silu / softmax-attention / depthwise conv.

Host-only research tool: needs the official weights in a local directory (never
downloaded at runtime, never committed). Frames passed in are the caller's; nothing
is written except the JSON report asked for.
"""
import argparse, json, math, os, resource, statistics, sys, time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

PATCH, DOWNSAMPLE = 16, 2


def grid(height, width, min_tokens=64, max_tokens=256):
    """The processor's smart_resize: patch grid (rows, cols) for a frame."""
    f = PATCH * DOWNSAMPLE
    hb, wb = max(f, round(height / f) * f), max(f, round(width / f) * f)
    if hb * wb > max_tokens * PATCH * PATCH * DOWNSAMPLE * DOWNSAMPLE:
        b = math.sqrt(height * width / (max_tokens * PATCH * PATCH * DOWNSAMPLE * DOWNSAMPLE))
        hb, wb = max(f, math.floor(height / b / f) * f), max(f, math.floor(width / b / f) * f)
    elif hb * wb < min_tokens * PATCH * PATCH * DOWNSAMPLE * DOWNSAMPLE:
        b = math.sqrt(min_tokens * PATCH * PATCH * DOWNSAMPLE * DOWNSAMPLE / (height * width))
        hb, wb = math.ceil(height * b / f) * f, math.ceil(width * b / f) * f
    return hb // PATCH, wb // PATCH


def patchify(frames, rows, cols):
    """uint8 frames (B, H, W, 3) -> normalised patches (B, rows*cols, 768), as the processor does
    (bilinear + antialias resize on uint8, x/255, (x-0.5)/0.5, row-major 16x16 patches, channels last)."""
    x = frames.permute(0, 3, 1, 2)
    if x.dtype == torch.uint8:  # the processor resizes uint8 images: the result is uint8 too
        x = F.interpolate(x, size=(rows * PATCH, cols * PATCH), mode="bilinear", antialias=True, align_corners=False).float()
    else:
        x = F.interpolate(x.float(), size=(rows * PATCH, cols * PATCH), mode="bilinear", antialias=True, align_corners=False)
    x = (x / 255.0 - 0.5) / 0.5
    b = x.shape[0]
    x = x.reshape(b, 3, rows, PATCH, cols, PATCH).permute(0, 2, 4, 3, 5, 1)
    return x.reshape(b, rows * cols, PATCH * PATCH * 3)


def rotate_half(x):
    a, b = x.chunk(2, dim=-1)
    return torch.cat((-b, a), dim=-1)


def rms(x, weight, eps):
    return weight * (x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + eps))


class FastVision(nn.Module):
    """vision (+ projector) (+ the first `exit_layers` LFM2 decoder layers) for one console grid."""

    def __init__(self, model, rows, cols, vision_layers=12, exit_layers=0, image_start=None, image_end=None):
        super().__init__()
        m = model.model
        vt = m.vision_tower
        self.rows, self.cols = rows, cols
        self.patch_embedding = vt.embeddings.patch_embedding
        with torch.no_grad():  # the resized positional table for this grid, as a constant
            size = vt.embeddings.position_embedding_size
            table = vt.embeddings.position_embedding.weight.reshape(size, size, -1)
            pos = vt.embeddings.resize_positional_embeddings(table, torch.tensor([[rows, cols]]), max_length=rows * cols)
        self.register_buffer("vision_pos", pos.detach().clone(), persistent=False)
        self.vision_layers = nn.ModuleList(list(vt.encoder.layers[:vision_layers]))
        self.post_layernorm = vt.post_layernorm
        self.projector = m.multi_modal_projector
        self.exit_layers = exit_layers
        if exit_layers:
            lm = m.language_model
            self.lm_layers = nn.ModuleList(list(lm.layers[:exit_layers]))
            self.layer_types = list(lm.config.layer_types[:exit_layers])
            self.norm_eps = lm.config.norm_eps
            self.head_dim = lm.config.hidden_size // lm.config.num_attention_heads
            emb = lm.embed_tokens.weight
            self.register_buffer("image_start", emb[image_start].detach().clone()[None, None], persistent=False)
            self.register_buffer("image_end", emb[image_end].detach().clone()[None, None], persistent=False)
            seq = (rows // DOWNSAMPLE) * (cols // DOWNSAMPLE) + 2
            with torch.no_grad():
                probe = torch.zeros(1, seq, lm.config.hidden_size)
                cos, sin = lm.rotary_emb(probe, position_ids=torch.arange(seq)[None])
            self.register_buffer("cos", cos[:, None].detach().clone(), persistent=False)
            self.register_buffer("sin", sin[:, None].detach().clone(), persistent=False)

    def vision(self, patches):
        h = self.patch_embedding(patches) + self.vision_pos
        for layer in self.vision_layers:
            h = layer(h, None)
            h = h[0] if isinstance(h, tuple) else h
        h = self.post_layernorm(h)
        b = h.shape[0]
        return self.projector(h.reshape(b, self.rows, self.cols, -1)).reshape(b, -1, self.projector.linear_2.out_features)

    def _conv(self, layer, x):
        c = layer.conv
        bcx = c.in_proj(x).transpose(-1, -2)
        b, cc, xx = bcx.chunk(3, dim=-2)
        y = F.conv1d(b * xx, c.conv.weight, c.conv.bias, padding=c.conv_kernel_size - 1, groups=x.shape[-1])[..., : x.shape[1]]
        return c.out_proj((cc * y).transpose(-1, -2))

    def _attention(self, layer, x):
        a = layer.self_attn
        bsz, t, _ = x.shape
        q = a.q_proj(x).view(bsz, t, -1, self.head_dim)
        k = a.k_proj(x).view(bsz, t, -1, self.head_dim)
        v = a.v_proj(x).view(bsz, t, -1, self.head_dim).transpose(1, 2)
        q = rms(q, a.q_layernorm.weight, a.q_layernorm.variance_epsilon).transpose(1, 2)
        k = rms(k, a.k_layernorm.weight, a.k_layernorm.variance_epsilon).transpose(1, 2)
        q = q * self.cos + rotate_half(q) * self.sin
        k = k * self.cos + rotate_half(k) * self.sin
        rep = q.shape[1] // k.shape[1]
        if rep > 1:
            k, v = k.repeat_interleave(rep, dim=1), v.repeat_interleave(rep, dim=1)
        o = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return a.out_proj(o.transpose(1, 2).reshape(bsz, t, -1))

    def language(self, tokens):
        b = tokens.shape[0]
        h = torch.cat([self.image_start.expand(b, 1, -1), tokens, self.image_end.expand(b, 1, -1)], dim=1)
        exits = {}
        for i, (layer, kind) in enumerate(zip(self.lm_layers, self.layer_types)):
            n = rms(h, layer.operator_norm.weight, layer.operator_norm.variance_epsilon)
            h = h + (self._conv(layer, n) if kind == "conv" else self._attention(layer, n))
            h = h + layer.feed_forward(rms(h, layer.ffn_norm.weight, layer.ffn_norm.variance_epsilon))
            exits[i + 1] = h
        return exits

    def forward(self, patches):
        tokens = self.vision(patches)
        if not self.exit_layers:
            return tokens
        return self.language(tokens)[self.exit_layers]


def load(weights):
    from transformers import AutoProcessor, Lfm2VlForConditionalGeneration
    proc = AutoProcessor.from_pretrained(weights)
    model = Lfm2VlForConditionalGeneration.from_pretrained(weights, dtype=torch.float32).eval()
    tok = proc.tokenizer
    return proc, model, tok.convert_tokens_to_ids("<|image_start|>"), tok.convert_tokens_to_ids("<|image_end|>")


def reference_check(proc, model, start, end, frame):
    """The minimal graph against the transformers path on the same frame."""
    from PIL import Image
    h, w = frame.shape[:2]
    rows, cols = grid(h, w)
    out = {}
    with torch.no_grad():
        inp = proc.image_processor(images=[Image.fromarray(frame)], return_tensors="pt")
        ref = model.model.get_image_features(pixel_values=inp["pixel_values"], spatial_shapes=inp["spatial_shapes"],
                                             pixel_attention_mask=inp["pixel_attention_mask"]).pooler_output[0]
        own_patches = patchify(torch.from_numpy(frame)[None], rows, cols)
        n = int(inp["pixel_attention_mask"].sum())
        out["patch_max_abs_diff"] = float((own_patches[0] - inp["pixel_values"][0, :n]).abs().max())
        fv = FastVision(model, rows, cols, exit_layers=4, image_start=start, image_end=end).eval()
        mine = fv.vision(own_patches)[0]
        out["proj_max_abs_diff"] = float((mine - ref).abs().max())
        out["proj_ref_abs_mean"] = float(ref.abs().mean())
        lm = model.model.language_model
        emb = lm.embed_tokens.weight
        seq = torch.cat([emb[start][None], ref, emb[end][None]])[None]
        hs = lm(inputs_embeds=seq, output_hidden_states=True).hidden_states
        exits = fv.language(ref[None])
        for k in (2, 4):
            out[f"lm{k}_max_abs_diff"] = float((exits[k] - hs[k]).abs().max())
            out[f"lm{k}_ref_abs_mean"] = float(hs[k].abs().mean())
        out["grid"] = [rows, cols]
        out["tokens"] = int(ref.shape[0])
    return out


def bench(model, start, end, frames, configs, threads, repeats):
    rows_out = []
    for cfg in configs:
        h, w = frames.shape[1:3]
        rows, cols = grid(h, w, cfg["min_tokens"], cfg["max_tokens"])
        fv = FastVision(model, rows, cols, vision_layers=cfg["vision_layers"], exit_layers=cfg["exit"],
                        image_start=start, image_end=end).eval()
        params = sum(p.numel() for p in fv.parameters())
        for t in threads:
            torch.set_num_threads(t)
            times, prep = [], []
            with torch.no_grad():
                for i in range(repeats + 3):
                    f = torch.from_numpy(frames[i % len(frames)])[None]
                    t0 = time.perf_counter()
                    p = patchify(f, rows, cols)
                    t1 = time.perf_counter()
                    y = fv(p)
                    t2 = time.perf_counter()
                    if i >= 3:
                        prep.append((t1 - t0) * 1000)
                        times.append((t2 - t1) * 1000)
            q = lambda xs, f: round(float(np.percentile(xs, f)), 1)
            rows_out.append({**cfg, "grid": [rows, cols], "tokens": (rows // 2) * (cols // 2), "threads": t,
                             "params_M": round(params / 1e6, 1), "out": list(y.shape),
                             "preprocess_ms_p50": q(prep, 50), "model_ms_p50": q(times, 50), "model_ms_p95": q(times, 95),
                             "total_ms_p95": q([a + b for a, b in zip(prep, times)], 95)})
            print(json.dumps(rows_out[-1]), flush=True)
    return rows_out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("--frames", help=".npy uint8 (N,H,W,3) frames; default: random 240x256 frames")
    ap.add_argument("--threads", default="1,2,4")
    ap.add_argument("--repeats", type=int, default=20)
    ap.add_argument("--report")
    a = ap.parse_args()
    torch.manual_seed(0)
    proc, model, start, end = load(a.weights)
    frames = np.load(a.frames) if a.frames else (np.random.default_rng(0).random((8, 240, 256, 3)) * 255).astype(np.uint8)
    report = {"type": "gu-lfm-fast-vision", "schema": 1, "host": "x86 CPU, torch fp32 - NOT Android",
              "torch": torch.__version__, "frames": list(frames.shape),
              "loadRssMiB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)}
    report["reference"] = reference_check(proc, model, start, end, frames[0])
    print("reference", json.dumps(report["reference"]), flush=True)
    configs = [{"name": n, "min_tokens": mt, "max_tokens": xt, "vision_layers": vl, "exit": ex} for n, mt, xt, vl, ex in [
        ("proj", 64, 256, 12, 0), ("lm2", 64, 256, 12, 2), ("lm4", 64, 256, 12, 4),
        ("proj-v6", 64, 256, 6, 0), ("proj-t16", 16, 16, 12, 0), ("proj-t16-v6", 16, 16, 6, 0)]]
    report["bench"] = bench(model, start, end, frames, configs, [int(t) for t in a.threads.split(",")], a.repeats)
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
