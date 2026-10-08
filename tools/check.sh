#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
python tools/test_convert.py "$task_tmp"
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/Graph.java app/src/main/java/org/node/flyconsole/GraphDelta.java app/src/main/java/org/node/flyconsole/FdbGrowth.java app/src/main/java/org/node/flyconsole/Engine.java app/src/main/java/org/node/flyconsole/Experiment.java tools/EngineCheck.java tools/ExperimentCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.EngineCheck "$task_tmp/test.fly"
javac -cp "$task_tmp/classes" -d "$task_tmp/classes" tools/GraphDeltaCheck.java tools/FdbGrowthCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.GraphDeltaCheck
java -cp "$task_tmp/classes" org.node.flyconsole.FdbGrowthCheck

java -cp "$task_tmp/classes" org.node.flyconsole.ExperimentCheck
node tools/nes_check.cjs
node --check app/src/main/assets/lab/lab.js
node tools/gmode_check.cjs
node tools/system_controls_check.cjs
node tools/console_reset_check.cjs
node tools/runtime_flow_check.cjs
node tools/controller_check.cjs
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/RomImport.java tools/RomImportCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.RomImportCheck
node tools/two_player_mode_check.cjs
python tools/gpu_shader_check.py

node tools/learning_check.cjs
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

