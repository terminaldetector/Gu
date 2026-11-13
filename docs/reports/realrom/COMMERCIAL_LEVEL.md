# First commercial level - status against the 2026-11-12 directive

**Verdict: `LEVEL_CLEAR = UNVERIFIED`. Not `DEMONSTRATED`, not `REPRODUCIBLE`,
not `GENERALIZED`.** No run reached the end of a level, and the evaluation
used here (3 frozen holdout starts x 300 decisions x 8 frames = 2 400 frames
per start) cannot measure one: that is P3's full-level mode, not built yet.
Everything below is what was built and measured towards it, including the
negative results.

Private ROMs by hash only (R3 = SNES run-and-gun `a93ea87f...`, R2 = Sega
run-and-gun `704c54b3...`); aggregates only (`realrom-p0-ab.json`).

## Fields the directive asks for (every row of this report)

| field | value |
|---|---|
| agentKind | FDB+AGOD (30-neuron mechanism fixture graph, production learner `FdbLearning`) |
| runMode | FROZEN_300_STEP (not FROZEN_FULL_LEVEL) |
| seeds | 11, 23, 37, 41 |
| humanInputFrames | 0 |
| evalRestores | 0 inside an evaluation episode; each episode starts from a holdout snapshot of separate origin |
| weightsChangedInEval | false - and now the WHOLE learner state is digested around every evaluation (weights, traces, RNG, pending decisions, counters): clean in all 32 seed-arms |
| unknownRewardPayments | 0 (UNKNOWN never carries a value; checked by the objective's own tests) |
| levelClear / levelClearEvidence | UNVERIFIED / null - no stage-clear detector exists yet |
| encoderRevision | `realrom-obs-r1/legacy-16` (P0); P1 arms below |

## P0 - rewind fan and payment budget (A/B, matched seeds)

Same discovery, action set, starts, 2 400 training decisions (19 200 frames,
branch steps included), carry on. Arms: baseline; **rewind** (at a verified
loss go back 96 frames, 4 branches, each starting with an action the policy
picks among those not yet tried there; training only); **budget** (provisional
progress paid between two verified losses capped at one loss); **both**.

Per seed, `progress/deaths/frames` for argmax · sampled (frozen):

| | 11 | 23 | 37 | 41 |
|---|---|---|---|---|
| R3 base | 725/9/3080 · 728/9/3032 | 725/9/3080 · 652/9/3024 | 126/9/2904 · 619/9/2872 | 126/9/2904 · 126/9/3384 |
| R3 rewind | 725/9/3080 · 759/9/3048 | 126/9/2904 · 416/9/3464 | 725/9/3080 · 705/9/3032 | 126/9/2904 · 208/9/3184 |
| R3 budget | 0/0/7200 · 126/0/7200 | 126/9/2904 · 326/9/3400 | 436/9/3920 · 512/9/4952 | 0/0/7200 · 244/6/7128 |
| R3 both | 260/9/2616 · 831/9/3808 | 725/9/3080 · 653/9/3080 | 4/0/7200 · 34/0/7200 | 718/9/3080 · 650/9/3240 |
| R2 base | 74/0/7200 · 2485/7/7000 | 74/0/7200 · 2415/5/7200 | 74/0/7200 · 1704/4/7200 | 2304/9/6864 · 3230/7/7088 |
| R2 rewind | 1044/2/7200 · 2774/7/7144 | 0/0/7200 · 1156/6/6840 | 74/0/7200 · 2087/7/6928 | 74/0/7200 · 1094/4/7200 |
| R2 budget | 74/0/7200 · 2499/7/7112 | 2676/8/6896 · 2184/8/6640 | 1860/9/6656 · 1932/9/6672 | 0/0/7200 · 754/3/7200 |
| R2 both | 2268/9/6456 · 2885/8/6888 | 984/2/7200 · 3201/6/7200 | 74/0/7200 · 1814/4/7200 | 74/0/7200 · 1794/7/7200 |

Totals (both evaluations, four seeds):

| | progress | deaths | frames survived | best episode | rewind branches survived |
|---|---|---|---|---|---|
| R3 base | 3 827 | 72 | 24 280 | 292 | - |
| R3 rewind | 3 790 | 72 | 24 696 | 325 | 18 / 296 |
| R3 budget | 1 770 (-54 %) | 42 | 43 904 | 224 | - |
| R3 both | 3 875 | 54 | 33 304 | 380 | 27 / 229 |
| R2 base | 12 360 | 32 | 56 952 | 1 483 | - |
| R2 rewind | 8 303 (-33 %) | 26 | 56 912 | 980 | 7 / 177 |
| R2 budget | 11 979 | 44 | 55 576 | 1 160 | - |
| R2 both | 13 094 | 36 | 56 544 | 1 459 | 10 / 192 |

**What this says.**

* **No P0 configuration passes the directive's gate** (better survival without
  a collapse of progress, on several seeds). Every "fewer deaths" in the table
  comes from seeds where the trained policy stopped moving: R3 budget seeds 11
  and 41 (0 progress, 0 deaths), R3 both seed 37 (4 progress, 0 deaths). On the
  seeds where it moves, R3 still spends all 9 lives in every arm. On R2 rewind
  cuts deaths by 19 % and costs 33 % of progress.
