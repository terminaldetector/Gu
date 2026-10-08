#!/usr/bin/env python3
"""Convert the official Male CNS neuronal graph to deterministic signed FLY1.

IPC record batches are streamed, while the edge arrays live in temporary disk
memmaps. No pandas DataFrame or whole-file sort of the 25M edges is constructed.
The output is the Traced x Traced graph, including isolated Traced neurons.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import struct
import tempfile

import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc


SIGN = {"acetylcholine": 1, "gaba": -1, "glutamate": -1, "histamine": -1}
SCALE = 0.275
MAX_NEURONS = 1_000_000
MAX_EDGES = 100_000_000


def batches(path, columns):
    """Feather v2 is an Arrow IPC file; reject schema drift, stream each batch."""
    # OSFile avoids pinning the 508 MB source mmap's pages in process RSS.
    # read_all()/read_table() would defeat this record-batch memory bound.
    with pa.OSFile(str(path), "r") as source:
        # Avoid per-worker allocator arenas retaining hundreds of old string
        # decompression buffers although only one record batch is live.
        reader = ipc.open_file(source, options=ipc.IpcReadOptions(use_threads=False))
        indices = [reader.schema.get_field_index(name) for name in columns]
        if any(index < 0 for index in indices):
            raise ValueError("Missing columns in " + str(path) + ": " + str(columns))
        for index in range(reader.num_record_batches):
            batch = reader.get_batch(index)
            yield {name: batch.column(column) for name, column in zip(columns, indices)}
            if index % 16 == 15:
                pa.default_memory_pool().release_unused()


def integer_array(column, name):
    if column.null_count or not pa.types.is_integer(column.type):
        raise ValueError("Expected non-null integer " + name)
    return column.to_numpy(zero_copy_only=False).astype(np.int64, copy=False)


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def neuron_table(path):
    rows = []
    statuses = Counter()
    columns = ("bodyId", "status", "superclass", "type", "somaSide")
    for batch in batches(path, columns):
        body = integer_array(batch["bodyId"], "bodyId")
        other = {name: batch[name].to_pylist() for name in columns[1:]}
        statuses.update(other["status"])
        for index, status in enumerate(other["status"]):
            if status == "Traced":
                rows.append((int(body[index]), other["superclass"][index],
                             other["type"][index], other["somaSide"][index]))
    rows.sort()
    ids = np.array([row[0] for row in rows], dtype=np.int64)
    if len(ids) < 1 or len(ids) > MAX_NEURONS or ids[0] <= 0 or np.any(ids[1:] <= ids[:-1]):
        raise ValueError("Invalid or duplicate Traced neuron IDs")
    return ids, rows, {str(key): value for key, value in statuses.items()}


def positions(ids, raw):
    indices = np.searchsorted(ids, raw)
    valid = indices < len(ids)
    valid[valid] &= ids[indices[valid]] == raw[valid]
    return indices, valid


def transmitter_signs(path, ids):
    signs = np.zeros(len(ids), dtype=np.int8)
    seen = np.zeros(len(ids), dtype=np.bool_)
    counts = Counter()
    for batch in batches(path, ("body", "consensus_nt")):
        body = integer_array(batch["body"], "body")
        index, valid = positions(ids, body)
        nts = batch["consensus_nt"].to_pylist()
        for row in np.flatnonzero(valid):
            where = index[row]
            if seen[where]:
                raise ValueError("Duplicate neurotransmitter body")
            seen[where] = True
            nt = nts[row]
            normalized = nt.strip().lower() if isinstance(nt, str) else None
            signs[where] = SIGN.get(normalized, 0)
            counts[str(normalized)] += 1
    counts["missing_body"] = int(np.count_nonzero(~seen))
    return signs, dict(sorted(counts.items()))


def edges(path, ids):
    for batch in batches(path, ("body_pre", "body_post", "weight")):
        raw_pre = integer_array(batch["body_pre"], "body_pre")
        raw_post = integer_array(batch["body_post"], "body_post")
        weight = integer_array(batch["weight"], "weight")
        if np.any(weight <= 0) or np.any(weight > np.iinfo(np.int32).max) or np.any(raw_pre <= 0) or np.any(raw_post <= 0):
            raise ValueError("Invalid connection IDs or nonpositive synapse count")
        pre, keep_pre = positions(ids, raw_pre)
        post, keep_post = positions(ids, raw_post)
        keep = keep_pre & keep_post
        yield pre[keep], post[keep], weight[keep], len(weight), int(np.count_nonzero(~keep))


def defaults(rows, superclass, count):
    # Deterministic experimental ports, not a claim that fly neurons encode
    # game buttons. Spread over the ordered class instead of one dense cluster.
    candidates = [row for row in rows if row[1] == superclass]
    if len(candidates) < count:
        return [], []
    selected = [candidates[int(index)] for index in np.linspace(0, len(candidates)-1, count)]
    return [str(row[0]) for row in selected], [row[2] or "untyped" for row in selected]


def convert(connectivity, annotations, neurotransmitters, output, source_manifest=None):
    connectivity, annotations, neurotransmitters, output = map(Path,
        (connectivity, annotations, neurotransmitters, output))
    ids, rows, status_counts = neuron_table(annotations)
    signs, nt_counts = transmitter_signs(neurotransmitters, ids)
    n = len(ids)
    counts = np.zeros(n, dtype=np.int64)
    source_rows = excluded = total_synapses = m = 0
    for pre, post, weight, raw_count, dropped in edges(connectivity, ids):
        counts += np.bincount(pre, minlength=n)
        m += len(pre)
        source_rows += raw_count
        excluded += dropped
        total_synapses += int(weight.sum(dtype=np.int64))
        if m > MAX_EDGES:
            raise ValueError("Edge count exceeds FLY1 bound")
    off = np.empty(n+1, dtype=np.int64)
    off[0] = 0
    np.cumsum(counts, out=off[1:])
    output.parent.mkdir(parents=True, exist_ok=True)
    graph_digest = hashlib.sha256()
    signed_edges = Counter()
    with tempfile.TemporaryDirectory(prefix="male-cns-csr-", dir=output.parent) as directory:
        work = Path(directory)
        # Empty graphs are valid FLY1 but numpy cannot mmap an empty file.
        target = np.memmap(work / "targets.bin", mode="w+", dtype=np.int32, shape=(max(1,m),))
        weights = np.memmap(work / "weights.bin", mode="w+", dtype=np.float32, shape=(max(1,m),))
        cursor = off[:-1].copy()
        for pre, post, weight, _, _ in edges(connectivity, ids):
            if not len(pre):
                continue
            order = np.argsort(pre, kind="stable")
            pre, post, weight = pre[order], post[order], weight[order]
            local = np.bincount(pre, minlength=n)
            starts = np.cumsum(local)-local
            ranks = np.arange(len(pre), dtype=np.int64)-np.repeat(starts, local)
            location = cursor[pre]+ranks
            target[location] = post
            scaled = weight.astype(np.float64)*SCALE*signs[pre]
            if not np.isfinite(scaled).all() or np.any(np.abs(scaled) > np.finfo(np.float32).max):
                raise ValueError("Invalid signed weight")
            weights[location] = scaled
            signed_edges["positive"] += int(np.count_nonzero(scaled > 0))
            signed_edges["negative"] += int(np.count_nonzero(scaled < 0))
            signed_edges["zero_unknown_or_modulatory"] += int(np.count_nonzero(scaled == 0))
            cursor += local
        if not np.array_equal(cursor, off[1:]):
            raise ValueError("Source changed between passes")
        # Canonical target order and duplicate checks are local to one neuron,
        # so even a shuffled input never requires a whole-graph permutation.
        for begin, end in zip(off[:-1], off[1:]):
            if end-begin > 1:
                order = np.argsort(target[begin:end], kind="stable")
                adjacent = np.array(target[begin:end][order])
                if np.any(adjacent[1:] == adjacent[:-1]):
                    raise ValueError("Duplicate aggregated connection")
                old_weights = np.array(weights[begin:end][order])
                target[begin:end] = adjacent
                weights[begin:end] = old_weights
        with (work / "model.gz").open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as packed:
                packed.write(struct.pack(">I", 0x464c5931))
                header = struct.pack(">II", n, m)
                packed.write(header)
                graph_digest.update(header)
                for values, dtype in ((ids, ">i8"), (off, ">i4"), (target[:m], ">i4"), (weights[:m], ">f4")):
                    for start in range(0, len(values), 65536):
                        block = np.asarray(values[start:start+65536], dtype=dtype).tobytes()
                        packed.write(block)
                        graph_digest.update(block)
        (work / "model.gz").replace(output)
        del target, weights
    inputs, input_types = defaults(rows, "ol_sensory", 16)
    outputs, output_types = defaults(rows, "vnc_motor", 12)
    provenance = json.loads(Path(source_manifest).read_text()) if source_manifest else {}
    meta = {
        "version": 1, "model_id": "male-cns-v1.0", "name": "Male CNS v1.0 / Traced neurons",
        "asset": output.name, "dataset": "male-cns:v1.0", "coverage": "brain, optic lobes and ventral nerve cord",
        "selection": "All annotation status=Traced neurons; Traced x Traced connections, min synapse confidence 0.5; no edge-weight threshold",
        "neurons": n, "edges": m, "synapse_count": total_synapses,
        "source_connection_rows": source_rows, "excluded_non_traced_edges": excluded,
        "packed_bytes": 16+12*n+8*m, "gzip_bytes": output.stat().st_size,
        "runtime_array_budget_bytes": 116*n+8*m+4,
        "graph_sha256": graph_digest.hexdigest(), "gzip_sha256": sha256(output),
        "source_sha256": sha256(connectivity), "annotations_sha256": sha256(annotations),
        "neurotransmitters_sha256": sha256(neurotransmitters),
        "annotation_status_counts": status_counts, "neurotransmitter_counts": nt_counts,
        "signed_edge_counts": dict(signed_edges),
        "weight_policy": {"scale": SCALE, "source_property": "consensus_nt", "sign": SIGN,
                          "unlisted_unknown_modulatory": 0,
                          "note": "Static LIF approximation; no receptor-specific glutamate or neuromodulator dynamics. Zero weights retain anatomical edges, but transmit no current."},
        "default_inputs": inputs, "default_outputs": outputs,
        "default_input_types": input_types, "default_output_types": output_types,
        "port_policy": "Deterministic evenly-spread ordered ol_sensory and vnc_motor bodies; retinal/game mapping is experimental, not biological button semantics",
        "license": "CC-BY-4.0", "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": provenance.get("attribution", "HHMI Janelia FlyEM, Cambridge Connectomics, MRC LMB, Google Research"),
        "source_page": "https://male-cns.janelia.org/download/", "source_manifest": provenance,
        "dynamics": "Existing Gu CPU/GPU LIF engines; anatomical topology is real, biological dynamical equivalence is unverified"
    }
    output.with_suffix(".json").write_text(json.dumps(meta, indent=2, sort_keys=True)+"\n")
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("connectivity", type=Path)
    parser.add_argument("annotations", type=Path)
    parser.add_argument("neurotransmitters", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-manifest", type=Path)
    args = parser.parse_args()
    meta = convert(args.connectivity, args.annotations, args.neurotransmitters,
                   args.output, args.source_manifest)
    print(json.dumps({key: meta[key] for key in ("model_id", "neurons", "edges", "synapse_count",
          "gzip_bytes", "runtime_array_budget_bytes", "graph_sha256", "gzip_sha256")}, indent=2))


if __name__ == "__main__":
    main()
