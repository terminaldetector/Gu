/* Host-only baseline on original diagnostic cartridges, never a device claim. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const assets=path.resolve(__dirname,'../app/src/main/assets/lab');
const frames=Number(process.env.GU_BASELINE_FRAMES||3600);
if(!Number.isSafeInteger(frames)||frames<600||frames>216000)throw Error('GU_BASELINE_FRAMES must be 600..216000');
const systems=(process.env.GU_BASELINE_SYSTEMS||'nes,sega,gb,gbc,snes').split(',');
if(!systems.length||systems.some(s=>!['nes','sega','gb','gbc','snes'].includes(s))||new Set(systems).size!==systems.length)throw Error('Invalid GU_BASELINE_SYSTEMS');
const rom=name=>Uint8Array.from(Buffer.from(JSON.parse(fs.readFileSync(path.join(assets,name==='nes'?'demo-rom.json':'demo-'+name+'.json'))).base64,'base64'));
const digest=core=>crypto.createHash('sha256').update(Buffer.from(Array.from(core.cpu.mem))).digest('hex');
const quantile=(a,p)=>a[Math.min(a.length-1,Math.floor(a.length*p))];
async function run(name){
 let callbacks=0,audio=0;
 const options={onFrame:()=>callbacks++,onAudioSample:(l,r)=>{assert(Number.isFinite(l)&&Number.isFinite(r));audio++;}};
 let core;
 if(name==='nes')core=new (require(path.join(assets,'jsnes.min.js')).NES)(options);
 else if(name==='sega')core=await require(path.join(assets,'sega-core.js')).create(options,require(path.join(assets,'sega/genplus.js')),{wasmBinary:fs.readFileSync(path.join(assets,'sega/genplus.wasm'))});
 else{const system=name==='gbc'?'gb':name;core=await require(path.join(assets,'retro-core.js')).create(system,options,require(path.join(assets,system,'core.js')),{wasmBinary:fs.readFileSync(path.join(assets,system,'core.wasm'))});}
 core.loadROM(rom(name));
 for(let i=0;i<180;i++)core.frame();
 const heap=[];if(global.gc)global.gc();heap.push(process.memoryUsage());
 const samples=[],start=performance.now(),cpu=process.cpuUsage(),beforeFrames=callbacks,beforeAudio=audio;
 for(let i=0;i<frames;i++){
  const t=performance.now();core.frame();samples.push(performance.now()-t);
  if((i+1)%300===0){if(global.gc)global.gc();heap.push(process.memoryUsage());}
 }
 const elapsed=performance.now()-start,cpuUsed=process.cpuUsage(cpu),measuredVideo=callbacks-beforeFrames,measuredAudio=audio-beforeAudio;
 assert.equal(callbacks-beforeFrames,frames,'one video callback per frame');
 assert(audio>beforeAudio,'audio remains active');
 let t=performance.now();const saved=core.toJSON(),saveMs=performance.now()-t;
 for(let i=0;i<120;i++)core.frame();const future=digest(core);
 t=performance.now();core.fromJSON(saved);const loadMs=performance.now()-t;
 for(let i=0;i<120;i++)core.frame();assert.equal(digest(core),future,'restored CPU/RAM follows identical execution');
 // Reset/reopen the cartridge without constructing an additional emulator.
 core.reloadROM();for(let i=0;i<60;i++)core.frame();
 core.loadROM(rom(name));for(let i=0;i<60;i++)core.frame();
 samples.sort((a,b)=>a-b);
 return {system:name,frames,videoCallbacks:measuredVideo,audioSamplesDuringMeasurement:measuredAudio,
  wallMs:elapsed,unpacedHostFps:frames*1000/elapsed,frameMs:{p50:quantile(samples,.5),p95:quantile(samples,.95),p99:quantile(samples,.99),max:samples.at(-1)},
  processCpuMs:(cpuUsed.user+cpuUsed.system)/1000,saveMs,loadMs,snapshotJsonBytes:Buffer.byteLength(JSON.stringify(saved)),
  memory:{gcAvailable:!!global.gc,start:heap[0],end:heap.at(-1),peakRss:Math.max(...heap.map(v=>v.rss)),heapSamples:heap.map(v=>v.heapUsed)},
  deterministicRestore:true,resetAndReopen:true,neuralInferenceLatency:null,gpuCost:null,battery:null};
}
(async()=>{
 const report={schema:1,at:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,
  scope:'Unpaced host diagnostic ROMs with neural backend disabled; includes periodic GC overhead. Not Android FPS, audio synchronization, energy, commercial-ROM compatibility or proof of absence of leaks.',
  results:[]};
 for(const name of systems){report.results.push(await run(name));console.error('PASS host baseline: '+name);}
 const output=process.argv[2];if(output)fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');else console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
