## Version 2.0.0-alpha13: realtime teaching sessions

* **Learning → Показываю сам** records human P1 actions while the current game continues. **Automode** uses saved imitation plus reward learning; **Проверка** freezes the learned weights and FDB. The independent research controls remain available. See [the training system and limits](docs/TRAINING.md).
* Raw press/release changes are recorded separately from executed game frames. A tap between frames stays in the archive without inventing a training label; a one-frame action keeps its actual platform duration. Human control remains exclusive during teaching.
* Full sessions live outside compact policies. Browse accepted/skipped actions, game time and button coverage, export a complete Android session as streaming NDJSON, or explicitly delete a selected archive after confirmation. The archive browser can include other ROMs/connectomes. Models and the live FDB handoff retain their bounded 200-example buffers; archive replay is future work.
* Android uses an append-only private journal with atomic committed-prefix metadata, ordered/idempotent batches and visible storage errors: 32 MiB per session, 64 MiB total event data, 32 sessions. Unsent data may be lost on process termination. Policy v1/v2/v3 compatibility and NES/Sega/GB/SNES support are retained. Physical Android verification remains necessary.

## Version 2.0.0-alpha08: named Layer Set and live experience

* **Network / 2P → Layer Set**: create a named set, update it, select/load, export/import JSON, or delete after an explicit second click. Each set contains SARSA action weights/counters/RNG, reward profile, neural ports/options, FDB structural layer and growth clock/RNG/source activity, plus a bounded experience journal. It does not contain a ROM, another copy of the base connectome, or the complete LIF state. Android stores sets atomically in app-private files (32 sets, 2 MiB each, 32 MiB total), outside the WebView storage quota. Browser fixtures use localStorage with errors surfaced without replacing the old checkpoint.
* A trained solo set can be loaded on **P2 while retaining the current player arrangement**. Load pauses the link and leaves the ROM frame and episode-start snapshot intact. Reconnect applies the saved FDB checkpoint, even when the structural edge list is identical. Existing LIF dynamics remain live when seed/backend stay the same; changing seed or CPU/GPU needs the explicit network-reset button. Load never triggers a console reset.
* Active-set autosave runs at training boundaries, manual experience marks, and Android pause/system changes. It records the latest completed neural window; this is not a crash-proof per-frame transaction. New/save-as sets allow separate strategies and experiments without overwriting an earlier set. Old single-slot policy/profile and model JSON remain supported, including Sega XYZ actions and FDB growth checkpoints.
* **Learning → Live experience** separates manual victory/loss/continue notes, user-configured RAM/diagnostic outcomes, and decision-limit boundaries. Marks alone do not reward the learner; +1/−1 and the configured RAM profile control the reward. The journal is included in a Layer Set and can be exported as a separate report. Updates and FDB size remain visible with the active set's name.
* Continuous-learning victory/death predicates now use rising transitions: a RAM result held across many windows is scored once. This prevents a finished round from manufacturing repeated rewards/episodes. Failed model import validates before modifying live weights; FDB growth-state timing is excluded from policy identity but restored with the layer.

The author's field run reports one Mortal Kombat round won after about ten continues, easier adaptation in Pulseman, and working human/agent co-op. The journal makes these observations retainable and comparable; no commercial-game performance benchmark is claimed. Two independent connectomes and a three-agent council remain design work in [Recursive Lab](docs/recursive-lab-next.md).

## Version 2.0.0-alpha07: Sega six-button and controller release

