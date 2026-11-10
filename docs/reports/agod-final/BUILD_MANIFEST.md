# BUILD_MANIFEST

- Commit: `b46c946abf0c8fde0f07e368884424047330de72` on `research/agod-neural-e0-e1` (worktree dirty)
- APK: `FlyConsole-AGOD-2.2.0-debug.apk` — 208279425 bytes
- APK SHA-256: `7e015295b9c31c15d360351194543ec3c120f86de3832e1a04bf89120e5301fe`
- Variant: debug, signed with the Android debug key. **Not a release-signed APK.**
- Package: `package: name='org.node.flyconsole.nes' versionCode='42' versionName='2.2.0-agod' platformBuildVersionName='15' platformBuildVersionCode='35' compileSdkVersion='35' compileSdkVersionCodename='15'`
- Launch smoke: PENDING

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
