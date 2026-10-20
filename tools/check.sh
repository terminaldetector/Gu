#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
python tools/test_convert.py "$task_tmp"
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/Graph.java app/src/main/java/org/node/flyconsole/GraphDelta.java app/src/main/java/org/node/flyconsole/FdbGrowth.java app/src/main/java/org/node/flyconsole/FdbLearning.java app/src/main/java/org/node/flyconsole/Engine.java app/src/main/java/org/node/flyconsole/Experiment.java tools/EngineCheck.java tools/ExperimentCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.EngineCheck "$task_tmp/test.fly"
javac -cp "$task_tmp/classes" -d "$task_tmp/classes" tools/GraphDeltaCheck.java tools/FdbGrowthCheck.java tools/FdbLearningCheck.java tools/FdbUnknownRewardCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.GraphDeltaCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbGrowthCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbLearningCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbUnknownRewardCheck

java -cp "$task_tmp/classes" org.node.flyconsole.ExperimentCheck
node tools/nes_check.cjs
node --check app/src/main/assets/lab/lab.js
node tools/gmode_check.cjs
node tools/system_controls_check.cjs
node tools/console_reset_check.cjs
node tools/neural_isolation_check.cjs
node tools/current_gate_check.cjs
node tools/save_states_check.cjs
node tools/save_states_ui_check.cjs
node tools/runtime_flow_check.cjs
node tools/emulation_clock_check.cjs
node tools/controller_check.cjs
node tools/action_hold_check.cjs
node tools/score_search_check.cjs
node --check app/src/main/assets/lab/score-ui.js
node tools/settings_check.cjs
node tools/interface_settings_check.cjs
node --check app/src/main/assets/lab/interface-ui.js
node --check app/src/main/assets/lab/state-ui.js
node --check app/src/main/assets/lab/session-logger.js
python tools/inspect_diagnostics_check.py
node --check app/src/main/assets/lab/episode-starts.js
node --check app/src/main/assets/lab/shell-ui.js
node --check app/src/main/assets/lab/training-flow.js
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/RomImport.java tools/RomImportCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.RomImportCheck
node tools/two_player_mode_check.cjs
python tools/gpu_shader_check.py

node tools/learning_check.cjs
node tools/demonstration_check.cjs
node tools/human_capture_check.cjs
node tools/training_sessions_check.cjs
node tools/archive_replay_check.cjs
node --check app/src/main/assets/lab/archive-ui.js
node --check app/src/main/assets/lab/training-journal.js
node tools/fdb_feedback_check.cjs
node tools/fdb_reward_check.cjs
node tools/model_ui_check.cjs
node tools/synthetic_import_check.cjs
node tools/shared_experience_check.cjs
node tools/shared_experience_ui_check.cjs
node --check app/src/main/assets/lab/shared-experience-ui.js
node tools/dual_ui_check.cjs
node tools/dual_routing_check.cjs
node tools/layer_sets_check.cjs
node tools/current_layer_check.cjs
node --check app/src/main/assets/lab/layer-ui.js

node tools/game_tools_check.cjs