* Dedicated Sega A/B/C + X/Y/Z touch pad, Start and Mode; stable legacy bits 0..7, new bits 8..11. Both physical emulated ports receive all 12 bits. Per-port auto/3/6-button protocol selection changes controller hardware without resetting ROM or connectome. Source rebuilt as API5; API4 snapshot tags accepted where the underlying state header/size matches.
* Separate Sega keyboard (A/S/D, Q/W/E, Enter, Shift, arrows), per-platform key remapping, Android native gamepad keys and analog/hat axes with at least 25% deadzone. Choose the human's physical device; model Start/Select/Mode can be blocked. Lost pointer capture, device disconnect and lifecycle release held buttons. Android hardware testing still needed.
* Bounded ZIP with a single cartridge, Sega SMD deinterleave and word-swap normalization before SHA identity. Stale ROM-end headers warn rather than reject a runnable cartridge. Corrupt vectors, ambiguous archives, CD/32X and oversized files remain rejected. NES mapper limitations are unchanged.
* Sega automatic neural ports may expose 12 outputs; legacy 8-output profiles remain valid. The existing 45-feature SARSA readout uses the first eight neural channels plus retinal/motion features and can learn 12-bit actions. No trained policy is silently enlarged or overwritten.
* FDB checkpoint includes growth-window counter, RNG and previous **source** activity (16 integers rather than a full graph-count copy). Evaluation freezes growth state. Base CSR is unchanged; the layer is portable only to matching graph and ports. This checkpoint is not a snapshot of all LIF voltages/pending events.
* Realtime, continuous play, Solo/2P Boost, independent console/model resets, GPU and Code/JSON lab retained from alpha06.

Commercial-game observations supplied by the author (Contra co-op, Mortal Kombat round, Dune/Pulseman) are interesting field observations, not controlled performance measurements. A phone with 6 GB RAM has been reported to work; a universal 6 GB minimum, thermal profile and game-completion rate are not certified.

## Version 1.0.1: Sega raster hotfix

The upstream WASM custom blitter doubled pixels/rows while the frontend read native viewport dimensions. Worse, its second-row pointer mixed byte pitch with pixel indexing and wrote outside the framebuffer. Replaced it with one native-resolution RGBA row per emulated line; the frontend reads the actual byte pitch. Added framebuffer boundary guards checked each frame. This also corrects the retinal input derived from the image.

Regression tests run the actual rebuilt WASM in 256/320-column and NTSC224/PAL240 modes: complete solid backdrop, no alternating holes or half-image crop, untouched unused rows/columns and buffer guards, correct red channel, and state roundtrip. Sega controller, audio, learning and mobile-browser integration remain checked. Commercial-ROM screenshot prompted the fix; that exact ROM was not provided for direct verification. Core snapshot tag moves to API3: old Sega snapshots/profile packages containing API2 starts must be recaptured; learner weights without old snapshots are unchanged. Updated core source archive is bundled for licence compliance.

System-bar/cutout insets are now applied to a parent layout around WebView, preventing content from drawing underneath Android bars. Physical-device verification remains needed. This is a bugfix release only. No FDB or new GPT-like features are added.

## Version 1.0: audited experimental release

Three offline modes: **1 NES / 2 Sega / 3 Lab Code + JSON inference**. Shared APK retains the existing application ID and signing certificate. Full FlyWire v783 signed graph is bundled; there is no model download or commercial game ROM. Model: 138,639 nodes / 15,091,983 directed aggregated edges, about 50.7 MiB gzip / 116.7 MiB raw FLY1. Android 8+ and a current WebView are required. Physical-device minimum RAM/FPS is not certified.

* Model/device passport shows graph SHA256, node/edge counts, LIF timestep/delay, app/Android/WebView/ABI and Java heap limits. Measured CPU timings distinguish emulator and network. The memory estimate includes graph plus one neural state, not total app RSS.
* Separate reproducible evaluation series on NES and Sega: 1–100 attempts from a captured start, frozen external SARSA readout / direct neural buttons / seeded random control. Explicit user-defined RAM victory criterion, death and decision limit; report JSON includes ROM/graph identity, device, configuration, criterion scope, per-attempt wall/CPU time, real FPS, success fraction and Wilson 95% interval. Interrupted attempts are recorded separately and excluded from the completed-trial success denominator. Weights, training counters and trained-policy RNG stay untouched. Manual control, backgrounding or errors stop the series. Frame/decision limits are not biological time and phone FPS is not inferred from a desktop test.
* RAM inspector displays 64 bytes and changes between readings; Sega offset 0 maps to $FF0000. **There is no bundled Zero Tolerance ROM, known final-game RAM profile or evidence of completing that game.** Configure and verify a criterion on your own ROM. Even a reported success means the declared criterion was reached; it is not independent proof of the final credits. Coarse 4×4 vision, fixed LIF connections and linear readout remain substantial limitations for a 3D game.
* Audit fixes: one shared graph load, visible fallback notice for damaged imported models, graph-bound policy identity, candidate-ROM validation before replacing current emulator/policy metadata, independent NES/Sega snapshot and CSV files, stricter snapshot validation, stale configure/page callbacks ignored, background cancellation preserved, 30-second response timeout, Android 15 system-bar insets, truncating SAF exports and explicit size errors. Graph import validates and persists before replacing the previous graph. Network parameter edits stop the current experiment.
* JSON inference now actually supports the advertised 256 inputs. Numbers/booleans are strict, fractional seeds/durations rejected, full-plan validation and already-cancelled programs preserve prior neural state. Results include graph SHA256. Code editor restores an automatic draft, exports UTF-8 byte-bounded JSON, bounds log payloads/API calls, handles extreme finite plots and BigInt logs, and requires awaited asynchronous API calls.

