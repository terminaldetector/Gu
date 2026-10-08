# Alpha15: acquired computation, not only sparse inference

## Implemented architecture

The existing `Graph`, `GraphDelta`, `FdbGrowth`, `FdbLearning`, CPU `Engine`,
`GpuLifEngine` and `LayerSetStore` are retained. No parallel FDB inference engine
is introduced. Changes from `27bad21` and `4f23682` remain in the branch: mutable
growth weights still update adjacency and revision, and their CPU checks remain.

| Level | Storage | Simulation / learning |
|---|---|---|
| W₀ | Original signed FLY1 CSR `Graph` | CPU/GPU read it; learning never writes its arrays |
| ΔW | `GraphDelta` deltas on existing W₀ pairs | Applied by both backends; explicitly configured, not automatically reward-trained here |
| Wexo | Additional `GraphDelta` edges between existing neuron IDs | Actual delayed synaptic current, supervised consolidation, action-conditioned reward learning and pruning |

`W_effective = W₀ + ΔW + Wexo`. The public Java arrays are a read-only
architectural contract, not a Java-language immutable-array type. Tests check
that the implemented learning paths preserve W₀ and explicit ΔW.

## Two controllers, three learning modes

In **Обучение → Кто выбирает действия**, the existing external SARSA/imitation
adapter remains selectable. Its global reward is no longer misrepresented as
causal credit for arbitrary active neural connections.

**Коннектом + FDB** chooses from the configured allowed action masks using real
neural output firing rates. Automode samples a seeded epsilon/softmax policy;
evaluation uses a deterministic maximum without advancing its learning RNG.
The old raw neural button mode and GMode ownership remain available.

- Human teaching: labelled, actually executed P1 examples consolidate bounded
  input-to-button Wexo; up to 200 recent examples may seed the layer.
- Neural Automode: cached activity and chosen action receive the subsequent
  game reward. External SARSA weights are not updated in this controller.
- Evaluation / Freeze: no FDB weight, topology, eligibility, baseline, learning
  counter or actor RNG updates. LIF/game state still evolves during inference.

Full-archive FDB training is **not implemented**. Alpha14 archive training and
heldout imitation checks continue to train only the external imitation adapter.

## Temporal credit and structure

At a decision, `FdbLearning` stores a bounded window-rate eligibility surrogate:
presynaptic spike rate × action-specific output feedback. Feedback subtracts
the policy's expected button participation; an unrelated active connection
with no exogenous path to the selected action receives no invented credit.
Feedback may travel backwards through at most three existing Wexo hops.
It does not compute exact gradients through the recurrent W₀ graph.

The game observation captures both RAM reward state and the executed interval
**before** requesting the next neural calculation. Frames executed while that
calculation is pending do not get invented as frames in the already captured
outcome. Real intervening game time contributes to temporal decay.

On an acknowledged, executed action: traces decay with τ=0.6 s; reward minus
an EMA baseline produces a clipped advantage; signed eligibility modulates
bounded Wexo updates. Positive evidence can birth direct input-to-output
pairs absent from W₀. Existing Wexo paths can strengthen or weaken. After
at least 12 observations, accumulated bad contribution and small weight can
prune at most one connection per outcome. Removal advances graph revision;
already emitted delayed events remain in flight, as physical synaptic events.

This is an **experimental window-rate approximation**, not exact e-prop,
millisecond STDP, receptor dynamics or a guarantee of correct long-horizon
credit. Negative-weight reinforcement preserves the sign in the reward rule.
The labelled human rule is an excitatory input-to-button consolidation rule;
it should not be used to reinterpret arbitrary inhibitory modules.

Limits: at most 1,024 acquired edges, at most edge-cap + 16×output-count traces,
four cached native decisions, eight UI feedback requests, at most two seconds
per eligible game interval, finite bounded rewards and weights. Growth order
and actor exploration are seeded. Pauses, graph/ROM changes and interventions
break eligibility; rejected old outcomes do not erase already cached newer
decisions. Overflow, timeout and acknowledgement errors fail closed until a
confirmed native boundary. Solo human input invalidates automatic credit;
human P1 does not invalidate independent agent P2 in co-op.

## Durable Layer Sets

Layer Set v2 stores graph SHA256 and metadata, ordered ports, ΔW, Wexo weights,
learning parameters, eligibility/utility/support/evidence, reward baseline,
actor RNG, birth/prune/rejection counters and legacy structural-growth state.
v1 counters migrate without fabricating historical eligibility.

