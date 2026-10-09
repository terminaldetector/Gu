#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")/.."
dual_test_tmp=$(mktemp -d)
trap 'rm -rf "$dual_test_tmp"' EXIT
python - "$dual_test_tmp/json.jar" <<'PY'
import urllib.request,hashlib,sys
b=urllib.request.urlopen('https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar').read()
assert hashlib.sha256(b).hexdigest()=='3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed'
open(sys.argv[1],'wb').write(b)
PY
javac -cp "$dual_test_tmp/json.jar" -d "$dual_test_tmp/classes" app/src/main/java/org/node/flyconsole/{Graph,GraphDelta,FdbGrowth,FdbLearning,Engine,Experiment,FdbCheckpoint,LayerSetStore,DualAgentContext,DualLayerStore,DualRequestGuard}.java tools/DualAgentCheck.java
java -Xmx1024m -cp "$dual_test_tmp/classes:$dual_test_tmp/json.jar" org.node.flyconsole.DualAgentCheck app/src/main/assets/brain.fly.gz app/src/main/assets/male-cns.fly.gz
CODE_CLASSPATH="$dual_test_tmp/classes:$dual_test_tmp/json.jar" DUAL_FLY_GRAPH=app/src/main/assets/brain.fly.gz node tools/dual_game_check.cjs
