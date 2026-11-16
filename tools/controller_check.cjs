'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Pad=require('../app/src/main/assets/lab/controller.js'),Sega=require('../app/src/main/assets/lab/sega-core.js'),Tools=require('../app/src/main/assets/lab/game-tools.js');
assert.equal(Pad.keyboard('sega').KeyD,2);assert.equal(Pad.keyboard('sega').KeyE,10);assert.equal(Pad.keyboard('nes').KeyX,0);assert.equal(Pad.keyboard('sega',{KeyE:11}).KeyE,11);
assert.equal(Pad.axis(.1,-.1),0);assert.equal(Pad.axis(1,-1),144);assert.equal(Pad.clean(48|192|256,true),256);assert.equal(Pad.clean(256,false),0);
assert.deepEqual(Tools.actions('0,256,512,1024,2048',4095),[0,256,512,1024,2048]);assert.throws(()=>Tools.actions('0,256'));assert.throws(()=>Tools.actions('0,4096',4095));
for(const system of ['nes','gb','snes','sega']){const extended=['snes','sega'].includes(system);assert.equal(Pad.gamepad(1,true,extended),2);assert.equal(Pad.gamepad(2,true,extended),1);assert.equal(Pad.gamepad(3|128,true,extended),3|128);assert.equal(Pad.gamepad(1,false,extended),1);}
const raw=Uint8Array.from(Buffer.from(require('../app/src/main/assets/lab/demo-sega.json').base64,'base64'));
const swap=raw.slice();for(let i=0;i<raw.length;i+=2){swap[i]=raw[i+1];swap[i+1]=raw[i];}assert.deepEqual(Sega.normalizeRom(swap).bytes,raw);
const smd=new Uint8Array(raw.length+512);for(let o=0;o<raw.length;o+=16384)for(let i=0;i<8192;i++){smd[512+o+i]=raw[o+2*i+1];smd[512+o+8192+i]=raw[o+2*i];}assert.deepEqual(Sega.normalizeRom(smd).bytes,raw);
const mismatch=raw.slice();new DataView(mismatch.buffer).setUint32(0x1a4,0x3fffff);assert.equal(Sega.validateRom(mismatch).warnings.length,1,'inexact header size is a warning, not false incompatibility');
const sp=raw.slice();new DataView(sp.buffer).setUint32(0,0x1000000);assert.doesNotThrow(()=>Sega.validateRom(sp));assert.throws(()=>Sega.validateRom(raw.slice(0,512)));
const source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8'),events=[];
const state={labPlatform:'sega',loaded:true,manualMask:256|1024|16|32,appliedMask:0,window:{},$:()=>({value:''}),nes:{buttonDown:(p,b)=>events.push(['down',p,b]),buttonUp:(p,b)=>events.push(['up',p,b])}};
vm.createContext(state);vm.runInContext(source.slice(source.indexOf('function normalizeMask'),source.indexOf('/* the latest frame is kept')),state);state.updateButtons();
assert.deepEqual(events,[['down',1,4],['down',1,8],['down',1,10]],'six-button human port 1, opposite directions resolved, nothing on port 2');
events.length=0;state.manualMask=256;state.updateButtons();assert.deepEqual(events,[['up',1,4],['up',1,10]],'only changed buttons are released');events.length=0;state.releasePorts();assert.equal(events.filter(x=>x[0]==='up').length,24,'release all 12 buttons on both ports');
console.log('PASS: Sega/NES keyboard isolation, 12-bit human port, axis deadzone, SMD/byte swap and header compatibility');
