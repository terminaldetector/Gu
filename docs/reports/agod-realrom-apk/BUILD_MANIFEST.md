# BUILD_MANIFEST

- Commit: `8e4c58566785b4a8d7ef59b44f6ff15231e32772` on `research/agod-neural-e0-e1` (worktree dirty only in `fdb-comparison.json`, a repo-root output of the local `tools/check.sh` run that is not packaged — verified absent from the APK)
- APK: `FlyConsole-AGOD-2.3.0-debug.apk` — 208304447 bytes
- APK SHA-256: `d9e63b0b359b1090265688f79241911e9cb19e3eb4860a1f62065f6ff8eb895d`
- Variant: debug, signed with the Android debug key. **Not a release-signed APK.**
- Package: `package: name='org.node.flyconsole.nes' versionCode='43' versionName='2.3.0-agod' platformBuildVersionName='15' platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'`
- Launch smoke: NOT RUN - no /dev/kvm here and no physical device attached; the APK was not launched anywhere. Physical device: DEVICE-PENDING.

## Assets inside the APK

| Asset | In APK |
|---|---|
| `assets/lab/agod-pipeline.js` | yes |
| `assets/lab/agod-sequences.js` | yes |
| `assets/lab/agod-graph.js` | yes |
| `assets/lab/agod-objective.js` | yes |
| `assets/lab/agod-live.js` | yes |
| `assets/lab/agod-worker.js` | yes |
| `assets/lab/agod-platform-driver.js` | yes |
| `assets/lab/agod-reward.js` | yes |
| `assets/lab/agod-evidence.js` | yes |
| `assets/lab/sega/genplus.wasm` | yes |
| `assets/lab/gb/core.wasm` | yes |
| `assets/lab/snes/core.wasm` | yes |
| `assets/brain.fly.gz` | yes, as `assets/brain.fly` |
| `assets/male-cns.fly.gz` | yes, as `assets/male-cns.fly` |

## Emulator cores

| Core | Upstream revision | Transport | Emscripten | WASM SHA-256 |
|---|---|---|---|---|
| gb | `d9d6cd06382d1ced30de34d56d3609452323dab1` | git-checkout | emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.6 () | `42249af883d59061…` |
| snes | `1bcc369e89f08243e0a462882fb1f3e42e51de3a` | git-checkout | emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.6 () | `7df4ded991519c37…` |
| sega | `49c584764893b0505ac7f768a754f97330fa4392` | as committed | as committed | `dc73bd69e789596c…` |

GB and SNES cores in this APK were built here with Emscripten 3.1.6 from the pinned
revisions, by git checkout verified against the pinned SHA and origin. CI builds them with
3.1.57, so these two WASM files are **not byte-identical** to a CI build.

## Connectomes

| File | Bytes | SHA-256 |
|---|---|---|
| `brain.fly.gz` | 53119189 | `e06ff2d29581c9bdf88ebba48fd355673c1b550e757c4325af21c01719489d62` |
| `male-cns.fly.gz` | 86170894 | `c8f5e2bd9d78a2f458c4947f6c999fb2911a46b543a4c01aa0b37f1caf74ed93` |

## Permissions requested by the APK

- `package: org.node.flyconsole.nes`
- `permission: org.node.flyconsole.nes.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
- `uses-permission: name='org.node.flyconsole.nes.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'`
- `uses-permission: name='android.permission.ACCESS_NETWORK_STATE'`

## What changed in this build (since 2.2.0-agod)

- AGOD on real cartridges: phase detection (`agod-phase.js`), automatic entry into
  play, survival discovery (`agod-survival.js`); the worker sends a game in play to
  survival first, and a background run at a title or menu waits for play.
- Second-controller input in the research drivers (NES, Sega, SNES).
- FDB `carry`: an interval with no verified event joins the eligibility traces
  unpaid (app default; `GU_FDB_CARRY=false` restores the old rule).
- Evidence: `docs/reports/realrom/REALROM_AGOD.md`.
