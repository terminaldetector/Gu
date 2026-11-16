#!/usr/bin/env python3
"""G2/G3 gate on a BUILT APK (not on the source tree): the minimal core.

  - no connectome or neural asset is packaged (male-cns / brain graphs, the code
    lab, the Male CNS notice and routing profile);
  - none of the deleted neural Java classes is in the dex;
  - the emulator host classes, the four emulator cores and AGOD are present;
  - the merged manifest requests no INTERNET permission and declares only the
    emulator activity (read with aapt2 from the Android build tools).

Fails closed: an APK that cannot be inspected (no aapt2) is not reported as passing.
Usage: apk_minimal_core_check.py APK [APK ...]
"""
import os, re, subprocess, sys, zipfile
from pathlib import Path

FORBIDDEN_ASSETS = re.compile(r'^assets/(male-cns\.fly|brain\.fly|code/|MALE-CNS-NOTICE|male-cns-routing)')
REQUIRED_ASSETS = [
    'assets/lab/index.html', 'assets/lab/lab.js', 'assets/lab/jsnes.min.js',
    'assets/lab/sega/genplus.wasm', 'assets/lab/gb/core.wasm', 'assets/lab/snes/core.wasm',
    'assets/lab/agod-pipeline.js', 'assets/lab/agod-worker.js', 'assets/lab/agod-platform-driver.js',
    'assets/lab/agod-objective.js', 'assets/lab/agod-live.js', 'assets/lab/agod-reward-sink.js',
    'assets/lab/goal-discovery-ui.js', 'assets/NOTICE.txt']
DELETED_CLASSES = ['Engine', 'Graph', 'GraphCache', 'GraphDelta', 'GpuLifEngine', 'GpuLayerSync', 'Experiment',
    'RoutingProfile', 'ConnectomeStore', 'InferenceProgram', 'LabDiagnostics', 'SyntheticGraphJson', 'FdbCheckpoint',
    'FdbDiagnostics', 'FdbGrowth', 'FdbLayerBinding', 'FdbLearning', 'DualAgentContext', 'DualLayerStore',
    'DualRequestGuard', 'IsolatedFdbContext', 'LayerSetStore', 'LearnedRoles', 'ComparisonStore', 'PairedEvaluation',
    'MainActivity', 'CodeLabActivity', 'LabModule', 'LabRequestFailure']
REQUIRED_CLASSES = ['NesLabActivity', 'RomImport', 'RomLibrary', 'ControllerInput', 'DeviceLog', 'ScoreOcr', 'DiagnosticsApplication']
descriptor = lambda name: ('Lorg/node/flyconsole/' + name + ';').encode()


def aapt2():
    for root in [os.environ.get('ANDROID_HOME'), os.environ.get('ANDROID_SDK_ROOT'), '/opt/android-sdk']:
        if root:
            tools = sorted(Path(root, 'build-tools').glob('*/aapt2'))
            if tools:
                return str(tools[-1])
    return None


def check(apk):
    problems = []
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        forbidden = [n for n in names if FORBIDDEN_ASSETS.match(n)]
        if forbidden:
            problems.append('neural assets packaged: ' + ', '.join(forbidden[:5]))
        missing = [n for n in REQUIRED_ASSETS if n not in names]
        if missing:
            problems.append('required assets missing: ' + ', '.join(missing))
        dex = b''.join(z.read(n) for n in names if re.fullmatch(r'classes\d*\.dex', n))
        if not dex:
            problems.append('no classes.dex')
        leaked = [c for c in DELETED_CLASSES if descriptor(c) in dex]
        if leaked:
            problems.append('deleted neural classes in the dex: ' + ', '.join(leaked))
        absent = [c for c in REQUIRED_CLASSES if descriptor(c) not in dex]
        if absent:
            problems.append('host classes missing from the dex: ' + ', '.join(absent))
        assets_bytes = sum(z.getinfo(n).file_size for n in names if n.startswith('assets/'))
    tool = aapt2()
    if not tool:
        problems.append('aapt2 not found (set ANDROID_HOME): the manifest cannot be checked, so the APK is not passed')
    else:
        permissions = subprocess.run([tool, 'dump', 'permissions', apk], capture_output=True, text=True)
        tree = subprocess.run([tool, 'dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], capture_output=True, text=True)
        if permissions.returncode or tree.returncode:
            problems.append('aapt2 could not read the manifest: ' + (permissions.stderr or tree.stderr).strip()[:200])
        else:
            if 'android.permission.INTERNET' in permissions.stdout:
                problems.append('the merged manifest requests android.permission.INTERNET')
            activities = re.findall(r'E: activity.*?A: http://schemas.android.com/apk/res/android:name\([^)]*\)="([^"]+)"', tree.stdout, re.S)
            own = [a for a in activities if a.startswith('org.node.flyconsole.')]
            if own != ['org.node.flyconsole.NesLabActivity']:
                problems.append('app activities in the manifest: %s (expected only NesLabActivity)' % own)
            libraries = [a for a in activities if not a.startswith('org.node.flyconsole.')]
    size = os.path.getsize(apk)
    third = ('; library activities: ' + ', '.join(libraries)) if tool and 'libraries' in locals() and libraries else ''
    if problems:
        print('FAIL %s (%d bytes):' % (apk, size))
        for p in problems:
            print('  - ' + p)
        return False
    print('PASS %s: %d bytes (%.1f MiB), uncompressed assets %.1f MiB; no connectome, no neural classes, '
          'four cores + AGOD present, only NesLabActivity of the app, no INTERNET%s' % (apk, size, size / 2**20, assets_bytes / 2**20, third))
    return True


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    results = [check(a) for a in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
