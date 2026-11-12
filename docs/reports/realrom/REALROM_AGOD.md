# AGOD on real cartridges — first non-synthetic analytics

Date: 2026-11-11. Branch `research/agod-neural-e0-e1`.
Corpus: two **private** Mega Drive cartridges supplied by the owner. Only their
SHA-256, byte size and aggregate results appear here; no ROM bytes, RAM offsets,
frames or states are in the repository. Machine-readable results:
`realrom-analytics.json` (produced by `tools/agod_realrom_check.cjs`, which is
BLOCKED without `AGOD_PRIVATE_ROMS`).

| tag | SHA-256 | bytes | role |
|---|---|---|---|
| R1 | `38e7f32e3874e2b516c584bbcb206326daec6f3e3a00261aa277578a76d9d809` | 524 288 | solo (vertical shooter: health bar, score) |
| R2 | `704c54b3fece68e5bbdc584cf8a22605380b0e845bd60f61c06406ed03a04b1c` | 2 097 152 | two players (run-and-gun hack: lives, per-life health bar, 2P drop-in) |

Ground truth ("oracle") was established by a human from the HUD and kept in the
private directory; the tool opens it only after discovery has answered, and the
report carries only match / no-match.

## 1. What the old system did on real games

| | R1 | R2 |
|---|---|---|
| background run 1.5 s after load (title screen) | REFUSED at `induce` after 12 371 frames — Start-driven menu bytes typed as a "resource" | — |
| classic pipeline from live **play** | REFUSED at `induce`, 12 371 frames | REFUSED at `induce`, 16 355 frames |

Root cause, measured: the resource stage asks *which button drives a field to a
floor compared with doing nothing*. In a commercial game the cost is the game:
enemies hit the player whether a button is pressed or not, so the neutral
control loses health too, and the real resource is excluded as time-driven. On
R1 the health byte fell 4, 3, 2, 1, 0 in front of the refusing stage.

## 2. What was added

* **`agod-phase.js`** — PLAYING / MENU / TRANSITION / INERT from controlled
  comparisons from one snapshot. PLAYING = a *controlled integrator*: a longer
  hold of a direction moves some field further, the opposite direction moves it
  the other way (with a wall-clipped variant for a player pinned against an
  edge). MENU = a button that rewrites ≥ 2 % of the RAM window (measured: title
  and menu presses 3–52 %, an in-play pause ≤ 1.1 %). `enter()` drives a game
  from power-on into play with no per-game script. Port-aware.
* **`agod-survival.js`** — rollouts from a PLAYING state under neutral and seeded
  random play. Control is re-tested along each rollout from snapshots (so the
  check never perturbs the trajectory); a long loss of control is an *ending*
  only if a menu appears or control never returns (a boss intro gives control
  back). A resource must fall at **policy-dependent** times (a clock falls on
  the same frames under every policy and is excluded), must have fallen while
  the player still had control (post-death fades excluded), and either sits at
  its floor at the ending (TERMINAL) or falls once per loss of life (PER_LOSS).
  Counters seen crossing zero (1, 0, 255) are read signed. Progress = rose under
  most active policies, never under neutral, never fell in play except as a
  digit carry; carry partners are merged into two-byte words. Calibration and
  holdout run from starts of their own origin through the **existing** evidence
  registry, so the GoalEvidenceDTO → profile → broker → FDB path is unchanged.
* **Worker routing** — a live state in play goes to survival first, the classic
  pipeline as fallback; a background run at a title/menu returns `NOT_IN_PLAY`
  and the panel waits for play without spending an attempt.
* **Port 2** — research drivers take an optional second-controller mask (NES,
  Sega, SNES).

## 3. Results

