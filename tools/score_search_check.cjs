'use strict';
const assert=require('node:assert/strict'),S=require('../app/src/main/assets/lab/score-search.js');
let checks=0;
for(const size of [2048,65536,8192,131072])for(const format of ['unsigned','bcd'])for(const endian of ['little','big'])for(const multiplier of [1,10,100,1000]){
 const mem=new Uint8Array(size),spec={address:171,width:3,format,endian,multiplier};
 const put=n=>{n/=multiplier;for(let i=0;i<3;i++){mem[spec.address+(endian==='little'?i:2-i)]=format==='bcd'?((Math.floor(n/10)%10)<<4)|(n%10):n%256;n=Math.floor(n/(format==='bcd'?100:256));}};
 put(1234*multiplier);const candidates=S.scan(mem,1234*multiplier);assert(candidates.length>0);
 put(2867*multiplier);const narrowed=S.narrow(candidates,mem,1234*multiplier,2867*multiplier),choices=S.compact(narrowed,mem);
 assert.equal(choices.length,1);assert.equal(S.read(mem,choices[0]),2867*multiplier);assert.equal(choices[0].format,format);assert.equal(choices[0].multiplier,multiplier);checks++;
}
const mem=new Uint8Array(2048);mem[19]=mem[80]=0x34;mem[20]=mem[81]=0x12;const mirrored=S.scan(mem,0x1234);mem[19]=mem[80]=0x67;mem[20]=mem[81]=0x28;
assert.equal(S.compact(S.narrow(mirrored,mem,0x1234,0x2867),mem).length,2,'two mirrored counters remain ambiguous');
assert.throws(()=>S.scan(mem,0));assert.throws(()=>S.narrow(mirrored,mem,100,99));assert.throws(()=>S.narrow(mirrored,mem,100,100));
assert.throws(()=>S.read(mem,{address:2047,width:2,format:'unsigned',endian:'big',multiplier:1}));
assert.equal(S.read(new Uint8Array([0xfa]),{address:0,width:1,format:'bcd',endian:'big',multiplier:1}),null);
const counter={address:10,width:2,format:'unsigned',endian:'little',multiplier:10},proof={version:1,system:'sega',romHash:'a'.repeat(64),counter,evidence:[{frame:10,score:12340},{frame:90,score:28670}]},profile={rewardAddress:'10',ramWidth:'2',ramFormat:'unsigned',ramEndian:'little',rewardScale:'.01'};
assert.equal(S.validate(proof,profile,'sega',proof.romHash,65536),proof);
assert.throws(()=>S.validate(proof,profile,'nes',proof.romHash,2048));assert.throws(()=>S.validate(proof,{...profile,rewardAddress:'11'},'sega',proof.romHash,65536));
assert.throws(()=>S.validate({...proof,evidence:[proof.evidence[0],{frame:10,score:28670}]},profile,'sega',proof.romHash,65536));
assert.throws(()=>S.validate(null,profile,'sega',proof.romHash,65536));
console.log('PASS: '+checks+' binary/BCD/endian/scaling score discoveries across platform RAM sizes; aliases, mirrored ambiguity, reset/timer rejection and versioned proof validation');