Feedback and human consolidation atomically update the active named Layer Set
before acknowledgement. A queued older UI save cannot overwrite the native
learner's latest topology for that active set. Failed persistence is visible;
acknowledged topology still appears in the UI. Manual saves wait for feedback.
Model loading breaks temporal eligibility because a Layer Set is not a snapshot
of the running game and LIF delay queues. Long-term weights, utility, growth
state and RNG survive. Exact full in-flight episode continuation is not claimed.

Profiles and local policy files are now keyed by ROM **and graph SHA256**;
legacy files remain readable only after normal identity validation. Named
Layer Sets reject another ROM, graph, platform or ordered-port identity.

## Measured checks

`tools/fdb_game_check.cjs` runs actual bundled WASM Sega, SNES and GB cartridges,
4×4 video observations, production Java CPU LIF, neural action selection,
hardware controller input, RAM-derived reward and FDB updates. Seeds 11/23/37
and identical game snapshots are used for each of four conditions. Evaluation
freezes learning; resumed training reloads v2 state halfway and resets both
comparison arms' game/neural temporal state consistently.

The fixed control is explicit: 16 input→Left connections, weight 8. It is a
deliberately biased fixed topology, **not the best possible pretrained control**.
The diagnostic task is deliberately simple, and its action set is {neutral,
Left, Right}. No commercial-game victory or general intelligence is inferred.

| Graph / diagnostic | Baseline reward | Fixed Wexo | Learned Wexo | Reload + continued |
|---|---:|---:|---:|---:|
| 30-neuron mechanism fixture / Sega, 24 intervals | 0 | −14.4 | 14.4 | 14.4 |
| Same fixture / SNES hardware Right predicate | −2.4 | −2.4 | 24 | 24 |
| Same fixture / GB hardware Right predicate | −2.4 | −2.4 | 24 | 24 |
| Full FlyWire 138,639 neurons / Sega, 8 intervals | 0 | −4.8 | 4.8 | 4.8 |

Each reward value held across the three seeds. Full FlyWire learned layers
contained 12–16 edges; fixture layers 16–21. Full-graph CPU simulation measured
about 59–94 ms per 10 ms neural window on this build host; this is not Android
FPS. Learned-layer bookkeeping was estimated around 19 KiB, graph plus one CPU
state around 130.7 MiB. These are implementation estimates, not measured RSS.
Reported engine wall time excludes IPC, actor/plasticity, disk I/O and WASM
emulation. The saved JSON includes separate emulator time. Battery and physical
device latency have not been measured.

Unit/integration checks also cover checkpoint corruption rollback, v1 migration,
continued-training parity, CPU removal, bounded internal-path credit, untouched
base/deltas and 19 production UI protocol cases. The real GLES compute shader
is compared tick-by-tick with CPU equations, including reinforcement, depression,
removal and outstanding delayed-event queues. Full-device CPU/GPU parity remains
unverified; the GPU test uses small controlled networks in Mesa.

## Male CNS is a second model

See [MALE-CNS-DATA.md](MALE-CNS-DATA.md). The APK bundles both actual graphs;
one model is selected for the existing CPU/GPU engines, with independent graph
identity, ports and learned sets. Switching preserves the console but stops
training, resets neural dynamics and does not transfer weights between animals.
The actual 165,122-neuron Male CNS check verifies a motor port 0→15→0 spikes
under controlled Wexo addition/removal. Improved Male CNS gameplay is not yet
established. Its approximately 213.3 MiB graph/CPU estimate requires additional
heap headroom for WebView, emulator, GPU and safe model-switch staging.

## Beyond existing neuron IDs: design, not fake implementation

New neurons/modules require a versioned virtual-ID namespace disjoint from
biological IDs, explicit dynamics and sign conventions, resizable LIF arrays,
delayed-event addressing, input/output routing, CPU/GPU CSR/SSBO capacity checks,
checkpointed node state and deterministic allocation/pruning transactions.
Evaluation must compare equally budgeted baselines and include transfer across
heldout game states. No virtual node is added in alpha15 without this support.
Current acquired computation grows connections, not the number of neurons.

Research basis: [Bellec et al., e-prop](https://www.nature.com/articles/s41467-020-17236-y)
and [Izhikevich, distal reward](https://izhikevich.org/publications/dastdp.htm).
These motivate local eligibility plus appropriate learning signals; they do not
validate this application's surrogate, anatomy-to-game mapping or intelligence.
