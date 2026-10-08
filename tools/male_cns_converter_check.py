#!/usr/bin/env python3
"""Synthetic mechanics check, not a surrogate advertised as the Male CNS."""
import gzip
import importlib.util
import json
from pathlib import Path
import struct
import tempfile

import numpy as np
import pyarrow as pa
import pyarrow.feather as feather

spec = importlib.util.spec_from_file_location("male_converter", Path(__file__).with_name("convert_male_cns.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


with tempfile.TemporaryDirectory(prefix="male-cns-test-") as temporary:
    directory = Path(temporary)
    annotations, nts, pairs = [directory/name for name in ("annotations.feather", "nt.feather", "pairs.feather")]
    feather.write_feather(pa.table({"bodyId": [90, 10, 20, 30, 40, 50],
        "status": ["Glia", "Traced", "Traced", "Traced", "Traced", "Traced"],
        "superclass": [None, "ol_sensory", "vnc_motor", "cb_intrinsic", "vnc_intrinsic", "vnc_motor"],
        "type": [None, "R1", "MN1", "unknown", "test", "isolated"],
        "somaSide": [None, "L", "R", "L", "R", "R"]}), annotations, chunksize=2)
    feather.write_feather(pa.table({"body": [90, 10, 20, 30, 40],
        "consensus_nt": ["gaba", "acetylcholine", "gaba", "dopamine", "histamine"]}), nts, chunksize=2)
    values = {"body_pre": [40, 10, 20, 30, 90, 10], "body_post": [10, 40, 10, 20, 10, 20],
              "weight": [4, 3, 2, 7, 100, 1]}
    feather.write_feather(pa.table(values), pairs, chunksize=2)
    output = directory/"male.fly.gz"
    result = module.convert(pairs, annotations, nts, output)
    assert result["neurons"] == 5 and result["edges"] == 5
    assert result["synapse_count"] == 17 and result["excluded_non_traced_edges"] == 1
    assert result["signed_edge_counts"] == {"positive": 2, "negative": 2, "zero_unknown_or_modulatory": 1}
    raw = gzip.decompress(output.read_bytes())
    assert struct.unpack_from(">III", raw) == (0x464c5931, 5, 5)
    ids = np.frombuffer(raw, dtype=">i8", offset=12, count=5)
    offsets = np.frombuffer(raw, dtype=">i4", offset=52, count=6)
    targets = np.frombuffer(raw, dtype=">i4", offset=76, count=5)
    weights = np.frombuffer(raw, dtype=">f4", offset=96, count=5)
    assert ids.tolist() == [10, 20, 30, 40, 50]
    assert offsets.tolist() == [0, 2, 3, 4, 5, 5]  # isolated neuron retained
    assert targets.tolist() == [1, 3, 0, 1, 0]  # canonical CSR target ordering
    assert np.allclose(weights, [.275, .825, -.55, 0, -1.1])
    import hashlib
    assert hashlib.sha256(raw[4:]).hexdigest() == result["graph_sha256"]
    # Source order and batch partition must not affect the model bytes.
    previous = output.read_bytes()
    feather.write_feather(pa.table({key: list(reversed(value)) for key, value in values.items()}), pairs, chunksize=3)
    module.convert(pairs, annotations, nts, output)
    assert output.read_bytes() == previous
    # Invalid aggregated pairs fail without replacing the previously-good model.
    feather.write_feather(pa.table({"body_pre": [10, 10], "body_post": [20, 20], "weight": [1, 2]}), pairs, chunksize=1)
    try:
        module.convert(pairs, annotations, nts, output)
        raise AssertionError("Duplicate pair accepted")
    except ValueError as error:
        assert "Duplicate" in str(error)
    assert output.read_bytes() == previous
    feather.write_feather(pa.table({"body_pre": [10], "body_post": [20], "weight": [-1]}), pairs)
    try:
        module.convert(pairs, annotations, nts, output)
        raise AssertionError("Negative synapse count accepted")
    except ValueError:
        pass
    assert output.read_bytes() == previous
    assert json.loads(output.with_suffix(".json").read_text())["graph_sha256"] == result["graph_sha256"]
print("PASS Male CNS converter: streamed batches, full Traced universe, sign policy, canonical deterministic FLY1, invalid data rejection")