| | R1 (solo) | R2 (2P candidate) |
|---|---|---|
| entry from power-on | PLAYING, 8 442 frames, 10 steps (Start ×3, A ×1) | PLAYING, 39 042 frames, 41 steps (Start ×17, A ×4, B ×8: title, character select, story text, intro) |
| survival discovery | **VERIFIED**, TERMINAL, 30 816 frames, 29.8 s (Node) | **VERIFIED**, TERMINAL, 76 472 frames, 85.1 s (Node) |
| discovery runs ending | 6 / 6 (neutral at 576 frames, random 640–1 216) | 4 / 6 (game over at 2 240–2 688 frames under random play; idling never died in 3 600) |
| calibration / holdout | confirmed / confirmed | confirmed / confirmed |
| oracle (opened after) | resource **match** (health bar); progress **match** (score word), 1 extra progress field | resource **match** after the oracle was corrected (the chosen byte is the per-life health bar, checked against the HUD frame by frame; the oracle had listed only the lives counter); progress: no oracle (the HUD shows no score) |
| browser worker (Chromium, from live play) | VERIFIED in 33.5 s, 32 936 frames | — |
| background run at the title | `NOT_IN_PLAY` in 0.8 s, 720 frames (was 12 371 frames and a refusal) | — |
| port 2 | no effect at all (solo game, nothing to join) | port 2 joins with two Start presses (4 586 frames); port-2 survival **VERIFIED** (per-loss counter), calibration and holdout confirmed; see the finding below |

R2 has two real loss resources: a lives counter and a per-life three-segment
health bar that refills on each new life. Which one is chosen depends on the
start state (from one start the lives counter, from another the health bar —
the denser signal); both were confirmed against the HUD frame by frame. The
oracle file had listed only the lives counter and was corrected after that
check.

**Two-player finding (R2).** Pressing Start on controller 2 during play makes
player 2 join (found automatically: two presses, both ports then PLAYING). On
this cartridge the join costs player 1 a life, and player 2's deaths take lives
from player 1's stock: the lives counter player 1 loses in solo play also falls
when only controller 2 plays. A per-player attribution must therefore allow a
**shared** resource; the port-2 survival search verified a death-aligned counter
of its own.

## 4. Learning on real frames (FDB production learner, frozen evaluation)

30-neuron mechanism fixture graph, 16-cell luminance retina, actions = no-op,
four directions, two buttons, direction + button; 2 400 training steps of 8
frames from four training starts; evaluation frozen (weights and update count
verified unchanged) on three holdout starts of separate origin, 300 steps cap
each. Reward = the live verified objective: −1 per verified loss, PROVISIONAL
progress at the aggressive policy.

| | seed | verified / provisional payouts | survival steps untrained → trained (random) | progress untrained → trained (random) |
|---|---|---|---|---|
| R1 | 11 | 165 / 107 | 154 → **204** (306) | 121 → 60 (2 811) |
| R1 | 23 | 109 / 239 | 154 → **170** (279) | 121 → **242** (1 457) |
| R2 | 11 | 21 / 65 | 900 → 900 (798) | 0 → 0 (216) |
| R2 | 23 | 10 / 56 | 900 → 900 (489) | 0 → 0 (423) |

What this shows, plainly:

* The chain runs end to end on real frames with no hand-written reward:
  discovery → verified profile → broker → native weight changes (5 000–10 000
  on R1).
* On R1 training improved survival over the untrained layer on both seeds
  (+32 %, +10 %), but **a seeded random policy beats the trained layer** on
  survival and by an order of magnitude on score. On R2 both learned and
  untrained layers stand still: they never die and never progress, while random
  play dies and progresses.
* **Root cause, in the production decision rule**: an action's score is the sum
  over its button bits of (rate / threshold − 1). While output neurons are quiet
  every button costs −1 and the empty mask scores 0, so the frozen argmax picks
  "press nothing". Removing the no-op from the action set (`REALROM_NOOP=0`) on
  R1: survival 179 → 170 (no gain), score 60 → 242 (×4), still far below random
  (2 377–2 913). The other limits are the 16-cell luminance retina (bullets and
  enemies are invisible at that resolution) and the 30-neuron fixture graph.

**The argmax hid a second fact.** With a frozen *stochastic* evaluation
(`REALROM_EVAL=stochastic`: sample from the layer's own policy, no feedback,
weights and update counts verified unchanged), R1:

| seed | survival untrained → trained (random) | progress untrained → trained (random) |
|---|---|---|
| 11 | **406** → 226 (306) | **4 360** → 1 086 (2 811) |
| 23 | **288** → 252 (279) | **1 965** → 1 877 (1 457) |

