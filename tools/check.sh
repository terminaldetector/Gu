#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
python tools/test_convert.py "$task_tmp"
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/Graph.java app/src/main/java/org/node/flyconsole/GraphDelta.java app/src/main/java/org/node/flyconsole/FdbGrowth.java app/src/main/java/org/node/flyconsole/FdbLearning.java app/src/main/java/org/node/flyconsole/Engine.java app/src/main/java/org/node/flyconsole/Experiment.java tools/EngineCheck.java tools/ExperimentCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.EngineCheck "$task_tmp/test.fly"
javac -cp "$task_tmp/classes" -d "$task_tmp/classes" tools/GraphDeltaCheck.java tools/FdbGrowthCheck.java tools/FdbLearningCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.GraphDeltaCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbGrowthCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbLearningCheck

java -cp "$task_tmp/classes" org.node.flyconsole.ExperimentCheck
node tools/nes_check.cjs
node --check app/src/main/assets/lab/lab.js
node tools/gmode_check.cjs
node tools/system_controls_check.cjs
node tools/console_reset_check.cjs
node tools/runtime_flow_check.cjs
node tools/controller_check.cjs
node tools/settings_check.cjs
node --check app/src/main/assets/lab/state-ui.js
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
node tools/dual_ui_check.cjs
node tools/dual_routing_check.cjs
node tools/layer_sets_check.cjs
node --check app/src/main/assets/lab/layer-ui.js

node tools/game_tools_check.cjs

python - "$task_tmp/json.jar" <<'PYJSON'
import urllib.request,hashlib,sys
b=urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar').read()
assert hashlib.sha256(b).hexdigest()=='3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed'
open(sys.argv[1],'wb').write(b)
PYJSON
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/InferenceProgram.java tools/InferenceCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.InferenceCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/LayerSetStore.java tools/LayerSetStoreCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.LayerSetStoreCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/FdbCheckpoint.java tools/FdbCheckpointCheck.java tools/FdbGameBridge.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.FdbCheckpointCheck
javac -cp "$task_tmp/classes:$task_tmp/json.jar" -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/DualAgentContext.java app/src/main/java/org/node/flyconsole/DualLayerStore.java app/src/main/java/org/node/flyconsole/DualRequestGuard.java tools/DualAgentCheck.java
java -cp "$task_tmp/classes:$task_tmp/json.jar" org.node.flyconsole.DualAgentCheck
CODE_CLASSPATH="$task_tmp/classes:$task_tmp/json.jar" node tools/fdb_game_check.cjs
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

