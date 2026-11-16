"""Track C: the trainable fast controller, and the Track A comparison of LFM variants
through it.

Real-time contract it is trained and evaluated under (the same one the app enforces):
  * decisions at 30 Hz (every 2 emulated frames); the emulator never waits;
  * the decision for frame t is made BEFORE frame t is emulated: its state uses frames
    up to t-1 only (frame t is already rendered with the decision's buttons);
  * FAST PATH, fresh every frame: global scroll (dx, dy) and its residual, scroll-
    compensated motion (8x6), a coarse 16x12 luminance frame - from the 64x48 grid;
  * SLOW PATH, asynchronous: LFM features of a keyframe taken every K frames become
    usable only LATENCY (>= 1) frames later, and some never arrive; the controller is
    told the feature's AGE and whether it is NEW at this step. A stale feature is never
    presented as fresh: slow updates and fast updates are counted apart;
  * own action history (previous applied mask, how long it was held) and a GRU memory.

Heads:
  action    goal-conditioned button mask: given the state and the consequence wanted
            over the next steps (here the consequence that really followed), which
            buttons produce it - trained by inverse dynamics on Frame(t) -> Action(t)
            -> Frame(t+1..) from real play, no teacher, no oracle;
  hold      how many steps to hold that mask (1, 2, 4, 8, 16);
  consequence  the next fast features given the state AND the action (a forward model:
            what pressing these buttons will do);
  value     trained ONLY on verified outcomes; a recording without verified reward
            leaves it untrained and the report says so (UNKNOWN is not 0).

usage: python -I fast_controller.py RECORD_PREFIX ... --report out.json
"""
import argparse, json, os, time, zlib

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

STEP = 2                     # frames per decision (30 Hz at 60 FPS)
HOLDS = (1, 2, 4, 8, 16)     # hold choices, in steps
FUTURE = 2                   # steps of observed consequence the action head is given
BITS = {"A": 0, "B": 1, "Up": 4, "Down": 5, "Left": 6, "Right": 7}


# ---------------------------------------------------------------- fast path (per frame)
def fast_features(lum):
    """(N, 48, 64) uint8 -> (N, 243) float32: dx, dy, residual, 8x6 compensated motion, 16x12 coarse.
    Row i describes frame i (its motion is frame i-1 -> frame i)."""
    x = lum.astype(np.float32) / 255.0
    n = len(x)
    out = np.zeros((n, 3 + 48 + 192), np.float32)
    m = 3
    prev, cur = x[:-1], x[1:]
    best = np.full(n - 1, np.inf, np.float32)
    bdx = np.zeros(n - 1, np.int8)
    bdy = np.zeros(n - 1, np.int8)
    core = cur[:, m:-m, m:-m]
    for dy in range(-m, m + 1):
        for dx in range(-m, m + 1):
            e = np.abs(core - prev[:, m + dy:48 - m + dy, m + dx:64 - m + dx]).mean(axis=(1, 2))
            better = e < best
            best[better], bdx[better], bdy[better] = e[better], dx, dy
    out[1:, 0], out[1:, 1], out[1:, 2] = bdx / m, bdy / m, best * 10
    for i in range(1, n):
        dx, dy = int(bdx[i - 1]), int(bdy[i - 1])
        r = np.abs(core[i - 1] - prev[i - 1, m + dy:48 - m + dy, m + dx:64 - m + dx])
        out[i, 3:51] = r[:, :56].reshape(6, 7, 8, 7).mean(axis=(1, 3)).ravel() * 10  # 42x58 core -> 6x8 cells
    out[:, 51:] = x.reshape(n, 12, 4, 16, 4).mean(axis=(2, 4)).reshape(n, 192)
    return out


