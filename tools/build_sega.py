#!/usr/bin/env python3
"""Rebuild API4 from bundled licensed source; archive exactly the compiled source."""
import hashlib,json,re,subprocess,tempfile,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
assets=root/'app/src/main/assets/lab/sega'
with tempfile.TemporaryDirectory(prefix='fly-sega-') as tmp:
    z=zipfile.ZipFile(assets/'genplus-source.zip')
    z.extractall(tmp)
    source=next(Path(tmp).glob('wasm-genplus-*'))
    c=source/'src/main/c/wasm/wasm.c'
    text=c.read_text()
    if 'lab_core_api' not in text:
        text=text.replace('#define GAMEPAD_API_INDEX 32','#define GAMEPAD_API_INDEX 64')
        text=text.replace('input_buffer = malloc(sizeof(float_t) * GAMEPAD_API_INDEX);','input_buffer = calloc(GAMEPAD_API_INDEX, sizeof(float_t));')
        start=text.index('int EMSCRIPTEN_KEEPALIVE wasm_input_update(void) {')
        end=text.index('\nuint8_t* EMSCRIPTEN_KEEPALIVE get_rom_buffer_ref',start)
        text=text[:start]+'''int EMSCRIPTEN_KEEPALIVE lab_core_api(void) { return 4; }
int EMSCRIPTEN_KEEPALIVE wasm_input_update(void) {
    for(int player=0;player<2;player++) {
        int port=player*4; /* Genesis Plus GX: physical port B is pad[4]. */
        float_t *b=input_buffer+player*32;
        input.pad[port]=0;
        if(b[10]) input.pad[port]|=INPUT_A;
        if(b[11]) input.pad[port]|=INPUT_B;
        if(b[9]) input.pad[port]|=INPUT_C;
        if(b[15]) input.pad[port]|=INPUT_START;
        if(b[8]) input.pad[port]|=INPUT_X;
        if(b[12]) input.pad[port]|=INPUT_Y;
        if(b[13]) input.pad[port]|=INPUT_Z;
        if(b[14]) input.pad[port]|=INPUT_MODE;
        if(b[7]==-1) input.pad[port]|=INPUT_UP;
        else if(b[7]==1) input.pad[port]|=INPUT_DOWN;
        if(b[6]==-1) input.pad[port]|=INPUT_LEFT;
        else if(b[6]==1) input.pad[port]|=INPUT_RIGHT;
    }
    return 1;
}
''' +text[end:]
        c.write_text(text)
        p=source/'FLY_BUILD.md'
        p.write_text(p.read_text()+'\nAPI4: 64-float input buffer; independent pad[0]/pad[4] controllers; lab_core_api() = 4. Rebuild via tools/build_sega.py in Gu.\n')
    build=source/'build-fly';build.mkdir()
    subprocess.run(['emcmake','cmake','..'],cwd=build,check=True)
    subprocess.run(['emmake','make','-j4'],cwd=build,check=True)
    output=source/'src/main/js'
    (assets/'genplus.js').write_text((output/'genplus.js').read_text()+'\nif(typeof window!=="undefined")window.GenPlusFactory=Module;\n')
    (assets/'genplus.wasm').write_bytes((output/'genplus.wasm').read_bytes())
    # Drop build outputs and old upstream compiled bundles from source delivery.
    with zipfile.ZipFile(assets/'genplus-source.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob('*')):
            if path.is_file() and build not in path.parents and 'docs' not in path.relative_to(source).parts and not path.name.endswith(('.wasm','.dbg')) and path!=output/'genplus.js':
                info=zipfile.ZipInfo(str(path.relative_to(source.parent)),(2024,1,1,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                archive.writestr(info,path.read_bytes())
    meta=json.loads((assets/'source.json').read_text())
    meta.update(core_api='genplus-fly-6090aff9-api4',compiler='Emscripten 3.1.57',controllers=2,
                wasm_sha256=hashlib.sha256((assets/'genplus.wasm').read_bytes()).hexdigest(),
                source_sha256=hashlib.sha256((assets/'genplus-source.zip').read_bytes()).hexdigest())
    (assets/'source.json').write_text(json.dumps(meta,indent=2)+'\n')
print('Sega API4 built with independent physical controller ports and matching source archive')