* **The budget alone teaches standing still**, as the directive feared:
  payment for progress drops from ~2 900 to ~54 on R3, the verified losses
  dominate, and the cheapest way to avoid them is not to advance.
* **Rewinding 96 frames almost never saves the life**: 62 of 894 branches
  survived (7 %). A different first action and the same policy after it do not
  avoid a death that is decided earlier, or by what the agent cannot see - the
  16-cell luminance retina does not show bullets. This points at P1/P2, not at
  more rewind.
* The budget combined with rewind is the only arm whose progress held on both
  games (+1 %, +6 %); its R3 death reduction is the passive seed.

## P1 and P2 - built, A/B running

* **P1 observation encoders** (`tools/realrom_observation.cjs`): `legacy-16`
  (the old retina, unchanged - the control above), `motion-16` (frame change
  after the global scroll is estimated and removed), `fused-16` (probe-proven
  position with explicit availability slots, verified resource, time since
  loss, scroll, compensated motion). Frame size from the core. Synthetic check
  12/12: a pure scroll is estimated exactly and leaves 0 motion (16.0 without
  compensation), a sprite lights its own cell even over a scrolling background.
* **P2 action readout** (`FdbLearning` readoutProfile `action-v1`): every
  action, "press nothing" included, gets a learned score `w_a . phi(inputs)`,
  trained only by verified feedback through traces that carry, pause and clear
  like the weights. Check 10/10: a quiet layer that stood everywhere learns to
  stand in the context where standing was paid and act where acting was;
  UNKNOWN intervals and frozen decisions change nothing; checkpoint roundtrip
  exact. With the readout off, checkpoints are byte-for-byte unchanged.

Real-cartridge A/B of P1/P2: section below, filled when the runs finish.

## What a level clear still needs (P3)

1. A **full-level evaluation mode**: one frozen run from the level start, no
   restore, until game over or a verified stage transition.
2. A **stage-clear detector** in AGOD independent of training signals: a scene
   transition with control lost and no resource loss, followed by a new play
   phase - verified on calibration/holdout like every other goal.
3. Policy capacity: a 30-neuron fixture with 16 inputs reacts to the current
   frame only; a level needs memory of where it is (temporal memory, skills).

## Reproduce

```
AGOD_PRIVATE_ROMS=... CODE_CLASSPATH=... REALROM_SEEDS=11,23,37,41 REALROM_CREDIT=carry \
 REALROM_DECISION=agod REALROM_PRIOR=0 [REALROM_REWIND=4] [REALROM_BUDGET=1] \
 [REALROM_OBS=motion-16|fused-16] [REALROM_READOUT=action-v1] \
 node tools/agod_realrom_check.cjs --fdb --no-baseline --only <hash prefix> --out <file>
```
