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

## One routing profile for the app and the bridge (M2.1)

`app/src/main/assets/male-cns-routing-v1.json`, profile sha256 `c5e53d437c9352a7...`,
read by ONE class (`RoutingProfile`) in the Android app and in `FdbGameBridge`.

* **Inputs, retinotopic.** Each LC/LPLC visual projection neuron is placed in its
  eye's visual field: the synapse-weighted mean optic-lobe column
  (`assignedOlHex1/2`) of its columnar input partners, and the eye they belong to
  (1 570 placed). The image is 4 x 4 cells: the left two columns go to the left
  eye, the right two to the right eye; each cell's patch gets the 16 projection
  neurons nearest its centre, types taken in turn (`tools/male_cns_routing_profile.py`).
  Neighbouring image cells drive neighbouring parts of the visual field.
* **Outputs, from the measured response to these 256 inputs**
  (`tools/MaleCnsRoutingProfile.java`): a weak background on all groups, each group
  raised in turn, 3 seeds; 401 of 1 314 descending neurons respond; the 12 with the
  largest spread across groups and no near-duplicate response (|corr| <= 0.9).
  They are lateralised and position-specific - e.g. one answers +9.0 spikes / 50 ms
  to image cell 6 only, another +6.7 to cell 4 only, others to the left or right eye.
* **Android** binds it in `ConnectomeStore.ports` (Male CNS); `Experiment` spreads the
  16 port rates over the 256 neurons at the profile's rate on CPU, GPU, dual and
  isolated paths; a reconfiguration on the same ports keeps the profile, other ports
  drop it.
* **Identity.** `FdbLearning.sensorProfile` carries the sha into every checkpoint;
  a checkpoint made through one profile is refused through another (a new layer
  starts); without a profile the checkpoint format is unchanged
  (`RoutingProfileCheck`; full graph validated in `check_full_dual.sh`).
* **The bridge** loads the asset from next to the graph: COMMERCIAL only on that
  path; `--manifest-ports` (diagnostics) and the fixture are NOT_COMMERCIAL.

## Typed credit (M2.3)

`FdbLearning.feedback(..., tier)`: VERIFIED trains the weights and the readout;
PROVISIONAL (an unverified progress gain) does not train FDB at all - its decision
joins the eligibility traces unpaid and is counted apart; it stays with AGOD as the
frontier signal. The tier travels from the AGOD packet through the app
(`lab.js` -> `fdb-feedback.js` -> `NesLabActivity`) and the measurement tool
(`agod_realrom_check` -> `FdbGameBridge`). Six PROVISIONAL rewards: 0 weight, 0
readout, 0 update changes; the same six as VERIFIED: 89 native changes; a later
VERIFIED loss still reaches the provisional decisions through the traces.

## Full episode and the stage detector (M2.2)

* `agod-stage.js`: a control gap of >= 2 s with no resource lost around it, ending
  in a scene unlike every scene of the stage so far, is a STAGE_TRANSITION_CANDIDATE;
  a gap with a life lost is a death, never a stage. Synthetic check 8/8.
* `REALROM_FULL_EPISODE=maxFrames`: the trained learner, frozen, on a freshly
  loaded cartridge; the entry is replayed without any restore
  (`Phase.replayEntry`, the state hash equals the original start); restores during
  play are counted (0); the action trace and transition frames stay private.

FULL_EPISODE_PLACEHOLDER

## Next, in order

1. Android binds the routing ports (16 groups -> 256 projection neurons, 12
   descending outputs) - same profile headless and on the device.
2. Engine time: event-driven LIF (section 7) - a decision must fit 133 ms.
3. Frontier archive search on Contra III with this brain, then a frozen run.
