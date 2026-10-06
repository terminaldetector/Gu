#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d)
trap 'rm -rf "$task_tmp"' EXIT
python tools/test_convert.py "$task_tmp"
javac -d "$task_tmp/classes" app/src/main/java/org/node/flyconsole/Graph.java app/src/main/java/org/node/flyconsole/Engine.java tools/EngineCheck.java
java -cp "$task_tmp/classes" org.node.flyconsole.EngineCheck "$task_tmp/test.fly"
