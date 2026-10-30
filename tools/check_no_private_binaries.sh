#!/bin/sh
# Refuse a commit that would put a ROM or an archive into this repository.
#
# .git/info/exclude is not a guarantee: `git add -f` walks straight past it, and
# so does an archive that happens to contain a ROM. This inspects what is
# actually STAGED, which is the only thing a commit can carry.
#
# Private user-supplied ROMs are local evaluation inputs. Hashes, header
# metadata and aggregate results may be published; bytes may not.
set -eu
status=0
staged=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$staged" ] && { echo "no staged files"; exit 0; }

fail() { echo "REFUSED: $1"; status=1; }

# 1. Extensions that must never be committed here.
echo "$staged" | while IFS= read -r f; do
  case "$f" in
    *.nes|*.NES|*.unf|*.unif|*.fds|*.nsf) echo "rom:$f";;
    *.zip|*.7z|*.rar|*.tar|*.tar.gz|*.tgz|*.gz) echo "archive:$f";;
  esac
done > /tmp/agod_guard_hits.$$ || true
if [ -s /tmp/agod_guard_hits.$$ ]; then
  while IFS= read -r hit; do fail "staged $hit"; done < /tmp/agod_guard_hits.$$
fi
rm -f /tmp/agod_guard_hits.$$

# 2. Any staged file carrying an iNES/NES 2.0 magic header, whatever its name.
echo "$staged" | while IFS= read -r f; do
  [ -f "$f" ] || continue
  magic=$(head -c 4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  [ "$magic" = "4e45531a" ] && echo "ines-magic:$f"
done > /tmp/agod_guard_magic.$$ || true
if [ -s /tmp/agod_guard_magic.$$ ]; then
  while IFS= read -r hit; do fail "staged file with an iNES header: $hit"; done < /tmp/agod_guard_magic.$$
fi
rm -f /tmp/agod_guard_magic.$$

# 3. Any staged file carrying one of the private corpus SHA-256 values, and any
#    staged file large enough to be a ROM payload in disguise.
PRIVATE_SHAS="116ff51eabad94da0c3bf32de9d50cc84becf73814fa2bf5574676b058a0a09a
1f4a9b3f04e2f828688512c0b83611a87c3fc1bd4f85ed91da1b19abc5816d73
c725a0c6b3eb52f542c10cf40538b69d0b163e5884ced7530dd250dbc02749b4
21faf868260bbc26a38127d31e98561679a7d0d17bb04ea747d8a549112e4812"
echo "$staged" | while IFS= read -r f; do
  [ -f "$f" ] || continue
  sha=$(sha256sum "$f" | cut -d' ' -f1)
  echo "$PRIVATE_SHAS" | grep -qx "$sha" && echo "private-rom-bytes:$f"
done > /tmp/agod_guard_sha.$$ || true
if [ -s /tmp/agod_guard_sha.$$ ]; then
  while IFS= read -r hit; do fail "staged content matches a private ROM: $hit"; done < /tmp/agod_guard_sha.$$
fi
rm -f /tmp/agod_guard_sha.$$

if [ "$status" -eq 0 ]; then
  echo "guard: $(echo "$staged" | wc -l) staged file(s), no ROM bytes, no archive, no iNES header"
else
  echo "guard: commit refused. Private ROM bytes and archives stay outside this repository."
fi
exit "$status"
