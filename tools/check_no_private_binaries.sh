#!/bin/sh
# Refuse a commit that would put ROM bytes or an archive into this repository.
#
# What a commit carries is the BLOB IN THE INDEX, not the file on disk. An
# earlier version of this script took paths from the index but read content from
# the working tree, which `git add -f rom.nes` followed by overwriting that path
# with harmless content walks straight through: the index still holds the ROM.
# Everything below is therefore read with `git cat-file blob :<path>`.
#
# This script is the policy. A pre-commit hook is a convenience that runs it,
# not a guarantee: hooks are local, uncommitted and skippable with --no-verify.
# Run it in CI, or before a commit, to have an actual gate.
#
# Private user-supplied ROMs are local evaluation inputs: hashes, header
# metadata and aggregate results may be published, bytes may not.
set -eu

findings=$(mktemp)
trap 'rm -f "$findings"' EXIT

PRIVATE_SHAS="116ff51eabad94da0c3bf32de9d50cc84becf73814fa2bf5574676b058a0a09a
1f4a9b3f04e2f828688512c0b83611a87c3fc1bd4f85ed91da1b19abc5816d73
c725a0c6b3eb52f542c10cf40538b69d0b163e5884ced7530dd250dbc02749b4
21faf868260bbc26a38127d31e98561679a7d0d17bb04ea747d8a549112e4812"

# Paths, newline separated. `read -d ""` is a bashism and this runs under dash,
# where it made the whole loop a no-op that reported success - caught by the
# regression test, which is why that test exists. A path containing a newline is
# refused outright rather than mis-parsed.
records=$(git diff --cached --name-only --diff-filter=ACMR -z | tr '\0' '\n')
nul_count=$(git diff --cached --name-only --diff-filter=ACMR -z | tr -cd '\0' | wc -c | tr -d ' ')
line_count=$(printf '%s' "$records" | grep -c '' || true)
if [ "$nul_count" -ne "$line_count" ]; then
  echo "guard: COMMIT REFUSED. A staged path contains a newline; refusing rather than parsing it."
  exit 1
fi

printf '%s\n' "$records" | while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    *.nes|*.NES|*.unf|*.unif|*.fds|*.nsf)
      printf 'rom-extension\t%s\n' "$path" >> "$findings";;
    *.zip|*.7z|*.rar|*.tar|*.tar.gz|*.tgz|*.gz|*.bz2|*.xz)
      printf 'archive\t%s\n' "$path" >> "$findings";;
  esac

  # Every content check reads the STAGED BLOB, never the working tree.
  magic=$(git cat-file blob ":$path" 2>/dev/null | head -c 4 | od -An -tx1 | tr -d ' \n' || true)
  [ "$magic" = "4e45531a" ] && printf 'ines-magic-in-index\t%s\n' "$path" >> "$findings"
  [ "$magic" = "504b0304" ] && printf 'zip-magic-in-index\t%s\n' "$path" >> "$findings"

  sha=$(git cat-file blob ":$path" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
  if printf '%s\n' "$PRIVATE_SHAS" | grep -qx "$sha"; then
    printf 'private-rom-bytes-in-index\t%s\n' "$path" >> "$findings"
  fi
done

staged_count=$(git diff --cached --name-only --diff-filter=ACMR | wc -l | tr -d ' ')
if [ -s "$findings" ]; then
  echo "guard: COMMIT REFUSED. These staged blobs must not enter this repository:"
  sort -u "$findings" | while IFS="$(printf '\t')" read -r kind path; do
    echo "  - $kind: $path"
  done
  echo "guard: private ROM bytes and archives stay outside this repository."
  exit 1
fi
echo "guard: $staged_count staged blob(s) inspected from the git index; no ROM bytes, no archive, no iNES or ZIP magic"
exit 0
