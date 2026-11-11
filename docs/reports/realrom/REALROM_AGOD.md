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

**No level was completed automatically.** Nothing here was run on a phone.

## 5. Next steps this data points to

1. Credit assignment over the time scale the game works on. FdbLearning has
   eligibility traces (τ ≈ 0.6 s), but every interval without a verified event
   calls `boundary()`, which clears them - that is how UNKNOWN ≠ 0 is kept - so
   on a real game, where 85–97 % of training intervals carry no event, a hit is credited
   to the last 8-frame decision only. Proposed: fold an UNKNOWN interval's
   decision into the traces *without* paying anything (no reward, no update,
   no replay record) and clear them only at real boundaries (restore, episode
   end, human input). Baseline to beat: the sampled untrained layer.
2. Decision rule: evaluate the sampled policy (as above), and stop the empty
   mask winning for free.
3. Observation: a retina with spatial resolution for sprites, or RAM-derived
   inputs (the discovered position integrators are a free player-position
   sensor).
4. Progress shaping from the survival data: the per-button attribution of
   progress events is already in the rollouts.
5. Per-player attribution from per-port control loss (which player lost
   control when the shared counter fell).

## Reproduce

```
AGOD_PRIVATE_ROMS=/path/to/private node tools/agod_realrom_check.cjs --2p \
  [--fdb with CODE_CLASSPATH] --out realrom-analytics.json
node tools/agod_survival_check.cjs     # synthetic, runs in CI: 20/20
```
