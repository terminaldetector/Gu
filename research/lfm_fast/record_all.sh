#!/bin/bash
# Re-record the Track A/C play set from a directory of cartridges (private; output to OUT_DIR).
# usage: research/lfm_fast/record_all.sh ROM_DIR OUT_DIR [frames=6000] [every=8]
# A cartridge is matched by file name; a platform whose core is absent is skipped and said so.
set -u
ROMS=$1 OUT=$2 FRAMES=${3:-6000} EVERY=${4:-8}
cd "$(dirname "$0")/../.."
LAB=app/src/main/assets/lab
mkdir -p "$OUT"
spec=(
 "nes contra.nes contra" "nes galaga.nes galaga" "nes lifeforce.nes lifeforce" "nes roadfighter.nes roadfighter"
 "snes contra3.sfc contra3" "snes secret-of-mana.sfc mana"
 "sega elemental-master.gen elemental" "sega contra-hard-corps-hack5.bin hardcorps")
for seed in 1 2; do
 for s in "${spec[@]}"; do
  set -- $s
  platform=$1 file=$2 name=$3
  if [ ! -f "$ROMS/$file" ]; then echo "SKIP $name: $ROMS/$file not present"; continue; fi
  if [ "$platform" = snes ] && [ ! -f "$LAB/snes/core.wasm" ]; then echo "SKIP $name: no SNES core in $LAB/snes"; continue; fi
  node research/lfm_fast/record_play.cjs --platform "$platform" --rom "$ROMS/$file" --out "$OUT/$name-s$seed" \
   --frames "$FRAMES" --every "$EVERY" --seed "$seed" --entry 900 2>&1 | grep -v '^Map_' || echo "FAILED $name s$seed"
 done
done
echo ALLDONE
