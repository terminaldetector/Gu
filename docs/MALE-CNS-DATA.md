# Male CNS v1.0: second bundled model

The second model is the real adult male Drosophila CNS reconstruction across
brain, optic lobes and ventral nerve cord. It does not replace the existing
female FlyWire/Shiu v783 graph. It is not the hemibrain or a renamed FlyWire file.

Official sources:

- [Data downloads](https://male-cns.janelia.org/download/)
- [Release notes](https://male-cns.janelia.org/release/): v1.0, June 8, 2026
- [Janelia project and attribution](https://www.janelia.org/project-team/flyem/male-cns-connectome)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Credit: the FlyEM Project Team at HHMI Janelia, Cambridge Drosophila Connectomics
Group, MRC Laboratory of Molecular Biology, and Google Research. Their data
licence is separate from the application source licence and FlyWire terms.
No endorsement by the data creators is implied.

## Precisely which graph

The reproducible bundled graph is `G_traced`: every body whose official
annotation `status` is `Traced`, with connections between those bodies. The
official `...minconf-0.5-traced-only.feather` pair-aggregated export is used.
The 0.5 threshold is the source synapse-detection confidence, not an additional
minimum connection-strength threshold. Every positive-count anatomical pair
in that export is retained, including pairs assigned zero LIF current below.
Isolated Traced bodies are retained as neurons.

| Measurement | Bundled Male CNS |
|---|---:|
| Traced neuronal bodies | 165,122 |
| Directed aggregated connections | 25,563,197 |
| Summed anatomical synapse count | 124,025,046 |
| Raw FLY1 bytes | 206,487,056 |
| Deterministic gzip bytes | 86,170,894 |
| Graph plus one LIF-state estimate | 223,659,732 bytes / 213.3 MiB |
| Positive / negative / zero-current pairs | 14,737,539 / 9,802,165 / 1,023,493 |

The paper's roughly 166,700-neuron figure is not substituted for the observed
165,122 Traced bodies in this exact release and selection. The annotations also
contain Orphan, Glia, Unimportant, Assign, Anchor and unlabelled segments. The
full segment graph is not silently advertised as a graph of computational
neurons. This selection is not a single anatomical-region demonstration:
the included bodies span central brain, optic lobes and VNC, including 708
`vnc_motor`, 1,314 `descending_neuron`, and 1,846 `ascending_neuron` bodies.

## Explicit modelling choices

Each pair's signed LIF weight is `synapse_count × 0.275 × sign(consensus_nt)`.
`consensus_nt` is the official neuron-level consensus neurotransmitter field.

| Consensus transmitter | Static current sign |
|---|---:|
| acetylcholine | +1 |
| GABA, glutamate, histamine | -1 |
| Unknown, missing, unclear, dopamine, octopamine, serotonin, other | 0 |

This is a documented approximation, not an official biological weight export.
Receptor-specific glutamate effects and neuromodulator dynamics are not
represented by the application's LIF model. Unknown/modulatory predictions
are not silently relabelled excitatory. Zero-current pairs remain anatomical
edges but do not transmit current. Existing CPU and GPU LIF engines consume
the same FLY1 graph; no second neural simulation engine is introduced.

The default 16 input ports are evenly spread through sorted `ol_sensory`
bodies; the 12 output ports are similarly selected from `vnc_motor`. Exact
IDs and type labels appear in `male-cns.fly.json`. This is an experimental
game/retina adapter, not a claim that particular biological motor neurons
encode A/B/C buttons or anatomical retinal pixels. Neural activity, useful
game behaviour and biological equivalence must be measured separately.

## Reproduction and memory

```bash
pip install -r tools/requirements.txt
python tools/male_cns_converter_check.py
python tools/bundle_male_cns.py --cache /absolute/path/to/source-cache
# The usual all-model build also executes the Male CNS bundler:
python tools/bundle_data.py
```

`tools/male_cns_sources.json` pins all three official source files by byte
length, GCS object generation, MD5 and SHA256. Downloads use bounded 1 MiB
chunks. Arrow IPC record batches are processed sequentially without loading a
full pandas connectivity DataFrame. Disk-backed target/weight arrays and two
streaming passes produce CSR; per-source sorting makes the resulting graph
independent of source row ordering. Duplicate aggregated pairs, corrupt
integer/schema fields and invalid counts are rejected. The successful output
is replaced only after validation. The gzip header is deterministic (`mtime=0`).
An actual local conversion of the full pinned exports took 38.8 seconds with
374,224 KiB peak process RSS after disabling per-batch parallel allocator
arenas and releasing unused Arrow buffers. This is a measured build-host
conversion cost, not Android runtime memory or an inference benchmark.

The output graph fingerprint follows `Graph.fingerprint()` exactly:
SHA256 of big-endian node count, edge count, IDs, CSR offsets, targets and
float weights, excluding the `FLY1` magic. The model passport includes
source hashes, counts, selection, transmitter policy and experimental ports.

- Graph SHA256: `90d9baae7627a521b08d5112eeb27057994b213bb2ecbc00aae1fb1c52e1cb56`
- gzip SHA256: `c8f5e2bd9d78a2f458c4947f6c999fb2911a46b543a4c01aa0b37f1caf74ed93`

Binary source exports and generated graphs are build artifacts, not tracked
Git source. APK assets are `male-cns.fly.gz`, `male-cns.fly.json` and
`MALE-CNS-NOTICE.txt`. The application retains one shared graph-cache slot.
A transactional switch temporarily stages the new graph and CPU state before
replacing the old slot, preserving the previous model if a load fails.
Insufficient headroom rejects the switch instead of substituting a small
synthetic graph. Inactive activities may retain old references until they
resume; this is extra transition memory, not simultaneous multi-animal inference.
The estimate is not total Android RSS: WebView, emulators, GPU buffers and
transition state need additional memory. Physical-device speed and minimum
RAM are not certified by the converter test.

## Tests and what they establish

`male_cns_converter_check.py` uses small labelled fixtures only to test file
mechanics: batches, full selected ID universe including isolated bodies,
signed/zero weights, canonical CSR, byte-identical reordered output and
invalid-source rejection. Those fixtures are not packaged as Male CNS.

`MaleCnsGraphCheck.java` loads the actual full bundled graph, checks exact
counts/fingerprint, and exercises the existing CPU LIF engine. With identical
seed 17 and 50 ms of stimulation, a controlled Wexo connection increases the
chosen VNC motor port from 0 to 15 spikes; removing it restores 0 and the full
baseline count vector. Insufficient memory budgets fail before allocation.
This demonstrates functional graph/CPU/Wexo compatibility, not improved
game intelligence, biological equivalence or full-device GPU parity.

```bash
javac -d /absolute/path/to/classes \
  app/src/main/java/org/node/flyconsole/Graph.java \
  app/src/main/java/org/node/flyconsole/GraphDelta.java \
  app/src/main/java/org/node/flyconsole/Engine.java \
  tools/MaleCnsGraphCheck.java
java -Xmx512m -cp /absolute/path/to/classes \
  org.node.flyconsole.MaleCnsGraphCheck app/src/main/assets/male-cns.fly.gz
```

CI runs the converter fixture check after Python dependency installation and
the full-graph CPU check after data bundling, before APK assembly.
