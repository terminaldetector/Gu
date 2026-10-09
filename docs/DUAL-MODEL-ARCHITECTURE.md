# Alpha16: two independently learned neural controllers

The same console advances once per game frame. P1 and P2 receive that shared
visual observation, but own separate instances of the existing CPU `Engine`,
`GraphDelta`, `FdbLearning`, eligibility state, action RNG and durable Layer Set.
Each slot can select FlyWire v783 or Male CNS v1.0. Identical selected models
share only immutable W₀. This composes the existing FDB implementation rather
than introducing another learning algorithm.

## Playing and teaching

1. Load a ROM, open **Network / 2P → Две нейронные модели**.
2. Select a model independently for P1/P2, seed and Train or Eval. FDB can be
   enabled independently. Train updates acquired Wexo; Eval freezes learning
   and action RNG. Initial human teaching remains in the existing single-agent
   **Обучение → Показываю сам** workflow.
3. Supply each slot's manual +1/−1 assessment or a verified RAM profile. RAM
   addresses/formats are game-specific. A shared screen does not imply a
   shared reward. Explicit team reward sends P1's profile to both agents; that
   is a cooperative criterion, not proof of individual causal contribution.
4. Start both networks. The emulator continues in realtime while the two CPU
   windows execute sequentially on the native worker. Neural updates may be
   substantially slower than game frames. Actual window timing is displayed.
5. Pause saves both sets. **Продолжить сохранённый FDB** restores acquired
   structure for the current platform / ROM / graph / slot. Clearing that
   checkbox creates a new set without deleting the old one. Preferences are
   restored without automatically starting the game.

NES, Sega MD and SNES have independent controller ports. GB has one controller;
GB link is not implemented. Either graph remains usable with FDB in the GB
single-agent loop. A game's own rules determine whether it supports two players.

## Temporal credit and boundaries

Commands are committed only after a successful console frame. Each outcome
contains its originating neural decision ID, actual mask, executed frame count,
game time and bounded reward. Shared RAM is captured once at the observation
cut. The following decision starts its reward interval only when the native
response activates its action; computation time after the cut is not attributed
to that new decision. Manual intervention invalidates only the affected port.

Native validates both requests before processing either. Session, epoch,
monotonic request token and frame guards reject stale/replayed observations.
Pause, background, freeze, emulator errors and configuration changes clear
pending credit and eligibility. Long-lived acquired weights, utility and RNG
survive valid boundaries. An inference timeout neutralizes controls. Save errors
pause the pair and remain visible; exit requires a durable acknowledgment before
single-agent configuration can replace the pair.

## Storage and memory

`DualLayerStore` uses the existing version-2 `LayerSetStore`; each actor has a
different UUID. The small atomic binding index is keyed by platform, ROM SHA,
graph SHA and P1/P2. Ownership and ordered ports are validated before restore.
Checkpoint files preserve ΔW, Wexo, learning RNG/baseline/utility/counters and
bounded trace state. Live LIF voltages, pending game actions and console phase
are reset on a fresh load. This is acquired-model continuity, not a whole-episode
snapshot. Pair installation stages both checkpoints and rolls back new files if
the second write or index commit fails. Per-window saves are independently atomic;
the two files are not a crash-proof cross-file transaction.

The mixed full-model graph plus two-engine array estimate is **360,477,724 bytes
(343.8 MiB)**, before WebView, WASM, retained single-engine state and object
overhead. Native checks additional allocations against available heap with a
64 MiB reserve; an unsuitable device receives an error without installing half
a pair. Pair operation currently uses CPU. Two concurrent GPU contexts are not
enabled because the existing GPU engine's context ownership needs further work.

Android packaging may unpack `.fly.gz` into `.fly`; both built-in loaders accept
either packaged name, retaining the same graph fingerprint.

## Reproducible verification

| Check | Actual scope |
|---|---|
| `DualAgentCheck` without paths | Explicit 30-neuron mechanism fixture |
| `DualAgentCheck` with both full paths | Pinned 138,639-neuron FlyWire and 165,122-neuron Male CNS; separate dynamics/FDB/RNG, asymmetric rewards, frozen Eval, continued learning, identity rejection and pair-write rollback |
| `dual_game_check.cjs` | Real full graphs, actual Genesis Plus GX / Snes9x WASM, shared retinal observation and physical P1/P2 register reads; independent reward updates and P1-only checkpoint reload |
| `dual_routing_check.cjs` | Production frontend routing, manual priority and exactly one console frame per shared observation |
| `dual_ui_check.cjs` | Production coordinator, reward interval cuts, stale contexts, safe exit and per-ROM preferences |
| `dual_layout_check.cjs` | Production frontend and real NES frames in Chromium with explicitly synthetic native replies; portrait/landscape cards and action outcomes |

The recovered host diagnostic used seeds 11/23, opposing masks [128,64]. Sega
read [+6,−6] hardware displacement after six frames and separate rewards
[+0.6,−0.6]; SNES serial registers read [+1,−1]. Each reward changed only its
own Wexo. Mean pair CPU cost for a 10 ms neural window was 221.8 ms (Sega) and
251.5 ms (SNES) while full tests ran concurrently. These are host diagnostics,
not phone FPS or commercial-game improvement. The existing baseline / fixed /
learned / checkpoint-resumed comparison remains in `fdb_game_check.cjs`; its
technical ports and intentionally biased fixed layer are documented in
[FDB architecture](FDB-ARCHITECTURE.md).

Growth alone is not an intelligence metric. Current evidence establishes that
the acquired structure affects simulated activity and actual game commands,
learns from bounded attributed outcomes, and persists. Held-out commercial game
success, biological equivalence and Android sustained performance remain
unproven. New neurons/modules require proper dynamics, addressing, serialization
and CPU/GPU support and are not added formally in this release.
