# Alpha20: learned root weights, signed synthetic structure and actual emulator speed

## Research used

These are references for mechanisms, not bundled dependencies or claims to reproduce their full algorithms. No upstream source code was copied.

| Project / primary source | Relevant mechanism | Use in Gu |
|---|---|---|
| [NEST dopamine STDP](https://nest-simulator.readthedocs.io/en/stable/models/stdp_dopamine_synapse.html) | Separate eligibility, reward baseline and bounded synaptic weights | Retain action-tagged eligibility; extend it to selected original synapses, preserve a bounded reference |
| [Brian2 reward-modulated example](https://brian2.readthedocs.io/en/stable/examples/frompapers.Izhikevich_2007.html) | Decaying local trace bridges activity and later reinforcement | Keep the observed action interval and actual elapsed game time; never credit an asynchronous backend tail |
| [BindsNET learning rules](https://bindsnet-docs.readthedocs.io/guide/guide_part_ii.html) | Local learning rules, weight dependence, reward-modulated eligibility | Strength-dependent Wexo updates; independent switches for root learning and the whole FDB learner |
| [RigL implementation](https://github.com/google-research/rigl) | Controlled topology change with bounded connection budget and evidence for new links | Repeated signed evidence before automatic birth, small structural changes per outcome, removal of weak persistently harmful Wexo |

Gu uses a **window-rate, action-conditioned surrogate**. It does not implement exact STDP, BPTT, e-prop or RigL's dense gradient. Sparse storage is a resource limit; the aim remains acquired computation through Wexo, alongside adaptation of the biological scaffold.

## Effective roots and exogenous computation

`W_effective = W0 + ΔW + Wexo` still uses `Graph`, `GraphDelta`, `FdbLearning`, CPU `Engine`, `GpuLifEngine` and existing Layer Sets. Original signed W0 arrays and fingerprints never change.

Previously ΔW could only be configured explicitly. It now learns from attributed game outcomes, or from human labels on existing direct sensory-to-button synapses. Automatic eligibility is the activity of the presynaptic neuron times signed feedback specific to the sampled action, with epsilon's uniform component excluded. Mixed paths carry this feedback through W0/ΔW and Wexo, up to three reverse hops; an inactive or lesioned intermediate source does not transmit feedback. This is a bounded approximation to a connection's contribution, not a proven exact causal gradient.

At configuration, at most 512 original synapses are selected deterministically from output predecessors. Three scans of the original CSR select up to eight strongest incoming candidates per frontier target, allocated across targets, without a full reverse graph. There is no whole-connectome gradient or per-frame scan of all 15–25 million edges. The projection depends only on W0 and ordered ports, so loading the learned layer reconstructs the same candidates. Other original weights continue participating in simulation and remain unmodified.

Root learning uses one tenth of the configured learning rate and a change bounded by `min(0.5 × abs(W0), 127)`. It preserves the original synapse sign. Explicit user deltas already outside this region remain as configured. The reference W0 is never rewritten. The root switch stops subsequent changes but preserves acquired ΔW. Both FlyWire and Male CNS use this same implementation; P1/P2 have independent switches and state.

Wexo improvements:

- Reward feedback crosses existing mixed paths, including actual internal neurons, instead of being restricted to Wexo-only paths.
- Potential new connections include the 16 sensory ports to game outputs and up to eight internal predecessors. Internal candidates require activity and an output path.
- Automatic birth needs at least three accumulated nonzero credit signals and sufficient signed support. Support decays with 2 seconds of game time. At most two connections are born per outcome within the existing edge cap.
- Signed evidence can create excitation or inhibition. Weight updates have bounded strength, reduced growth near the limit and slower changes for positive accumulated utility. Persistent negative contribution plus small strength can prune at most one connection per outcome.
- Direct human examples can still seed excitatory sensory-to-button Wexo immediately. They do not flip an existing inhibitory Wexo into excitation.
- Evaluation, freeze, mismatched executed action, intervention, lesion and boundary guards remain. No outcome means no root or synthetic weight update.

GPU synchronization now patches only changed root values. It restores removed deltas to W0 and avoids rebuilding/uploading the exogenous adjacency when only ΔW changed. CPU and GPU use the same learned effective weights; the existing delayed-event semantics remain.

## Persistence and controls

In Learning → Plasticity, **Обучать исходные веса вместе с Wexo** controls ΔW training. Two-model cards expose it independently for P1/P2. Missing `learning.trainBase` defaults to true; an explicit false survives save/load. Disabling it does not delete existing ΔW. New counters show root updates and the bounded candidate count; delta count remains the number of modified pairs.

The outer FDB/Layer Set format remains version 2. Learning state is version 3 (`mixed-path eligibility v3`) with signed support, root counters and projection size in addition to RNG, reward baseline, evidence, utility and traces. Version 2 states retain accumulated topology, counters and utility but clear temporal eligibility because the feedback algorithm changed. Version 1 counter migration remains supported. Malformed state validates before mutation. Named sets and automatic continuation still use atomic native storage; ROM/graph/ordered-port identity remains mandatory.

A Layer Set is not an in-flight game/LIF snapshot. Loading breaks temporal eligibility but restores acquired weights, structure and reproducible learning state. New neurons or external modules are not introduced.

## Speed

The old scheduler ran core frames only during requestAnimationFrame, capped at 4 ms per display callback. A core taking 3 ms could not reliably execute three frames within that callback even though the full display interval had sufficient capacity.

The production emulator now follows monotonic frame deadlines at `native FPS × selected rate`. A cooperative MessageChannel/timer pump executes complete core frames in short slices independently of display refresh. requestAnimationFrame presents the most recent complete frame. Pending realtime CPU/GPU replies do not stop the core; explicit Lockstep still waits for them. Game-time reward intervals and button expiration advance only for actually executed frames.

The main speed label shows an unqualified ×3 only when measured speed is within 5% of the target. Otherwise it shows achieved / requested speed. Pauses and rate changes reset the measurement interval. Catch-up is bounded to 250 ms of wall time after stalls; no skipped deadline is counted as an executed frame. Requested acceleration cannot exceed device capacity. Accelerated audio remains muted.

## Checks and local measurements

- Production Java learner: active mixed root paths change ΔW; unrelated active synapses do not; the trust region and W0 invariance hold; disabling root learning and evaluation freeze it; mismatched actions receive no credit; signed Wexo birth requires accumulated evidence.
- Root-only teaching on a controlled synapse changes production CPU output from 12 to 16 spikes with the same seed, input and 200 ms duration. This demonstrates a functional effect, not success at a commercial game.
- V3 load + continued learning produces identical root/exogenous weights, RNG and trace state. V2 migration clears obsolete temporal credit.
- Actual Sega/SNES/GB diagnostic ROMs, seeds 11/23/37: baseline, fixed Wexo, learned Wexo and resumed learning retain the controlled improvements. These diagnostic tasks are simple and not a comparison to an optimal fixed controller.
- Production pump with virtual time and 3 ms per core frame gives exact ×1/×2/×3; PAL/NTSC/GB rates are checked through ×10, with overload, pause and delayed-model cases.

Actual browser core frames over approximately 2 seconds, with a pending native-reply fixture at ×3:

| Core | Requested | Measured |
|---|---:|---:|
| NES, each frame padded to at least 3 ms | 3× | 2.997× |
| Mega Drive | 3× | 2.998× |
| SNES | 3× | 3.000× |
| GB | 3× | 3.001× |

The same deliberately costly NES core at requested ×10 ran at 5.248× and displayed its achieved rate instead of claiming ×10. Browser native acknowledgements are explicit fixtures; native CPU/FDB and GLES tests are separate. Physical Android GPU load, thermals and commercial-game skill still need field testing.
