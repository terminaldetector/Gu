#!/usr/bin/env python3
"""Male CNS routing atlas (directive 2026-11-13, section 3.1) - offline, host-side.

From the FULL production graph (male-cns.fly.gz, unchanged W0) and the official
body annotations, measure where activity injected into visual sensory neurons
can go: per synaptic hop (1..6), the signed effective influence on every
superclass, and the descending / motor neurons it reaches most. Nothing is cut
from the graph and no neuron is named after a game action.

Effective influence (the connectome_interpreter idea, signed): A[i,j] = w_ij /
sum_k |w_kj| - the share of j's synaptic input that comes from i, carrying the
transmitter sign the converter assigned. Influence after k hops from a source
set S is x_k = x_{k-1} A, x_0 = 1/|S| on S. Neurons whose transmitter is
missing or unclear keep the converter's sign; the atlas counts how much of the
reached influence passes through them, it does not invent confidence.

Output: a compact JSON with ID lists and per-hop statistics, bound to the graph
and annotation SHA-256 - no RAM, no ROM, nothing game-specific.

usage: male_cns_routing.py GRAPH.fly.gz ANNOTATIONS.feather OUT.json
"""
import gzip, hashlib, json, sys
import numpy as np
import pyarrow.feather as feather

HOPS = 6


def read_graph(path):
    raw = gzip.open(path, 'rb').read() if path.endswith('.gz') else open(path, 'rb').read()
    sha = hashlib.sha256(raw).hexdigest()
    magic, n, m = np.frombuffer(raw[:12], dtype='>i4')
    if magic != 0x464C5931:
        raise SystemExit('not a FLY1 graph')
    o = 12
    ids = np.frombuffer(raw[o:o + 8 * n], dtype='>i8').astype(np.int64); o += 8 * n
    off = np.frombuffer(raw[o:o + 4 * (n + 1)], dtype='>i4').astype(np.int64); o += 4 * (n + 1)
    tar = np.frombuffer(raw[o:o + 4 * m], dtype='>i4').astype(np.int64); o += 4 * m
    wei = np.frombuffer(raw[o:o + 4 * m], dtype='>f4').astype(np.float64); o += 4 * m
    if o != len(raw):
        raise SystemExit('trailing data')
    src = np.repeat(np.arange(n, dtype=np.int64), np.diff(off))
    return sha, ids, src, tar, wei


