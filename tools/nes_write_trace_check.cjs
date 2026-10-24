'use strict';
// SPDX-License-Identifier: MIT
// Production receives cartridge bytes and ordinary probe parameters only.
// The separate assembler oracle is read exclusively by this checker.
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');
const Probe=require('../app/src/main/assets/lab/core-probe.js');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-nes-trace-'));
const report={type:'gu-nes-write-trace-check',version:1,status:'RUNNING',startedAt:new Date().toISOString(),engine:'actual vendored JSNES 2.1.0',
 scope:'host emulator / original MIT controlled NROM-256 cartridge',
 oracle:'assembler output, checker only; never passed into production tracer/probe',
 conditions:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,
  serializedParity:'every executed oracle instruction, every defined frame, external write, NMI, save/load and reset boundary: entire core.toJSON() SHA256 plus emitted audio/video stream hashes and NES frame counter',
  outputHash:'all emitted 256x240 RGB pixels encoded as little-endian uint32; all stereo samples as little-endian float64',
  timing:'nearest-rank wall-time p50/p95/p99; paired AB/BA balanced order, equal restored start states, warmup excluded; raw frames retained; serialization and hash checks outside timed sections',
  limitations:'host Node timing only; short controlled cartridge workload, not browser/WebView, game generalization, physical Android, battery or an energy/performance-improvement claim'},
 categories:{unit:'separate core_probe_check.cjs',hostEmulator:'RUNNING',controlledRom:'RUNNING',frozenGeneralization:'NOT-TESTED',physicalAndroid:'DEVICE-PENDING'},
 parity:{boundaries:[],instructionCount:0,frameCount:0},writers:{},bounded:{},benchmarks:[]};
function save(){if(process.env.AGOD_TRACE_REPORT)fs.writeFileSync(process.env.AGOD_TRACE_REPORT,JSON.stringify(report,null,2)+'\n');}
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const stateOf=core=>JSON.parse(JSON.stringify(core.toJSON()));
const stateHash=core=>sha(JSON.stringify(core.toJSON()));
const distribution=values=>{const ordered=values.slice().sort((a,b)=>a-b),at=p=>ordered[Math.max(0,Math.ceil(ordered.length*p)-1)];return {count:values.length,totalMs:values.reduce((a,b)=>a+b,0),p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:ordered.at(-1)};};
const ratioDistribution=values=>{const ordered=values.slice().sort((a,b)=>a-b),at=p=>ordered[Math.max(0,Math.ceil(ordered.length*p)-1)];return {count:values.length,p50:at(.5),p95:at(.95),p99:at(.99),max:ordered.at(-1)};};
function outputSink(){
 const video=crypto.createHash('sha256'),audio=crypto.createHash('sha256'),sample=Buffer.alloc(16);
 let frames=0,samples=0,peak=0,maxColors=0;
 return {onFrame(pixels){const bytes=Buffer.allocUnsafe(pixels.length*4);for(let i=0;i<pixels.length;i++)bytes.writeUInt32LE(pixels[i]>>>0,i*4);video.update(bytes);frames++;maxColors=Math.max(maxColors,new Set(pixels).size);},
  onAudioSample(left,right){sample.writeDoubleLE(left,0);sample.writeDoubleLE(right,8);audio.update(sample);samples++;peak=Math.max(peak,Math.abs(left),Math.abs(right));},
  status(){return {frames,samples,videoSha256:video.copy().digest('hex'),audioSha256:audio.copy().digest('hex'),peak,maxColors};}};
}
let bytes,descriptor,oracle,Trace;
function makeCore({output=true,rom=bytes}={}){
 const sink=output?outputSink():null,core=new jsnes.NES(sink?{onFrame:sink.onFrame,onAudioSample:sink.onAudioSample}:{onFrame(){},onAudioSample(){}});
 core.loadROM(rom);return {core,sink};
}
function parity(items,label){
 const first=items[0],reference=stateHash(first.core),output=first.sink?.status();
 for(const item of items.slice(1)){
  assert.equal(stateHash(item.core),reference,label+': entire serialized state differs for '+item.name);
  assert.deepEqual(item.sink?.status(),output,label+': emitted outputs differ for '+item.name);
  assert.equal(item.core.fpsFrameCount,first.core.fpsFrameCount,label+': NES frame counter differs');
 }
 report.parity.boundaries.push({label,serializedStateSha256:reference,output});
}
function stepUntilDone(items){
 let steps=0;
 while(items[0].core.cpu.mem[oracle.doneAddress]!==oracle.doneValue){
  assert(steps++<256,'oracle phase must finish within 256 instructions');
  const cycles=items.map(item=>item.core.cpu.emulate());
  assert(cycles.every(value=>value===cycles[0]),'cycle parity at oracle instruction '+steps);
  parity(items,'instruction-'+steps);
 }
 report.parity.instructionCount=steps;
}
function frames(items,count,label){
 for(let frame=0;frame<count;frame++){
  const mask=[0,1,0,64,0,128][frame%6];
  for(const {core} of items){for(let bit=0;bit<8;bit++)(mask&(1<<bit)?core.buttonDown:core.buttonUp)(1,bit);core.frame();}
  report.parity.frameCount++;parity(items,label+'-'+(frame+1));
 }
}
function meta(frame=0,generation=7){return {generation,frame,atMs:frame*1000/60,
 action:{mask:0,humanMask:0,agentMask:0,manualOverride:false},
 provenance:{runId:'trace-check',originId:'trace-origin',startId:'trace-start',trajectoryId:'trace-path',partition:'discovery',independence:'unverified'}};}
