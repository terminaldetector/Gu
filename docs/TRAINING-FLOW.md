# FlyConsole alpha19: training phases and game-time acceleration

The production WebView uses the existing single-model learner, human session journal,
FDB feedback protocol and Layer Set store. No second plasticity engine was added.

## User flow

- **Automation** selects `train`, without human hints or manual rewards. It can use
  the neural/FDB controller or the existing external SARSA adapter. Configure a
  verified game score (screen discovery plus synchronized RAM confirmation) or
  a game-specific RAM reward; without it, this mode only explores.
- **REC** selects `teach`, recording only executed human actions at ×1. The neural
  engine observes without pressing gameplay buttons. **STOP → AUTO** closes the
  durable session, submits only outstanding human labels in bounded batches,
  waits for FDB acknowledgements and saves the acquired layer before handing over
  the same running ROM. Weight/FDB durability failure pauses the game and prevents handover. A full
  observation-archive failure is separate: existing records remain available,
  acquired weights are saved and the user can manage the archive.
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
It does not change neural weights, seed, epsilon or presets. Realtime keeps the
emulator clock running while CPU/GPU calculates the next decision. Native action
masks expire after 250 ms of executed game time, including the pending backend
interval. Lockstep deliberately waits; it remains the reproducible benchmark
clock. Expiration of a backend tail cannot rewrite the already captured outcome.
The feedback elapsed clock includes actual time between observations, while its
reward and executed-action frames belong only to the frozen observed interval.
If more than two seconds of game time expire, the feedback boundary clears old
eligibility without treating expected RT delay as an archive/durability failure.

Catch-up is capped; a batch has a 4 ms wall budget checked after each indivisible
core frame. Video presentation is assembled once per animation callback; retinal
sampling is calculated on an observation or an executed teacher label. Every core
frame still advances RAM, input provenance and learning time. Accelerated audio
is muted, and requested/achieved speed are shown separately. ×10 and phone GPU
smoothness are not guaranteed. Benchmarks force ×1 and an explicit lockstep clock.

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
native reply fixtures. It checks real fast-forwarded frames, continuous pending-backend RT, expired
action release and bounded observed reward intervals, exactly-once outstanding REC labels, same-ROM handover,
automation input isolation, executed streaming hints, Eval freeze, paused restore,
Male CNS selection for real Sega P2 and explicit P2 hints. The dual layout suite
also checks accelerated two-port outcomes. Existing native FDB, durability,
full-graph and GPU checks remain in CI. UI fixtures do not prove biological
fidelity or better gameplay. Physical Android and commercial ROM verification
are separate from these checks.