def main():
    graph_path, ann_path, out_path = sys.argv[1:4]
    raw_sha, ids, src, tar, wei = read_graph(graph_path)
    n = len(ids)
    ann_bytes = open(ann_path, 'rb').read()
    ann_sha = hashlib.sha256(ann_bytes).hexdigest()
    t = feather.read_table(ann_path, columns=['bodyId', 'superclass', 'class', 'type', 'somaSide',
                                               'assignedOlHex1', 'assignedOlHex2'])
    body = np.array(t.column('bodyId').to_pylist(), dtype=np.int64)
    rows = {int(b): i for i, b in enumerate(body)}
    cols = {c: t.column(c).to_pylist() for c in ['superclass', 'class', 'type', 'somaSide', 'assignedOlHex1', 'assignedOlHex2']}
    hex1 = [cols['assignedOlHex1'][rows[int(b)]] if int(b) in rows else None for b in ids]
    hex2 = [cols['assignedOlHex2'][rows[int(b)]] if int(b) in rows else None for b in ids]
    sc = [cols['superclass'][rows[int(b)]] if int(b) in rows else None for b in ids]
    typ = [cols['type'][rows[int(b)]] if int(b) in rows else None for b in ids]
    side = [cols['somaSide'][rows[int(b)]] if int(b) in rows else None for b in ids]
    sc_arr = np.array([s or 'unannotated' for s in sc])
    # input fraction normalisation: share of each target's total |input|
    total_in = np.bincount(tar, weights=np.abs(wei), minlength=n)
    a = wei / np.where(total_in[tar] > 0, total_in[tar], 1.0)

    def propagate(start, hops=HOPS):
        x = start.copy(); out = []
        for _ in range(hops):
            x = np.bincount(tar, weights=x[src] * a, minlength=n)
            out.append(x)
        return out

    def summary(per_hop, members=None):
        res = []
        for k, x in enumerate(per_hop, 1):
            by = {}
            for name in ['ol_sensory', 'ol_intrinsic', 'visual_projection', 'cb_intrinsic', 'descending_neuron',
                         'ascending_neuron', 'vnc_intrinsic', 'vnc_motor', 'cb_motor']:
                mask = sc_arr == name
                by[name] = {'positive': float(x[mask & (x > 0)].sum()), 'negative': float(x[mask & (x < 0)].sum()),
                            'reached': int((np.abs(x[mask]) > 1e-9).sum()), 'of': int(mask.sum())}
            res.append({'hop': k, 'total': float(np.abs(x).sum()), 'bySuperclass': by})
        return res

    def ranked(per_hop, cls, limit, hops=range(1, HOPS + 1)):
        mask = sc_arr == cls
        score = sum(np.abs(per_hop[k - 1]) for k in hops)
        signed = sum(per_hop[k - 1] for k in hops)
        order = [i for i in np.argsort(-score) if mask[i] and score[i] > 0][:limit]
        first = {}
        for i in order:
            for k in range(1, HOPS + 1):
                if abs(per_hop[k - 1][i]) > 1e-12:
                    first[i] = k; break
        return [{'id': str(int(ids[i])), 'type': typ[i], 'side': side[i], 'influence': float(score[i]),
                 'signed': float(signed[i]), 'firstHop': first.get(i)} for i in order]

    # visual sources: the photoreceptors (ol_sensory) - all of them, and the
    # manifest's 16 default inputs for comparison
    vis = np.where(sc_arr == 'ol_sensory')[0]
    start = np.zeros(n); start[vis] = 1.0 / len(vis)
    from_vision = propagate(start)
    # the 16 default ports
    man = json.load(open(graph_path.replace('.gz', '').replace('.fly', '') + '.fly.json'))
    port_idx = np.searchsorted(ids, np.array([int(v) for v in man['default_inputs']], dtype=np.int64))
    s16 = np.zeros(n); s16[port_idx] = 1.0 / len(port_idx)
    from_ports = propagate(s16)
    out_idx = np.searchsorted(ids, np.array([int(v) for v in man['default_outputs']], dtype=np.int64))
    # descending neurons -> motor: which DNs drive leg/body motor neurons most
    dn = np.where(sc_arr == 'descending_neuron')[0]
    sdn = np.zeros(n); sdn[dn] = 1.0 / len(dn)
    from_dn = propagate(sdn, 4)
    atlas = {
        'type': 'male-cns-routing', 'version': 1,
        'graph': {'file_sha256': raw_sha, 'neurons': int(n), 'edges': int(len(tar))},
        'annotations': {'file': ann_path.split('/')[-1], 'sha256': ann_sha},
        'method': 'signed input-fraction influence x_k = x_{k-1} A, A_ij = w_ij / sum_k |w_kj|, hops 1..%d; '
                  'the full graph, nothing cut; no neuron named after a game action' % HOPS,
        'superclassCounts': {k: int(v) for k, v in zip(*np.unique(sc_arr, return_counts=True))},
        'fromAllPhotoreceptors': {'sources': int(len(vis)), 'perHop': summary(from_vision)},
        'fromManifestPorts': {'sources': 16, 'perHop': summary(from_ports),
                              'manifestOutputsReached': [{'id': str(int(ids[i])), 'type': typ[i],
                                                          'influenceByHop': [float(from_ports[k][i]) for k in range(HOPS)]}
                                                         for i in out_idx]},
        'descendingFromVision': ranked(from_vision, 'descending_neuron', 64),
        'visualProjectionFromVision': ranked(from_vision, 'visual_projection', 32),
        'motorFromDescending': ranked(from_dn, 'vnc_motor', 64, hops=range(1, 5)),
        'motorFromVision': ranked(from_vision, 'vnc_motor', 32),
        # full ID sets the sensor/readout binding is built from: photoreceptors
        # with their optic-lobe column (hex) for a retinotopic eye, every
        # descending and motor neuron
        'sets': {
            # photoreceptors are listed by count only: injecting into them does not
            # spike anything downstream in the spiking engine (histaminergic, graded)
            'photoreceptorCount': int(len(vis)),
            'descending': [str(int(ids[i])) for i in dn],
            'motor': [str(int(ids[i])) for i in np.where(sc_arr == 'vnc_motor')[0]],
            # visual projection neurons (optic lobe -> central brain) with type and
            # side: where a spiking model can take visual features, since the
            # photoreceptor -> lamina step is histaminergic (inhibitory, graded)
            'visualProjection': [[str(int(ids[i])), typ[i], side[i]] for i in np.where(sc_arr == 'visual_projection')[0]
                                 if typ[i] and (typ[i].startswith('LC') or typ[i].startswith('LPLC'))],
        },
    }
    json.dump(atlas, open(out_path, 'w'), indent=1)
    print('atlas written:', out_path)
    for k, h in enumerate(atlas['fromAllPhotoreceptors']['perHop'], 1):
        b = h['bySuperclass']
        print('hop %d: DN reached %d/%d (+%.2e/%.2e)  motor reached %d/%d (+%.2e/%.2e)' % (
            k, b['descending_neuron']['reached'], b['descending_neuron']['of'], b['descending_neuron']['positive'],
            b['descending_neuron']['negative'], b['vnc_motor']['reached'], b['vnc_motor']['of'],
            b['vnc_motor']['positive'], b['vnc_motor']['negative']))
    print('manifest outputs (MNad...) influence from the 16 ports, by hop:',
          [max(abs(v) for v in o['influenceByHop']) for o in atlas['fromManifestPorts']['manifestOutputsReached']][:12])
    print('top DNs from vision:', [(d['type'], d['firstHop'], '%.1e' % d['influence']) for d in atlas['descendingFromVision'][:8]])
    print('top motor from DNs:', [(d['type'], d['firstHop']) for d in atlas['motorFromDescending'][:8]])


if __name__ == '__main__':
    main()
