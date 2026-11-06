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
    'snes': ('snes9xgit/snes9x', '1bcc369e89f08243e0a462882fb1f3e42e51de3a', 'libretro', 'Makefile', 'snes9x', 'libretro', 'Snes9xFactory'),
}
EXPORTS = ['malloc', 'free', 'lab_init', 'lab_load_rom', 'lab_tick', 'lab_reset', 'lab_video', 'lab_width', 'lab_height', 'lab_valid', 'lab_fps', 'lab_sample_rate', 'lab_audio_count', 'lab_audio_left', 'lab_audio_right', 'lab_ram_size', 'lab_read_ram', 'lab_save_state', 'lab_state', 'lab_load_state']

def run(*args, cwd):
    subprocess.run(list(args), cwd=cwd, check=True)

def stack_setting(bytes_):
    """The linker flag for the stack size, under whichever name this
    Emscripten knows.

    STACK_SIZE replaced TOTAL_STACK in Emscripten 3.1.27; an older toolchain
    rejects the new name outright ("Attempt to set a non-existent setting").
    The VALUE is identical either way - this is the same stack, not a smaller
    one chosen to make a build pass - and which name was used is recorded in
    source.json along with the compiler version."""
    settings = Path('/usr/share/emscripten/src/settings.js')
    root = os.environ.get('EMSCRIPTEN_ROOT')
    if root:
        settings = Path(root) / 'src/settings.js'
    text = settings.read_text() if settings.exists() else ''
    name = 'STACK_SIZE' if 'var STACK_SIZE' in text or not text else 'TOTAL_STACK'
    return f'-s{name}={bytes_}', name