python - "$task_tmp/json.jar" <<'PYJSON'
import urllib.request,hashlib,sys
b=urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar').read()
assert hashlib.sha256(b).hexdigest()=='3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed'
open(sys.argv[1],'wb').write(b)
PYJSON
javac -cp "$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/LabRequestFailure.java tools/LabRequestFailureCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.LabRequestFailureCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/GraphCache.java app/src/main/java/org/node/flyconsole/SyntheticGraphJson.java tools/GraphIdentityCheck.java tools/SyntheticGraphCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.GraphIdentityCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.SyntheticGraphCheck examples/synthetic/*.json
javac -cp "$task_tmp/json.jar" -d "$task_tmp/controller" tools/controller-fixture/android/content/Context.java tools/controller-fixture/android/hardware/input/InputManager.java tools/controller-fixture/android/view/*.java app/src/main/java/org/node/flyconsole/ControllerInput.java tools/ControllerInputCheck.java
java -cp "$task_tmp/controller:$task_tmp/json.jar" org.node.flyconsole.ControllerInputCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/InferenceProgram.java tools/InferenceCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.InferenceCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/LayerSetStore.java tools/LayerSetStoreCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.LayerSetStoreCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/{CheckpointDigest,DiagnosticJournal,DiagnosticSummary}.java tools/DiagnosticJournalCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.DiagnosticJournalCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/{CheckpointDigest,LearnedRoles,ComparisonStore,EvaluationArchive,BestPromotionGate}.java tools/LearnedRolesCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.LearnedRolesCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/RomLibrary.java app/src/main/java/org/node/flyconsole/CheckpointDigest.java app/src/main/java/org/node/flyconsole/EpisodeHistory.java tools/RomLibraryCheck.java tools/EpisodeHistoryCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.RomLibraryCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.EpisodeHistoryCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/CurriculumStore.java app/src/main/java/org/node/flyconsole/FrozenSeries.java app/src/main/java/org/node/flyconsole/EvaluationArchive.java app/src/main/java/org/node/flyconsole/BestPromotionGate.java tools/CurriculumCheck.java tools/FrozenSeriesCheck.java tools/BestPromotionGateCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.CurriculumCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FrozenSeriesCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.BestPromotionGateCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/FdbLayerBinding.java tools/FdbLayerBindingCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbLayerBindingCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/FdbCheckpoint.java app/src/main/java/org/node/flyconsole/{IsolatedFdbContext,PairedEvaluation}.java tools/PairedEvaluationCheck.java tools/FdbCheckpointCheck.java tools/FdbIdentityCheck.java tools/FdbProjectionCheck.java tools/FdbProjectionCacheCheck.java tools/FdbDualCreditCheck.java tools/FrozenFdbCheck.java tools/FdbTemporalExperiment.java app/src/main/java/org/node/flyconsole/FdbDiagnostics.java app/src/main/java/org/node/flyconsole/GpuLayerSync.java tools/GpuLayerSyncCheck.java tools/FdbDiagnosticsCheck.java tools/SyntheticLearningCheck.java tools/FdbPlasticityCheck.java tools/ExpandedPlasticityCheck.java tools/FdbGameBridge.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.PairedEvaluationCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbCheckpointCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbIdentityCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbProjectionCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.SyntheticLearningCheck examples/synthetic/*.json
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbPlasticityCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.ExpandedPlasticityCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbProjectionCacheCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbDualCreditCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FrozenFdbCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.GpuLayerSyncCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbDiagnosticsCheck
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbTemporalExperiment "${FDB_TEMPORAL_REPORT:-$task_tmp/fdb-temporal}"
node tools/fdb_diagnostics_check.cjs
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/DualAgentContext.java app/src/main/java/org/node/flyconsole/DualLayerStore.java app/src/main/java/org/node/flyconsole/DualRequestGuard.java tools/DualAgentCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.DualAgentCheck
CODE_CLASSPATH="$task_tmp/classes:$task_tmp/json.jar" node tools/fdb_game_check.cjs
FDB_EXPANDED_FIXTURE=1 CODE_CLASSPATH="$task_tmp/classes:$task_tmp/json.jar" node tools/expanded_game_check.cjs
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/TrainingSessionStore.java tools/TrainingSessionStoreCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.TrainingSessionStoreCheck
node tools/sega_check.cjs
node tools/sega_rom_check.cjs
node tools/sega_p2_check.cjs
node tools/sega_six_button_check.cjs
node tools/sega_render_check.cjs

node tools/sega_learning_check.cjs
node tools/retro_check.cjs

javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/LabModule.java tools/CodeLabCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.CodeLabCheck
CODE_CLASSPATH="$task_tmp/classes:$task_tmp/json.jar" node tools/code_worker_check.cjs
node --check app/src/main/assets/code/lab.js

node tools/benchmark_check.cjs
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/GraphCache.java tools/ReleaseCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.ReleaseCheck

