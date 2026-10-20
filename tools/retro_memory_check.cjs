/* Isolated process memory stress. No phone, battery or latency claims. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base=path.resolve('app/src/main/assets/lab'),system=process.env.GU_MEMORY_SYSTEM||'snes';
if(!['gb','snes'].includes(system)||!global.gc)throw Error('Use --expose-gc and GU_MEMORY_SYSTEM=gb|snes');
(async()=>{
 let frames=0;const core=await require(path.join(base,'retro-core.js')).create(system,{onFrame:p=>{assert(p.length>0);frames++;}},require(path.join(base,system,'core.js')),{wasmBinary:fs.readFileSync(path.join(base,system,'core.wasm'))});
 const demo=JSON.parse(fs.readFileSync(path.join(base,'demo-'+system+'.json')));core.loadROM(Uint8Array.from(Buffer.from(demo.base64,'base64')));
 const samples=[];for(let block=0;block<9;block++){for(let i=0;i<6000;i++){core.frame();if(i%300===0)global.gc();}global.gc();samples.push({frames,...process.memoryUsage(),wasmBytes:core.g.HEAPU8.buffer.byteLength});}
 assert.equal(frames,54000);assert(core.pixels.buffer!==core.g.HEAPU8.buffer,'video must own its storage outside growing WASM memory');
 const report={scope:'Isolated unpaced host allocation stress, no neural backend. Other tasks may run concurrently; timing deliberately omitted. Not a phone long-session or leak certification.',system,frames,samples};
 fs.writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log('PASS: '+system+' 54000 frames, private video storage, memory samples recorded');
})().catch(e=>{console.error(e);process.exitCode=1;});
