#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT

node tools/nes_check.cjs
node --check app/src/main/assets/lab/lab.js
node tools/emulator_independence_check.cjs
node tools/host_invariants_check.cjs
# F0/F1: newest-frame FrameSource and frame-bound ActionSink, wired into the real lab.js
node tools/frame_action_port_check.cjs
node tools/save_states_check.cjs
node tools/save_states_ui_check.cjs
node tools/emulation_clock_check.cjs
node tools/controller_check.cjs
node tools/score_search_check.cjs
node --check app/src/main/assets/lab/score-ui.js
node tools/settings_check.cjs
node tools/interface_settings_check.cjs
node --check app/src/main/assets/lab/interface-ui.js
node --check app/src/main/assets/lab/state-ui.js
node --check app/src/main/assets/lab/session-logger.js
node --check app/src/main/assets/lab/console-navigation.js
python tools/inspect_diagnostics_check.py
node --check app/src/main/assets/lab/episode-starts.js
node --check app/src/main/assets/lab/shell-ui.js
node --check app/src/main/assets/lab/frame-source.js
node --check app/src/main/assets/lab/action-sink.js
node --check app/src/main/assets/lab/fast-loop-probe.js
node --check app/src/main/assets/lab/fast-loop-worker.js
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/RomImport.java tools/RomImportCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.RomImportCheck
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/FrameProbe.java tools/FrameProbeCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.FrameProbeCheck

node tools/human_capture_check.cjs
node tools/training_sessions_check.cjs

node tools/game_tools_check.cjs
node --check app/src/main/assets/lab/core-probe.js
node --check app/src/main/assets/lab/goal-discovery-ui.js
node tools/core_probe_check.cjs
python3 tools/build_nes_trace.py --check
node tools/nes_write_trace_check.cjs
node tools/goal_discovery_check.cjs
node tools/objective_profiles_check.cjs
node tools/agod_rom_check.cjs

# GU_JSON_JAR: a local copy of the same jar (offline runs, rate-limited mirrors) - SHA-256 still pinned
python - "$task_tmp/json.jar" "${GU_JSON_JAR:-}" <<'PYJSON'
import urllib.request,hashlib,sys
b=open(sys.argv[2],'rb').read() if sys.argv[2] else urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar').read()
assert hashlib.sha256(b).hexdigest()=='3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed'
open(sys.argv[1],'wb').write(b)
PYJSON
javac -cp "$task_tmp/json.jar" -d "$task_tmp/controller" tools/controller-fixture/android/content/Context.java tools/controller-fixture/android/hardware/input/InputManager.java tools/controller-fixture/android/view/*.java app/src/main/java/org/node/flyconsole/ControllerInput.java tools/ControllerInputCheck.java
java -cp "$task_tmp/controller:$task_tmp/json.jar" org.node.flyconsole.ControllerInputCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/{CheckpointDigest,DiagnosticJournal,DiagnosticSummary}.java tools/DiagnosticJournalCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.DiagnosticJournalCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/RomLibrary.java app/src/main/java/org/node/flyconsole/CheckpointDigest.java app/src/main/java/org/node/flyconsole/EpisodeHistory.java tools/RomLibraryCheck.java tools/EpisodeHistoryCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.RomLibraryCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.EpisodeHistoryCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/CurriculumStore.java app/src/main/java/org/node/flyconsole/FrozenSeries.java app/src/main/java/org/node/flyconsole/EvaluationArchive.java app/src/main/java/org/node/flyconsole/BestPromotionGate.java tools/CurriculumCheck.java tools/FrozenSeriesCheck.java tools/BestPromotionGateCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.CurriculumCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FrozenSeriesCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.BestPromotionGateCheck
# AGOD gates: platform independence, four-console scenarios, temporal discovery,
# the three-step frontier search, survival, stage and the frontier archive. Each
# prints its own PASS/FAIL count and exits non-zero on a failure; a core that is
# not built is reported BLOCKED by the gate itself.
node tools/agod_g3_platform_independence_test.cjs
node tools/agod_platform_driver_check.cjs
node tools/agod_g4_platform_scenarios.cjs
node tools/agod_g5_sequence_check.cjs
node tools/agod_d1_frontier_check.cjs
node tools/agod_d2_progress_check.cjs
node tools/agod_survival_check.cjs
node tools/agod_stage_check.cjs
node tools/agod_explore_check.cjs
node tools/agod_realrom_check.cjs
# the AGOD research mechanisms (teacher, labeller, frontier archive, frozen evaluation,
# policy adapters) on the synthetic survival game - no private ROM, no neural backend
node tools/agod_research_check.cjs
# G1: the AGOD reward port - UNKNOWN is not 0, PROVISIONAL is not confirmed, one payment
# per event, no mixed ROM/epoch context; on a synthetic port and on the real AGOD chain
node tools/reward_port_check.cjs
node tools/realrom_observation_check.cjs
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/TrainingSessionStore.java tools/TrainingSessionStoreCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.TrainingSessionStoreCheck
node tools/sega_check.cjs
node tools/sega_rom_check.cjs
node tools/sega_p2_check.cjs
node tools/sega_six_button_check.cjs
node tools/sega_render_check.cjs

node tools/retro_check.cjs

node tools/benchmark_check.cjs

