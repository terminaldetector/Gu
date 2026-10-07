## Version 0.3: reward-driven game learning
Install `FlyConsole-NES-0.3-debug.apk`; same app ID/signing key as 0.2. Select **Учиться с исследованием**, enable the brain connection, then start NES. This forces closed/lockstep coupling. Linear SARSA(lambda) trains 9 controller-action readouts from 16 sampled retinal values, 8 actual neural firing rates, bias, and four diagnostic coordinates (zeros for other games). The original connectome weights are fixed. Hyperparameters: gamma .95, lambda .7, configurable epsilon and alpha; clipped updates and bounded weights. Manual control clears temporal learning traces.

The bundled task rewards reducing Manhattan distance to x=200,y=100; reaching it adds +2. Its reward and extra coordinates intentionally use the diagnostic ROM RAM. Other ROMs support one-byte RAM-delta reward (address 0–2047, signed scale) or manual +/- reward. No automatic game-score discovery, arbitrary-game mastery or connectome-wide plasticity is claimed. Choose episode length, automatic reset, or manual termination. Automatic reset restarts both NES and neural state while retaining learned weights. Evaluation disables weight updates and exploration; ties may still be seeded-random.

Save/load a local policy slot or transfer the JSON text. Imports require identical ROM SHA256, port IDs, network configuration and reward settings. Policy JSON contains readout weights, RNG and counters, not neural state or NES state. Reward chart stores the last 100 episode outcomes. CSV also records applied controller mask, learning mode and the previous decision reward (not an exact replay).

`node tools/learning_check.cjs` executes real NES episodes: 100 training episodes improve the diagnostic task, then 20/20 evaluation episodes reach the target for seed 123. This isolates the learner with fixed synthetic neural features; the browser integration test separately checks training from actual Java Engine outputs on its 24-node fixture. Neither proves whole-brain biological learning or success in other games.

# Fly Console NES — offline connectome experiment lab

Android 8+ app with a bundled NES emulator and Shiu/FlyWire v783 connectome. Both run locally. This is a **sensorimotor experiment workbench** with an experimental trainable game readout.

## Version 0.2: NES lab
Install `FlyConsole-NES-0.2-debug.apk` (or the latest Actions artifact). This build has app ID `org.node.flyconsole.nes`, so it can coexist with version 0.1. Android System WebView must support modern JavaScript; update it if the emulator fails to initialize.

1. The original diagnostic NROM loads automatically; press **Запустить NES** and try the direction buttons. A changes sprite colour and gates a pulse tone. Import your `.nes` file with **Открыть .nes** (up to 4 MiB; unsupported mappers produce an error).
2. Once the graph loads, choose **Наблюдение** or **Замкнутый**, then **Включить связь**. The default ports are technical selections, not labelled fly sensory or motor neurons.
3. Try **Пошаговая связь**: one NES frame waits for one neural window. Async mode keeps the NES running while a bounded stream of screen samples is processed. Biological/network time is reported separately from NES frames and wall time.
4. Under **Вмешательства и порты**, edit gain, negative-edge removal, deterministic input shuffle, frozen retinal input, lesions and explicit FlyWire IDs. **Применить** resets network state and RNG. Connectome synaptic plasticity is not implemented; the version 0.3 readout can learn.
5. **Запись CSV** resets the connectome by seed and records a new trial from the current NES frame. CSV includes ports/configuration, ROM SHA256, wall/network time, inputs, output spike counts, manual and neural button masks and frozen-input flag. Recording caps at 8 MiB. Export uses the Android document picker. CSV is observational, not a complete executable replay.
6. **Снимок NES** saves one emulator slot locally, associated with the ROM hash. It does not save neural state; restoring resets the connectome. **Консоль** opens the original command interface, including graph import. The immutable graph is shared to avoid duplicating its large edge arrays.

### Coupling assumptions
The rendered screen becomes a 4×4 luminance grid; values 0–1 scale 16 Poisson input frequencies. Eight selected output neuron spike rates map to A, B, Select, Start, Up, Down, Left and Right through a configurable threshold. Opposite neural directions cancel. Manual directional presses override conflicting neural directions. Stale neural buttons release after 500 ms; pause/stop and app backgrounding release them too.

Automatic input ports are the 16 nodes with highest outgoing degree. Outputs are eight strong positive postsynaptic targets excluding inputs; fallback picks unused nodes if needed. These are reproducible engineering defaults, **not a biological account of vision or motor behaviour**. Brian2 parity remains unverified. The emulator and interventions do not make the fly learn NES or prove cognition.

The bundled diagnostic ROM is original project code/assets under MIT, generated by `tools/make_test_rom.py`. JSNES **2.1.0** is vendored unmodified and licensed Apache-2.0; see `app/src/main/assets/lab/JSNES-LICENSE.txt` and `jsnes-source.json`. No game downloads are performed by the app.

## Build and validation
JDK 17, Gradle 8.9, Android SDK 35 / minSdk 26. Install `tools/requirements.txt`, run `python tools/bundle_data.py`, then `gradle assembleDebug lintDebug`. CI verifies source blob fingerprints before bundling the graph. `bash tools/check.sh` tests the original console engine, converter, interventions, incremental state and actual NES video/audio/controller/save-state behaviour.

Optional mobile browser protocol test: compile `tools/FixtureBridge.java` with the `org.json` library, set `FIXTURE_CLASSPATH` and `CHROMIUM_EXECUTABLE`, then run `node tools/lab_ui_check.cjs` with Playwright installed. It couples the actual rendered NES screen to the Java Engine on a clearly labelled 24-node fixture. This test is not an Android-device or whole-brain behaviour benchmark.

Full-data validation on the workspace JVM (256 MiB heap): original graph loaded and ran 20 ms of 16-port stimulus; 47 spikes / 28 active neurons, about 152 ms CPU on this host. This result depends on selected inputs, seed and host. Real-time phone performance and biological fidelity are not established.

## Original console and data details

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
Based on Shiu et al., Nature 2024 https://www.nature.com/articles/s41586-024-07763-9 and inspected https://github.com/philshiu/Drosophila_brain_model/blob/main/model.py (MIT). Original simulator is Brian2/Python, not an Android library. This is an independent mobile implementation; **numerical and spike-train parity with Brian2 has not been established**. Input event scheduling, discretization and RNG can differ. No body, biological sensory transduction, connectome plasticity, consciousness claim, or natural-language model is included.

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