Validation: converter/engine/DSL/module checks; actual NES and Genesis WASM video/controller/audio/snapshots; deterministic synthetic-feature learning tasks; mobile browser CSP/Worker and actual Java-engine coupling on a clearly labelled 24-node fixture; model/profile import, failed boot rollback, snapshot corruption, stale configuration, frozen repeated evaluation and RAM inspection. Full bundled graph runs a 20 ms neural window in Java on the build host. **Physical Android lifecycle, SAF providers, device performance and whole-brain Brian2 parity remain unverified.** This is version 1.0 of an experimental workbench, not a validated biological brain or general game-solving agent.

Earlier UI policy packages without graph identity are rejected instead of silently attaching them to a different imported graph. Raw learner weights can be migrated deliberately; retain an export before updating. Local script modules are CommonJS JS/JSON packages, not APK/Linux software installation.

## Version 0.6: programmable Lab / Code
The third mode now opens an offline JavaScript workbench. Original commands and bounded JSON inference remain under **JSON / Console**. NES/Sega retain their own engines, profiles and learning; code projects operate on a separate neural state sharing the immutable graph.

* Async JS editor, disposable Web Worker, `fly.info()`, `fly.run(program)`, `fly.log(value)`, `fly.plot(name, values)`, `fly.sleep(ms)`; results are actual Java LIF outputs. No generated language. `info.ids` exposes the first 64 string IDs; any known graph ID may be used in inference. No direct NES/Sega scripting or sensor API in this version: game experiments remain in their respective labs.
* Up to 20 local named projects, JSON import/export with source and full installed modules. A project stores neither neural checkpoints nor emulator state. `reset:false` explicitly carries neural state across API calls/runs; default inference resets by seed. `Math.random` remains unseeded; reproducible scripts must use their own seeded RNG.
* Install local CommonJS ZIP modules through Android's document picker. `module.json`: `{ "id":"signal", "name":"Signal tools", "api":1, "entry":"index.js" }`; `index.js`: `exports.mean = x => x.reduce((a,b)=>a+b,0)/x.length;`. Paths are validated; no archive file is extracted or installed as native code. JS/JSON/TXT/MD only, <=64 ZIP entries, <=256 KiB per file and <=1 MiB expanded package. Up to 16 modules and 2 MiB combined per project. `require("module-id")`, relative JS/JSON dependencies and CommonJS cycles supported; no network dependency installer. Installed modules run only when a script calls them. The built-in **Example module** installs original MIT signal utilities.
* Scripts terminate after 30 seconds wall time, at most 64 inference/info calls, 512 exported events / 1 MiB event JSON and 16 plots of <=2,000 finite values. Native inference validates the full DSL before modifying state, allows <=10,000 ms biological time per call, and cancellation is propagated. Stop/background/navigation terminates the Worker; run generations discard stale replies. Exported results include source/modules, API programs/results and user log/plot events; timings aren't deterministic or an exact neural replay.
* Worker code has no Android bridge or DOM access. WebView intercepts only packaged `/code/` assets, refuses navigation/file/content access, and CSP denies external connections. Dynamic compilation is explicitly enabled inside this scripting frontend. This is process/API isolation for experiments, not a formally audited adversarial-code sandbox; very large allocation by user JS can still exhaust WebView memory. Do not install untrusted code on that assumption.

Android 8+ with a current System WebView supporting Blob Workers and modern JS. External Android/Linux programs, Python/Termux integration, microphone/accelerometer inputs, live emulator API, package permission negotiation and neural checkpoint/replay are future work, not implemented functionality. No INTERNET permission added. Shared v0.6 APK preserves app ID/signature for updates.

