/* Bounded, read-only RAM hypotheses. Ranking is not game meaning or reward. */
(function(root){'use strict';
const SCHEMA_VERSION=1,DETECTOR_REVISION='agod-foundation-1';
const DEFAULT_LIMITS=Object.freeze({maxRamBytes:2048,maxObservationHz:5,minFrameGap:6,maxCandidates:256,maxRejectedCandidates:32,maxSeedAddresses:16,maxDecodePerObservation:2048,maxTransitions:64,maxOrigins:32,maxObservations:600,maxElapsedMs:120000,maxWorkMsPerObservation:4,maxTotalWorkMs:500,maxReportedCandidates:64});
const CAPS={maxRamBytes:65536,maxObservationHz:20,minFrameGap:600,maxCandidates:512,maxRejectedCandidates:128,maxSeedAddresses:64,maxDecodePerObservation:8192,maxTransitions:128,maxOrigins:64,maxObservations:10000,maxElapsedMs:3600000,maxWorkMsPerObservation:50,maxTotalWorkMs:30000,maxReportedCandidates:256};
const numeric=root.FlyGameTools||(typeof module!=='undefined'&&typeof require==='function'?require('./game-tools.js'):null);
const clone=value=>JSON.parse(JSON.stringify(value)),integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max,finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
function validateContext(value){
 if(!value||typeof value!=='object'||!['nes','sega','gb','snes'].includes(value.platform)||!/^([a-f0-9]{64})$/.test(value.romHash)||!text(value.coreRevision,160)||value.schema!==SCHEMA_VERSION||value.detectorRevision!==DETECTOR_REVISION||!value.mapper||!(value.mapper.id===null||integer(value.mapper.id,0,4095))||!(value.mapper.submapper===null||integer(value.mapper.submapper,0,255))||!value.ramLayout||!integer(value.ramLayout.base,0,0x7fffffff)||!integer(value.ramLayout.length,1,CAPS.maxRamBytes)||value.ramLayout.base+value.ramLayout.length>0x80000000||value.ramLayout.canonical!==true)throw Error('Invalid goal discovery context');
 return {platform:value.platform,romHash:value.romHash,coreRevision:value.coreRevision,mapper:{id:value.mapper.id,submapper:value.mapper.submapper},schema:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,ramLayout:{base:value.ramLayout.base,length:value.ramLayout.length,canonical:true}};
}
function contextKey(context){return JSON.stringify(validateContext(context));}
function limitsOf(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid goal discovery limits');
 const result={...DEFAULT_LIMITS};for(const key of Object.keys(input)){
  if(!(key in DEFAULT_LIMITS)||!finite(input[key],key==='minFrameGap'?0:1,CAPS[key])||!['maxObservationHz','maxWorkMsPerObservation','maxTotalWorkMs'].includes(key)&&!Number.isInteger(input[key]))throw Error('Invalid goal discovery limit '+key);
  result[key]=input[key];
 }
 result.maxReportedCandidates=Math.min(result.maxReportedCandidates,result.maxCandidates);return Object.freeze(result);
}
function read(memory,spec){
 // Reuse the existing platform-neutral integer contract. Invalid BCD is an
 // expected competing interpretation, so reject it before the throwing reader.
 if(numeric&&typeof numeric.readRam==='function'){
  if(spec.format==='bcd')for(let k=0;k<spec.width;k++){const b=memory[spec.address+k];if((b&15)>9||(b>>>4)>9)return null;}
  return numeric.readRam(memory,spec,memory.length);
 }
 let value=0;for(let k=0;k<spec.width;k++){
  const b=memory[spec.address+(spec.endian==='big'?k:spec.width-1-k)];
  if(spec.format==='bcd'){if((b&15)>9||(b>>>4)>9)return null;value=value*100+(b>>>4)*10+(b&15);}else value=value*256+b;
 }
 if(spec.format==='signed'&&value>=2**(spec.width*8-1))value-=2**(spec.width*8);return value;
}
function validatedObservation(value,context,length){
 if(!value||value.version!==SCHEMA_VERSION||contextKey(value.context)!==context||!integer(value.generation,0,Number.MAX_SAFE_INTEGER)||!integer(value.frame,0,Number.MAX_SAFE_INTEGER)||!finite(value.atMs,0,Number.MAX_SAFE_INTEGER)||!(value.ram instanceof Uint8Array)||value.ram.length!==length)throw Error('Invalid goal discovery observation');
 const a=value.action,v=value.visual,p=value.provenance,f=value.fingerprint,bins=v&&(v.bins16||v.bins);
 if(!a||!['mask','humanMask','agentMask'].every(k=>integer(a[k],0,4095))||typeof a.manualOverride!=='boolean'||(a.mask&48)===48||(a.mask&192)===192||!v||!(Array.isArray(bins)||ArrayBuffer.isView(bins))||bins.length!==16||!Array.from(bins).every(n=>finite(n,0,1))||!text(v.hash,128)||!p||!['runId','trajectoryId'].every(k=>text(p[k],128))||!['originId','startId'].every(k=>p[k]===null||text(p[k],128))||p.partition!=='discovery'||p.independence!=='unverified'||!f||f.scope!=='ram-visual-partial'||!text(f.hash,128))throw Error('Invalid or non-discovery provenance');
 const interval=a.interval;
 if(interval&&(!integer(interval.firstFrame,0,value.frame)||!integer(interval.lastFrame,interval.firstFrame,value.frame)||!integer(interval.frames,1,1000000)||interval.frames>interval.lastFrame-interval.firstFrame+1||!integer(interval.unionMask,0,4095)||!integer(interval.changes,0,interval.frames)||typeof interval.manualOverrideSeen!=='boolean'||typeof interval.complete!=='boolean'||interval.coverage!=='executed-frames'))throw Error('Invalid executed-action interval');
 return value;
}
function provenanceKey(p){return JSON.stringify([p.runId,p.originId,p.startId,p.trajectoryId]);}
const clock=()=>typeof performance!=='undefined'&&performance.now?performance.now():Date.now();
class CandidateMiner{
 constructor({context,limits={}}={}){
  this.context=validateContext(context);this.key=contextKey(this.context);this.limits=limitsOf(limits);
  const n=this.context.ramLayout.length;if(n>this.limits.maxRamBytes)throw Error('RAM layout exceeds discovery budget');
  this.previous=null;this.lastAt=null;this.lastFrame=null;this.generation=null;this.startedAt=null;this.stopped=false;
  this.candidates=new Map();this.rejections=new Map();this.groups=new Map();this.history=[];this.boundaries=[];this.serial=0;
  this.byteChanges=new Uint32Array(n);this.byteObservations=new Uint32Array(n);
  this.stats={accepted:0,skipped:0,rejected:0,decodeEvaluations:0,droppedCandidates:0,evictedCandidates:0,seedAddressesOmitted:0,budgetExceeded:0,analysisMs:0,maxAnalysisMs:0,segments:1,boundaries:0,ramChanges:0,provenanceGroups:0,independentConfirmations:0,coverageComplete:true,stoppedReason:null};
 }
 boundary(reason='boundary'){
  if(!text(reason,120))throw Error('Invalid discovery boundary');
  this.previous=null;this.lastFrame=null;this.history=[];this.stats.boundaries++;this.stats.segments++;this.stats.coverageComplete=false;
  this.boundaries.push({reason,observation:this.stats.accepted});if(this.boundaries.length>16)this.boundaries.shift();
  return {status:'UNKNOWN',reason};
 }
 _stop(reason){this.stopped=true;this.stats.stoppedReason=reason;this.stats.budgetExceeded++;this.stats.coverageComplete=false;return {accepted:false,reason,status:'UNKNOWN'};}
 observe(input){
  const began=clock();let observation;
  try{observation=validatedObservation(input,this.key,this.context.ramLayout.length);}catch(error){this.stats.rejected++;this.boundary('invalid-observation');return {accepted:false,reason:error.message,status:'UNKNOWN'};}
  if(this.stopped){this.stats.skipped++;return {accepted:false,reason:this.stats.stoppedReason,status:'UNKNOWN'};}
  if(this.lastAt!==null&&observation.atMs<this.lastAt||this.generation!==null&&observation.generation<this.generation){this.stats.rejected++;this.stats.coverageComplete=false;return {accepted:false,reason:'stale-observation',status:'UNKNOWN'};}
  if(this.startedAt===null)this.startedAt=observation.atMs;
  if(this.stats.accepted>=this.limits.maxObservations||observation.atMs-this.startedAt>this.limits.maxElapsedMs||this.stats.analysisMs>=this.limits.maxTotalWorkMs)return this._stop('discovery-budget-exhausted');
  if(this.generation!==null&&observation.generation>this.generation)this.boundary('generation-change');
  const group=provenanceKey(observation.provenance);
  if(this.previous&&this.previous.group!==group)this.boundary('provenance-change');
  if(this.lastFrame!==null&&observation.frame<=this.lastFrame){this.stats.rejected++;this.stats.coverageComplete=false;return {accepted:false,reason:'non-increasing-frame',status:'UNKNOWN'};}
  if(this.previous&&(observation.atMs-this.previous.atMs<1000/this.limits.maxObservationHz||observation.frame-this.previous.frame<this.limits.minFrameGap)){this.stats.skipped++;return {accepted:false,reason:'sample-rate-limit',status:this._status()};}
  if(!this.groups.has(group)){
   if(this.groups.size>=this.limits.maxOrigins)return this._stop('provenance-budget-exhausted');
   const p=observation.provenance;
   this.groups.set(group,{runId:p.runId,originId:p.originId,startId:p.startId,trajectoryId:p.trajectoryId,partition:'discovery',independence:'unverified'});this.stats.provenanceGroups=this.groups.size;
  }
  this.generation=observation.generation;this.lastAt=observation.atMs;this.lastFrame=observation.frame;this.stats.accepted++;
  if(!this.previous){this._remember(observation,group);this._timing(began);return {accepted:true,reason:'baseline',status:this._status()};}
  const prior=this.previous,changed=[];let visualDifference=0;
  const bins=observation.visual.bins16||observation.visual.bins;
  for(let i=0;i<16;i++)visualDifference+=Math.abs(bins[i]-prior.visual[i]);visualDifference/=16;
  for(let i=0;i<observation.ram.length;i++){
   this.byteObservations[i]++;if(observation.ram[i]!==prior.ram[i]){this.byteChanges[i]++;changed.push(i);}
  }
  this.stats.ramChanges+=changed.length;
  const interval=observation.action.interval,summary={frame:observation.frame,atMs:observation.atMs,mask:interval?interval.unionMask:observation.action.mask,manualOverride:interval?interval.manualOverrideSeen:observation.action.manualOverride,visualDifference,changedBytes:changed.length};
  this.history.push(summary);if(this.history.length>this.limits.maxTransitions)this.history.shift();
  let evaluations=0,truncated=false;
  const permitted=()=>{
   if(evaluations>=this.limits.maxDecodePerObservation)return false;
   if(evaluations%32===0&&clock()-began>this.limits.maxWorkMsPerObservation)return false;
   return true;
  };
  const visited=new Set();
  for(const candidate of this.candidates.values()){
   if(!permitted()){truncated=true;break;}evaluations++;visited.add(candidate.id);this._update(candidate,prior,observation,visualDifference,group);
  }
  const interesting=address=>{
   const count=this.byteChanges[address],density=count/Math.max(1,this.byteObservations[address]);return Math.min(count,4)+8*(1-density)+2;
  };
  changed.sort((a,b)=>interesting(b)-interesting(a)||a-b);
  const seeds=changed.slice(0,this.limits.maxSeedAddresses),proposals=new Set();
  if(changed.length>seeds.length){this.stats.seedAddressesOmitted+=changed.length-seeds.length;this.stats.coverageComplete=false;}
  outer:for(const seed of seeds)for(let width=1;width<=4;width++)for(let offset=0;offset<width;offset++){
   const address=seed-offset;if(address<0||address+width>observation.ram.length)continue;
   for(const format of ['unsigned','signed','bcd'])for(const endian of width===1?['little']:['little','big']){
    const spec={address,width,format,endian},id=this._id(spec);if(visited.has(id)||proposals.has(id))continue;proposals.add(id);
    if(!permitted()){truncated=true;break outer;}evaluations++;
    if(this.candidates.has(id))continue;
    const before=read(prior.ram,spec),after=read(observation.ram,spec);if(before===null||after===null||before===after)continue;
    const candidate=this._new(spec,group);this._update(candidate,prior,observation,visualDifference,group);
    if(this.candidates.size>=this.limits.maxCandidates){
     // A cloud of wide/format aliases must not erase the fact that a rare byte
     // changed. Unsigned byte anchors preserve address coverage, not semantics:
     // signedness, larger widths and polarity remain separate hypotheses.
     const anchor=row=>row.spec.width===1&&row.spec.format==='unsigned'&&!row.confounds.length;let lowest=null;
     for(const row of this.candidates.values())if(!anchor(row)&&(!lowest||row.rank<lowest.rank))lowest=row;
     if(!lowest&&anchor(candidate))for(const row of this.candidates.values())if(!lowest||row.rank<lowest.rank)lowest=row;
     if(!lowest||!anchor(candidate)&&candidate.rank<=lowest.rank){this.stats.droppedCandidates++;this.stats.coverageComplete=false;continue;}
     this.candidates.delete(lowest.id);this.stats.evictedCandidates++;this.stats.coverageComplete=false;
    }
    this.candidates.set(id,candidate);
   }
  }
  this.stats.decodeEvaluations+=evaluations;
  if(truncated){this.stats.budgetExceeded++;this.stats.coverageComplete=false;}
  this._remember(observation,group);this._timing(began);
  if(this.stats.analysisMs>=this.limits.maxTotalWorkMs){this.stopped=true;this.stats.stoppedReason='analysis-time-budget-exhausted';this.stats.coverageComplete=false;}
  return {accepted:true,reason:truncated?'observation-budget-truncated':'observed',status:this._status()};
 }
 _id(s){return 'counter:'+s.address+':'+s.width+':'+s.format+':'+s.endian;}
 _new(spec,group){return {id:this._id(spec),spec,observations:0,changes:0,increases:0,decreases:0,wraps:0,resets:0,invalidBcd:0,frameFits:0,neutralChanges:0,activeChanges:0,visualChanges:0,actionLagChanges:0,echoHits:0,echoChecks:0,echoMasks:new Set(),reversals:0,lastSign:0,largeJumps:0,regularIntervals:0,lastChangeFrame:null,lastGap:null,recentValues:[],groups:new Set([group]),rank:0,confounds:[],aliasGroup:'',endpointOnlyIntervals:0,mixedActionIntervals:0,completeActionIntervals:0};}
 _update(c,prior,observation,visualDifference,group){
  const before=read(prior.ram,c.spec),after=read(observation.ram,c.spec),interval=observation.action.interval;c.observations++;c.groups.add(group);
  const complete=Boolean(interval&&interval.complete&&interval.firstFrame===prior.frame+1&&interval.lastFrame===observation.frame&&interval.frames===observation.frame-prior.frame);
  if(complete)c.completeActionIntervals++;else c.endpointOnlyIntervals++;
  if(interval&&interval.changes)c.mixedActionIntervals++;
  if(before===null||after===null){c.invalidBcd++;this._rank(c);return;}
  c.aliasGroup=this._alias(c.spec,prior.ram,observation.ram);
  if(complete&&!interval.changes&&observation.action.mask&&!interval.manualOverrideSeen){c.echoChecks++;if(after===observation.action.mask)c.echoHits++;if(c.echoMasks.size<4)c.echoMasks.add(observation.action.mask);}
  const delta=after-before;if(!delta){this._rank(c);return;}
  c.changes++;delta>0?c.increases++:c.decreases++;
  const base=(c.spec.format==='bcd'?100:256)**c.spec.width,frameDelta=observation.frame-prior.frame;
  if(complete&&(delta===frameDelta||delta===-frameDelta)&&!interval.manualOverrideSeen)c.frameFits++;
  if(Math.abs(delta)>base/2&&Math.abs(delta)<base){c.wraps++;}
  if(after===0&&before!==0&&Math.abs(delta)!==1)c.resets++;
  const sign=Math.sign(delta);if(c.lastSign&&c.lastSign!==sign)c.reversals++;c.lastSign=sign;
  if(Math.abs(delta)>Math.max(16,base*.05))c.largeJumps++;
  const inputMask=interval?interval.unionMask:observation.action.mask;
  if(complete&&!inputMask&&!interval.manualOverrideSeen)c.neutralChanges++;else if(complete&&inputMask&&!interval.manualOverrideSeen)c.activeChanges++;
  if(visualDifference>.04)c.visualChanges++;
  if(inputMask||this.history.slice(-4).some(row=>row.mask))c.actionLagChanges++;
  if(c.lastChangeFrame!==null){const gap=observation.frame-c.lastChangeFrame;if(c.lastGap!==null&&Math.abs(gap-c.lastGap)<=1)c.regularIntervals++;c.lastGap=gap;}c.lastChangeFrame=observation.frame;
  c.recentValues.push(after);if(c.recentValues.length>8)c.recentValues.shift();this._rank(c);
 }
 _alias(spec,a,b){
  let address=spec.address,width=spec.width;
  while(width>1){const edge=spec.endian==='little'?address+width-1:address;
   if(a[edge]!==0||b[edge]!==0)break;
   if(spec.format==='signed'){const next=spec.endian==='little'?edge-1:edge+1;if((a[next]&128)||(b[next]&128))break;}
   if(spec.endian==='big')address++;width--;
  }
  return 'span:'+address+':'+width+':'+(width===1?'byte':spec.endian);
 }
 _rank(c){
  const density=c.changes/Math.max(1,c.observations),confounds=[];
  if(c.invalidBcd)confounds.push('invalid-bcd-observed');
  if(c.changes>=8&&c.neutralChanges>=3&&c.activeChanges>=3&&c.frameFits/c.changes>.9)confounds.push('frame-linear-counter');
  if(c.changes>=8&&c.neutralChanges>=4&&c.activeChanges>=2&&c.regularIntervals/Math.max(1,c.changes-2)>.85)confounds.push('periodic-neutral-counter');
  if(c.echoChecks>=8&&c.echoMasks.size>=2&&c.echoHits/c.echoChecks>.9)confounds.push('applied-mask-echo');
  if(c.observations>=16&&density>.8&&new Set(c.recentValues).size>=7&&c.reversals/Math.max(1,c.changes-1)>.3)confounds.push('high-churn-variable');
  c.confounds=confounds;
  c.rank=Math.max(0,Math.min(c.changes,12)+8*(1-density)+Math.min(c.visualChanges,4)+Math.min(c.actionLagChanges,4)-confounds.length*32-(c.spec.width-1)*.1);
  if(confounds.length){
   const key=(c.aliasGroup||c.id)+'|'+confounds.join('|'),existing=this.rejections.get(key);
   if(!existing||c.spec.width<existing.spec.width||c.spec.width===existing.spec.width&&c.spec.format==='unsigned'){
    this.rejections.delete(key);this.rejections.set(key,{...c,spec:{...c.spec},groups:new Set(c.groups),confounds:confounds.slice(),recentValues:[],echoMasks:new Set()});
    if(this.rejections.size>this.limits.maxRejectedCandidates){
     const priority=row=>(5-row.spec.width)*100+(row.confounds.some(reason=>reason!=='invalid-bcd-observed')?40:0)+Math.min(row.observations,50);
     let worst=null;for(const entry of this.rejections)if(!worst||priority(entry[1])<priority(worst[1]))worst=entry;
     this.rejections.delete(worst[0]);
    }
   }
  }
 }
 _remember(o,group){this.previous={ram:new Uint8Array(o.ram),frame:o.frame,atMs:o.atMs,mask:o.action.mask,visual:Array.from(o.visual.bins16||o.visual.bins),group};}
 _timing(started){const elapsed=Math.max(0,clock()-started);this.stats.analysisMs+=elapsed;this.stats.maxAnalysisMs=Math.max(this.stats.maxAnalysisMs,elapsed);}
 _status(){return this.stopped?'UNKNOWN':[...this.candidates.values()].some(c=>!c.confounds.length)?'CANDIDATES':'DISCOVERING';}
 report(){
  const project=c=>({
   id:c.id,spec:{...c.spec,address:c.spec.address+this.context.ramLayout.base},status:c.confounds.length?'REJECTED':'CANDIDATE',role:'unknown',polarity:'unknown',confidence:null,rank:c.rank,aliasGroup:c.aliasGroup,confounds:c.confounds.slice(),
   statistics:Object.fromEntries(['observations','changes','increases','decreases','wraps','resets','invalidBcd','frameFits','neutralChanges','activeChanges','visualChanges','actionLagChanges','echoHits','echoChecks','reversals','largeJumps','regularIntervals','endpointOnlyIntervals','mixedActionIntervals','completeActionIntervals'].map(key=>[key,c[key]])),
   coverage:{complete:this.stats.coverageComplete&&c.endpointOnlyIntervals===0,segments:this.stats.segments,actionCoverage:c.endpointOnlyIntervals?'endpoint-only-or-incomplete':'executed-frames',mixedActions:c.mixedActionIntervals>0,causality:'unverified',meaning:'sampled observations only; writes between samples can be missed'},
   provenance:{groups:[...c.groups].map(key=>clone(this.groups.get(key))).filter(Boolean),independence:'unverified'},alternatives:['score','lives','level','timer','input-echo','noise','unknown']
  });
  const ranked=[...this.candidates.values()].sort((a,b)=>b.rank-a.rank||a.id.localeCompare(b.id)),anchors=ranked.filter(c=>c.spec.width===1&&c.spec.format==='unsigned'&&!c.confounds.length).slice(0,Math.ceil(this.limits.maxReportedCandidates/2)),selected=new Map(anchors.map(c=>[c.id,c]));
  for(const row of ranked){if(selected.size>=this.limits.maxReportedCandidates)break;selected.set(row.id,row);}
  const candidates=[...selected.values()].map(project),rejections=[...this.rejections.values()].sort((a,b)=>a.spec.width-b.spec.width||a.id.localeCompare(b.id)).map(project);
  return {type:'gu-goal-discovery-report',version:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,context:clone(this.context),status:this._status(),rewardStatus:'UNKNOWN',phase:{value:'unknown',confidence:null,evidence:[]},candidates,rejections,stats:{...this.stats,retainedCandidates:this.candidates.size,reportedCandidates:candidates.length,retainedRejections:rejections.length,retainedTransitions:this.history.length,typedBufferBytes:this.byteChanges.byteLength+this.byteObservations.byteLength+(this.previous?this.previous.ram.byteLength:0)},boundaries:clone(this.boundaries),limits:{...this.limits},limitations:['Candidate ranking is not calibrated confidence or goal semantics.','Provenance groups are not independent confirmations.','Observation fingerprints do not prove complete emulator-state identity.','No reward, terminal result, neural action or FDB mutation is generated.']};
 }
}
const api={SCHEMA_VERSION,DETECTOR_REVISION,DEFAULT_LIMITS,CandidateMiner,validateContext,contextKey};root.FlyGoalDiscovery=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