def fetch_archive(repo, revision):
    """The pinned upstream tree as a zip from codeload.

    Not available in every environment: a sandbox whose GitHub gateway serves
    only the repositories enabled for the session answers 403 here for a
    third-party upstream. Hence local_source() below, which takes the SAME
    pinned revision from a checkout and verifies the SHA rather than trusting
    the directory."""
    request = urllib.request.Request(f'https://codeload.github.com/{repo}/zip/{revision}', headers={'User-Agent': 'FlyConsole-build'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return response.read()

def local_source(system, repo, revision):
    """A git checkout of the pinned revision, if one was provided.

    FLY_RETRO_SRC_GB / FLY_RETRO_SRC_SNES name a directory. The revision is
    NOT taken on trust: git is asked for HEAD and the build refuses unless it
    is exactly the pinned SHA, so the offline path cannot quietly build a
    different version of the core from the one recorded in source.json."""
    variable = 'FLY_RETRO_SRC_' + ('GB' if system == 'gb' else 'SNES')
    given = os.environ.get(variable)
    if not given:
        return None
    path = Path(given).resolve()
    if not (path / '.git').exists():
        raise ValueError(f'{variable}={path} is not a git checkout')
    head = subprocess.run(['git', '-C', str(path), 'rev-parse', 'HEAD'], check=True, capture_output=True, text=True).stdout.strip()
    if head != revision:
        raise ValueError(f'{variable}={path} is at {head}, not the pinned {revision}')
    origin = subprocess.run(['git', '-C', str(path), 'remote', 'get-url', 'origin'], check=True, capture_output=True, text=True).stdout.strip()
    if repo.lower() not in origin.lower():
        raise ValueError(f'{variable}={path} has origin {origin}, which is not {repo}')
    return path

def build(system, settings):
    repo, revision, directory, makefile, name, include, factory = settings
    checkout = local_source(system, repo, revision)
    archive = None if checkout else fetch_archive(repo, revision)
    with tempfile.TemporaryDirectory(prefix=f'fly-{system}-') as temporary:
        temp = Path(temporary)
        if checkout:
            # Copied, not built in place: the build writes object files and a
            # static archive into the tree, and the checkout is not ours.
            source = temp / (name + '-' + revision[:7])
            shutil.copytree(checkout, source, ignore=shutil.ignore_patterns('.git'))
        else:
            with zipfile.ZipFile(io.BytesIO(archive)) as z:
                for info in z.infolist():
                    target = (temp / info.filename).resolve()
                    if not target.is_relative_to(temp.resolve()):
                        raise ValueError('Unsafe upstream source path')
                z.extractall(temp)
            source = next(p for p in temp.iterdir() if p.is_dir())
        work = source / directory
        shutil.copy2(ROOT / 'tools/retro/bridge.cpp', source / 'fly_bridge.cpp')
        shutil.copy2(ROOT / 'LICENSE', source / 'fly_frontend_license.txt')
        adapter = source / 'fly_bridge.o'
        adapter_command = ['em++', str(source / 'fly_bridge.cpp'), '-I' + str(source / include), '-std=c++17', '-O3', '-c', '-o', str(adapter)]
        if system == 'gb':
            adapter_command.append('-DFLY_GB')
        run(*adapter_command, cwd=source)
        run('emmake', 'make', '-f', makefile, 'platform=emscripten', 'CC=emcc', 'CXX=em++', 'AR=emar', 'HAVE_NETWORK=0', '-j' + str(min(4, os.cpu_count() or 2)), cwd=work)
        # Upstream calls the emar static archive .bc; modern em++ parses that
        # suffix as LLVM input. Preserve its bytes with the archive suffix.
        library = work / (name + '_libretro_emscripten.a')
        shutil.copy2(work / (name + '_libretro_emscripten.bc'), library)
        common_objects = []
        if system == 'gb':
            # Static libretro builds expect RetroArch to provide these. Our
            # standalone frontend links the upstream VFS/path helpers itself.
            common = source / 'libgambatte/libretro-common'
            helpers = ['compat/compat_posix_string.c', 'compat/compat_snprintf.c', 'compat/compat_strcasestr.c', 'compat/compat_strl.c', 'compat/fopen_utf8.c', 'encodings/encoding_utf.c', 'file/file_path.c', 'file/file_path_io.c', 'streams/file_stream.c', 'streams/file_stream_transforms.c', 'string/stdstring.c', 'time/rtime.c', 'vfs/vfs_implementation.c']
            for index, helper in enumerate(helpers):
                obj = source / f'fly_common_{index}.o'
                run('emcc', '-O3', '-DHAVE_STDINT_H', '-DHAVE_INTTYPES_H', '-I' + str(common / 'include'), '-c', str(common / helper), '-o', str(obj), cwd=source)
                common_objects.append(str(obj))
        output = ROOT / 'app/src/main/assets/lab' / system
        output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'LICENSE', output / 'FLY-LICENSE.txt')
        stack_flag, stack_name = stack_setting(2097152)
        command = ['em++', str(adapter), str(library), '-O3', '--no-entry', '-sMODULARIZE=1', '-sEXPORT_NAME=' + factory, '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432', '-sMAXIMUM_MEMORY=268435456', stack_flag, '-sEXPORTED_FUNCTIONS=' + json.dumps(['_' + symbol for symbol in EXPORTS]), '-o', str(output / 'core.js')]
        if system == 'gb':
            command.extend(common_objects)
        run(*command, cwd=source)
        # GPL/noncommercial redistribution includes the exact frontend and full source.
        with zipfile.ZipFile(output / 'source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for p in sorted(source.rglob('*')):
                if p.is_file() and p.suffix not in ['.o', '.bc', '.a']:
                    z.write(p, p.relative_to(source))
            z.write(ROOT / 'tools/build_retro.py', 'fly_build_retro.py')
        metadata = {'system': system, 'upstream': repo, 'revision': revision, 'core': f'{name}-{revision[:7]}-fly1', 'source_url': f'https://github.com/{repo}/tree/{revision}',
                    # stated rather than omitted: a checkout build has no
                    # upstream archive to hash, and which transport delivered
                    # the pinned revision is part of the provenance
                    'source_transport': 'git-checkout' if checkout else 'codeload-zip',
                    'upstream_archive_sha256': None if archive is None else hashlib.sha256(archive).hexdigest(),
                    'emscripten_version': subprocess.run(['emcc', '--version'], capture_output=True, text=True).stdout.splitlines()[0].strip(),
                    'stack_setting': stack_name,
                    'wasm_sha256': hashlib.sha256((output / 'core.wasm').read_bytes()).hexdigest(), 'source_sha256': hashlib.sha256((output / 'source.zip').read_bytes()).hexdigest()}
        (output / 'source.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(f'Built offline {system}: {metadata["core"]}', flush=True)

if __name__ == '__main__':
    for system, settings in CORES.items():
        build(system, settings)
