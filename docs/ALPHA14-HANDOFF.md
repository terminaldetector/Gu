# FlyConsole alpha14 — archive imitation experiment

Branch: `v2/gmode-fdb-gpu` in https://github.com/terminaldetector/Gu.
Source under CI: `421052a03d234dea467383f1d4675d8b6c7bb0c6`.
CI: https://github.com/terminaldetector/Gu/actions/runs/37819220945.
Release target: `org.node.flyconsole.nes`, `2.0.0-alpha14`, versionCode 22.
Current release state: CI running; signed APK not yet delivered.

## Implemented

- Bounded closed-session `read` RPC in native/private JSONL and localStorage fallback: at most 32 events, around 128 KiB payload; snapshot count/bytes and cursor sequence checks. Reads only committed data.
- `archive-replay.js`: fresh imitation weights, stable action identities, retained SARSA weights, 1–5 fixed passes; training/heldout session IDs must be disjoint and match platform/ROM/graph/ports. Only accepted executed samples teach. No ROM replay or FDB mutation.
- Holdout metrics: full action-mask agreement by sample/time, training-majority baseline, neutral fraction, unseen masks, skips, duration-weighted per-button precision/recall. Deterministic action-order ties; no epsilon, RNG updates, SARSA scores or network execution in this check.
- `archive-ui.js`: role selectors, progress/cancel, report export and explicit apply. Experiment never changes active weights. Apply verifies live model/configuration and source snapshots; replacing imitation persists Policy v3. ROM/frame and FDB stay intact.
- Policy v3 optional archive provenance (train/test IDs and snapshots, context, passes), with validation before mutation. Later live demonstration updates are counted separately. Compact FDB handoff gets only the final 200 first-pass training samples; full archive FDB replay remains unimplemented.
- Pause/background cancels processing. Error/cancellation retains active policy. Partial archive recording and export behavior from alpha13 remains.

## Validation

Passed locally: Java TrainingSessionStore reopen/crash-tail/paged history beyond 200; JS archive replay/cancellation/frozen holdout/provenance/metrics; previous learner actual NES task, demonstration, controller, system-control and Layer Set checks; syntax and git diff checks.
CI includes real WASM all platforms, Java/JS, portrait/landscape UI with candidate/apply assertions, GPU runtime, assembleDebug and lintDebug. Wait for final result before claiming a release.
Physical Android verification remains outstanding.

## Continuation

Follow docs/TRAINING.md for the exact scope. Do not label heldout stored-feature agreement as game success or an FDB benchmark. Repeated tuning against one control set weakens independence. Source sessions were originally used online; independence here applies to the newly reset imitation adapter. Archived neural features are not recomputed.

Next substantial tasks: explicit bounded full-archive FDB replay; human correction labels; validated commercial-ROM reward profiles; calibration of imitation vs SARSA; separate closed-loop FDB/game evaluation; richer vision/full neural output features.

Local mirror historically named Gu-alpha09. Do not replace the established release signing key. Keep private signing material out of repository and tool output. Preserve remote concurrent changes by checking branch head before every API tree commit.
