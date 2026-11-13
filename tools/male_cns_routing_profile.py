#!/usr/bin/env python3
"""Male CNS routing PROFILE, stage 1 of 2 (directive 2026-11-13, M2.1).

One versioned sensorimotor profile that the Android app and the headless bridge
both read: 16 image cells -> 256 visual projection neurons -> (full Male CNS) ->
12 descending outputs. This stage builds the 16 input groups RETINOTOPICALLY:

* every LC/LPLC visual projection neuron gets a position in its eye's visual
  field - the synapse-weighted mean optic-lobe column (assignedOlHex1/2) of its
  columnar input partners - and the eye those partners belong to;
* each eye's columns are put on their two principal axes (a fixed sign
  convention, written into the profile); the image is split into 4 x 4 cells,
  the left two columns of cells to the left eye, the right two to the right eye;
  each cell's patch of the visual field gets the 16 projection neurons closest
  to its centre, types taken in turn so a patch carries several feature types.

Neighbouring image cells therefore drive neighbouring parts of the visual field:
spatial structure is kept at 4 x 4. Orientation within an eye (which principal
direction is front or up) is a convention, not a claim - the readout is learned.

Stage 2 (tools/MaleCnsRoutingProfile.java) stimulates each group in the
production engine and picks the 12 outputs from the measured responses.

usage: male_cns_routing_profile.py GRAPH.fly.gz ANNOTATIONS.feather OUT_STAGE1.json
"""
import gzip, hashlib, json, sys
import numpy as np
import pyarrow.feather as feather

PER_GROUP = 16


def read_graph(path):
    raw = gzip.open(path, 'rb').read() if path.endswith('.gz') else open(path, 'rb').read()
    magic, n, m = np.frombuffer(raw[:12], dtype='>i4')
    assert magic == 0x464C5931
    o = 12
    ids = np.frombuffer(raw[o:o + 8 * n], dtype='>i8').astype(np.int64); o += 8 * n
    off = np.frombuffer(raw[o:o + 4 * (n + 1)], dtype='>i4').astype(np.int64); o += 4 * (n + 1)
    tar = np.frombuffer(raw[o:o + 4 * m], dtype='>i4').astype(np.int64); o += 4 * m
    wei = np.frombuffer(raw[o:o + 4 * m], dtype='>f4').astype(np.float64)
    src = np.repeat(np.arange(n, dtype=np.int64), np.diff(off))
    return ids, src, tar, wei


