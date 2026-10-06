# Fly Console — Android connectome launcher

Offline Android laboratory with a conversational command log. **The connectome is not a language model**: commands stimulate neurons and return measured simulation statistics, not generated language.

## Run
Android 8+ (API 26). Build in Android Studio with JDK 17 / Gradle 8.9 / SDK 35, or use the APK produced by GitHub Actions. No account, network permission, CUDA, Python or server on the phone.

The packaged APK includes original Shiu v783 signed connectivity and automatically loads it. GitHub Actions verifies upstream Git blob hashes before packaging. To build locally, run `python tools/bundle_data.py` before Gradle.

If loading fails (e.g. heap too small), it falls back to a labelled synthetic test. For replacement graphs:

1. Without a loaded model, `stim 1 150 1000` runs an explicitly labelled synthetic four-neuron smoke test.
2. On a desktop, install `tools/requirements.txt`. Download `proofread_connections_783.feather` (852 MB) and `proofread_root_ids_783.npy` (1.1 MB) from https://zenodo.org/records/10676866.
3. `python tools/convert.py proofread_connections_783.feather connectome.fly --root-ids proofread_root_ids_783.npy`
4. Transfer `.fly` to Android and tap **Import**. The app saves its own copy and reloads it next launch. Enter `stim FLYWIRE_ID 150 1000`, using a real ID from the import report. `status`, `reset`, and Stop are supported. Duration 1–10000 ms; rate 0–1000 Hz.

A reduced induced graph can be built with `--max-neurons 10000`. This selects smallest IDs, **not** an anatomical or functionally complete circuit. It is only a memory/performance experiment.

## What has been implemented
* Sorted 64-bit FlyWire IDs, CSR graph, signed aggregated weights, file and heap validation.
* CPU LIF engine, 0.1 ms step, 20 ms membrane time constant, 5 ms current decay, -52 mV rest/reset, -45 mV threshold, 2.2 ms refractory, 1.8 ms delay, 0.275 mV per synapse.
* Analytic membrane/current update between inputs; seeded Poisson stimulation; bounded delay ring; cancellable background simulation; wall-clock/biological-time benchmark.
* All outputs are computed by the engine. No invented chat responses or fake whole-brain demo.

## Research and limitations
Based on Shiu et al., Nature 2024 https://www.nature.com/articles/s41586-024-07763-9 and inspected https://github.com/philshiu/Drosophila_brain_model/blob/main/model.py (MIT). Original simulator is Brian2/Python, not an Android library. This is an independent mobile implementation; **numerical and spike-train parity with Brian2 has not been established**. Input event scheduling, discretization and RNG can differ. No body, sensory transduction, learning/plasticity, consciousness claim, or natural-language model is included.

Transmitter identity is inferred per presynaptic neuron using synapse-count-weighted argmax. ACh excites; GABA/glutamate inhibit; modulatory classes are omitted. These are model assumptions, not measured temporal physiology. There is no spike raster export yet. A maximum of eight most active neurons is displayed.

### Size and hardware
Raw source: 852 MB connectivity plus 1.1 MB IDs; full all-synapse spatial table is 9.5 GB and is not needed. Source: https://zenodo.org/records/10676866 (v783).

For arbitrary imports, packed file is exactly `12 + 8*N + 4*(N+1) + 8*E` bytes. Runtime array payload about `116*N + 8*E + 4` bytes plus Java overhead. 

Provisional target: Android 8+, CPU, 2 GB system RAM for small graphs; 4 GB+ recommended for whole-brain experiments. These are engineering estimates, **not verified minimum requirements**. Heap availability matters more than advertised RAM. Import is limited to 1 GiB and rejects models above 2/3 of free heap. Real-time whole-brain performance is not promised. Desktop conversion may need several GB RAM because Feather/DataFrames are expanded and grouped.

### Data rights
Source code licence: MIT. FlyWire data have separate source licences/terms; consult the dataset and FlyWire before redistribution or commercial use. The APK bundles the Shiu v783 model dataset for offline use. Binary data are not tracked in this repository; build-time source fingerprints are verified. FlyWire data remain subject to their separate terms, including applicable noncommercial restrictions.

## Validation
`bash tools/check.sh` compiles and runs engine/parser checks with JDK 17, and checks converter end-to-end with synthetic schema data. GitHub Actions additionally assembles the Android APK and runs lint. Device and original Brian2 parity tests remain outstanding.

## Measured packaged dataset
Shiu v783: **138,639 neurons; 15,091,983 directed connection records**. Packed graph 122,399,548 bytes (116.73 MiB), gzip 53,119,189 bytes (50.66 MiB); estimated runtime array budget 136,817,992 bytes (130.48 MiB), plus runtime/UI overhead. Upstream source files total 104,131,989 bytes. 

Full-data smoke run passed in a JVM limited to 256 MiB heap: 100 ms biological simulation took 0.381 s on the workspace CPU. This is not an Android-device benchmark. APK was compiled against Android 35, DEX-built and signature-verified locally. Physical-device execution and Brian2 comparison remain untested.
