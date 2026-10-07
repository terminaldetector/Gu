#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
python tools/test_convert.py "$task_tmp"
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/Graph.java app/src/main/java/org/node/flyconsole/Engine.java app/src/main/java/org/node/flyconsole/Experiment.java tools/EngineCheck.java tools/ExperimentCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.EngineCheck "$task_tmp/test.fly"

java -cp "$task_tmp/classes" org.node.flyconsole.ExperimentCheck
node tools/nes_check.cjs
node --check app/src/main/assets/lab/lab.js

node tools/learning_check.cjs

node tools/game_tools_check.cjs
