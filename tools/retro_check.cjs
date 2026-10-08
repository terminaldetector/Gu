'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Retro=require('../app/src/main/assets/lab/retro-core.js'),Controller=require('../app/src/main/assets/lab/controller.js');
const assets=path.resolve(__dirname,'../app/src/main/assets/lab');
const rom=name=>Uint8Array.from(Buffer.from(JSON.parse(fs.readFileSync(path.join(assets,'demo-'+name+'.json'))).base64,'base64'));
const digest=s=>crypto.createHash('sha256').update(Buffer.from(s.pixels.buffer)).digest('hex');
(async()=>{
 for(const name of ['gb','gbc','snes']){
  const system=name==='gbc'?'gb':name;let frames=0,samples=0,peak=0;
  const core=await Retro.create(system,{onFrame:(pixels,w,h)=>{assert.equal(pixels.length,w*h);assert(w>0&&h>0);frames++;},onAudioSample:(l,r)=>{assert(Number.isFinite(l)&&Number.isFinite(r));assert(Math.abs(l)<=1&&Math.abs(r)<=1);samples++;peak=Math.max(peak,Math.abs(l),Math.abs(r));}},require(path.join(assets,system,'core.js')),{wasmBinary:fs.readFileSync(path.join(assets,system,'core.wasm'))});
  const bytes=rom(name);assert.equal(Retro.normalizeRom(bytes,system).warnings.length,0);core.loadROM(bytes);
  for(let i=0;i<30;i++)core.frame();
  assert.equal(core.ramSize,name==='gb'?8192:name==='gbc'?32768:131072);assert(core.fps>49&&core.fps<61);assert.equal(frames,30);assert(samples>1000,'audio transport');
  assert(core.pixels.some(p=>(p&0xffffff)!==0),'real cartridge generates visible video');if(system==='gb'){assert.equal(core.g._lab_width(),160);assert.equal(core.g._lab_height(),144);assert(peak>0,'GB original diagnostic square tone');}
  if(system==='gb'){
   assert.equal(core.cpu.mem[1]&1,1,'Right initially released');core.buttonDown(1,7);for(let i=0;i<3;i++)core.frame();assert.equal(core.cpu.mem[1]&1,0,'Right reaches GB hardware');
   core.buttonDown(2,0);assert.equal(core.mask2,0,'GB has one port');core.buttonUp(1,7);for(let i=0;i<3;i++)core.frame();assert.equal(core.cpu.mem[1]&1,1,'release reaches GB');
  }else{
   // SNES serial controller order B,Y,Select,Start,Up,Down,Left,Right,A,X,L,R.
   const serial=[8,0,1,3,4,5,6,7,9,10,11,2];
   for(let bit=0;bit<12;bit++){
    core.mask=1<<bit;core.mask2=1<<((bit+1)%12);for(let i=0;i<3;i++)core.frame();
    for(let j=0;j<12;j++){assert.equal(core.cpu.mem[0x10+j],Number(j===serial[bit]),'SNES P1 bit '+bit);assert.equal(core.cpu.mem[0x30+j],Number(j===serial[(bit+1)%12]),'SNES P2 bit '+bit);}
   }
   core.mask=core.mask2=0;for(let i=0;i<3;i++)core.frame();for(let j=0;j<12;j++){assert.equal(core.cpu.mem[0x10+j],0);assert.equal(core.cpu.mem[0x30+j],0);}
   const header=new Uint8Array(bytes.length+512);header.set(bytes,512);assert.deepEqual(Retro.normalizeRom(header,'snes').bytes,bytes);
  }
  const saved=core.toJSON(),initial=Array.from({length:64},(_,i)=>core.cpu.mem[i]),initialVideo=digest(core);
  core.mask=128;for(let i=0;i<12;i++)core.frame();const expected=Array.from({length:64},(_,i)=>core.cpu.mem[i]),expectedVideo=digest(core);
  core.fromJSON(saved);assert.deepEqual(Array.from({length:64},(_,i)=>core.cpu.mem[i]),initial);assert.equal(digest(core),initialVideo);
  core.mask=128;for(let i=0;i<12;i++)core.frame();assert.deepEqual(Array.from({length:64},(_,i)=>core.cpu.mem[i]),expected,'repeatable CPU/RAM snapshot');assert.equal(digest(core),expectedVideo,'repeatable raster');
  assert.throws(()=>core.fromJSON({...saved,kind:system==='gb'?'snes':'gb'}));assert.throws(()=>core.fromJSON({...saved,data:'AAAA'}));
  core.reloadROM();assert.equal(core.mask|core.mask2,0);for(let i=0;i<10;i++)core.frame();assert(core.g._lab_valid());
  console.log('PASS: '+name+' real WASM cartridge, video/audio, hardware ports, RAM, snapshots and reset');
 }
 assert.throws(()=>Retro.normalizeRom(new Uint8Array(1),'gb'));assert.throws(()=>Retro.normalizeRom(new Uint8Array(8*1024*1024+1),'gb'));assert.throws(()=>Retro.normalizeRom(rom('gb'),'snes'));
 assert.equal(Controller.keyboard('snes').KeyQ,8);assert.equal(Controller.keyboard('snes').ShiftLeft,11);assert.equal(Controller.keyboard('gb').KeyX,0);
})().catch(e=>{console.error(e);process.exitCode=1;});
