"""Pinned offline Game Boy/Color and SNES WASM builds with corresponding source."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CORES = {
    'gb': ('libretro/gambatte-libretro', 'd9d6cd06382d1ced30de34d56d3609452323dab1', '.', 'Makefile.libretro', 'gambatte', 'libgambatte/libretro-common/include', 'GambatteFactory'),
    'snes': ('snes9xgit/snes9x', '1bcc369e89f08243e0a462882fb1f3e42e51de3a', 'libretro', 'Makefile', 'snes9x', 'libretro/libretro-common/include', 'Snes9xFactory'),
}
EXPORTS = ['malloc', 'free', 'lab_init', 'lab_load_rom', 'lab_tick', 'lab_reset', 'lab_video', 'lab_width', 'lab_height', 'lab_valid', 'lab_fps', 'lab_sample_rate', 'lab_audio_count', 'lab_audio_left', 'lab_audio_right', 'lab_ram_size', 'lab_read_ram', 'lab_save_state', 'lab_state', 'lab_load_state']

def run(*args, cwd):
    subprocess.run(list(args), cwd=cwd, check=True)

def build(system, settings):
    repo, revision, directory, makefile, name, include, factory = settings
    request = urllib.request.Request(f'https://codeload.github.com/{repo}/zip/{revision}', headers={'User-Agent': 'FlyConsole-build'})
    with urllib.request.urlopen(request, timeout=90) as response:
        archive = response.read()
    with tempfile.TemporaryDirectory(prefix=f'fly-{system}-') as temporary:
        temp = Path(temporary)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            for info in z.infolist():
                target = (temp / info.filename).resolve()
                if not target.is_relative_to(temp.resolve()):
                    raise ValueError('Unsafe upstream source path')
            z.extractall(temp)
        source = next(p for p in temp.iterdir() if p.is_dir())
        work = source / directory
        shutil.copy2(ROOT / 'tools/retro/bridge.cpp', source / 'fly_bridge.cpp')
        run('emmake', 'make', '-f', makefile, 'platform=emscripten', 'CC=emcc', 'CXX=em++', 'AR=emar', 'HAVE_NETWORK=0', '-j' + str(min(4, os.cpu_count() or 2)), cwd=work)
        # Upstream calls the emar static archive .bc; modern em++ parses that
        # suffix as LLVM input. Preserve its bytes with the archive suffix.
        library = work / (name + '_libretro_emscripten.a')
        shutil.copy2(work / (name + '_libretro_emscripten.bc'), library)
        output = ROOT / 'app/src/main/assets/lab' / system
        output.mkdir(parents=True, exist_ok=True)
        command = ['em++', str(source / 'fly_bridge.cpp'), str(library), '-I' + str(source / include), '-std=c++17', '-O3', '--no-entry', '-sMODULARIZE=1', '-sEXPORT_NAME=' + factory, '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432', '-sMAXIMUM_MEMORY=268435456', '-sSTACK_SIZE=2097152', '-sEXPORTED_FUNCTIONS=' + json.dumps(['_' + symbol for symbol in EXPORTS]), '-o', str(output / 'core.js')]
        if system == 'gb':
            command.append('-DFLY_GB')
        run(*command, cwd=source)
        # GPL/noncommercial redistribution includes the exact frontend and full source.
        with zipfile.ZipFile(output / 'source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for p in sorted(source.rglob('*')):
                if p.is_file() and p.suffix not in ['.o', '.bc', '.a']:
                    z.write(p, p.relative_to(source))
            z.write(ROOT / 'tools/build_retro.py', 'fly_build_retro.py')
        metadata = {'system': system, 'upstream': repo, 'revision': revision, 'core': f'{name}-{revision[:7]}-fly1', 'source_url': f'https://github.com/{repo}/tree/{revision}', 'upstream_archive_sha256': hashlib.sha256(archive).hexdigest(), 'wasm_sha256': hashlib.sha256((output / 'core.wasm').read_bytes()).hexdigest(), 'source_sha256': hashlib.sha256((output / 'source.zip').read_bytes()).hexdigest()}
        (output / 'source.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(f'Built offline {system}: {metadata["core"]}', flush=True)

if __name__ == '__main__':
    for system, settings in CORES.items():
        build(system, settings)