Sampled, the untrained layer is as good as random or better, and **training
with the verified reward makes it worse**. The reward is right; the credit is
not: a hit is paid to whichever 8-frame action was running when it landed,
while what caused it is where the player was over the preceding second or two.
Immediate credit on a real game teaches noise and narrows the policy. This,
not the discovery side, is now the bottleneck for "a level passed
automatically".

**Carry, measured (2026-11-11, later the same day).** `FdbLearning.carry`
folds an interval with no verified event into the eligibility traces and does
nothing else (no reward, no baseline change, no update, no replay record).
Same seeds, starts, budget and sampled frozen evaluation:

| | seed | trained, `boundary` (old) | trained, `carry` | untrained | random |
|---|---|---|---|---|---|
| R1 survival | 11 | 226 | **300** | 406 | 306 |
| R1 survival | 23 | 252 | **373** | 288 | 279 |
| R1 progress | 11 | 1 086 | **2 604** | 4 360 | 2 811 |
| R1 progress | 23 | 1 877 | **4 119** | 1 965 | 1 457 |
| R2 solo progress (losses) | 11 | 283 (2) | 3 (0) | 95 (4) | 216 (6) |
| R2 solo progress (losses) | 23 | 3 (0) | 143 (1) | 144 (6) | 423 (9) |

On R1 carry improves the trained layer on every number and both seeds, and on
seed 23 it beats both the untrained layer and random play. On R2 solo it is
mixed: the trained layer survives the whole evaluation either way and barely
progresses, with either credit rule. Carry is now the app default
(`GU_FDB_CARRY=false` restores the old rule); a human taking over still
breaks the link. The R2 passivity is the open problem.

**No level was completed automatically.** Nothing here was run on a phone.

## 4b. SNES, and the decision side (2026-11-12)

Two more private cartridges, SNES, by hash only (`realrom-snes-decision.json`):

| tag | SHA-256 | bytes | role |
|---|---|---|---|
| R3 | `a93ea87fc835c530b5135c5294433d15eef6dbf656144b387e89ac19cf864996` | 1 048 576 | run-and-gun (lives, score) |
| R4 | `4c15013131351e694e05f22e38bb1b3e4031dedac77ec75abecebe8520d82d5f` | 2 097 152 | action RPG (long intro, naming, dialogue) |

**What SNES broke, and what was fixed (each found on these cartridges):**

* A raw research snapshot made by one Snes9x core was rejected by a fresh core:
  the core allocates its state buffer on its first save, and the pointer is 0
  until then. `restore()` now saves once when the buffer is missing (driver
  check 85/85; without the fix the three new assertions fail).
* R4's attract sequence runs ~3000 frames before the title takes input; the
  entry procedure spent its budget on probes. Waits now double while nothing
  answers (60 → 960 frames). R4: intro, title, new game and the opening
  dialogue to a controllable hero in **37 606 frames, no script**.
* On R3's title, Select moved "1 PLAYER" to "2 PLAYERS", and every measurement
  was of a two-player game with an idle player 2. Select/Mode are now used only
  when no other button advances the screen. R3: 1-player play in **10 502 frames**.
* R3's lives counter (3, 2, 1, 0 into GAME OVER) tied on every count with a byte
  that fell once; ties are now broken by how much of its range a field spends
  before the ending.

| | R3 (SNES run-and-gun) | R4 (SNES RPG) |
|---|---|---|
| survival discovery | **VERIFIED**, terminal, 67 368 frames; calibration and holdout confirmed | **REFUSED**: no ending within 3 600 frames in any of 6 runs - nothing in the opening area can hurt the hero, so nothing was verified and nothing was invented |
| oracle (opened after) | resource **match** (lives); progress **no match**: the four progress fields are level-advance counters, the HUD score was not among them | - |

**The decision prior.** Survival discovery now measures, per button, the lift
of being held 0..7 strides before a progress rise (best lag reported; a lift at
each lag, because a press-edge game makes the step before the event empty and
an average cancelled to 1.0 on the synthetic check). The buttons the game pays
for are added to the agent's action set. Trained progress, seeds 11 / 23, carry
on, 2400 steps, frozen evaluation (weights checked unchanged):

