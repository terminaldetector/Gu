#!/usr/bin/env python3
"""Build the pinned Genesis Plus GX API6; deliver its exact licensed source."""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

COMMIT = '49c584764893b0505ac7f768a754f97330fa4392'
ARCHIVE_SHA256 = 'f04f89c20ec286a23d7a10bc5ec0329bdc4954d3d41062d836fccba7b18c7d85'
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'app/src/main/assets/lab/sega'


def extract(archive, destination):
    for item in archive.infolist():
        target = (destination / item.filename).resolve()
        if not target.is_relative_to(destination.resolve()):
            raise RuntimeError('Source archive contains an unsafe path')
    archive.extractall(destination)


def build(upstream_path=None):
    if upstream_path:
        data = Path(upstream_path).read_bytes()
    else:
        url = f'https://codeload.github.com/ekeeke/Genesis-Plus-GX/zip/{COMMIT}'
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError('Pinned Genesis Plus GX archive SHA256 mismatch')
    with tempfile.TemporaryDirectory(prefix='fly-sega-') as temporary:
        directory = Path(temporary)
        with zipfile.ZipFile(ASSETS / 'genplus-source.zip') as archive:
            extract(archive, directory / 'wrapper')
        source = next((directory / 'wrapper').glob('wasm-genplus-*'))
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            extract(archive, directory / 'upstream')
        upstream = next((directory / 'upstream').glob('Genesis-Plus-GX-*'))
        core = source / 'src/main/c/core'
        shutil.rmtree(core)
        shutil.copytree(upstream / 'core', core)
        loader = core / 'loadrom.c'
        text = loader.read_text()
        needle = '  size = cdd_load(filename, (char *)(cart.rom));'
        if text.count(needle) != 1:
            raise RuntimeError('Pinned cartridge-only loader patch no longer matches')
        loader.write_text(text.replace(needle,
            '#ifdef WASM_GENPLUS\n  size = 0; /* Cartridge frontend: no CD probing. */\n'
            '#else\n' + needle + '\n#endif'))
        (source / 'GENPLUS-GX-LICENSE.txt').write_bytes((upstream / 'LICENSE.txt').read_bytes())
        for overlay in (ROOT / 'tools/sega-api6').rglob('*'):
            if overlay.is_file():
                target = source / overlay.relative_to(ROOT / 'tools/sega-api6')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(overlay, target)
        (source / 'FLY_BUILD.md').write_text(
            f'FlyConsole API6: Genesis Plus GX {COMMIT}; Emscripten 3.1.57.\n'
            'Original wasm-genplus wrapper retained with FlyConsole controller, video,\n'
            'audio, region and snapshot adapters. Cartridge limit 32 MiB.\n'
            'Build with: emcmake cmake -S . -B build-fly; cmake --build build-fly -j4.\n'
        )
        build_directory = source / 'build-fly'
        subprocess.run(['emcmake', 'cmake', '-S', str(source), '-B', str(build_directory)], check=True)
        subprocess.run(['cmake', '--build', str(build_directory), '--parallel', '4'], check=True)
        output = source / 'src/main/js'
        (ASSETS / 'genplus.js').write_text((output / 'genplus.js').read_text() +
            '\nif(typeof window!=="undefined")window.GenPlusFactory=Module;\n')
        (ASSETS / 'genplus.wasm').write_bytes((output / 'genplus.wasm').read_bytes())
        with zipfile.ZipFile(ASSETS / 'genplus-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob('*')):
                relative = path.relative_to(source)
                if not path.is_file() or build_directory in path.parents or 'docs' in relative.parts:
                    continue
                if path.name.endswith(('.wasm', '.dbg')) or path == output / 'genplus.js':
                    continue
                info = zipfile.ZipInfo(str(path.relative_to(source.parent)), (2024, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
        metadata = json.loads((ASSETS / 'source.json').read_text())
        metadata.update(core_api='genplus-fly-49c5847-api6',
            core_upstream='https://github.com/ekeeke/Genesis-Plus-GX', core_commit=COMMIT,
            core_archive_sha256=ARCHIVE_SHA256, max_rom_bytes=33554432,
            compiler='Emscripten 3.1.57', controllers=2,
            wasm_sha256=hashlib.sha256((ASSETS / 'genplus.wasm').read_bytes()).hexdigest(),
            source_sha256=hashlib.sha256((ASSETS / 'genplus-source.zip').read_bytes()).hexdigest())
        (ASSETS / 'source.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print('PASS: Sega API6 built from pinned upstream with matching complete source')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--upstream-archive', help='Use a local copy of the SHA256-pinned upstream archive')
    build(parser.parse_args().upstream_archive)