function probeFor(core){return Probe.create({platform:'nes',core,identity:{romHash:descriptor.sha256,coreRevision:'jsnes-2.1.0-pr2-test'}});}
function knownWriterCheck(events,initialRam){
 assert.equal(events.length,oracle.expectedWrites.length,'every ordered RAM bus write in original assembly oracle must be observed');
 const prior=initialRam.slice();
 for(let index=0;index<events.length;index++){
  const actual=events[index],expected=oracle.expectedWrites[index],label='writer '+index+' '+expected.name;
  for(const field of ['address','logicalAddress','value','writerPc','opcode'])assert.equal(actual[field],expected[field],label+' '+field);
  assert.equal(actual.writerPC,expected.writerPc,label+' writerPC alias');
  assert.equal(actual.newValue,actual.value,label+' newValue');
  assert.equal(actual.oldValue,prior[expected.address],label+' oldValue follows the ordered bus writes');
  prior[expected.address]=expected.value;
  assert.equal(actual.origin,'cpu',label+' origin');
  assert.equal(actual.bank.status,'KNOWN',label+' bank status');
  assert.equal(actual.bank.mapper,0,label+' mapper');
  for(const field of ['physicalBank','bankOffset','prgOffset'])assert.equal(actual.bank[field],expected[field],label+' '+field);
  assert.equal(actual.bank.bankSize,16384,label+' static bank size');
  assert.equal(actual.cycle,null,label+' cycle precision is not established');
  assert.equal(actual.cycleStatus,'UNKNOWN',label+' cycle status');
 }
 const sites=new Set(events.filter(event=>event.address===0x40).map(event=>event.writerPc));
 assert(sites.size>=6,'same canonical variable has several independently known writer sites');
 assert.deepEqual([...new Set(events.map(event=>event.bank.physicalBank))].sort(),[0,1]);
 const rmw=oracle.expectedWrites.filter(event=>/^(inc|dec|asl|lsr|rol|ror)-/.test(event.name));
 assert.equal(rmw.length,12,'six original RMW instructions each have old-value and new-value writes');
 report.writers={status:'PASS',orderedEvents:events.length,distinctSites:new Set(events.map(event=>event.writerPc)).size,
  sameCanonicalVariableSites:sites.size,staticPrgBanks:[0,1],rmwBusWrites:rmw.length,events};
}
function boundedIntegration(){
 const {core}=makeCore({output:false}),probe=probeFor(core);
 assert.equal(probe.capabilities().cpuWriteTrace,true);assert.equal(probe.capabilities().bankMapping,true);
 const baseline=stateHash(core);probe.beginWriteTrace({generation:7,frame:0,maxEvents:3,maxFrames:120});
 assert.equal(stateHash(core),baseline,'opening trace window changes no emulator state');
 while(probe.traceReport().active)core.cpu.emulate();
 const limit=probe.traceReport(),drained=probe.drainWriteTrace();
 assert.equal(limit.reason,'event-limit');assert.equal(limit.eventCount,3);assert.equal(limit.overflow,true);
 assert.equal(limit.partialWindow,true);assert.equal(limit.endedDuringFrame,true);assert.equal(limit.lastFrame,0);
 assert.equal(drained.length,3);assert.equal(probe.drainWriteTrace().length,0,'drain is explicit and consumes retained events');
 assert.equal(limit.redacted,true);assert.equal(Object.hasOwn(limit,'events'),false);assert.equal(Object.hasOwn(limit,'ram'),false);
 const beforeBoundary=stateHash(core);probe.endWriteTrace('manual-override');assert.equal(stateHash(core),beforeBoundary);
 assert.equal(probe.traceReport().active,false);
 // Frame TTL is enforced at every completed frame, even during a no-write frame.
 probe.beginWriteTrace({generation:7,frame:0,maxEvents:4096,maxFrames:2});
 core.frame();probe.advanceTrace({generation:7,frame:1});assert.equal(probe.traceReport().active,true);
 core.frame();probe.advanceTrace({generation:7,frame:2});
 const ttl=probe.traceReport();assert.equal(ttl.reason,'frame-limit');assert.equal(ttl.active,false);assert.equal(ttl.partialWindow,false);
 // A normal observation window supplies its observed RAM changes as watchpoints.
 const first=probe.observe(meta(2)),old=first.ram;core.buttonDown(1,0);for(let i=0;i<4;i++)core.frame();
 const next=probe.observe(meta(6)),changed=[];for(let i=0;i<old.length;i++)if(old[i]!==next.ram[i])changed.push(i);
 assert(changed.length>0,'ordinary observations find RAM changes without consulting the oracle');
 const watchpoints=changed.slice(0,32);probe.beginWriteTrace({generation:7,frame:6,watchpoints,maxEvents:128,maxFrames:2});
 core.frame();probe.advanceTrace({generation:7,frame:7});
 const prior=stateHash(core);probe.endWriteTrace('manual-override');assert.equal(stateHash(core),prior,'manual boundary is emulator-read-only');
 const manual=probe.traceReport(),watched=probe.drainWriteTrace();
 assert.equal(manual.reason,'manual-override');assert.equal(manual.active,false);
 assert(watched.length>0);assert(watched.every(event=>watchpoints.includes(event.address)),'actual core watchpoints emit only selected canonical addresses');
 const retained=probe.drainWriteTrace().length;core.frame();assert.equal(probe.drainWriteTrace().length,retained,'closed boundary captures no later writes');
 probe.beginWriteTrace({generation:7,frame:8,maxFrames:8});core.frame();assert(probe.traceReport().queuedEvents>0);probe.advanceTrace({generation:8,frame:9});
 assert.equal(probe.traceReport().reason,'generation-change');assert.equal(probe.drainWriteTrace().length,0,'generation boundary discards old trace evidence');
 probe.beginWriteTrace({generation:8,frame:9,maxFrames:8});core.frame();assert(probe.traceReport().queuedEvents>0);
 const beforeSave=stateHash(core),snap=probe.snapshot();assert.equal(stateHash(core),beforeSave,'save boundary changes no serialized emulator state');
 assert.equal(probe.traceReport().active,false,'snapshot is a trace boundary');
 assert.equal(probe.traceReport().reason,'save-state');assert.equal(probe.drainWriteTrace().length,0,'snapshot boundary discards trace payload');
 assert.equal(Object.hasOwn(snap,'events'),false,'ordinary snapshots contain no local trace event payload');
 assert.equal(Object.hasOwn(snap.state,'trace'),false);
 probe.beginWriteTrace({generation:8,frame:9,maxFrames:8});const oldCpu=core.cpu;core.fromJSON(snap.state);
 probe.advanceTrace({generation:8,frame:10});assert.equal(probe.traceReport().active,false,'CPU replacement ends trace');
 const staleCount=probe.drainWriteTrace().length;oldCpu.write(0x40,1);assert.equal(probe.drainWriteTrace().length,0,'discarded CPU cannot deliver stale local trace callbacks');
 report.bounded={status:'PASS',eventLimit:limit,frameLimit:ttl,manualBoundary:manual,dataDerivedWatchpoints:watchpoints,
  watchpointEvents:watched.length,staleEventsDiscarded:staleCount,unknownTraceStatus:'observations only; no reward, terminal, semantic role or policy input is created'};
}
function benchmark(startState){
 const pairCount=12,framesPerRun=8,warmupFrames=12;
 report.conditions.benchmark={pairCount,framesPerRun,warmupFramesPerRun:warmupFrames,warmup:'each fresh core restores the same fixture state, executes twelve excluded frames in its own condition, then starts timing; active warmup has its own bounded window',orders:'AB,BA repeated six times for each comparison',active:'production bounded CoreProbe window, default canonical RAM coverage, maxEvents=4096, maxFrames=8; frame advance included',disabled:'helper loaded, no attachment',detached:'attach then detach before warmup and timing; original CPU methods restored',baseline:'unmodified vendor CPU',callbacks:'no-op video/audio in every timed core',restoredStateSha256:sha(JSON.stringify(startState))};
 for(const mode of ['disabled','detached','active']){
  const row={mode,status:'RUNNING',raw:[]},raw=row.raw,baselineFrames=[],conditionFrames=[],pairedDeltas=[],pairedRatios=[];
  report.benchmarks.push(row);save();
  for(let pair=0;pair<pairCount;pair++){
   const order=pair%2?['condition','baseline']:['baseline','condition'],runs={};
   for(const name of order){
    const {core}=makeCore({output:false});core.fromJSON(startState);let probe=null;
    const original={emulate:core.cpu.emulate,write:core.cpu.write,push:core.cpu.push};
    if(name==='condition'&&mode==='detached'){Trace.attach(core,{onWrite(){}}).detach();for(const key of Object.keys(original))assert.equal(core.cpu[key],original[key]);}
    if(name==='condition'&&mode==='active'){probe=probeFor(core);probe.beginWriteTrace({generation:1,frame:0,maxEvents:4096,maxFrames:warmupFrames});}
    for(let frame=1;frame<=warmupFrames;frame++){core.frame();if(probe)probe.advanceTrace({generation:1,frame});}
    const startStateSha256=stateHash(core);
    if(probe){assert.equal(probe.traceReport().reason,'frame-limit');probe.beginWriteTrace({generation:1,frame:warmupFrames,maxEvents:4096,maxFrames:framesPerRun});}
    const times=[];
    for(let frame=1;frame<=framesPerRun;frame++){
     const began=performance.now();core.frame();if(probe)probe.advanceTrace({generation:1,frame:warmupFrames+frame});times.push(performance.now()-began);
    }
    const after=stateHash(core),trace=probe?.traceReport();
    if(probe){assert.equal(trace.active,false);assert.equal(trace.reason,'frame-limit');assert.equal(trace.overflow,false);}
    runs[name]={frameMs:times,totalMs:times.reduce((sum,value)=>sum+value,0),startStateSha256,stateSha256:after,trace};
   }
   assert.equal(runs.condition.startStateSha256,runs.baseline.startStateSha256,'paired '+mode+' timed start states must agree after excluded warmup');
   assert.equal(runs.condition.stateSha256,runs.baseline.stateSha256,'paired '+mode+' end states must agree');
   baselineFrames.push(...runs.baseline.frameMs);conditionFrames.push(...runs.condition.frameMs);
   pairedDeltas.push((runs.condition.totalMs-runs.baseline.totalMs)/framesPerRun);
   pairedRatios.push(runs.condition.totalMs/runs.baseline.totalMs);
   raw.push({pair,order,runs});save();
  }
  Object.assign(row,{status:'PASS',baselineFrame:distribution(baselineFrames),conditionFrame:distribution(conditionFrames),
   pairedPerFrameDelta:distribution(pairedDeltas),pairedTotalRatio:ratioDistribution(pairedRatios),
   interpretation:'descriptive host samples; noise/JIT/order effects can dominate small differences; no significance or speedup claim'});save();
 }
}
save();
try{
 const romPath=path.join(directory,'rom.json'),oraclePath=path.join(directory,'oracle.json');
 execFileSync(process.env.PYTHON||'python3',[path.join(__dirname,'make_nes_trace_rom.py'),'--out',romPath,'--oracle-out',oraclePath]);
 descriptor=JSON.parse(fs.readFileSync(romPath));oracle=JSON.parse(fs.readFileSync(oraclePath));bytes=Buffer.from(descriptor.base64,'base64');
 assert.equal(sha(bytes),descriptor.sha256);assert.equal(bytes[4],2);assert.equal(descriptor.license,'MIT');
 report.rom={name:descriptor.name,sha256:descriptor.sha256,license:descriptor.license,prgBanks16KiB:2};
 require('../app/src/main/assets/lab/nes-write-trace.js');Trace=globalThis.FlyNesWriteTrace;
 const sourceManifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../app/src/main/assets/lab/nes-write-trace-source.json')));
 const ordinaryCoreSha256=sha(fs.readFileSync(path.join(__dirname,'../app/src/main/assets/lab/jsnes.min.js'))),helperSha256=sha(fs.readFileSync(path.join(__dirname,'../app/src/main/assets/lab/nes-write-trace.js')));
 assert.equal(ordinaryCoreSha256,sourceManifest.ordinary_core_sha256);assert.equal(helperSha256,sourceManifest.generated_bundle_sha256);
 report.reproducibility={ordinaryCoreSha256,helperSha256,upstreamArchiveSha256:sourceManifest.upstream_archive_sha256,
  checkerSha256:sha(fs.readFileSync(__filename)),fixtureGeneratorSha256:sha(fs.readFileSync(path.join(__dirname,'make_nes_trace_rom.py')))};
 const cpuPrototype=Object.getPrototypeOf(makeCore({output:false}).core.cpu),prototypeEmulate=cpuPrototype.emulate,prototypeWrite=cpuPrototype.write,prototypePush=cpuPrototype.push;
 const activeEvents=[],items=['vendor-baseline','instrumented-disabled','instrumented-active','instrumented-detached'].map(name=>({name,...makeCore()}));
 const active=items[2],detached=items[3],original=active.core.cpu.emulate,originalWrite=active.core.cpu.write,originalPush=active.core.cpu.push;
 let session=Trace.attach(active.core,{onWrite:event=>activeEvents.push(event)});
 const detachedOriginal=detached.core.cpu.emulate;Trace.attach(detached.core,{onWrite(){throw Error('detached sink called');}}).detach();
 assert.equal(detached.core.cpu.emulate,detachedOriginal);assert.equal(items[0].core.cpu.emulate,original,'attachment affects only selected instance');
 assert.equal(cpuPrototype.emulate,prototypeEmulate);assert.equal(cpuPrototype.write,prototypeWrite);assert.equal(cpuPrototype.push,prototypePush);
 const initialRam=items[0].core.cpu.mem.slice(0,2048);
 parity(items,'loaded');stepUntilDone(items);knownWriterCheck(activeEvents,initialRam);save();
 // Out-of-band writes cannot inherit the preceding instruction's provenance.
 const priorEvents=activeEvents.length;for(const item of items)item.core.cpu.write(0x0840,0xfa);parity(items,'external-write');
 const external=activeEvents[priorEvents];assert.equal(external.writerPc,null);assert.equal(external.opcode,null);assert.equal(external.origin,'unknown');assert.equal(external.bank.status,'UNKNOWN');
 report.writers.externalWrite=external;
 // Real interrupt stack pushes happen before any next decoded instruction.
 const beforeNmi=activeEvents.length;for(const item of items){item.core.cpu.nmiImmediate=true;item.core.cpu.emulate();}parity(items,'forced-nmi-entry');
 const interrupt=activeEvents.slice(beforeNmi);assert.equal(interrupt.length,3);for(const event of interrupt){assert.equal(event.writerPc,null);assert.equal(event.opcode,null);assert.equal(event.origin,'unknown');assert.equal(event.bank.status,'UNKNOWN');}
 report.writers.interruptStack=interrupt;
 frames(items,24,'frame');
 const outputs=items[0].sink.status();assert(outputs.frames>=24);assert(outputs.samples>1000);assert(outputs.peak>0,'fixture must produce sound');assert(outputs.maxColors>1,'fixture must produce nontrivial video');
 session.detach();assert.equal(active.core.cpu.emulate,original);assert.equal(active.core.cpu.write,originalWrite);assert.equal(active.core.cpu.push,originalPush);
 const afterDetach=activeEvents.length;frames(items,3,'detached');assert.equal(activeEvents.length,afterDetach);
 const saved=items.map(item=>stateOf(item.core));parity(items,'save');
 for(let index=0;index<items.length;index++)items[index].core.fromJSON(saved[index]);parity(items,'load');
 session=Trace.attach(active.core,{onWrite:event=>activeEvents.push(event)});frames(items,12,'restored-frame');session.detach();
 for(const item of items){item.core.reset();item.core.loadROM(bytes);}parity(items,'reset-and-reload');frames(items,12,'reset-frame');
 const benchmarkStart=stateOf(items[0].core);
 const faultItems=['vendor-fault-control','sink-fault-active'].map(name=>({name,...makeCore()}));
 for(const item of faultItems)item.core.fromJSON(benchmarkStart);
 const faultOriginal=faultItems[1].core.cpu.emulate;let faultCalls=0;
 const faultSession=Trace.attach(faultItems[1].core,{onWrite(){faultCalls++;throw Error('intentional checker sink failure');}});
 frames(faultItems,2,'sink-fault');assert.equal(faultCalls,1);assert.equal(faultSession.getStatus().active,false);
 assert.equal(faultSession.getStatus().reason,'sink_fault');assert.equal(faultItems[1].core.cpu.emulate,faultOriginal);
 report.writers.sinkFault={status:'isolated',calls:faultCalls,session:faultSession.getStatus()};
 // Actual supported emulator mapper 2 is outside the tracer's static bank model.
 const uxromBytes=Buffer.from(bytes);uxromBytes[6]=0x20;
 const {core:uxrom}=makeCore({output:false,rom:uxromBytes}),unknown=[];
 assert.equal(uxrom.rom.mapperType,2);const uxromSession=Trace.attach(uxrom,{onWrite:event=>unknown.push(event)});
 for(let step=0;uxrom.cpu.mem[oracle.doneAddress]!==oracle.doneValue&&step<256;step++)uxrom.cpu.emulate();
 assert.equal(uxrom.cpu.mem[oracle.doneAddress],oracle.doneValue);assert.equal(unknown.length,oracle.expectedWrites.length);
 for(const event of unknown){assert.equal(event.bank.status,'UNKNOWN');assert.equal(event.bank.physicalBank,null);assert.equal(event.bank.prgOffset,null);assert.equal(event.bank.mapper,2);}
 uxromSession.detach();report.writers.unsupportedMapper={mapper:2,executedEvents:unknown.length,status:'UNKNOWN',sample:unknown[0]};
 boundedIntegration();benchmark(benchmarkStart);
 assert.equal(cpuPrototype.emulate,prototypeEmulate);assert.equal(cpuPrototype.write,prototypeWrite);assert.equal(cpuPrototype.push,prototypePush);
 report.categories.hostEmulator='PASS';report.categories.controlledRom='PASS';report.status='PASS';report.completedAt=new Date().toISOString();save();
 console.log(JSON.stringify({type:report.type,status:report.status,rom:report.rom,parity:{instructionCount:report.parity.instructionCount,frameCount:report.parity.frameCount,boundaries:report.parity.boundaries.length},writers:{orderedEvents:report.writers.orderedEvents,distinctSites:report.writers.distinctSites,staticPrgBanks:[0,1],unsupportedMapper:'UNKNOWN'},bounded:report.bounded.status,benchmarks:report.benchmarks.map(({mode,baselineFrame,conditionFrame})=>({mode,baselineFrame,conditionFrame})),categories:report.categories}));
 console.log('PASS: actual NES ordered writer PC/static-bank oracle, mirrors/indexed/indirect/direct stack/RMW writes, external/NMI/mapper UNKNOWN, serialized-state and audio/video parity across disabled/active/detached/save/load/reset, bounded actual-core windows, balanced paired host overhead; Android pending');
}catch(error){report.status='FAIL';report.completedAt=new Date().toISOString();report.error={message:error.message,stack:error.stack};save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
