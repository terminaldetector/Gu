#!/usr/bin/env python3
"""Original NROM-0 diagnostic: moving sprite, controller and animated palette.
No commercial game code or assets. Copyright 2026 Fly Console contributors, MIT.
"""
import base64, json
from pathlib import Path

code = bytearray(); labels = {}; patches = []
def emit(*values): code.extend(values)
def label(name): labels[name] = len(code)
def branch(op, name): emit(op, 0); patches.append((len(code)-1, name, 'relative'))
def jump(name): emit(0x4c, 0, 0); patches.append((len(code)-2, name, 'absolute'))
def lda(value): emit(0xa9, value)
def sta(addr): emit(0x8d, addr & 255, addr >> 8)
def zp(op, addr): emit(op, addr)

label('reset'); emit(0x78, 0xd8, 0xa2, 0xff, 0x9a)  # SEI, CLD, LDX, TXS
lda(0); sta(0x2000); sta(0x2001); sta(0x4010); sta(0x4015)
for name in ['vblank1','vblank2']:
 label(name); emit(0x2c,2,0x20); branch(0x10,name)
# Palette via data table.
lda(0x3f); sta(0x2006); lda(0); sta(0x2006); emit(0xa2,0)
label('palette_loop'); emit(0xbd,0,0); patches.append((len(code)-2,'palette','absolute')); sta(0x2007); emit(0xe8,0xe0,32); branch(0xd0,'palette_loop')
# Four pages including attributes, then scroll reset.
lda(0x20); sta(0x2006); lda(0); sta(0x2006); emit(0xa0,4,0xa2,0)
label('nametable_loop'); lda(1); sta(0x2007); emit(0xe8); branch(0xd0,'nametable_loop'); emit(0x88); branch(0xd0,'nametable_loop')
# Hide 64 sprites; update the first one during the frame loop.
emit(0xa2,0); lda(255); label('hide'); emit(0x9d,0,2,0xe8); branch(0xd0,'hide')
lda(120); zp(0x85,0); lda(100); zp(0x85,1); lda(0); zp(0x85,2)
lda(2); sta(0x0201); lda(0); sta(0x0202)
lda(0); sta(0x2000); sta(0x2005); sta(0x2005); lda(0x1e); sta(0x2001)
label('frame'); emit(0x2c,2,0x20); branch(0x10,'frame')
lda(1); sta(0x4016); lda(0); sta(0x4016)
for i in range(8): emit(0xad,0x16,0x40,0x29,1,0x85,0x10+i)
for port,op,pos,name in [(0x16,0xc6,0,'left'),(0x17,0xe6,0,'right'),(0x14,0xc6,1,'up'),(0x15,0xe6,1,'down')]:
 zp(0xa5,port); branch(0xf0,name); zp(op,pos); label(name)
zp(0xa5,1); sta(0x0200); zp(0xa5,0); sta(0x0203); lda(2); sta(0x4014)
# A also gates an audible pulse channel for audio/controller verification.
zp(0xa5,0x10); branch(0xf0,'silent'); lda(1); sta(0x4015)
lda(0x3f); sta(0x4000); lda(0); sta(0x4001); lda(0x80); sta(0x4002); lda(8); sta(0x4003); jump('sound_done')
label('silent'); lda(0); sta(0x4015)
label('sound_done')
# Animate one palette colour every frame. A selects brighter sprite colour.
zp(0xe6,2); lda(0x3f); sta(0x2006); lda(0x11); sta(0x2006)
zp(0xa5,0x10); branch(0xf0,'normal'); lda(0x30); jump('colour')
label('normal'); zp(0xa5,2); emit(0x29,0x0f,0x09,0x20)
label('colour'); sta(0x2007); lda(0); sta(0x2000); sta(0x2005); sta(0x2005); jump('frame')
label('interrupt'); emit(0x40)  # RTI
label('palette'); emit(*([0x0f,0x12,0x22,0x30]*4+[0x0f,0x21,0x30,0x16]*4))
for offset,name,kind in patches:
 address=0x8000+labels[name]
 if kind=='relative':
  delta=labels[name]-(offset+1)
  assert -128<=delta<=127,(name,delta)
  code[offset]=delta & 255
 else:code[offset:offset+2]=address.to_bytes(2,'little')
prg=bytearray([0xea]*16384);prg[:len(code)]=code
for offset,name in [(0x3ffa,'interrupt'),(0x3ffc,'reset'),(0x3ffe,'interrupt')]:prg[offset:offset+2]=(0x8000+labels[name]).to_bytes(2,'little')
chrdata=bytearray(8192)
# Tile 1: sparse checker/grid background; tile 2: geometric diagnostic sprite.
chrdata[16:24]=bytes([0xff,0x81,0x81,0x81,0x81,0x81,0x81,0xff])
chrdata[32:40]=bytes([0x18,0x3c,0x7e,0xdb,0xff,0x7e,0x24,0x42])
chrdata[40:48]=bytes([0,0x18,0x3c,0x7e,0x7e,0x3c,0x18,0])
rom=b'NES\x1a'+bytes([1,1,0,0])+bytes(8)+prg+chrdata
root=Path(__file__).resolve().parents[1]
p=root/'app/src/main/assets/lab/demo-rom.json';p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps({'name':'Fly NES diagnostic','license':'MIT','author':'Fly Console contributors','base64':base64.b64encode(rom).decode()}))
if __name__=='__main__': print('Original diagnostic ROM:',len(rom),'bytes')
