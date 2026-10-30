#!/bin/sh
# Regression test for the commit guard, including the defect Sol found: content
# must be read from the git index, not the working tree.
set -eu
cd "$(git rev-parse --show-toplevel)"
GUARD=./tools/check_no_private_binaries.sh
ROMS=${AGOD_PRIVATE_ROMS:?set AGOD_PRIVATE_ROMS to the private corpus directory}
pass=0; fail=0
check() { # name expected_exit
  name=$1; expected=$2
  set +e; $GUARD >/tmp/guard_out.$$ 2>&1; actual=$?; set -e
  if [ "$actual" -eq "$expected" ]; then
    echo "  PASS  $name (exit $actual)"; pass=$((pass+1))
  else
    echo "  FAIL  $name (exit $actual, expected $expected)"; sed 's/^/        /' /tmp/guard_out.$$; fail=$((fail+1))
  fi
  rm -f /tmp/guard_out.$$
}
cleanup() { git reset -q HEAD -- tmp_guard_probe.dat 2>/dev/null || true; rm -f tmp_guard_probe.dat; }
trap cleanup EXIT

echo "1. a clean tree passes"
cleanup; check "clean index" 0

echo "2. a force-added ROM is refused"
cp "$ROMS/galaga.nes" tmp_guard_probe.dat
git add -f tmp_guard_probe.dat
check "ROM staged under an innocent name" 1

echo "3. THE DEFECT: ROM staged, then the working file replaced with safe content"
echo "this is harmless text" > tmp_guard_probe.dat   # index still holds the ROM
check "index holds ROM while the working tree looks clean" 1

echo "4. re-staging the safe content passes"
git add tmp_guard_probe.dat
check "safe content staged" 0

echo "5. a staged archive is refused"
cleanup
if command -v zip >/dev/null 2>&1; then
  echo hi > tmp_guard_probe.dat && zip -q tmp_guard_probe.zip tmp_guard_probe.dat && git add -f tmp_guard_probe.zip
  check "archive staged" 1
  git reset -q HEAD -- tmp_guard_probe.zip; rm -f tmp_guard_probe.zip
else
  printf 'PK\003\004rest-of-a-zip' > tmp_guard_probe.dat && git add -f tmp_guard_probe.dat
  check "ZIP magic staged under another name" 1
fi
cleanup

echo
echo "guard regression: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