def main():
    graph_path, ann_path, out_path = sys.argv[1:4]
    ids, src, tar, wei = read_graph(graph_path)
    n = len(ids)
    ann_sha = hashlib.sha256(open(ann_path, 'rb').read()).hexdigest()
    t = feather.read_table(ann_path, columns=['bodyId', 'superclass', 'type', 'somaSide', 'assignedOlHex1', 'assignedOlHex2'])
    row = {int(b): i for i, b in enumerate(t.column('bodyId').to_pylist())}
    col = {c: t.column(c).to_pylist() for c in ['superclass', 'type', 'somaSide', 'assignedOlHex1', 'assignedOlHex2']}
    get = lambda c, i: col[c][row[int(ids[i])]] if int(ids[i]) in row else None
    sc = np.array([get('superclass', i) or '' for i in range(n)])
    typ = [get('type', i) for i in range(n)]
    side = np.array([get('somaSide', i) or '' for i in range(n)])
    h1 = np.array([get('assignedOlHex1', i) if get('assignedOlHex1', i) is not None else np.nan for i in range(n)], dtype=float)
    h2 = np.array([get('assignedOlHex2', i) if get('assignedOlHex2', i) is not None else np.nan for i in range(n)], dtype=float)
    columnar = ~np.isnan(h1) & ~np.isnan(h2)
    vpn = np.array([sc[i] == 'visual_projection' and typ[i] is not None and (typ[i].startswith('LC') or typ[i].startswith('LPLC'))
                    for i in range(n)])
    # weighted mean column of columnar inputs, per eye
    e = columnar[src] & vpn[tar]
    w = np.abs(wei[e]); s = src[e]; d = tar[e]
    pos = {}
    for eye in ('L', 'R'):
        k = side[s] == eye
        ww = np.bincount(d[k], weights=w[k], minlength=n)
        x = np.bincount(d[k], weights=w[k] * h1[s[k]], minlength=n)
        y = np.bincount(d[k], weights=w[k] * h2[s[k]], minlength=n)
        pos[eye] = (ww, np.divide(x, ww, out=np.zeros(n), where=ww > 0), np.divide(y, ww, out=np.zeros(n), where=ww > 0))
    placed = []
    for i in np.where(vpn)[0]:
        wl, wr = pos['L'][0][i], pos['R'][0][i]
        if wl + wr < 5:  # too little columnar input to place it
            continue
        eye = 'L' if wl >= wr else 'R'
        purity = max(wl, wr) / (wl + wr)
        if purity < 0.8:  # binocular / mixed: not a clean retinotopic site
            continue
        placed.append((int(i), eye, float(pos[eye][1][i]), float(pos[eye][2][i]), typ[i]))
    # each eye's principal axes, from that eye's own columns
    frames = {}
    for eye in ('L', 'R'):
        k = columnar & (side == eye)
        pts = np.stack([h1[k], h2[k]], 1)
        mu = pts.mean(0); cov = np.cov((pts - mu).T); vals, vecs = np.linalg.eigh(cov)
        a1, a2 = vecs[:, 1], vecs[:, 0]  # a1 = longer axis
        # sign convention: each axis points towards increasing assignedOlHex1 (then hex2)
        if a1[0] < 0 or (a1[0] == 0 and a1[1] < 0): a1 = -a1
        if a2[0] < 0 or (a2[0] == 0 and a2[1] < 0): a2 = -a2
        proj = (pts - mu) @ np.stack([a1, a2], 1)
        frames[eye] = {'mean': mu.tolist(), 'axis1': a1.tolist(), 'axis2': a2.tolist(),
                       'range1': [float(np.percentile(proj[:, 0], 2)), float(np.percentile(proj[:, 0], 98))],
                       'range2': [float(np.percentile(proj[:, 1], 2)), float(np.percentile(proj[:, 1], 98))]}
    def field(eye, hx, hy):
        f = frames[eye]; v = np.array([hx, hy]) - np.array(f['mean'])
        p1 = v @ np.array(f['axis1']); p2 = v @ np.array(f['axis2'])
        u = (p1 - f['range1'][0]) / (f['range1'][1] - f['range1'][0])
        z = (p2 - f['range2'][0]) / (f['range2'][1] - f['range2'][0])
        return float(np.clip(u, 0, 1)), float(np.clip(z, 0, 1))
    groups = []
    used = set()
    for c in range(16):
        r, x = divmod(c, 4)
        eye = 'L' if x < 2 else 'R'
        # cell centre in the eye's normalised field: azimuth bin (2 per eye), elevation bin (4)
        cu = ((x % 2) + 0.5) / 2.0; cz = (r + 0.5) / 4.0
        cand = []
        for (i, e2, hx, hy, ty) in placed:
            if e2 != eye or i in used: continue
            u, z = field(eye, hx, hy)
            cand.append(((u - cu) ** 2 + (z - cz) ** 2, ty, i, u, z))
        cand.sort()
        # types in turn among the nearest candidates
        by_type = {}
        for dist, ty, i, u, z in cand[:200]:
            by_type.setdefault(ty, []).append((dist, i, u, z))
        chosen = []
        while len(chosen) < PER_GROUP and any(by_type.values()):
            for ty in sorted(by_type, key=lambda t: by_type[t][0][0] if by_type[t] else 9):
                if by_type[ty] and len(chosen) < PER_GROUP:
                    chosen.append((ty,) + by_type[ty].pop(0))
        if len(chosen) < PER_GROUP:
            raise SystemExit('patch %d has only %d projection neurons' % (c, len(chosen)))
        for ch in chosen: used.add(ch[2])
        groups.append({'cell': c, 'row': r, 'col': x, 'eye': eye, 'centre': [cu, cz],
                       'neurons': [str(int(ids[ch[2]])) for ch in chosen],
                       'types': [ch[0] for ch in chosen],
                       'meanDistance': float(np.mean([ch[1] for ch in chosen]) ** 0.5)})
    out = {'type': 'male-cns-routing-profile-stage1', 'version': 1,
           'annotations_sha256': ann_sha, 'method': __doc__.strip().split('\n')[2:14],
           'placedProjectionNeurons': len(placed), 'eyes': frames, 'groups': groups}
    json.dump(out, open(out_path, 'w'), indent=1)
    print('placed', len(placed), 'LC/LPLC neurons;', 'groups:')
    for g in groups:
        print(' cell %2d eye %s centre (%.2f,%.2f) mean dist %.3f types %s' % (
            g['cell'], g['eye'], g['centre'][0], g['centre'][1], g['meanDistance'], sorted(set(g['types']))[:6]))


if __name__ == '__main__':
    main()
