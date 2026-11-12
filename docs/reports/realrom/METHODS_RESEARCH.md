# AGOD + FDB: which proposals can deliver, and the methods behind them

Date: 2026-11-12. Scope: turn AGOD (automatic goal discovery from the game's own
memory) plus FDB (the connectome's learned layer: memory, credit, skills) from
"advance aggressively" into a loop that also survives. The connectome alone is a
graph with no motive; AGOD supplies the stimuli (verified losses, provisional
progress), FDB turns them into lasting change. Decisions need both.

Constraints every method below has to respect (from the project's own rules):
a reward exists only for a verified event (UNKNOWN is never a number); the
reward belongs to the action actually executed; W0 never changes; train,
calibration and holdout come from states of separate origin; the person's live
game is never paused or rewound by the agent; offline only.

## What the measurements say the bottleneck is

| game | what training now does | what is left |
|---|---|---|
| SNES run-and-gun (R3) | with the discovery action set the agent advances ~4x further than random play | it spends every life (9 of 9) - deaths are the failure |
| Sega run-and-gun (R2) | sampled policy progresses 3-7x more than before | argmax policy still stands still |
| Sega shooter (R1) | even with the old set | dies at the same rate as random play |
| SNES RPG (R4) | - | random exploration never meets an enemy in 3 x 12 000 frames: nothing to verify, nothing to learn |

So the two open problems are **credit for deaths** (scarce, delayed events) and
**reaching danger at all** (R4). Proposals are ranked by how directly they
attack those two.

A third fact came out of this round's A/B (REALROM_AGOD.md section 4c): on R3
a training run pays ~1 150 provisional progress events (0.25-1 each) against
~46 verified losses (-1 each). Per event a provisional payment never outweighs
a loss; in total it outweighs them several times over. No credit time scale
changes that sum, which is why R3's trained policy spends every life under
every credit variant: advance and die.

## Ranked

### 1. Counterfactual rewind at a verified loss - highest expected value
At a verified loss, restore a snapshot from 72-96 frames earlier and run 4-6
short branches with other actions; a branch that does not lose is evidence about
the action, from the same state, in a deterministic emulator.
*Why it can work here:* raw snapshot/restore costs 0.4-0.5 ms on these cores and
replay is exact (driver check 85/85, including restore into a fresh core), so a
fan of 6 x 110 frames costs ~660 frames per loss. It produces data exactly where
data is scarcest (7 losses in a whole R3 discovery run).
*Method lineage:* Go-Explore returns to archived states and explores from them
([Ecoffet et al., Nature 2021](https://arxiv.org/abs/2004.12919)); hindsight
credit assignment scores past actions by how likely they made the observed
outcome ([Harutyunyan et al., NeurIPS 2019](https://proceedings.neurips.cc/paper/2019/hash/195f15384c2a79cedf293e4a847ce85c-Abstract.html)).
*What must change to be legal:* "the surviving branch gets a positive reward"
would pay for the ABSENCE of an event, which the reward policy forbids. The
compliant form is a PAIRED verification: same snapshot, action X -> verified
loss, action Y -> no loss, both executed, both replayed - registered as evidence
and paid through the broker. And only in the research worker or an autonomous
run, never in the game a person is playing.

### 2. Two time scales of eligibility - implemented (`dual-time-v1`), no consistent gain
Fast trace tau = 15 frames, slow tau = 90 frames, both by game time; eligibility
= 1/2 fast + 1/2 slow. The existing `dual-v1` aged its slow trace per DECISION,
so its reach depended on how often the agent decided.
*Method lineage:* three-factor (neo-Hebbian) rules with eligibility traces on
behavioural time scales ([Gerstner et al., Front. Neural Circuits 2018](https://www.frontiersin.org/journals/neural-circuits/articles/10.3389/fncir.2018.00053/full));
e-prop learns recurrent spiking networks online from eligibility traces plus a
learning signal ([Bellec et al., Nat. Commun. 2020](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7367848/)).
For delays far beyond 90 frames, return decomposition (RUDDER,
[Arjona-Medina et al.](https://arxiv.org/abs/1806.07857)) is the reference
approach; it needs a learned return model and is not proposed yet.

### 2b. Balance of provisional against verified payment - new, cheap, testable
Measured above: the provisional tier wins by volume. A budget such as "between
two verified losses, provisional payments add up to at most one loss" keeps
every per-event rule and changes the sum the policy optimises. It needs only
the existing ledger. To be A/B-tested like everything else here, not assumed.

### 3. Control authority - implemented (passive tracker + post-fall test)
For each 8-frame stride, did a field the phase probe found to follow the held
direction move the commanded way? Used twice: (a) a fall followed within two
active strides by ignored commands is a HIT (knock-back) - this verifies hit
points where no game over is in reach (`PER_HIT`, synthetic check 26/26);
(b) FDB pauses accumulation while authority is lost (`carry` with
`accumulate=false`: traces decay, nothing is added, nothing is cleared).
*Method lineage:* contingency awareness - the parts of an observation that
depend on the agent's last action ([Bellemare, Veness, Bowling, AAAI 2012](https://ojs.aaai.org/index.php/AAAI/article/view/8321));
the inverse-dynamics features of curiosity-driven exploration learn the same
"what my actions control" signal ([Pathak et al., ICML 2017](https://proceedings.mlr.press/v70/pathak17a.html)).
Here it is measured, not learned: the integrator fields are found causally.

### 4. Rare-RAM step tracker - implemented as evidence, not as reward
Cells with rare stepwise changes (at most one change per second of play) are
counted by behaviour (fall only / rise only / mixed) and gate `PER_HIT`. A cell
becomes a reward only after the same verification as every other goal - a rare
cell by itself is a candidate.

### 5. Reaching danger in a peaceful opening (R4) - next, exploration only
Go-Explore-style archive inside AGOD discovery: cells = (screen, coarse
position), return by snapshot, explore from the least visited. Novelty steers
WHERE discovery looks; it is never paid to FDB (a novelty reward would be a
number without a verified event).

### 6. Evasion attribution (near-miss windows) - after 1
Needs >= 15 loss events per button to mean anything; discovery sees ~7. The
rewind fan produces the paired data that makes it meaningful. "High RAM churn"
as a danger proxy is weak (scrolling and explosions churn too).

### 7. Three attribution windows 16/64/180 - partly there
Lift is already measured at every lag 0-56 frames, best lag reported. Longer
windows inflate chance lifts (best-of-many: a non-scoring button reached 1.41 on
the synthetic game where only A scores); extend only with a shuffled-time null.

### 8. Context-dependent action sets per FDB layer - defer
A 16-mask set was not the bottleneck (it gave the 4-7x gains); switching sets
per scene hash is a large change for an unmeasured benefit.

## Results of what was implemented

Full table: REALROM_AGOD.md, section 4c. In short:

* **AGOD signals** work as evidence: the synthetic HP game is verified as
  `HIT_POINTS` with no game over in reach; on R4 the hit signal proposed a
  candidate and the independent calibration/holdout runs refuted it, so R4
  stays REFUSED - on evidence now.
* **dual-time-v1 and the pause** did not give a consistent gain on R2 or R3
  over four seeds: they trade wins between seeds, and R3 dies on every life
  either way. They stay opt-in (lab selector; `REALROM_CREDIT_PROFILE`,
  `REALROM_PAUSE` in the measurement tool); the app defaults are unchanged.
  The pause fired on 1-2.5 % of R3's unpaid intervals and 7-9 % of R2's.
  Four seeds: R3 +9 % progress with the same 72 losses, R2 -13 % with 41
  losses against 33.
* So the next experiments are the ones that change WHAT is learned, not how
  far credit reaches: the rewind fan (1) and the payment balance (2b).
