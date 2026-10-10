# FlyConsole alpha18: training phases and game-time acceleration

The production WebView uses the existing single-model learner, human session journal,
FDB feedback protocol and Layer Set store. No second plasticity engine was added.

## User flow

- **Automation** selects `train`, without human hints or manual rewards. It can use
  the neural/FDB controller or the existing external SARSA adapter. Configure a
  game-specific RAM reward; without it, this mode only explores.
- **REC** selects `teach`, recording only executed human actions at ×1. The neural
  engine observes without pressing gameplay buttons. **STOP → AUTO** closes the
  durable session, submits only outstanding human labels in bounded batches,
  waits for FDB acknowledgements and saves the acquired layer before handing over
  the same running ROM. A failure pauses the game and prevents the handover.
- **Streaming hints** selects `train` with explicit human guidance. A human
  gameplay action replaces the model action for that interval; the journal labels
  only that actually executed action. The interrupted interval cannot earn
  autonomous FDB or SARSA credit. In human + model 2P, the default input remains
  on the human port; **Hint the model** explicitly redirects it to the model port.
- **Evaluation** uses `eval`; existing policy and FDB freeze semantics remain.

Guidance is an optional field of the existing policy's `training` record, validated
on load and saved in Layer Sets. Old records default to automation. The page
reopens paused, at ×1. Two-model CPU sessions retain separate native Train/Eval
settings; REC/streaming imitation belongs to the one-model contour.

## Acceleration

The game toolbar's ×1/×2/×3/×5/×10 control changes real emulator-frame scheduling.
It does not change neural weights, seed, epsilon or presets. At speeds above ×1,
a connected model executes bounded game-time action blocks (at most about 100 ms)
then waits for the next native decision. The two-model contour shares the same
frame clock and pending guard. Both reward paths account for executed game time,
not display FPS. Catch-up is capped, and a frame batch has an 8 ms wall budget.
Intermediate video presentation is coalesced, but each core frame still updates
its observation, RAM, input provenance and learning interval. Accelerated audio is
muted; the UI shows requested and achieved speed separately. There is no guarantee
of ×10 on a given phone or with two full models. Benchmarks force ×1 and retain
an explicit lockstep clock.

The former Boost is a SARSA starting heuristic, now under training mechanism
settings. It is excluded from neural/FDB selection and no longer masquerades as
an emulator-speed control.

## Player selection and layout

Human + model has a visible FlyWire/Male CNS selector. Launch uses the existing
acknowledged model-selection boundary and waits for the matching learned set to
restore before assigning the neural controller to P2 (or P1 in the reversed
layout). Two independent models still use the original dual controller.

The game surface shows training phase and speed, large eight-way touch controls,
and optional telemetry. Advanced engine parameters remain in expandable settings;
no RetroArch code or artwork was copied.

## Checks and limits

`training_flow_ui_check.cjs` runs real NES/MD/SNES/GB WASM/JS cores with explicit
native reply fixtures. It checks real fast-forwarded frames, bounded accelerated
reward intervals, exactly-once outstanding REC labels, same-ROM handover,
automation input isolation, executed streaming hints, Eval freeze, paused restore,
Male CNS selection for real Sega P2 and explicit P2 hints. The dual layout suite
also checks accelerated two-port outcomes. Existing native FDB, durability,
full-graph and GPU checks remain in CI. UI fixtures do not prove biological
fidelity or better gameplay. Physical Android and commercial ROM verification
are separate from these checks.
