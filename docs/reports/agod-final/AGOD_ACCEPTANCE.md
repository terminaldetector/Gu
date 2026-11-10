# AGOD_ACCEPTANCE — against the final directive of 2026-11-10

Baseline revision: `5b6e974`. Everything below is measured on a Linux host (Node 22, JVM, jsnes and
the WASM cores). **Nothing here is a physical-Android measurement.** Host, emulator and device are
kept apart in every row.

## Gate matrix

| Gate | Status | Evidence |
|---|---|---|
| D-CAUSAL | **PASS** (host) | `agod_d1_frontier_check.cjs` 39/39; `agod_g5_sequence_check.cjs` 28/28 |
| D-GOAL | **PARTIAL** | resources/selectors/echoes told apart; polarity as in G4 68/68; phase is RESPONSIVE/UNKNOWN only; new D2 deception fixtures NOT added |
| L-BRIDGE | **PASS** (host, production classes) | `agod_l1_bridge_check.cjs` 48/48; in-app reward path in `agod_app_e2e_check.cjs` step 14 |
| L-FROZEN | **PASS** (host) | every frozen evaluation left updates, RNG, edges, weights unchanged; UNKNOWN source: 0 reward calls, 0 updates |
| L-IMPROVEMENT | **PASS for the bridge; NEGATIVE for the one L2 ablation** | frozen A/B below; "measured zero" tried and reverted |
| PLATFORM | **PASS** (host) | `agod_platform_driver_check.cjs` 81/81; `agod_g4_platform_scenarios.cjs` 68/68, 0 blocked; `agod_g3_…` 36/36 |
| UX | **PARTIAL** | host E2E: status line, stop, cartridge change, live game untouched. Background autostart only runs where the native bridge exists — not exercised on host |
| APK | **BUILT, NOT LAUNCHED** | Gradle `assembleDebug` exit 0; all AGOD assets, three cores and both connectomes verified inside the APK; no INTERNET permission. Launch smoke **BLOCKED**: no KVM, and the software emulator's system server dies on every install (see `BUILD_MANIFEST.md`) |
| RELEASE | **PARTIAL** | debug APK + SHA-256 + manifest. No release signature. |
| regression | **PASS** | `bash tools/check.sh` exit 0, 134 PASS lines (before the AGOD gates were added to it); GitHub Actions run 229 on `fd8adec` - the whole workflow, including `check.sh` WITH the AGOD gates, `check_full_dual.sh` and both APK builds - concluded `success` |
| `agod_phase_detector_regression` | **BLOCKED** | `AGOD_PRIVATE_ROMS` absent; no fixture substituted |
| physical Android | **DEVICE-PENDING** | no device attached to this environment |

## What is better than `5b6e974`, with the measurement

| Area | At `5b6e974` | Now | Measured how |
|---|---|---|---|
| Three-step dependency with a hidden middle state | not found: the pair-extending search confirms nothing deeper than 1 step (196 experiments) | found: `A → B → Start`, order-sensitive, 3/3 starts, both windows and the delay measured as intervals | `agod_d1_frontier_check.cjs` §1–2 |
| Search cost for depth 3 | would be 584 sequences exhaustively | 72 expansions, 149 experiments, 12,550 frames, 11.2 s | same |
| Resources vs counters | one byte at a time | 2 resources with floor and restoring action; 2 input echoes (one falling), 1 transient, 2 time-driven counters correctly excluded | same §3 |
| Discovery → learning | no path: the learner needed a hand-typed RAM address | verified reward from the discovered goal reaches `FdbLearning.feedback` | `agod_l1_bridge_check.cjs` |
| Behaviour (frozen, same starts/seeds, resource lost in 60 steps) | — | untrained 26 / trained **0** / seeded random 13–14, on 3 seeds | same §A/B |
| Blind homebrew | none | 4 causal claims confirmed against the game's headers; 1 role label wrong and fixed | `docs/reports/agod-final/blind-openNES-Snake.*` |
| Heap during search | 430 MB peak | 265 MB peak (host) | drop flattened savestates after signature |

## Not better, said plainly

- **L2 optimisation: 0 confirmed.** "Measured zero" credit was not consistently better than paying
  losses only across 120/160/200 training steps × 3 seeds, and was reverted.
- **A saturated habit is not unlearned.** With a prior ≥ 4 toward the costly action, ~1600 weight
  changes in 240 steps changed no behaviour. The 26 → 0 result holds for prior 3 (chosen on seed 11;
  seeds 23 and 37 held out). This is the first concrete target for the learner itself.
- **The full-connectome run adds nothing behavioural.** On FlyWire 783 (138,639 neurons, 15,091,983
  base edges) the L1 check gives the same numbers as the 30-neuron fixture, because learning acts in
  the acquired layer between technical ports. It shows the chain runs with W₀ intact, not that the
  connectome contributed. Male CNS was not run through this check.
- **The learning task is a bandit**: the screen does not depend on game state.
- **No latency, energy, FPS or RSS measurement on Android exists.** A2 is entirely DEVICE-PENDING.

## Failures found by running, all mine

1. Depth-1 `lastAlone` control was the experiment itself (fixed before `5b6e974`, kept fixed).
2. `frame` added to the reward snapshot broke `fdb_feedback_check.cjs` in its isolated context — caught by `check.sh`.
3. The run panel echoed a refusal text containing "VERIFIED" — caught by the existing E2E assertion.
4. The L1 harness's first prior (8) saturated the policy; its first cartridge rendered black.
5. Blind run: a direction selector labelled `ACCUMULATOR_CANDIDATE`.
6. The build-manifest check looked for `brain.fly.gz` inside the APK; the build stores it as `brain.fly`.

## Open, in order

1. **Install and launch the APK at all** — it has not been started anywhere — then run the chain on a physical device (A1/A2), including background discovery under load.
2. The learner's saturation limit, with ablations, on a task whose screen depends on state.
3. D2 deception fixtures (score↑ at defeat, false win after reset) and live contradiction → revoke.
4. Phase detection beyond RESPONSIVE/UNKNOWN; private-ROM corpus for the blocked regression.
5. Release signing — not changed here, by instruction.
