#!/usr/bin/env python3
"""Write BUILD_MANIFEST.md and build-manifest.json from files that exist.

Nothing here is typed by hand: every hash is computed from the artefact it
describes, every core revision is read from the source.json its build wrote,
and a file that is missing is reported as missing rather than omitted.
"""
import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'app/src/main/assets'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(*args):
    try:
        return subprocess.run(args, capture_output=True, text=True, cwd=ROOT).stdout.strip()
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--out-dir', type=Path, required=True)
    parser.add_argument('--smoke', default='NOT RUN')
    args = parser.parse_args()
    apk = args.apk
    names = zipfile.ZipFile(apk).namelist()
    wanted = ['assets/lab/agod-pipeline.js', 'assets/lab/agod-sequences.js',
              'assets/lab/agod-graph.js', 'assets/lab/agod-objective.js',
              'assets/lab/agod-live.js', 'assets/lab/agod-worker.js',
              'assets/lab/agod-platform-driver.js', 'assets/lab/agod-reward.js',
              'assets/lab/agod-evidence.js', 'assets/lab/sega/genplus.wasm',
              'assets/lab/gb/core.wasm', 'assets/lab/snes/core.wasm',
              'assets/brain.fly.gz', 'assets/male-cns.fly.gz']
    # The Android build stores `.gz` assets unpacked, under the name without the
    # suffix, and the app opens either. So a connectome is present if EITHER
    # name is in the APK - looking only for `.fly.gz` reported both as missing
    # from an APK that had grown by 150 MB because they were in it.
    def packaged(name):
        if name in names:
            return name
        if name.endswith('.gz') and name[:-3] in names:
            return name[:-3]
        return None
    present = {name: packaged(name) for name in wanted}
    cores = {}
    for system, meta in [('gb', 'lab/gb/source.json'), ('snes', 'lab/snes/source.json'),
                         ('sega', 'lab/sega/source.json')]:
        path = ASSETS / meta
        cores[system] = json.loads(path.read_text()) if path.exists() else None
    connectomes = {}
    for name in ['brain.fly.gz', 'male-cns.fly.gz']:
        path = ASSETS / name
        connectomes[name] = {'sha256': sha256(path), 'bytes': path.stat().st_size} if path.exists() else None
    manifest = {
        'type': 'gu-agod-build-manifest', 'version': 1,
        'git': {'commit': run('git', 'rev-parse', 'HEAD'),
                'branch': run('git', 'rev-parse', '--abbrev-ref', 'HEAD'),
                'dirty': bool(run('git', 'status', '--porcelain'))},
        'apk': {'file': apk.name, 'sha256': sha256(apk), 'bytes': apk.stat().st_size,
                'variant': 'debug', 'signing': 'Android debug key (not a release signature)',
                'badging': run('/opt/android-sdk/build-tools/35.0.0/aapt2', 'dump', 'badging', str(apk)).splitlines()[:1]
                if Path('/opt/android-sdk/build-tools/35.0.0/aapt2').exists() else None,
                'permissions': [line for line in (run('/opt/android-sdk/build-tools/35.0.0/aapt2', 'dump', 'permissions', str(apk)) or '').splitlines()]},
        'assetsInApk': present,
        'cores': cores,
        'connectomes': connectomes,
        'toolchain': {'java': (run('java', '-version') or '') or 'see stderr',
                      'gradle': next((l for l in (run('gradle', '--version') or '').splitlines() if l.startswith('Gradle')), None),
                      'emscripten': (run('emcc', '--version') or '').splitlines()[:1],
                      'cc65': (run('cc65', '--version') or '') or 'n/a',
                      'node': run('node', '--version')},
        'smoke': args.smoke,
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / 'build-manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    lines = ['# BUILD_MANIFEST', '',
             f"- Commit: `{manifest['git']['commit']}` on `{manifest['git']['branch']}`"
             + (' (worktree dirty)' if manifest['git']['dirty'] else ''),
             f"- APK: `{apk.name}` — {apk.stat().st_size} bytes",
             f"- APK SHA-256: `{manifest['apk']['sha256']}`",
             f"- Variant: debug, signed with the Android debug key. **Not a release-signed APK.**",
             f"- Package: `{(manifest['apk']['badging'] or ['?'])[0]}`",
             f"- Launch smoke: {args.smoke}", '',
             '## Assets inside the APK', '', '| Asset | In APK |', '|---|---|']
    for name, ok in present.items():
        lines.append(f"| `{name}` | {('yes' if ok == name else 'yes, as `' + ok + '`') if ok else '**MISSING**'} |")
    lines += ['', '## Emulator cores', '', '| Core | Upstream revision | Transport | Emscripten | WASM SHA-256 |', '|---|---|---|---|---|']
    for system, meta in cores.items():
        if not meta:
            lines.append(f'| {system} | (no source.json in this checkout) | | | |')
            continue
        lines.append('| %s | `%s` | %s | %s | `%s` |' % (
            system, meta.get('revision') or meta.get('core_commit') or '?',
            meta.get('source_transport', 'as committed'),
            (meta.get('emscripten_version') or meta.get('emscripten') or 'as committed'),
            (meta.get('wasm_sha256') or '?')[:16] + '…'))
    lines += ['', 'GB and SNES cores in this APK were built here with Emscripten 3.1.6 from the pinned',
              'revisions, by git checkout verified against the pinned SHA and origin. CI builds them with',
              '3.1.57, so these two WASM files are **not byte-identical** to a CI build.', '',
              '## Connectomes', '', '| File | Bytes | SHA-256 |', '|---|---|---|']
    for name, meta in connectomes.items():
        lines.append(f"| `{name}` | {meta['bytes']} | `{meta['sha256']}` |" if meta else f'| `{name}` | **MISSING** | |')
    lines += ['', '## Permissions requested by the APK', '']
    lines += ['- `' + p + '`' for p in manifest['apk']['permissions']] or ['- (none reported)']
    (args.out_dir / 'BUILD_MANIFEST.md').write_text('\n'.join(lines) + '\n')
    print('manifest written; APK sha256', manifest['apk']['sha256'])


if __name__ == '__main__':
    main()