| | default set (old) | v1 replace set + bias | v2 add + bias | **v3 add, no bias (app)** | random (v3 set) |
|---|---|---|---|---|---|
| R3 argmax | 126 / 0 | 725 / 725 | 126 / 725 | **725 / 725** | 208 / 200 |
| R3 sampled | 228 / 2 | 618 / 718 | 704 / 817 | **747 / 650** | |
| R2 argmax | 74 / 74 | 74 / 74 | 492 / 941 | 74 / 74 | 1703 / 1274 |
| R2 sampled | 604 / 74 | 2613 / 1974 | 1926 / 2293 | **1804 / 3119** | |
| R1 argmax | 1550 / 3459 | 60 / 60 | 60 / 242 | 120 / **3820** | 3131 / 1992 |
| R1 sampled | 1813 / 2792 | 60 / 60 | 1006 / 1779 | 725 / **4927** | |

v1 **replaced** the default set and on R1 lost the fire button, whose effect
arrives after the bullet travels, beyond the lags then used: progress fell to
60. v3 adds instead. Summed over seeds and both evaluations, v3 against the
old set: R3 356 → **2847**, R2 752 → **5071**, R1 9614 → 9592 (one seed better
than ever, one worse). v3 is the app default (`GU_AGOD_DECISION=false` turns
it off; a set the person typed is never replaced). The innate bias helped R2
under argmax and hurt R1, so it is not applied in the app.

In R3 the trained layer now advances and dies (9 losses = every life) where the
old one stood still and lived: that is playing the game, and it is still not
finishing a stage.

## 4c. Control authority, rare cells, two time scales (2026-11-12, later)

Targeted additions, no refactor (method notes and the ranking of all proposals:
[`METHODS_RESEARCH.md`](METHODS_RESEARCH.md)).

**AGOD, two signals besides the terminal ending** (`agod-pipeline-survival-r2`):

* **Control authority.** The phase probe already finds, causally, the RAM fields
  that integrate a held direction; it now also exports the sign each field moves
  with. A passive tracker checks every 8-frame stride: did a commanded direction
  move one of those fields the commanded way? A run of ignored commands (2
  strides in both directions - a wall blocks one, a stun both - or 4 in a row)
  is a loss of control. Rollouts record these drops; a fall of a field followed
  within two active strides by a drop is a **hit**.
* **Rare-RAM step cells.** Cells that change at most once per second of play
  are counted by what they do (fall only / rise only / mixed). They are
  evidence, not reward: a rare cell becomes a goal only as a `PER_HIT`
  candidate - it falls >= 3 times, >= 60 % of falls are followed by a loss of
  control, at least twice the base rate of drops, never like a clock - and then
  passes the same calibration and holdout as every other goal (judgement
  `HIT_POINTS`). Synthetic check: a health game with 90 frames of knock-back and
  no game over in reach is verified as `HIT_POINTS`; the old games keep their
  old verdicts (26/26).

**FDB, two changes to carry** (unpaid eligibility):

* `dual-time-v1`: a fast trace (tau 15 frames) and a slow one (tau 90 frames),
  both decaying by GAME time; eligibility = half of each. Selectable in the lab
  ("Fast 15 + Slow 90 кадров"); `dual-v1` aged its slow trace per decision.
* **Pause on authority loss**: `carry(..., accumulate=false)` decays the traces
  and adds nothing - the decision taken while the game ignores the pad
  (respawn, invulnerability, transitions) is not a cause of what follows. It is
  counted apart (`paused`), pays nothing, and clears nothing.
  `fdb_carry_check`: 10/10, `FrozenFdbCheck` now covers four profiles.

**A/B on real cartridges** (carry on, discovery action set, 2 400 training
steps, frozen evaluation with weights and update counts checked unchanged;
progress = sum over the discovered progress fields; runs are deterministic: the
R3 baseline reproduces the v3 row above exactly).

Progress is summed over argmax and sampled evaluations; losses over both.

