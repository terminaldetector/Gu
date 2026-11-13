# Male CNS as the agent's brain - where it stood, what was in the way

**ROM hash / Male graph hash:** Contra III (SNES) `a93ea87fc835c530b5135c5294433d15eef6dbf656144b387e89ac19cf864996` / Male CNS v1.0 `90d9baae7627a521b08d5112eeb27057994b213bb2ecbc00aae1fb1c52e1cb56`
**Best full-episode frontier:** none on Male CNS yet - until this commit the Male CNS policy could not press a button at all (below); every earlier real-ROM number was the 30-neuron fixture (`NOT_COMMERCIAL`).
**LEVEL_CLEAR evidence:** none - `UNVERIFIED`.

## Product: Male CNS only

FlyWire v783 is removed end to end: not downloaded (`bundle_data.py`), not packaged
(`build.gradle` always excludes `brain.fly*`, default and only connectome
`male-cns-v1.0`), not read or substituted (`ConnectomeStore` rejects it; a stored
`flywire-v783` selection resolves to Male CNS, its layers are not migrated), not
offered (model, partner and 2P selectors). A failed Male CNS load reports
`MODEL_UNAVAILABLE` and the agent does not start. The full 2P check runs both
players on Male CNS (shared W0, isolated contexts). Not done yet: the checkpoint
key does not yet include sensor-adapter and policy revisions (the native binding
store normalises the key to system/ROM/graph/ports).

## Observed dead end 1 - the manifest ports cannot act

`tools/FdbGameBridge` now binds the manifest's ports when given the real graph
(same as `ConnectomeStore.ports` on Android) and checks the pinned SHA. Host,
4 cores: load 3.3 s, peak RSS 387 MiB, decision p50 142 ms / p95 256 ms (20 ms
neural window).

The 12 default outputs (abdominal motor neurons, `MNad*`) **never spike**: dark,
mid or bright input, 20 or 100 ms windows - every button scores -1 and the frozen
decision is always "press nothing". The routing atlas explains why: the 16
default inputs reach them with signed influence 1e-9..1e-8.

## Observed dead end 2 - photoreceptors do not drive a spiking model

Even 256 photoreceptors at 500 Hz for 200 ms make **no other neuron spike**
(`MaleCnsActivityProbe`): the R1-R6 -> lamina synapse is histaminergic, so the
converter signs it inhibitory, and real lamina signalling is graded. Injecting
the game image at the photoreceptors cannot work in this engine.

## What the full graph does allow

`tools/male_cns_routing.py` (offline, full W0, official annotations SHA
`2177e246...`) - signed input-fraction influence per hop from all 4 114 traced
photoreceptors: descending neurons are reached at hop 2 (231 of 1 314) and hop 3
(925); motor neurons only from hop 3. `male-cns-routing-v1.json` holds the
per-hop statistics and the ID sets (descending, motor, LC/LPLC visual
projection neurons with type and side).

Measured in the production engine, 50 ms:

| stimulus | neurons active | descending active (spikes) | motor active (spikes) |
|---|---|---|---|
| 16 manifest photoreceptors | 16 | 0 | 0 |
| 256 photoreceptors | 256 | 0 | 0 |
| 256 looming projection neurons (LPLC2+LC4) | 5 870 | 305 (1 191) | 218 (834) |
| 256 mixed LC/LPLC | 4 203 | 214 (510) | 171 (375) |

## This commit: routing ports (research, `--routing`)

Each of the 16 retina cells drives 16 visual projection neurons of one type on
one side (8 types x 2 sides); the outputs are the 12 descending neurons vision
reaches most (6 per side). No neuron is named after a button - the value of a
descending neuron's activity for an action is left to the learned readout.
Result: the Male CNS policy's action scores now depend on the input (dark: all
-1; mid: 2.33/0.67/...; bright: 2.33/2.33/...), weights change under verified
feedback (28 deltas in 20 updates against 0 before). Cost: decision p50 241 ms /
p95 427 ms, peak RSS 691 MiB on the host - slower than game time (133 ms per
8-frame decision).

Labelled `NOT_COMMERCIAL` until the Android app binds the same routing ports.

## Next, in order

1. Android binds the routing ports (16 groups -> 256 projection neurons, 12
   descending outputs) - same profile headless and on the device.
2. Engine time: event-driven LIF (section 7) - a decision must fit 133 ms.
3. Frontier archive search on Contra III with this brain, then a frozen run.
