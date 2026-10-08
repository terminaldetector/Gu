'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const Sega=require('../app/src/main/assets/lab/sega-core.js'),Factory=require('../app/src/main/assets/lab/sega/genplus.js');
(async()=>{
 const s=await Sega.create({},Factory,{wasmBinary:fs.readFileSync('app/src/main/assets/lab/sega/genplus.wasm')});assert.equal(s.g._lab_core_api(),6);
 // Own 68K cartridge reads both hardware ports through the actual six-button TH handshake.
 const rom=Buffer.from(require('../app/src/main/assets/lab/demo-sega.json').base64,'base64');rom.fill(0,0x200);let pc=0x200;const labels={},fix=[];
 const words=(...a)=>a.forEach(v=>{rom.writeUInt16BE(v&65535,pc);pc+=2;});const long=v=>words(v>>>16,v);const mb=(v,addr)=>{words(0x13fc,v);long(addr);};const read=(addr,ram)=>{words(0x13f9);long(addr);long(ram);};const branch=(op,label)=>{words(op,0);fix.push([pc-2,label]);};
 words(0x46fc,0x2700,0x33fc,0x8144);long(0xc00004);mb(0x40,0xa10009);mb(0x40,0xa1000b);mb(0x40,0xa10003);mb(0x40,0xa10005);
 labels.end=pc;words(0x3039);long(0xc00004);words(0x0800,3);branch(0x6600,'end');labels.blank=pc;words(0x3039);long(0xc00004);words(0x0800,3);branch(0x6700,'blank');
 for(let p=0;p<2;p++){const addr=0xa10003+p*2,ram=0xff0010+p*4;read(addr,ram);mb(0,addr);read(addr,ram+1);mb(0x40,addr);mb(0,addr);mb(0x40,addr);mb(0,addr);mb(0x40,addr);read(addr,ram+2);mb(0,addr);mb(0x40,addr);}
 branch(0x6000,'end');for(const [at,label] of fix)rom.writeInt16BE(labels[label]-at,at);
 s.loadROM(Uint8Array.from(rom));s.configurePads([6,6]);const frames=()=>{for(let i=0;i<4;i++)s.frame();};frames();assert.equal(s.cpu.mem[18]&15,15);
 for(const [button,bit,offset] of [[0,16,1],[1,16,0],[2,32,0],[3,32,1]]){s.buttonDown(1,button);frames();assert.equal(s.cpu.mem[16+offset]&bit,0,'A/B/C/Start physical bus');s.buttonUp(1,button);frames();}
 for(const [button,bit] of [[8,4],[9,2],[10,1],[11,8]]){
  s.buttonDown(1,button);frames();assert.equal(s.cpu.mem[18]&15,15^bit,'P1 six-button bus '+button);assert.equal(s.cpu.mem[22]&15,15,'P2 isolated');
  s.buttonDown(2,button);frames();assert.equal(s.cpu.mem[22]&15,15^bit,'P2 six-button bus '+button);s.buttonUp(1,button);s.buttonUp(2,button);frames();
 }
 s.buttonDown(1,8);s.buttonDown(2,10);const saved=s.toJSON();frames();s.fromJSON(saved);frames();assert.equal(s.mask,256);assert.equal(s.mask2,1024);assert.equal(s.cpu.mem[18]&15,11);assert.equal(s.cpu.mem[22]&15,14);
 const frame=s.cpu.mem[18];s.configurePads([3,6]);s.buttonDown(1,8);frames();assert.equal(s.cpu.mem[18]&15,15,'3-button compatibility ignores X without a ROM reset');assert(frame!==undefined);s.reloadROM();assert.equal(s.mask|s.mask2,0);
 console.log('PASS: real 68K TH handshake, X/Y/Z/Mode on P1/P2, 3/6 controller types, snapshots and neutral reset');
})().catch(e=>{console.error(e);process.exit(1);});