| | seeds | baseline (single-v1) | dual-time-v1 | dual-time-v1 + pause |
|---|---|---|---|---|
| R3 progress | 11, 23 | 2 847 | 2 796 | 2 578 |
| R3 progress | 11, 23, 37, 41 | 3 912 | - | **4 254** (+9 %) |
| R3 losses of life | 11, 23, 37, 41 | 72 | - | 72 |
| R2 progress | 11, 23 | 5 071 | 4 646 | 4 194 |
| R2 progress | 11, 23, 37, 41 | **12 062** | - | 10 466 (-13 %) |
| R2 losses of life | 11, 23, 37, 41 | 33 | - | 41 |

The pause fired on 1-2.5 % of R3's unpaid intervals and 7-9 % of R2's.
Per-seed rows: `realrom-credit-ab.json`.

**What this says, plainly.** Neither change gives a consistent gain: on R3 the
pause is +9 % in progress and every life is still spent; on R2 it is -13 % and
dies more. Seed variance dominates - an earlier run of the same R2 variant,
whose tracker skipped the strides that carried an event (a difference in which
~1 % of strides are paused), scored 6 611 on seeds 11/23 against 4 194 now.
**App defaults are unchanged**: carry stays single-time, `dual-time-v1` is a
lab option, the pause is a measurement option (`REALROM_CREDIT_PROFILE`,
`REALROM_PAUSE=1`) and is not wired into the live loop.

Why credit reach does not move R3: per training run it pays ~1 150 provisional
progress events (0.25-1 each) and ~46 verified losses (-1 each). Each loss
outweighs any single progress payment, but the sum is dominated by progress,
and no trace length changes that sum - under every variant and every seed R3's
trained policy spends all 9 lives. The levers that change what is
learned are the payment balance and more loss evidence per death (section 5).

**R4 (SNES RPG), honestly.** Discovery with the new signals, same entry
(37 606 frames to a controllable hero), 62 536 frames: no run ends, and the
tracker sees control lost 0-3 times per run (8 drops in 6 runs; their cause was
not inspected - a text box or a door stops the hero just as a hit would). One rare cell fell before such drops often
enough to be proposed as `PER_HIT`; the calibration runs (3 falls, 0 followed
by a loss of control) and the holdout runs (2 falls, 0) contradicted it, and
the registry refused. **Still REFUSED, now on evidence rather than on absence**:
the hit signal looked, proposed, and was refuted on states it had not seen. So
there is no verified objective on R4 and no learning A/B is possible there -
running one would mean paying for something nobody verified. Of 596 rare cells
574 move both ways; 7 only fall. The way forward on R4 is exploration that
reaches enemies (Go-Explore-style archive inside discovery, METHODS_RESEARCH
item 5), not a reward.

## 5. Next steps this data points to

Ranked with sources in [`METHODS_RESEARCH.md`](METHODS_RESEARCH.md). In short:

1. **Counterfactual rewind at a verified loss** (research worker / autonomous
   runs only, never the person's game): restore 72-96 frames before the loss,
   run 4-6 branches, register paired evidence (same state: action X -> verified
   loss, action Y -> none). It multiplies the scarcest data - R3 discovery sees
   ~7 losses - and costs ~660 frames per loss at 0.4-0.5 ms per restore.
2. **Exploration that reaches danger** on R4: a Go-Explore-style archive inside
   discovery (cells by screen and coarse position, return by snapshot). It
   steers where discovery looks; novelty is never paid.
3. Done: carry (2026-11-11), two time scales and the pause (4c above) - credit
   reach is no longer what limits R3: under every variant it spends all 9
   lives.
4. Observation: a retina with spatial resolution for sprites, or RAM-derived
   inputs (the discovered position integrators are a free player-position
   sensor).
5. Per-player attribution from per-port control loss.

## Reproduce

```
AGOD_PRIVATE_ROMS=/path/to/private node tools/agod_realrom_check.cjs --2p \
  [--fdb with CODE_CLASSPATH] --out realrom-analytics.json
node tools/agod_survival_check.cjs     # synthetic, runs in CI: 26/26
```
