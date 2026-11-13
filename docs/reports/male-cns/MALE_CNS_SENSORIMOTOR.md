# Male CNS as the agent's brain - where it stands on Contra III

**ROM hash / Male graph hash:** Contra III (SNES) `a93ea87fc835c530b5135c5294433d15eef6dbf656144b387e89ac19cf864996` / Male CNS v1.0 `90d9baae7627a521b08d5112eeb27057994b213bb2ecbc00aae1fb1c52e1cb56`, routing profile `c5e53d437c9352a7`
**Best full-episode frontier** (frozen, freshly loaded cartridge, 0 restores): progress **580 by the Male CNS policy alone** - its decisions read from 2 048 of its own neurons through an FDB readout fitted to an AGOD route; it reproduces all 548 route steps with its activity identical to training and dies where the route ends. A memorised search route, not steering: started 1-8 frames late it reaches 100-241. Before the population readout: 146 after imitation through 12 descending neurons, 8 without.
**LEVEL_CLEAR evidence:** none - `UNVERIFIED`. No stage transition in any run; the search frontier stops at 580.

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

Measured on Contra III, seed 11, 2 400 training decisions (typed credit, action
readout), then one frozen episode of up to 36 000 frames on a fresh load:

| input encoder | training events verified / provisional | weight changes | full episode: frames, losses, progress, transitions |
|---|---|---|---|
| legacy-16 (luminance) | 0 / 2 | 0 | 36 000, 0, **8**, 0 |
| motion-16 | 11 / 74 | 855 | 36 000, 0, **0**, 0 |

The Male CNS policy, trained only by verified losses, stands still: nothing it
sees pays it for moving, and progress no longer trains it (M2.3). Progress has to
come from search.

## Search and distillation (stages B and C)

**Frontier archive on the real cartridge** (`REALROM_EXPLORE`, research copy only).
With the first loss ending a branch the frontier stopped at progress 176 after
100 000 frames. Allowing a branch to go on through a loss (lives are part of the
cell; `allowLoss`) moved it to 523 / 580 (two archive seeds) by 1.2 M frames - and
there it stops: the best cells have one life left, every attempt from them ends
the game. Every route replays from a fresh load with 0 restores and the same
progress (two fresh loads fed the same route never diverge - checked stride by
stride). No route reaches a stage transition yet.

Why it stopped at 580 (private frame and RAM inspection, offsets not reported):
two of the four discovered progress fields are per-segment scroll counters. They
climb to 255 in front of a fortified wall at the end of the first scrolling part
and restart at 0 when the screen locks for the next segment - with the player
alive (580 = 255 + 255 + the other two fields). The archive read the next segment
as 510 progress BEHIND the wall and never explored from it. Discovery could not
see this: its runs never reach the end of a segment.

Fix (`agod-explore` r2, `unwrap`): progress is what a trajectory has gained - a
counter that falls from its upper half to under a quarter of that value in play
continues from where it was; any other fall stays a fall. On a synthetic segmented
stage the archive reaches the end in 1 496 frames against 114 840 read raw
(`agod_explore_check` 11/11). The archive is also bounded now: savestates are kept
deflated (823 KB -> ~40 KB on SNES) and past `maxCells` the cells worth least are
dropped - a run that kept 9 600 full savestates was killed by the memory limit.
Unwrapped searches on the cartridge go past the old ceiling: 717 and 712 by 1.5 M
frames, 1 030 - 1 110 by 3-4 M frames (three archive seeds) - and stop again, all
three at the same place, with one life left: a locked screen where a tank pins the
player against the right edge (private frames). From there, firing or jumping to
the right survives 120 strides and scores nothing; everything else dies within
about 12.

The search could not even try the obvious answers: its action set is the
learner's decision set (discovery's attribution, capped at 16), which on this
cartridge holds fire only alone or with right, and jump only straight up - no
fire to the left, up or down, no jump with a direction. `REALROM_EXPLORE_ACTIONS=
composite`: every stick position (with diagonals) with none, one or two of the
three most-attributed action buttons - 63 actions, still within FDB's 64, so a
route found with them can be distilled (the brain's action set takes every action
the route uses). `select: 'lives'` (opt-in) pushes one frontier per number of
lives left; on the synthetic gated stage it is slower than the default (93 768
against 1 576 frames), so it is measured, not assumed. Composite searches are
running.

