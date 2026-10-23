/* Platform probes expose observations, never controls or neural policy inputs. */
(function(root){'use strict';
 const SCHEMA=1,REVISION='agod-foundation-1',RAM_BYTES=2048,PIXELS=256*240;
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
  const checkCore=()=>{if(core.romData!==romData)fail('ROM changed; create a new probe');const mapper=mapperOf(core);if(mapper.id!==context.mapper.id||mapper.submapper!==context.mapper.submapper)fail('mapper context changed');if(!core.cpu?.mem||core.cpu.mem.length<RAM_BYTES)fail('RAM unavailable');};
  return {
   capabilities:()=>clone(capabilities),context:()=>context?clone(context):null,
   observe(meta){
    if(!supported)return null;checkCore();
    if(!meta||!integer(meta.generation,0,Number.MAX_SAFE_INTEGER)||!integer(meta.frame,0,Number.MAX_SAFE_INTEGER)||typeof meta.atMs!=='number'||!Number.isFinite(meta.atMs)||meta.atMs<0)fail('invalid observation timing');
    const action=actionOf(meta.action),provenance=provenanceOf(meta.provenance),ram=new Uint8Array(RAM_BYTES);if(action.interval&&action.interval.lastFrame>meta.frame)fail('action interval exceeds observation frame');
    for(let address=0;address<RAM_BYTES;address++){const value=core.cpu.mem[address];if(!integer(value,0,255))fail('invalid RAM byte');ram[address]=value;}
    const visual=visualOf(core),partial=new Uint8Array(RAM_BYTES+16);partial.set(ram);partial.set(visual.bins16.map(value=>Math.round(value*255)),RAM_BYTES);
    return {version:SCHEMA,context:clone(context),generation:meta.generation,frame:meta.frame,atMs:meta.atMs,ram,action,visual,provenance,fingerprint:{hash:hashBytes(partial),scope:'ram-visual-partial'}};
   },
   snapshot(){
    if(!supported||!capabilities.snapshot)return null;checkCore();
    const encoded=JSON.stringify(core.toJSON()),bytes=typeof encoded==='string'?new TextEncoder().encode(encoded).length:Infinity;if(bytes>budget.maxSnapshotBytes)fail('snapshot budget exceeded');
    return {version:SCHEMA,context:clone(context),state:JSON.parse(encoded),bytes,scope:'emulator-save-state'};
   }
  };
 }
 const api={create,schema:SCHEMA,detectorRevision:REVISION};root.FlyCoreProbe=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