Validation: module archive traversal/native-file/expanded-size/API checks, actual Java inference from a JS worker with deterministic seeds and CommonJS dependencies, mobile browser CSP/graph/result plotting, project/module roundtrip, malformed import rollback and terminating an infinite loop. Fixtures test protocol behavior on a labelled small graph; physical Android lifecycle/document-picker and phone performance remain untested.

## Version 0.5: 1 NES / 2 Sega / 3 GPT-like direct inference
Install `FlyConsole-Lab-0.5-debug.apk` over earlier NES builds (same package/signing key for shared APKs). Three modes retain the full local connectome:

1. **NES**: JSNES and existing profiles, learning and experiments.
2. **Sega Mega Drive / Genesis**: bundled Genesis Plus GX WebAssembly, three-button A/B/C/Start control, automatic region and 50/60 Hz pacing, video/audio, 64 KiB logical 68K work RAM and core-native state snapshots. Raw `.bin/.md/.gen` up to 8 MiB. ZIP/SMD, Sega CD and 32X are rejected. RAM offset 0 means 68K address $FF0000; multibyte game values usually require big endian. A/B/C/Start/Up/Down/Left/Right use the same eight adapter channels. Six-button X/Y/Z/Mode and battery .sav export are not exposed by this interface.
3. **GPT-like inference console**: conversational command log retained, plus a bounded JSON experiment DSL. The phrase names the interface, not a language model. Set seed/reset/gain/inhibition/lesions; run up to 64 steps (10,000 ms total), each with up to 256 input ID/rate pairs and 256 named output channels. IDs must be strings to preserve 64-bit identity. Responses contain actual LIF spike counts/rates/timing, not generated prose. Import programs/export clean result JSON through Android's document picker. GitHub Actions uses its own debug signing key; shared release APK updates require the shared signing key. JSON template fills a valid ID from the currently loaded graph. `stim`, `status`, `reset` remain available. `reset:false` carries neural state across programs; seed is applied only on reset.

Sega uses the same 4x4 image adapter and trainable SARSA output policy as NES. Choose a per-game reward/profile; no automatic game understanding. The original MD diagnostic changes a RAM counter with Left/Right, changes backdrop colour and emits a PSG tone with B. For this ROM use signed 16-bit big-endian RAM at offset 0 as reward, or explicit manual rewards. For other games find score/death addresses yourself. NES's coordinate-based diagnostic reward is disabled in Sega.

Genesis core is pinned/built locally with Emscripten 3.1.57. Its noncommercial licence, component notices, complete modified source archive and build recipe are bundled in assets/lab/sega/ and this repository; see THIRD_PARTY.md. No game downloads or commercial ROMs. The immutable graph is shared across modes; inference engines have separate states. Core and Android code can be modified from source. Profiles/models are keyed by platform/ROM/settings; UI v0.4 NES profile keys without a platform field are treated as NES.

Validation: actual 68K diagnostic boot, pad->RAM, RGB output, PSG audio, repeatable snapshots and PAL/NTSC detection; mobile browser screen->Java Engine->Sega controller loop, training and profile/model roundtrip; pure Java programmable inference tests. Whole-brain biological equivalence and physical Android document-picker/lifecycle/performance tests remain outstanding. NES PAL/Dendy and battery .sav limitations remain as documented in its earlier modes.

## Version 0.4: external-ROM profiles and audit fixes
Install `FlyConsole-NES-0.4-debug.apk` over 0.2/0.3 (same package and signing key for the shared APK builds). Full graph remains bundled/offline.

