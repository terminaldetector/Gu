/* Platform probes expose observations, never controls or neural policy inputs. */
(function(root){'use strict';
 const SCHEMA=1,REVISION='agod-foundation-1',RAM_BYTES=2048,PIXELS=256*240;
 const TRACE_CAPS=Object.freeze({maxEvents:4096,maxFrames:120,maxWatchpoints:32,maxWallMs:5000});
 const clone=value=>JSON.parse(JSON.stringify(value));
 const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
 const hashBytes=values=>{let hash=2166136261;for(const value of values){hash^=value&255;hash=Math.imul(hash,16777619);}return(hash>>>0).toString(16).padStart(8,'0');};
 const fail=message=>{throw Error('CoreProbe: '+message);};
 const id=(value,name,max=160)=>{if(typeof value!=='string'||!value.length||value.length>max)fail('invalid '+name);return value;};
 function limitsOf(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid limits');
  const maxRamBytes=value.maxRamBytes===undefined?RAM_BYTES:value.maxRamBytes,maxSnapshotBytes=value.maxSnapshotBytes===undefined?8*1024*1024:value.maxSnapshotBytes;
  if(!integer(maxRamBytes,1,65536)||!integer(maxSnapshotBytes,1024,16*1024*1024))fail('limits exceed hard caps');
  return {maxRamBytes,maxSnapshotBytes};
 }
 function mapperOf(core){
  const rom=core&&core.rom,mapper=rom&&rom.mapperType,submapper=rom&&rom.subMapper;
  return {id:integer(mapper,0,4095)?mapper:null,submapper:integer(submapper,0,255)?submapper:null};
 }
 function actionOf(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('missing executed action');
  const result={};for(const key of ['mask','humanMask','agentMask']){if(!integer(value[key],0,255)||(value[key]&48)===48||(value[key]&192)===192)fail('invalid action '+key);result[key]=value[key];}
  if(typeof value.manualOverride!=='boolean')fail('invalid manualOverride');result.manualOverride=value.manualOverride;
  if(value.interval!==undefined){
   const interval=value.interval;
   if(!interval||typeof interval!=='object'||!integer(interval.firstFrame,0,Number.MAX_SAFE_INTEGER)||!integer(interval.lastFrame,interval.firstFrame,Number.MAX_SAFE_INTEGER)||!integer(interval.frames,1,1000000)||interval.frames>interval.lastFrame-interval.firstFrame+1||!integer(interval.unionMask,0,255)||!integer(interval.changes,0,interval.frames)||typeof interval.manualOverrideSeen!=='boolean'||typeof interval.complete!=='boolean'||interval.coverage!=='executed-frames'||interval.complete&&interval.frames!==interval.lastFrame-interval.firstFrame+1)fail('invalid executed action interval');
   result.interval={firstFrame:interval.firstFrame,lastFrame:interval.lastFrame,frames:interval.frames,unionMask:interval.unionMask,changes:interval.changes,manualOverrideSeen:interval.manualOverrideSeen,complete:interval.complete,coverage:'executed-frames'};
  }
  return result;
 }
 function provenanceOf(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('missing provenance');
  const result={};for(const key of ['runId','originId','startId','trajectoryId'])result[key]=id(value[key],key,128);
  if(!['discovery','calibration','holdout'].includes(value.partition)||value.independence!=='unverified')fail('invalid provenance partition/independence');
  result.partition=value.partition;result.independence='unverified';return result;
 }
 function visualOf(core){
  const buffer=core&&core.ppu&&core.ppu.buffer;
  if(!buffer||buffer.length!==PIXELS)fail('missing bounded NES video buffer');
  // Four pixel probes in each of sixteen regions: fixed work, no frame copies.
  const bins16=[],quantized=[];
  for(let gy=0;gy<4;gy++)for(let gx=0;gx<4;gx++){
   let sum=0;for(const dy of [15,45])for(const dx of [16,48]){
    const pixel=buffer[(gy*60+dy)*256+gx*64+dx];
    if(!integer(pixel,0,0xffffffff))fail('invalid video pixel');
    sum+=(.2126*(pixel&255)+.7152*((pixel>>>8)&255)+.0722*((pixel>>>16)&255))/255;
   }
   const value=sum/4;bins16.push(value);quantized.push(Math.round(value*255));
  }
  return {bins16,hash:hashBytes(quantized)};
 }
 function create({platform,core,identity,limits}={}){
  const budget=limitsOf(limits),nes=platform==='nes',memory=nes&&core&&core.cpu&&core.cpu.mem;
  const supported=nes&&!!memory&&memory.length>=RAM_BYTES&&budget.maxRamBytes>=RAM_BYTES;
  const reason=!nes?'platform-not-supported':!memory||memory.length<RAM_BYTES?'core-ram-unavailable':budget.maxRamBytes<RAM_BYTES?'ram-budget-exceeded':null;
  let context=null,romData=null;
  if(supported){
   if(!identity||typeof identity.romHash!=='string'||!/^[a-f0-9]{64}$/.test(identity.romHash))fail('invalid ROM SHA256');
   const coreRevision=id(identity.coreRevision,'core revision'),mapper=mapperOf(core);
   context={platform:'nes',romHash:identity.romHash,coreRevision,mapper,schema:SCHEMA,detectorRevision:REVISION,ramLayout:{base:0,length:RAM_BYTES,canonical:true}};
   romData=core.romData;
  }
  const capabilities={supported,platform:typeof platform==='string'?platform:'unknown',ram:supported,canonicalRamBytes:supported?RAM_BYTES:0,visual:supported&&!!core.ppu&&core.ppu.buffer?.length===PIXELS,snapshot:supported&&typeof core.toJSON==='function',cpuWriteTrace:false,bankMapping:false,isolatedReplay:false,mapperKnown:supported&&context.mapper.id!==null,reason};
  let trace=null,traceIdleReason='idle';
  const traceNow=()=>typeof root.performance?.now==='function'?root.performance.now():Date.now();
  const helperOf=()=>{try{const helper=root.FlyNesWriteTrace;return supported&&helper&&typeof helper.attach==='function'&&typeof helper.supports==='function'&&helper.supports(core)?helper:null;}catch(_){return null;}};
  // No helper is installed, and no per-instruction work is requested, until beginWriteTrace.
  const finishTrace=(reason,{discard=false,overflow=false,duringFrame=false}={})=>{
   if(!trace)return;
   if(trace.active){trace.partialWindow=reason!=='frame-limit';trace.endedDuringFrame=duringFrame;}
   trace.active=false;trace.reason=reason;trace.overflow=trace.overflow||overflow;
   if(trace.timer!==null){try{root.clearTimeout(trace.timer);}catch(_){}trace.timer=null;}
   const handle=trace.handle;trace.handle=null;
   if(handle)try{handle.detach();}catch(_){trace.reason='helper-fault';}
   if(discard){trace.discardedEvents+=trace.queue.length;trace.queue.length=0;}
  };
  const checkCore=()=>{try{if(core.romData!==romData)fail('ROM changed; create a new probe');const mapper=mapperOf(core);if(mapper.id!==context.mapper.id||mapper.submapper!==context.mapper.submapper)fail('mapper context changed');if(!core.cpu?.mem||core.cpu.mem.length<RAM_BYTES)fail('RAM unavailable');}catch(error){if(trace?.active)finishTrace('context-change',{discard:true});throw error;}};
  const traceGuard=(duringFrame=false)=>{
   if(!trace?.active)return false;
   try{
    checkCore();
    if(core.cpu!==trace.cpu||core.cpu.mem!==trace.memory||core.rom!==trace.rom||core.mmap!==trace.mapper){finishTrace('context-change',{discard:true});return false;}
    if(traceNow()-trace.startedAt>=trace.maxWallMs){finishTrace('timeout',{duringFrame});return false;}
    return true;
   }catch(_){finishTrace('context-change',{discard:true});return false;}
  };
  const traceReport=()=>{
   traceGuard();
   if(!trace)return {version:1,active:false,reason:traceIdleReason,coverage:'canonical-ram-writes',redacted:true,eventCount:0,queuedEvents:0,droppedEvents:0,discardedEvents:0,overflow:false};
   return {version:1,active:trace.active,reason:trace.reason,context:clone(context),generation:trace.generation,startFrame:trace.startFrame,lastFrame:trace.lastFrame,frames:trace.lastFrame-trace.startFrame,partialWindow:trace.partialWindow,endedDuringFrame:trace.endedDuringFrame,maxEvents:trace.maxEvents,maxFrames:trace.maxFrames,maxWallMs:trace.maxWallMs,watchpointCount:trace.watchpoints?trace.watchpoints.size:0,watchpointMode:trace.watchpoints?'selected':'all-canonical-ram',eventCount:trace.eventCount,queuedEvents:trace.queue.length,droppedEvents:trace.droppedEvents,discardedEvents:trace.discardedEvents,overflow:trace.overflow,coverage:'canonical-ram-writes',redacted:true};
  };
  const onWrite=(value,window)=>{
   // A malformed helper event or observer failure must never escape into CPU execution.
   try{
    if(trace!==window||!traceGuard(true))return;
    if(!value||!integer(value.address,0,RAM_BYTES-1)||!integer(value.oldValue,0,255)||!integer(value.newValue,0,255))throw Error('invalid write');
    if(trace.watchpoints&&!trace.watchpoints.has(value.address))return;
    const logicalAddress=value.logicalAddress===undefined?value.address:value.logicalAddress;
    if(!integer(logicalAddress,0,0x1fff)||(logicalAddress&0x7ff)!==value.address)throw Error('invalid canonical write');
    const sourceBank=value.bank,writerPC=integer(value.writerPC,0,0xffff)?value.writerPC:null;
    const known=context.mapper.id===0&&core.rom.mapperType===0&&core.mmap?.constructor?.mapperName==='NROM'&&integer(core.rom.romCount,1,2)&&sourceBank?.status==='KNOWN'&&sourceBank.mapper===0&&sourceBank.bankSize===16384&&integer(sourceBank.physicalBank,0,1)&&integer(sourceBank.bankOffset,0,0x3fff)&&integer(sourceBank.prgOffset,0,0x7fff)&&integer(writerPC,0x8000,0xffff)&&sourceBank.bankOffset===(writerPC&0x3fff)&&sourceBank.physicalBank===(core.rom.romCount===1?0:(writerPC-0x8000)>>>14)&&sourceBank.prgOffset===sourceBank.physicalBank*16384+sourceBank.bankOffset;
    const bank={status:known?'KNOWN':'UNKNOWN',mapper:context.mapper.id,physicalBank:known?sourceBank.physicalBank:null,bankOffset:known?sourceBank.bankOffset:null,prgOffset:known?sourceBank.prgOffset:null,bankSize:known?16384:null,reason:known?null:'mapping-unavailable'};
    const cycleKnown=value.cycleStatus==='KNOWN'&&integer(value.cycle,0,Number.MAX_SAFE_INTEGER);
    trace.queue.push({version:1,generation:trace.generation,frame:trace.lastFrame+1,address:value.address,logicalAddress,oldValue:value.oldValue,newValue:value.newValue,writerPC,opcode:integer(value.opcode,0,255)?value.opcode:null,cycle:cycleKnown?value.cycle:null,cycleStatus:cycleKnown?'KNOWN':'UNKNOWN',origin:['cpu','dma'].includes(value.origin)?value.origin:'unknown',bank});
    trace.eventCount++;
    // Stop on the cap itself: no additional writer callback or unbounded ring overwrite.
    if(trace.eventCount>=trace.maxEvents)finishTrace('event-limit',{overflow:true,duringFrame:true});
   }catch(_){finishTrace('helper-fault',{duringFrame:true});}
  };
  return {
   capabilities:()=>{const result=clone(capabilities);result.cpuWriteTrace=!!helperOf();result.bankMapping=result.cpuWriteTrace&&context.mapper.id===0&&integer(core.rom.romCount,1,2)&&core.mmap?.constructor?.mapperName==='NROM';return result;},context:()=>context?clone(context):null,
   beginWriteTrace(options={}){
    if(trace)finishTrace('replaced',{discard:true});
    trace=null;traceIdleReason='idle';
    try{
     if(!options||typeof options!=='object'||Array.isArray(options))throw Error('invalid options');
     const {generation,frame}=options,maxEvents=options.maxEvents===undefined?128:options.maxEvents,maxFrames=options.maxFrames===undefined?8:options.maxFrames,maxWallMs=options.maxWallMs===undefined?1000:options.maxWallMs;
     if(!integer(generation,0,Number.MAX_SAFE_INTEGER)||!integer(frame,0,Number.MAX_SAFE_INTEGER-TRACE_CAPS.maxFrames)||!integer(maxEvents,1,TRACE_CAPS.maxEvents)||!integer(maxFrames,1,TRACE_CAPS.maxFrames)||!integer(maxWallMs,1,TRACE_CAPS.maxWallMs))throw Error('invalid options');
     let watchpoints=null;
     if(options.watchpoints!==undefined){
      if(!Array.isArray(options.watchpoints)||options.watchpoints.length<1||options.watchpoints.length>TRACE_CAPS.maxWatchpoints||options.watchpoints.some(address=>!integer(address,0,RAM_BYTES-1)))throw Error('invalid watchpoints');
      watchpoints=new Set(options.watchpoints);
     }
     trace={active:false,reason:null,generation,startFrame:frame,lastFrame:frame,partialWindow:false,endedDuringFrame:false,maxEvents,maxFrames,maxWallMs,watchpoints,eventCount:0,droppedEvents:0,discardedEvents:0,overflow:false,queue:[],handle:null,timer:null,startedAt:traceNow(),cpu:null,memory:null,rom:null,mapper:null};
     const helper=helperOf();
     if(!helper){trace.reason='unsupported';return traceReport();}
     checkCore();trace.cpu=core.cpu;trace.memory=core.cpu.mem;trace.rom=core.rom;trace.mapper=core.mmap;trace.active=true;
     const window=trace,handle=helper.attach(core,{onWrite:value=>onWrite(value,window),onFault:fault=>{if(trace===window)finishTrace(fault?.reason==='core_fault'?'core-fault':'helper-fault',{duringFrame:true,discard:true});}});
     if(!handle||typeof handle.detach!=='function')throw Error('invalid helper handle');
     if(!trace.active){try{handle.detach();}catch(_){}return traceReport();}
     trace.handle=handle;
     trace.timer=root.setTimeout(()=>{if(trace===window&&trace.active)finishTrace('timeout');},maxWallMs);
     // Node checkers should not be held open by an otherwise idle trace window.
     if(trace.timer&&typeof trace.timer.unref==='function')trace.timer.unref();
    }catch(_){
     if(trace)finishTrace('helper-fault');
     else traceIdleReason='invalid-options';
    }
    return traceReport();
   },
   advanceTrace(meta){
    if(traceGuard()){
     if(!meta||!integer(meta.generation,0,Number.MAX_SAFE_INTEGER)||!integer(meta.frame,0,Number.MAX_SAFE_INTEGER))finishTrace('invalid-context',{discard:true});
     else if(meta.generation!==trace.generation)finishTrace('generation-change',{discard:true});
     else if(meta.frame<trace.lastFrame)finishTrace('context-change',{discard:true});
     else{trace.lastFrame=meta.frame;if(meta.frame-trace.startFrame>=trace.maxFrames)finishTrace('frame-limit');}
    }
    return traceReport();
   },
   endWriteTrace(reason='manual',options){
    if(trace?.active)finishTrace(typeof reason==='string'&&reason.length>0&&reason.length<=80?reason:'manual',{discard:options?.discard===true});
    else if(trace&&options?.discard===true)finishTrace(trace.reason,{discard:true});
    return traceReport();
   },
   traceReport,
   drainWriteTrace(){
    traceGuard();if(!trace||!supported||!trace.cpu)return [];
    try{checkCore();if(core.cpu!==trace.cpu||core.cpu.mem!==trace.memory||core.rom!==trace.rom||core.mmap!==trace.mapper)finishTrace('context-change',{discard:true});}catch(_){finishTrace('context-change',{discard:true});}
    const events=trace.queue;trace.queue=[];return events;
   },
   observe(meta){
    if(!supported)return null;checkCore();
    if(!meta||!integer(meta.generation,0,Number.MAX_SAFE_INTEGER)||!integer(meta.frame,0,Number.MAX_SAFE_INTEGER)||typeof meta.atMs!=='number'||!Number.isFinite(meta.atMs)||meta.atMs<0)fail('invalid observation timing');
    if(traceGuard()&&meta.generation!==trace.generation)finishTrace('generation-change',{discard:true});
    const action=actionOf(meta.action),provenance=provenanceOf(meta.provenance),ram=new Uint8Array(RAM_BYTES);if(action.interval&&action.interval.lastFrame>meta.frame)fail('action interval exceeds observation frame');
    for(let address=0;address<RAM_BYTES;address++){const value=core.cpu.mem[address];if(!integer(value,0,255))fail('invalid RAM byte');ram[address]=value;}
    const visual=visualOf(core),partial=new Uint8Array(RAM_BYTES+16);partial.set(ram);partial.set(visual.bins16.map(value=>Math.round(value*255)),RAM_BYTES);
    return {version:SCHEMA,context:clone(context),generation:meta.generation,frame:meta.frame,atMs:meta.atMs,ram,action,visual,provenance,fingerprint:{hash:hashBytes(partial),scope:'ram-visual-partial'}};
   },
   snapshot(){
    if(!supported||!capabilities.snapshot)return null;checkCore();
    if(trace?.active)finishTrace('save-state',{discard:true});
    const encoded=JSON.stringify(core.toJSON()),bytes=typeof encoded==='string'?new TextEncoder().encode(encoded).length:Infinity;if(bytes>budget.maxSnapshotBytes)fail('snapshot budget exceeded');
    return {version:SCHEMA,context:clone(context),state:JSON.parse(encoded),bytes,scope:'emulator-save-state'};
   }
  };
 }
 const api={create,schema:SCHEMA,detectorRevision:REVISION,traceLimits:TRACE_CAPS};root.FlyCoreProbe=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
