# Expanded FDB Plasticity — alpha21

One existing Graph/GraphDelta/FdbLearning/Engine/GpuLifEngine path, with five diagnostic profiles: `base`, `root`, `dynamics`, `wexo`, `expanded`. The default is `base`, retaining alpha20 candidate selection, formation evidence and learning rules. Diagnostic comparisons must start from separate equal Layer Sets; switching modes deliberately keeps acquired parameters.

## Parameters and limits

| Profile | W0 projection | Threshold learning | Maximum learned Wexo |
|---|---:|---:|---:|
| base | 512 | off | existing configured cap ≤1024 |
| root | 2048 | off | existing configured cap ≤1024 |
| dynamics | 512 | ±5 mV | existing configured cap ≤1024 |
| wexo | 512 | off | 2048 |
| expanded | 2048 | ±5 mV | 2048 |

W0 arrays and biological graph fingerprint remain immutable. ΔW keeps the alpha20 ±50% reference-weight trust region and sign. Expanded selection uses at most sixteen strongest predecessors per target, three CSR scans at configuration only, round-robin allocation and cumulative limits 256 / 1024 / 2048. Selection depends only on W0 and ordered ports. A SHA-256 of ordered candidate IDs/weights detects projection mismatch after reload. This is a capped projection, not whole-connectome optimization.

Threshold offsets are sparse parameters in GraphDelta. At most 256 deterministic output/internal candidates receive threshold learning; retained offsets across port changes are limited to 2048. Only threshold is adapted: gain, leak, rest/reset voltage and refractory duration remain unchanged. Bounds are ±5 mV around −45 mV. CPU constructs the float32 effective threshold once per simulation window and compares it at every 0.1-ms step. GLES uses the same float32 addition and comparison on every tick. The lesion SSBO's second half stores threshold bits, retaining the existing ten bindings. Sparse changes are patched; ordinary windows do not re-upload a full doubled mask.

Neuron eligibility is signed, action-conditioned feedback times observed activity. Reward uses the same delayed outcome and baseline as ΔW/Wexo. Eligibility is capped ±2 and decays over 0.6 seconds of game time. Neurons above 250 Hz in the observed window clear their neuron eligibility, preventing that interval from reducing their threshold. This is a surrogate and a local guard, not proof of global recurrent stability. Input ports are excluded from threshold adaptation; inactive neurons cannot invent attribution. Lesions, invalid/executed-mask mismatch, evaluation and boundaries preserve their guards.

Freer Wexo raises connection capacity and expands the candidate destination set from eight internal predecessors to at most 128 total output/internal ports (up to 2048 sensory-to-destination candidates). Internal destinations remain actual active neurons with a mixed path to a game output; availability depends on the original graph. Three evidence signals, signed support ≥0.25, current-credit agreement, support decay and at most two births per outcome remain unchanged. It does not lower birth thresholds. Persistent negative utility, small strength and at least twelve evidence signals / six bad outcomes still govern pruning.

## One decision, one budget

Expanded profiles propose changes to ΔW, Wexo and neuron thresholds in the same feedback call, then scale them together to a normalized L1 budget of 1:

`sum(abs(rootChange)/max(1,abs(W0)) + abs(exoChange)/maxWeight + abs(thresholdChange)/5) <= 1`.

All continuous changes receive the same scale, so one subsystem cannot consume the whole budget merely by being applied first. Birth strength consumes budget too. Removal is discrete: if the full proposed update exceeds budget, removal is deferred; it is never a partial deletion. Up to one removal per outcome remains. Human root/Wexo consolidation uses the same budget in expanded profiles. `base` intentionally retains its old unscaled behavior. Budget clipping, neuron updates and the last applied normalized budget are diagnostics, not intelligence scores.

## Persistence and migration

Outer FDB format becomes 3; Layer Set envelope remains 2. `neuronDynamics.version=1` stores sorted string neuron IDs and float32 `offsetMv`. Learning checkpoint becomes 4 (`bounded mixed plasticity v4`), adding profile, projection fingerprint, neuron candidates/traces, update counters and budget counters. Validation completes before live learner mutation. Native and frontend accept FDB formats 1–3 and learning states 1–4.

- v1: existing counter migration.
- v2: old temporal synapse eligibility cleared, acquired structure/utility retained.
- v3: base profile eligibility retained when the projection matches; switching profile clears temporal eligibility.
- v4: identical profile/projected IDs restores exact continuation; changing profile clears temporal credit, preserves learned parameters and accumulated counters.

Switching back to base stops further neuron learning and expanded growth while continuing to apply saved ΔW, Wexo and thresholds. It does not erase acquired parameters. FDB freeze/evaluation freezes all three parameter types. A checkpoint does not recreate in-flight game or LIF phase; game/LIF reset boundaries remain explicit.

Maximum traces: 2048 for new base traces, 8192 for expanded profiles; migrated retained traces may be larger than base's new-trace cap. Connection lists and threshold parameters have hard caps. Per-set storage rises from 2 to 4 MiB to accommodate a full trace checkpoint plus its portable parameter key; total store budget stays 32 MiB and maximum set count stays 32. The engine working-memory estimate accounts for an additional 4 bytes per neuron for effective thresholds. Sparse learned parameters and candidates have separate bounded estimates.

## Verification and comparisons

`ExpandedPlasticityCheck` verifies all five profiles, exact resumed weights/thresholds/traces/RNG, 2048 actual root candidates and projection fingerprint, dense-root budget clipping, threshold rollback, corrupt-state atomicity, disabled-mode parameter retention, bounds, and a CPU threshold effect (29 versus 5 spikes with equal input/seed). Existing alpha20 suites remain required.

The GLES runtime suite executes the production shader with thresholds −5, −2, ±0.1234567, 0, 2, 5; compares every tick to the CPU equations; tests live threshold changes, return to zero, event-queue preservation and resting stability. It tests actual desktop GLES, not a physical phone or equality of the existing CPU/GPU stochastic input generators.

The browser suite verifies native-acknowledged mode configuration, reload and retained thresholds on disabling, plus independent P1/P2 profiles. Native acknowledgements are explicit fixtures. CI separately compiles actual Android bridge and tests full models.

`expanded_game_check.cjs`: actual Sega/SNES/GB cores, an explicit 30-neuron mechanism fixture with sensory/internal/motor roots, seeds 11/23/37/53/71, equal training starts, 120 training decisions and two separate neutral-control start states. Each profile is trained both uninterrupted and with a halfway checkpoint; acquired parameters and learner state must match. Evaluation freezes all parameters. Each row records reward, action success, spikes, CPU/decision time, round-trip latency, core time, connection/threshold counts and bounded memory estimate. Control starts differ from training starts, but these simple diagnostic cartridges do not demonstrate broad generalization.

Initial local results: all profiles reached 100% criterion success; reward was 14.4 on Sega and 24 on SNES/GB over 24 decisions, across both controls and all five seeds. Root/dynamics updates are functional, but the tasks are saturated: **no superiority of Expanded is established**. Inference timing on this small fixture was roughly 0.11–0.15 ms per decision, layer-state estimates about 26–27 KiB; these values do not represent full-model Android cost. Raw measurements and full-model diagnostics must accompany the build report. Increasing graph size is not evidence of intelligence.

Remaining experimental limits: physical GPU/thermals, long-running recurrent stability on arbitrary ROMs, stronger independent control tasks, full-model commercial-game skill, and exact causal credit beyond the bounded window-rate surrogate. No neurons/modules are added.