* Correct NES BGR-to-RGB conversion, so both video colours and retinal luminance are accurate. Reject truncated iNES/NES2 images, unsupported mappers and declared ROM sizes larger than the file before core allocation. Failed imports retain the previous emulator. Native ROM identity is committed only after the core acknowledges successful loading.
* Configurable 2–64 action masks. Default 22 actions include Start, Select, A+B and directional button combinations. Opposing directions are rejected. Policies preserve weights by action mask when the action set changes.
* RAM reward uses 1–4 bytes, little/big endian, unsigned/signed/packed BCD, optional modular overflow correction. Explicit one-byte equality conditions can terminate on death or victory and add a configured penalty/bonus. RAM addresses are game-specific; no automatic score/death discovery.
* Capture a game-start snapshot after manually passing menus. Episode restarts restore that immutable snapshot and reset neural/RNG state; without it the ROM reboots. Episode limits now count exactly the selected number of decisions. Reward/profile edits stop the experiment and clear pending transition history, preventing spurious deltas.
* Feature vector adds 16 differences from the previous sampled screen (45 values total). The image remains a coarse 4x4 luminance grid, not object tracking or full visual history. The diagnostic task still has explicit RAM coordinate features unavailable to arbitrary games.
* Per-ROM local profiles, episode autosaves, document-picker JSON import/export with a profile, neural port configuration, policy, optional start snapshot, last 100 episode outcomes and last 200 feature/action/reward transitions. Exported transitions are bounded observations, not exact emulator/neural replay. Imported profile/model identity, ranges and shape are validated. Core policy v1 weights can be expanded to v2 internally; old 0.3 UI packages need profile migration and do not import directly.

Recommended external game workflow: load `.nes` → manually start the game → capture episode start → select actions and reward RAM format → configure death/win conditions if known → choose training → enable connection → start NES. Save a profile or export JSON for reuse. Import JSON only after loading the matching ROM.

Current JSNES 2.1.0 mapper support is validated against the vendored implementation. PAL/Dendy timing and battery `.sav` persistence are not implemented by this frontend; use NES snapshots. The 4 MiB ROM cap remains. Sparse/delayed rewards, coarse vision and linear SARSA remain limitations; no arbitrary-game mastery or connectome plasticity is claimed. Android document-picker and physical-device lifecycle tests remain outstanding.

Validation includes RAM format/overflow, invalid ROM sizes/mappers, configurable actions, readout feature updates and v1 policy migration. Mobile browser integration tests real Java neural coupling plus BGR correctness, exact episode limits, repeated snapshot restore, imported profile/model roundtrip, failed-ROM rollback and reward-edit boundaries.

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
4. Under **Вмешательства и порты**, edit gain, negative-edge removal, deterministic input shuffle, frozen retinal input, lesions and explicit FlyWire IDs. **Применить** preserves neural state; the separate reset button resets dynamics and RNG. Connectome synaptic plasticity is not implemented; the version 0.3 readout can learn.
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

## Version 2.0.0-alpha09: Mega Drive cartridge compatibility

* Upgrade the Genesis Plus GX core to pinned `49c584764893b0505ac7f768a754f97330fa4392`, with API6 controller/region/snapshot adapters. CI rebuilds the engine before testing and packaging; `python tools/build_sega.py` is also required before using the checked-in frontend locally. The build verifies the downloaded upstream SHA256 and bundles the exact modified source and component licences in the APK.
* Cartridge import accepts valid zero/wrapped initial stack pointers, nonstandard executable homebrew headers, copier headers, headerless/headered SMD, word-swapped dumps, MDX and bounded ZIP/GZIP. Normalization occurs before ROM SHA identity. Limit increased from 8 to 32 MiB; malformed formats still produce an explicit error.
* Sega settings expose Auto/USA/Europe/Japan NTSC/Japan PAL and detected region, framerate and both controller types. Auto remains the default. Applying a region deliberately restarts the console while retaining the connectome/FDB/learned weights.
* API6 console-state snapshots require recapture; named Layer Set weights/FDB remain independent of emulator snapshots. The APK uses the persistent alpha08 release key for updates.

Regression coverage includes zero-SSP cartridge boot, format identity, actual >8 MiB WASM loading, region pacing, P1/P2 six-button buses, video/audio and snapshot roundtrip. Elemental Master and Comix Zone dumps were not supplied, so exact-ROM/device verification and a whole-library compatibility claim remain outstanding. Sega CD/32X are separate systems and remain unsupported.

## Version 2.0.0-alpha10: held touchscreen buttons

Prevent Android text selection, drag and Copy/Share actions on the NES/Sega gamepad. Long holds remain controller input; simultaneous touches, pointer cancellation and release remain independent. Text fields and research logs retain their normal selection behavior. UI coverage exercises held and simultaneous touches through Chromium's touch input protocol; physical Android verification remains necessary.