def load_record(prefix, variant):
    meta = json.load(open(prefix + ".meta.json"))
    actions = np.fromfile(prefix + ".actions.u16", np.uint16).astype(np.int64)
    phase = np.fromfile(prefix + ".phase.u8", np.uint8)
    lum = np.frombuffer(zlib.decompress(open(prefix + ".lum.u8.z", "rb").read()), np.uint8).reshape(-1, 48, 64)
    rec = {"meta": meta, "actions": actions, "phase": phase, "fast": fast_features(lum)}
    if variant != "none":
        f = np.load(prefix + ".features.npz")
        rec["visual"] = np.concatenate([f[variant + "_grid"].reshape(len(f[variant + "_grid"]), -1),
                                        f[variant + "_summary"]], axis=1).astype(np.float16)
    return rec


def steps_of(rec, latency, every, use_motion, use_visual, drop=0.0, seed=0):
    """per-decision tensors under the real-time contract; `drop` loses that fraction of slow
    updates (a keyframe whose features never arrive), so the controller keeps the older one"""
    n = len(rec["actions"]) // STEP
    # fast[s] = features of frames 2s-2, 2s-1 (known when deciding frame 2s); fast[s+1..] are
    # then the frames produced under decision s - its consequence (the action head's
    # "wanted" input and the forward model's target).
    shifted = np.concatenate([np.zeros((STEP, rec["fast"].shape[1]), np.float32), rec["fast"]])[: n * STEP]
    fast = shifted.reshape(n, -1)
    fast_in = fast
    if not use_motion:  # ablation: no fresh motion between slow updates - the STATE input is frozen at the
        # last usable keyframe (scroll and motion zeroed); targets and the wanted consequence stay true
        idx = np.arange(n * STEP) - STEP
        avail = np.clip(((idx - latency) // every) * every, 0, None)
        frozen = rec["fast"][avail].copy()
        frozen[:, :51] = 0
        frozen[idx < latency] = 0
        fast_in = frozen.reshape(n, -1)
    acts = rec["actions"][: n * STEP].reshape(n, STEP)[:, 0]          # the mask applied at this decision
    bits = ((acts[:, None] >> np.arange(8)) & 1).astype(np.float32)
    prev_bits = np.concatenate([np.zeros((1, 8), np.float32), bits[:-1]])
    run_len = np.zeros(n, np.float32)  # how long action i has been held, as of step i
    for i in range(1, n):
        run_len[i] = run_len[i - 1] + 1 if acts[i] == acts[i - 1] else 0
    held = np.concatenate([[0], run_len[:-1]]).astype(np.float32)  # known at decision i: the PREVIOUS action's run
    t = np.arange(n) * STEP
    k = np.where(t - latency >= 0, (t - latency) // every, -1)       # newest keyframe usable at frame t
    if drop > 0:
        kept = np.random.default_rng(seed).random(len(rec["actions"]) // every + 2) >= drop
        kept[0] = True
        last = np.maximum.accumulate(np.where(kept, np.arange(len(kept)), 0))
        k = np.where(k >= 0, last[np.clip(k, 0, None)], -1)
    age = np.where(k >= 0, t - k * every, 999).astype(np.float32)
    new = np.concatenate([[k[0] >= 0], k[1:] != k[:-1]]).astype(np.float32)
    play = (rec["phase"][: n * STEP].reshape(n, STEP)[:, 0] == 1) & ((acts & 8) == 0)
    out = {"fast": fast, "fast_in": fast_in, "bits": bits, "prev": prev_bits, "held": np.minimum(held, 32) / 32,
           "age": np.minimum(age, 60) / 60, "new": new, "valid": play, "k": k,
           "slowUpdates": int(new.sum()), "fastUpdates": int(n)}
    if use_visual:
        out["visual"] = rec["visual"]
    return out


class FastController(nn.Module):
    def __init__(self, fast_dim, visual_dim=0, hidden=256):
        super().__init__()
        self.visual_dim = visual_dim
        self.fast = nn.Sequential(nn.Linear(fast_dim, 256), nn.GELU())
        if visual_dim:
            self.visual = nn.Sequential(nn.LayerNorm(visual_dim), nn.Linear(visual_dim, 256), nn.GELU())
        self.inp = nn.Linear(256 + (256 if visual_dim else 0) + 8 + 3, hidden)
        self.gru = nn.GRUCell(hidden, hidden)
        self.action = nn.Sequential(nn.Linear(hidden + 256, 256), nn.GELU(), nn.Linear(256, 8))
        self.future = nn.Sequential(nn.Linear(FUTURE * fast_dim, 256), nn.GELU())
        self.hold = nn.Linear(hidden, len(HOLDS))
        self.value = nn.Linear(hidden, 1)
        self.consequence = nn.Sequential(nn.Linear(hidden + 8, 256), nn.GELU(), nn.Linear(256, fast_dim))

    def step(self, h, fast, prev, held, age, new, visual=None):
        x = [self.fast(fast)]
        if self.visual_dim:  # a missing slow feature (age saturated) contributes nothing
            x.append(self.visual(visual) * (age < 1).float().unsqueeze(-1))
        x += [prev, held.unsqueeze(-1), age.unsqueeze(-1), new.unsqueeze(-1)]
        return self.gru(F.gelu(self.inp(torch.cat(x, -1))), h)

    def act(self, h, wanted):
        """goal-conditioned button logits: state + the consequence wanted over the next FUTURE steps"""
        return self.action(torch.cat([h, self.future(wanted)], -1))


def collate(xs, seq, use_visual):
    def stack(key, extra=0):
        return torch.from_numpy(np.stack([d[key][s:s + seq + extra] for d, s in xs]).astype(np.float32))
    b = {k: stack(k) for k in ("bits", "prev", "held", "age", "new")}
    b["valid"] = torch.from_numpy(np.stack([d["valid"][s:s + seq] for d, s in xs]))
    b["fast"] = stack("fast", FUTURE + 1)        # true features: wanted consequence + forward-model target
    b["fast_in"] = stack("fast_in", FUTURE + 1)  # what the controller state is allowed to see
    if use_visual:
        vis = []
        for d, s in xs:
            k = d["k"][s:s + seq]
            v = d["visual"][np.clip(k, 0, len(d["visual"]) - 1)].astype(np.float32)
            v[k < 0] = 0
            vis.append(v)
        b["visual"] = torch.from_numpy(np.stack(vis))
    return b


def batches(data, seq, size, rng, use_visual):
    keys = list(data)
    while True:
        xs = []
        for _ in range(size):
            d = data[keys[rng.integers(len(keys))]]
            xs.append((d, rng.integers(0, len(d["bits"]) - seq - FUTURE - 1)))
        yield collate(xs, seq, use_visual)


def run(model, b, seq, actions=None):
    bs = b["bits"].shape[0]
    h = torch.zeros(bs, model.gru.hidden_size)
    acts = b["bits"] if actions is None else actions
    logits, cons = [], []
    for t in range(seq):
        h = model.step(h, b["fast_in"][:, t], b["prev"][:, t], b["held"][:, t], b["age"][:, t], b["new"][:, t],
                       b["visual"][:, t] if "visual" in b else None)
        wanted = b["fast"][:, t + 1:t + 1 + FUTURE].reshape(bs, -1)
        logits.append(model.act(h, wanted))
        cons.append(model.consequence(torch.cat([h, acts[:, t]], -1)))
    return torch.stack(logits, 1), torch.stack(cons, 1)


def loss_of(model, b, seq):
    logits, cons = run(model, b, seq)
    v = b["valid"].float()
    sel = list(BITS.values())
    bce = F.binary_cross_entropy_with_logits(logits[..., sel], b["bits"][..., sel], reduction="none").mean(-1)
    mse = ((cons - b["fast"][:, 1:seq + 1]) ** 2).mean(-1)
    return (bce * v).sum() / v.sum().clamp(min=1) + 0.5 * (mse * v).sum() / v.sum().clamp(min=1)


def evaluate(model, data, seq, use_visual):
    """balanced accuracy per button group on held-out decisions + consequence error with the true vs a shuffled action"""
    model.eval()
    groups = {"horizontal": (6, 7), "vertical": (4, 5), "A": (0,), "B": (1,)}
    pred, true, valid, err_true, err_shuf = [], [], [], [], []
    g = torch.Generator().manual_seed(0)
    with torch.no_grad():
        for d in data.values():
            for s in range(0, len(d["bits"]) - seq - FUTURE - 1, seq):
                b = collate([(d, s)], seq, use_visual)
                logits, cons = run(model, b, seq)
                _, cons_shuf = run(model, b, seq, actions=b["bits"][:, torch.randperm(seq, generator=g)])
                target = b["fast"][0, 1:seq + 1]
                pred.append(torch.sigmoid(logits[0]).numpy())
                true.append(b["bits"][0].numpy())
                valid.append(b["valid"][0].numpy())
                err_true.append(((cons[0] - target) ** 2).mean(-1).numpy())
                err_shuf.append(((cons_shuf[0] - target) ** 2).mean(-1).numpy())
    p, y, v = np.concatenate(pred), np.concatenate(true), np.concatenate(valid).astype(bool)
    p, y = p[v], y[v]
    out = {}
    for name, bits in groups.items():
        if len(bits) == 1:
            yy, pp = y[:, bits[0]], p[:, bits[0]] > 0.5
            accs = [((pp == c) & (yy == c)).sum() / max((yy == c).sum(), 1) for c in (0, 1)]
        else:
            ycls = np.where(y[:, bits[0]] > 0, 1, np.where(y[:, bits[1]] > 0, 2, 0))
            pcls = np.where((p[:, bits[0]] > 0.5) & (p[:, bits[0]] >= p[:, bits[1]]), 1, np.where(p[:, bits[1]] > 0.5, 2, 0))
            accs = [((pcls == c) & (ycls == c)).sum() / max((ycls == c).sum(), 1) for c in (0, 1, 2)]
        out[name] = round(float(np.mean(accs)), 4)
    out["meanBalancedAccuracy"] = round(float(np.mean([out[k] for k in groups])), 4)
    out["chance"] = round(float(np.mean([1 / 3, 1 / 3, 1 / 2, 1 / 2])), 4)
    et, es = np.concatenate(err_true)[v], np.concatenate(err_shuf)[v]
    out["consequenceMse"] = round(float(et.mean()), 5)
    out["consequenceMseShuffledAction"] = round(float(es.mean()), 5)
    out["actionInformationGain"] = round(float(1 - et.mean() / max(es.mean(), 1e-9)), 4)
    out["decisions"] = int(v.sum())
    model.train()
    return out


def step_latency(model, fast_dim, visual_dim, threads=1, n=300):
    torch.set_num_threads(threads)
    model.eval()
    h = torch.zeros(1, model.gru.hidden_size)
    args = [torch.zeros(1, fast_dim), torch.zeros(1, 8), torch.zeros(1), torch.zeros(1), torch.zeros(1)]
    vis = torch.zeros(1, visual_dim) if visual_dim else None
    wanted = torch.zeros(1, FUTURE * fast_dim)
    times = []
    with torch.no_grad():
        for i in range(n + 20):
            t = time.perf_counter()
            h = model.step(h, *args, visual=vis)
            model.act(h, wanted)
            model.hold(h)
            if i >= 20:
                times.append((time.perf_counter() - t) * 1000)
    model.train()
    return {"threads": threads, "p50": round(float(np.percentile(times, 50)), 3), "p95": round(float(np.percentile(times, 95)), 3),
            "params": sum(p.numel() for p in model.parameters())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("records", nargs="+")
    ap.add_argument("--test-seed", default="s2", help="records whose name ends with this are held out (same games, other play)")
    ap.add_argument("--test-game", default=None, help="records starting with this are held out (unseen game)")
    ap.add_argument("--variants", default="none,proj,lm2,lm4")
    ap.add_argument("--latency", type=int, default=8, help="frames from keyframe capture to its features being usable")
    ap.add_argument("--every", type=int, default=8)
    ap.add_argument("--iters", type=int, default=1500)
    ap.add_argument("--seq", type=int, default=32)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--no-motion-too", action="store_true")
    ap.add_argument("--report")
    a = ap.parse_args()
    assert a.latency >= 1, "a keyframe of frame t cannot be used for the decision that frame t was rendered with"
    torch.manual_seed(0)
    report = {"type": "gu-fast-controller-variants", "schema": 1, "host": "x86 CPU (training + step latency) - NOT Android",
              "contract": {"decisionHz": 60 // STEP, "keyframeEvery": a.every, "slowLatencyFrames": a.latency,
                           "trainingDropOfSlowUpdates": 0.2},
              "valueHead": "UNTRAINED: these recordings carry no verified reward; no number is invented for it",
              "runs": []}
    for variant in a.variants.split(","):
        for use_motion in ([True, False] if a.no_motion_too else [True]):
            torch.set_num_threads(a.threads)
            use_visual = variant != "none"
            raw = {os.path.basename(p): load_record(p, variant) for p in a.records}
            held = [k for k in raw if k.endswith(a.test_seed) or (a.test_game and k.startswith(a.test_game))]
            train = {k: steps_of(r, a.latency, a.every, use_motion, use_visual, drop=0.2, seed=i)
                     for i, (k, r) in enumerate(raw.items()) if k not in held}
            test = {k: steps_of(raw[k], a.latency, a.every, use_motion, use_visual) for k in held}
            stress = {"latency24": {k: steps_of(raw[k], 24, a.every, use_motion, use_visual) for k in held},
                      "missing50": {k: steps_of(raw[k], a.latency, a.every, use_motion, use_visual, drop=0.5, seed=99) for k in held}}
            fd = next(iter(train.values()))["fast"].shape[1]
            vd = next(iter(train.values()))["visual"].shape[1] if use_visual else 0
            model = FastController(fd, vd)
            opt = torch.optim.AdamW(model.parameters(), 1e-3, weight_decay=1e-4)
            gen = batches(train, a.seq, 32, np.random.default_rng(0), use_visual)
            t0 = time.time()
            for _ in range(a.iters):
                loss = loss_of(model, next(gen), a.seq)
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
            res = {"variant": variant, "freshMotion": use_motion, "train": sorted(train), "test": sorted(test),
                   "iters": a.iters, "trainSeconds": round(time.time() - t0), "finalLoss": round(float(loss.detach()), 4),
                   "updatesPerHeldOutRecord": {k: {"slow": v["slowUpdates"], "fast": v["fastUpdates"]} for k, v in test.items()},
                   "heldOut": evaluate(model, test, a.seq, use_visual),
                   "heldOutStress": {name: evaluate(model, d, a.seq, use_visual) for name, d in stress.items()},
                   "trainSet": evaluate(model, train, a.seq, use_visual),
                   "stepLatencyMs": step_latency(model, fd, vd)}
            report["runs"].append(res)
            print(json.dumps({"variant": variant, "freshMotion": use_motion, "heldOut": res["heldOut"]["meanBalancedAccuracy"],
                              "gain": res["heldOut"]["actionInformationGain"],
                              "stress": {n: s["meanBalancedAccuracy"] for n, s in res["heldOutStress"].items()},
                              "train": res["trainSet"]["meanBalancedAccuracy"], "seconds": res["trainSeconds"],
                              "stepMs": res["stepLatencyMs"]["p95"]}), flush=True)
            if a.report:
                json.dump(report, open(a.report, "w"), indent=1)


if __name__ == "__main__":
    main()