The cartridge's score (the oracle's progress field) is not among the discovered
fields: it is BCD, and the carry test expects a binary `+1` in the next byte.

**FDB skill memory** (`FdbLearning` skill-v1, opt-in): (state key -> action) from a
route replayed on its own fresh load; the key is AGOD's cell (progress, controlled
position, lives, coarse screen) with the number of earlier visits to that cell and
the dwell in it - without the visit count 548 route steps gave 494 keys and a
frozen run left the route at decision 10. Where it holds a verified action it
decides; each decision records what the brain alone would have chosen.

**Distilling the 580 route** (548 strides) into the Male CNS agent, frozen run on a
fresh load:

| | route steps reproduced from the start | progress | losses | brain agreed with the route |
|---|---|---|---|---|
| skill memory + brain | 548 of 548 | 580 | 3 (game over after the route ends) | 27 of 548 (5 %) |
| skill memory + brain, after 3 imitation passes (readout over descending-neuron activity, `action-dn-v1`) | 548 of 548 | 580 | 3 | 55 of 548 (10 %) |
| **brain alone**, after the same imitation | 0 | 146 | 3 (game over at frame 1 296) | - |

With 12 descending neurons the route was carried by FDB's memory, not by the Male
CNS policy: 28 numbers per decision do not tell 548 route states apart.

**Population readout** (`FdbLearning` readout `action-pop-v1`, opt-in): the readout
reads a population of the brain's own neurons - a frozen pass along the route
measures every neuron's activity, the 2 048 that vary most (of 8 441 that vary at
all) become the population - and is fitted to the route's action at each step
(`fitImitation`: multi-class margin perceptron over the readout only; W0, the
plastic layer and the traces do not change). The engine starts from the same seed
for the imitation pass and for every evaluation, and every decision reports a
digest of all 165 122 spike counts, so "the brain did the same thing" is checked,
not assumed.

| | route steps reproduced from the start | progress | losses | brain activity identical to training | readout fit |
|---|---|---|---|---|---|
| **Male CNS alone**, population readout, frozen, fresh load | **548 of 548** | **580** | 3 (game over after the route) | 548 of 548 steps | 100 % of 548 after 148 epochs, 4 s |
| the same with the skill memory present | 548 of 548 | 580 | 3 | 548 of 548 | memory never had to override the brain (0 of 548) |

Reproducible: a second run from scratch gave the same population, the same fit
(148 epochs) and the same episode. The decisions are the brain's: nothing is read
from RAM at play time, the action is the argmax of the descending neurons' score
plus the readout of the population's spike counts.

What this does NOT show: that the policy steers. The emulator is deterministic and
the engine starts identically, so reproducing a route is close to replaying it.
Measured by starting the episode a few frames late - the brain then sees images it
never saw - against the route's own actions replayed blind from the same late
start:

| start delay (frames) | 0 | 1 | 2 | 4 | 8 |
|---|---|---|---|---|---|
| Male CNS alone, population readout (progress) | 580 | 100 | 135 | 114 | 241 |
| the route's actions replayed open-loop (progress) | 580 | 580 | 160 | 158 | 150 |

One frame late the route still works blind, and the brain does not: its readout
fitted 548 exact activity patterns, a slightly different image gives a different
pattern and a different action. Eight frames late it goes further than the blind
replay, but every delayed episode ends in a game over before progress 250. So this
is the distillation of one search route into the Male CNS, not play; and the route
itself is fragile (blind, it survives one frame of delay, not two).



## Next, in order

1. A route to the stage end: the unwrapping, bounded archive is searching; if the
   wall itself stops it, a signal for destroying it (decimal carries accepted by
   the progress test, so a score counts).
2. The brain steering, not only replaying: robustness to a changed start; then
   demonstrations from perturbed runs labelled by the route's cells (the same AGOD
   cell, the route's action there) so the readout covers the route's neighbourhood.
3. Only then: engine time (event-driven LIF), Android device runs.
