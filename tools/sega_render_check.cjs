'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Sega=require('../app/src/main/assets/lab/sega-core.js'),Factory=require('../app/src/main/assets/lab/sega/genplus.js');
const binary=fs.readFileSync(path.join(__dirname,'../app/src/main/assets/lab/sega/genplus.wasm'));
const original=Buffer.from(require('../app/src/main/assets/lab/demo-sega.json').base64,'base64');
(async()=>{
 const sega=await Sega.create({},Factory,{wasmBinary:binary});
 for(const [wide,pal] of [[false,false],[true,false],[false,true],[true,true]]){
  const rom=Buffer.from(original);
  if(wide){const at=rom.indexOf(Buffer.from('33fc857800c00004','hex'));assert(at>=512);rom.writeUInt16BE(0x8c81,at+2);}
  if(pal){rom.fill(32,0x1f0,0x200);rom[0x1f0]=69;const at=rom.indexOf(Buffer.from('33fc814400c00004','hex'));assert(at>=512);rom.writeUInt16BE(0x814c,at+2);}
  // Own diagnostic has cleared tiles and a solid CRAM backdrop: every visible pixel must agree.
  sega.loadROM(Uint8Array.from(rom));for(let i=0;i<20;i++)sega.frame();
  const w=sega.g._lab_video_width(),h=sega.g._lab_video_height();assert.equal(w,wide?320:256);assert.equal(h,pal?240:224);
  assert(sega.pixels[0]!==0,'nonblack backdrop');assert(sega.pixels.every(p=>p===sega.pixels[0]),'no alternating black rows, missing columns or half-image crop');
  const raw=new Uint32Array(sega.g.HEAPU8.buffer,sega.g._get_frame_buffer_ref(),640*480);
  for(let y=0;y<480;y++)for(let x=0;x<640;x++)if(x>=w||y>=h)assert.equal(raw[y*640+x],0,'renderer writes outside active geometry');
  assert.equal(sega.g._lab_video_buffer_valid(),1,'framebuffer guards unchanged');
  const state=sega.toJSON();sega.buttonDown(1,7);for(let i=0;i<8;i++)sega.frame();sega.fromJSON(state);assert(sega.pixels.every(p=>p===sega.pixels[0]));assert.equal(sega.g._lab_video_buffer_valid(),1);
 }
 // Explicit CRAM red validates channel ordering independently of uniformity.
 const red=Buffer.from(original);const at=red.indexOf(Buffer.from('004000e0','hex'));assert(at>=512);red.writeUInt16BE(0x000e,at+2);sega.loadROM(Uint8Array.from(red));for(let i=0;i<20;i++)sega.frame();const color=sega.pixels[0];assert((color&255)>0&&((color>>>8)&255)===0&&((color>>>16)&255)===0,'red maps to RGBA red, not blue');
 console.log('PASS: actual WASM 256/320 columns, NTSC224/PAL240, complete solid raster, untouched padding/guards, snapshots and RGB ordering');
})().catch(e=>{console.error(e);process.exit(1);});
