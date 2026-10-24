/* Experimental goal discovery. Bounded diagnostics never write controls or learned state. */
'use strict';
(()=>{
 const node=document.createElement('p');node.id='gameObjectiveStatus';node.className='note';node.setAttribute('role','status');$('trainingStatus').after(node);
 const preference='gu-agod-experimental-v1';let saved=false;try{saved=localStorage.getItem(preference)==='true';}catch(_){}
 const runId=crypto.randomUUID();let enabled=typeof window.GU_AGOD_ENABLED==='boolean'?window.GU_AGOD_ENABLED:saved,active=null,serial=0,store=null,lastState='UNKNOWN',reason='disabled';
 const clock=()=>performance.now(),trajectory=()=>crypto.randomUUID();
 // A single pilot window per explicit engine/context session. Count the whole
 // instrumented core frame conservatively; this is separate from miner work.
 const traceLimits=Object.freeze({maxFrames:16,maxEvents:128,maxWallMs:1000,maxWatchpoints:4,maxInstallMs:20,maxFrameWorkMs:50,maxTotalWorkMs:250});
 const log=(name,data={},level='info')=>{try{window.guLogger?.event?.(name,data,level);}catch(_){}};
 const option=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.id='experimentalGoalDiscovery';toggle.checked=enabled;option.append(toggle,document.createTextNode(' Автоанализ NES (эксперимент, без награды)'));$('trainingResearch').append(option);toggle.onchange=()=>setEnabled(toggle.checked);
 const same=s=>active===s&&s.core===nes&&s.hash===romHash&&s.revision===window.labCoreIdentity;
 function traceSummary(s){
  const summary=s?.traceSummary||{active:false,reason:enabled?'not-started':'disabled'};
  return {...summary,pilotAttempted:Boolean(s?.traceAttempted),installMs:s?.traceInstallMs||0,workMs:s?.traceWorkMs||0,workScope:'adapter calls and complete instrumented core frames',limits:{...traceLimits},rewardStatus:'UNKNOWN'};
 }
 function retainTrace(s,value){
  if(!value||typeof value!=='object')return;
  // Raw writes, values and writer sites never reach reports, cache or logger.
  const keys=['supported','active','reason','frames','maxFrames','maxEvents','eventCount','queuedEvents','overflow','droppedEvents','discardedEvents','watchpointCount','partialWindow','endedDuringFrame','coverage','redacted'];
  s.traceSummary=Object.fromEntries(keys.filter(key=>typeof value[key]==='boolean'||typeof value[key]==='number'||typeof value[key]==='string'||value[key]===null).map(key=>[key,value[key]]));
 }
 function stopTrace(s,value){
  if(!s?.adapter||!s.traceAttempted||s.traceLogged&&!s.traceSummary?.active)return;
  const began=clock();
  try{retainTrace(s,s.adapter.endWriteTrace?.(value,{discard:true}));}
  catch(_){retainTrace(s,{active:false,reason:'trace-error'});}
  finally{
   s.traceWorkMs=(s.traceWorkMs||0)+Math.max(0,clock()-began);
   if(s.traceSummary&&!s.traceSummary.active&&!s.traceLogged){
    s.traceLogged=true;
    log('goal.trace-window',{reason:s.traceSummary.reason||'stopped',frames:s.traceSummary.frames||0,eventCount:s.traceSummary.eventCount||0,droppedEvents:s.traceSummary.droppedEvents||0,overflow:Boolean(s.traceSummary.overflow),installMs:Number.isFinite(s.traceInstallMs)?Math.max(0,s.traceInstallMs):0,workMs:Number.isFinite(s.traceWorkMs)?Math.max(0,s.traceWorkMs):0,costScope:'adapter calls and complete instrumented core frames'});
   }
  }
 }
 function excluded(){
  const startId=window.labStartStateId,assignment=window.curriculumSessions?.assignment?.();
  if(startId!=null&&startId!=='rom-boot')return 'unclassified-restored-start';
  return document.hidden||$('freeze').checked||benchmark||$('learnMode').value==='eval'||window.autonomousEpisodes?.active?.()||assignment&&assignment.role!=='discovery'&&assignment.role!=='train'||window.dualAgents?.active?.()||gmodeMode!=='off'?'evaluation-or-context':null;
 }
 function beforeFrame(meta){
  const s=active;if(!s?.traceSummary?.active)return;
  try{
   const why=!enabled||!loaded||romLoading||!same(s)?'context-change':s.stopped?'observer-stopped':excluded()||meta?.action?.manualOverride&&'manual-override';
   if(why||!meta||meta.generation!==s.traceGeneration||meta.frame!==s.traceLastFrame+1)stopTrace(s,why||'generation-or-frame-boundary');
  }catch(_){stopTrace(s,'trace-error');}
 }
 function advanceTrace(s,meta){
  if(!s.traceSummary?.active)return;
  const began=clock(),coreMs=Number.isFinite(meta.elapsedMs)&&meta.elapsedMs>=0?meta.elapsedMs:0;let failed=false;
  s.traceWorkMs+=coreMs;
  try{retainTrace(s,s.adapter.advanceTrace({generation:meta.generation,frame:meta.frame}));s.traceLastFrame=meta.frame;}
  catch(_){failed=true;}
  s.traceWorkMs+=Math.max(0,clock()-began);
  if(failed)stopTrace(s,'trace-error');else if(!s.traceSummary?.active)stopTrace(s,s.traceSummary?.reason||'trace-stopped');
  if(coreMs>traceLimits.maxFrameWorkMs||s.traceWorkMs>traceLimits.maxTotalWorkMs)stopTrace(s,'trace-work-budget');
 }
 function beginTrace(s,meta){
  if(s.traceAttempted||meta.action.manualOverride||!s.adapter.capabilities().cpuWriteTrace)return;
  const began=clock(),watchpoints=[];
  for(const row of s.miner.report().candidates){
   if(row.status!=='CANDIDATE')continue;
   for(let offset=0;offset<row.spec.width&&watchpoints.length<traceLimits.maxWatchpoints;offset++){
    const address=row.spec.address-s.context.ramLayout.base+offset;if(!watchpoints.includes(address))watchpoints.push(address);
   }
   if(watchpoints.length>=traceLimits.maxWatchpoints)break;
  }
  if(!watchpoints.length){s.traceWorkMs+=Math.max(0,clock()-began);if(s.traceWorkMs>traceLimits.maxTotalWorkMs){s.traceAttempted=true;retainTrace(s,{active:false,reason:'trace-work-budget'});}return;}
  s.traceAttempted=true;s.traceGeneration=meta.generation;s.traceLastFrame=meta.frame;
  let failed=false;
  try{retainTrace(s,s.adapter.beginWriteTrace({generation:meta.generation,frame:meta.frame,watchpoints,maxFrames:traceLimits.maxFrames,maxEvents:traceLimits.maxEvents,maxWallMs:traceLimits.maxWallMs}));}
  catch(_){failed=true;}
  s.traceInstallMs=Math.max(0,clock()-began);s.traceWorkMs+=s.traceInstallMs;
  if(failed)stopTrace(s,'trace-error');else if(!s.traceSummary?.active)stopTrace(s,s.traceSummary?.reason||'trace-stopped');
  if(s.traceInstallMs>traceLimits.maxInstallMs||s.traceWorkMs>traceLimits.maxTotalWorkMs)stopTrace(s,'trace-install-budget');
 }
 function status(){
  const running=Boolean(enabled&&active&&!active.stopped&&!active.inhibited&&playing&&!romLoading&&!document.hidden),state=!enabled||active?.inhibited?'UNKNOWN':lastState;
  return {version:1,source:'auto-discovery',enabled,state,running,rewardStatus:'UNKNOWN',reason:!enabled?'disabled':active?.inhibited?active.inhibitedReason:reason,cache:active?.cacheStatus||'not-loaded',observations:active?.observations||0,text:!enabled?'Цель не подтверждена.':state==='UNSUPPORTED'?'Автоматический поиск цели для этой системы пока недоступен.':running?'Поиск игровых событий. Цель не подтверждена.':'Цель не подтверждена. Анализ приостановлен.'};
 }
 function render(){node.textContent=status().text;}
 function fail(s,error,kind='observer-error'){
  stopTrace(s,kind);if(!same(s))return;try{s.miner?.boundary(kind);}catch(_){}
  s.stopped=true;lastState='UNKNOWN';reason=kind;render();
  log('goal.discovery-stopped',{reason:kind,message:String(error?.message||error||kind),observations:s.observations,computeMs:s.computeMs},kind==='resource-budget'?'warn':'error');
 }
 function report(){
  try{if(active?.traceAttempted){retainTrace(active,active.adapter.traceReport?.());if(!active.traceSummary?.active)stopTrace(active,active.traceSummary?.reason||'trace-stopped');}return {...(active?.miner?.report()||{version:1,context:null,candidates:[],phase:{value:'unknown'}}),runtime:status(),rewardStatus:'UNKNOWN',observerComputeMs:active?.computeMs||0,capabilities:active?.adapter?.capabilities?.()||null,trace:traceSummary(active)};}
  catch(error){if(active)fail(active,error);return {version:1,context:active?.context||null,status:'UNKNOWN',rewardStatus:'UNKNOWN',candidates:[],runtime:status()};}
 }
 function persist(s,force=false){
  if(!same(s)||!s.cacheReady||s.cachePending||!store||!window.FlyObjectiveProfiles)return;
  const now=Date.now();if(!force&&now-s.lastCacheAt<10000)return;s.lastCacheAt=now;
  let profile;try{profile=FlyObjectiveProfiles.createProfile(s.context,s.miner.report(),{now});}catch(error){log('goal.profile-error',{operation:'prepare',message:error.message},'warn');return;}
  s.cachePending=true;
  Promise.resolve(store.put(profile,{expectedRevision:s.cacheRevision})).then(saved=>{
   if(!same(s))return;s.cacheRevision=saved.revision;s.cacheStatus='saved';
   log('goal.profile-saved',{status:profile.status,revision:saved.revision});
  }).catch(error=>{if(!same(s))return;s.cacheStatus='unavailable';log('goal.profile-error',{operation:'save',message:error.message},'warn');}).finally(()=>{s.cachePending=false;if(same(s))render();});
 }
 function cache(s){
  if(!window.FlyObjectiveProfiles||!window.indexedDB)return;
  try{store=store||new FlyObjectiveProfiles.Store({indexedDB:window.indexedDB,crypto:window.crypto});}
  catch(error){s.cacheStatus='unavailable';log('goal.profile-error',{operation:'open',message:error.message},'warn');return;}
  Promise.resolve(store.get(s.context)).then(saved=>{
   if(!same(s))return;s.cacheRevision=saved?.revision||0;s.cacheStatus=saved?'compatible-provisional':'empty';s.cacheReady=true;
   // Cached candidates describe prior observations; they are never trusted as
   // verified semantics or restored into the new miner's evidence counters.
   log('goal.profile-cache',{found:Boolean(saved),status:saved?.profile?.status||null});render();
  }).catch(async error=>{
   if(!same(s))return;log('goal.profile-error',{operation:'read',message:error.message},'warn');
   try{
    if(typeof store.getForRefresh!=='function')throw error;
    // Expired candidates can supply only an integrity-checked CAS revision.
    // They cannot become fresh evidence or verified semantics in this session.
    const retained=await store.getForRefresh(s.context);if(!same(s))return;
    s.cacheRevision=retained?.revision||0;s.cacheReady=true;s.cacheStatus='refresh-required';render();
   }catch(failed){if(!same(s))return;s.cacheStatus='unavailable';log('goal.profile-error',{operation:'refresh',message:failed.message},'warn');render();}
  });
 }
 function start(){
  stopTrace(active,'context-change');
  if(!enabled){lastState='UNKNOWN';reason='disabled';render();return null;}
  if(!loaded||romLoading)return null;
  if(labPlatform!=='nes'){active=null;lastState='UNSUPPORTED';reason='platform';render();return null;}
  const s={serial:++serial,core:nes,hash:romHash,revision:window.labCoreIdentity,trajectoryId:trajectory(),lastObservedAt:-Infinity,lastGeneration:null,observations:0,computeMs:0,traceWorkMs:0,traceInstallMs:0,traceAttempted:false,lastSummaryAt:clock(),stopped:false,cacheReady:false,cacheRevision:0,cacheStatus:'not-loaded',cachePending:false,lastCacheAt:Date.now()};active=s;
  try{
   if(!window.FlyCoreProbe||!window.FlyGoalDiscovery)throw Error('Модули анализа недоступны');
   s.limits={...FlyGoalDiscovery.DEFAULT_LIMITS,...(window.GU_AGOD_LIMITS||{})};
   s.adapter=FlyCoreProbe.create({platform:labPlatform,core:nes,identity:{romHash,coreRevision:window.labCoreIdentity},limits:{maxRamBytes:s.limits.maxRamBytes}});
   if(!s.adapter.capabilities().supported){s.stopped=true;lastState='UNSUPPORTED';reason='core-capability';render();return null;}
   s.context=s.adapter.context();s.miner=new FlyGoalDiscovery.CandidateMiner({context:s.context,limits:s.limits});
   lastState='DISCOVERING';reason=null;render();cache(s);
   log('goal.discovery-start',{platform:labPlatform,detectorRevision:s.context.detectorRevision,ramBytes:s.context.ramLayout.length,rewardStatus:'UNKNOWN'});return s;
  }catch(error){fail(s,error);return null;}
 }
 function boundary(value='emulator-boundary'){
  const s=active;if(!s)return;
  stopTrace(s,value);
  try{s.miner?.boundary(value);s.trajectoryId=trajectory();s.lastObservedAt=-Infinity;s.lastGeneration=null;s.interval=null;persist(s,true);render();}
  catch(error){fail(s,error);}
 }
 function observeFrame(meta){
  if(!enabled||!loaded||romLoading||labPlatform!=='nes'){stopTrace(active,'context-change');return;}
  let s=active;if(!s||!same(s))s=start();if(!s)return;
  // Every actual frame closes the trace budget, including returns below the
  // RAM sample throttle and a stopped miner. No instruction stream is logged.
  if(meta)advanceTrace(s,meta);if(s.stopped)return;
  let inhibitedReason;try{
   // Restored snapshots have no persistent discovery/control classification in
   // PR1. Do not mine them even after their curriculum assignment is cleared.
   inhibitedReason=excluded();
  }catch(error){fail(s,error);return;}
  if(inhibitedReason){if(!s.inhibited||s.inhibitedReason!==inhibitedReason){s.inhibited=true;s.inhibitedReason=inhibitedReason;boundary('observation-suspended');}return;}
  if(s.inhibited){s.inhibited=false;s.inhibitedReason=null;boundary('observation-resumed');}
  if(!meta||!Number.isSafeInteger(meta.frame)||meta.frame<0||!Number.isSafeInteger(meta.generation)||meta.generation<0||!Number.isFinite(meta.atMs)||meta.atMs<0||!meta.action){fail(s,'Неверный контекст наблюдения','observation-rejected');return;}
  const at=meta.atMs;
  if(s.lastGeneration!==null&&s.lastGeneration!==meta.generation)boundary('generation');
  s.lastGeneration=meta.generation;
  // RAM samples are sparse, but executed input coverage is not. Preserve taps
  // between samples instead of attributing the whole interval to its last mask.
  const action=meta.action;
  if(!s.interval)s.interval={firstFrame:meta.frame,lastFrame:meta.frame,frames:1,unionMask:action.mask,changes:0,manualOverrideSeen:action.manualOverride,complete:true,coverage:'executed-frames',lastMask:action.mask};
  else{const interval=s.interval;interval.complete=interval.complete&&meta.frame===interval.lastFrame+1;interval.lastFrame=meta.frame;interval.frames++;interval.unionMask|=action.mask;if(interval.lastMask!==action.mask)interval.changes++;interval.lastMask=action.mask;interval.manualOverrideSeen=interval.manualOverrideSeen||action.manualOverride;}
  // Throttle before copying RAM or computing a visual fingerprint, including
  // fast-forward: observer work is bounded by wall time, not emulator FPS.
  if(at-s.lastObservedAt<1000/s.limits.maxObservationHz)return;
  s.lastObservedAt=at;const began=clock();
  try{
   const {lastMask,...interval}=s.interval;
   const observation=s.adapter.observe({...meta,action:{...action,interval},provenance:{runId,originId:window.flyOriginId||'unknown',startId:window.labStartStateId||'rom-boot',trajectoryId:s.trajectoryId,partition:'discovery',independence:'unverified'}});
   if(!observation){stopTrace(s,'observation-unavailable');lastState='UNSUPPORTED';reason='observation-unavailable';s.stopped=true;render();return;}
   const result=s.miner.observe(observation);s.computeMs+=clock()-began;
   if(result.accepted){s.observations++;s.interval=null;}
   lastState=result.status||lastState;reason=result.reason||null;
   if(s.computeMs>s.limits.maxTotalWorkMs||clock()-began>s.limits.maxWorkMsPerObservation){fail(s,'Превышен бюджет наблюдателя','resource-budget');return;}
   if(lastState==='UNKNOWN'&&!result.accepted){const stats=s.miner.report().stats;fail(s,result.reason||'Наблюдение отклонено',stats.stoppedReason?'resource-budget':'observation-rejected');return;}
   if(at-s.lastSummaryAt>=15000){const stats=s.miner.report().stats;s.lastSummaryAt=at;log('objective.discovery-window',{state:lastState,rewardStatus:'UNKNOWN',observations:s.observations,computeMs:s.computeMs,accepted:stats.accepted,skipped:stats.skipped,decodeEvaluations:stats.decodeEvaluations,budgetExceeded:stats.budgetExceeded});}
   beginTrace(s,meta);render();persist(s);
  }catch(error){s.computeMs+=clock()-began;fail(s,error);}
 }
 function setEnabled(value){
  if(typeof value!=='boolean')throw Error('Переключатель анализатора должен быть boolean');
  boundary(value?'engine-restart':'engine-disabled');enabled=value;toggle.checked=value;try{localStorage.setItem(preference,String(value));}catch(error){log('goal.profile-error',{operation:'preference',message:error.message},'warn');}active=null;lastState='UNKNOWN';reason=value?'waiting-for-rom':'disabled';render();if(value)start();
 }
 window.gameObjectiveDiscovery={beforeFrame,observeFrame,boundary,status,report,setEnabled};
 window.addEventListener('lab-rom-loaded',()=>{stopTrace(active,'rom-loaded');active=null;start();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)boundary('background');});
 document.addEventListener('change',()=>stopTrace(active,'controls-change'),true);
 document.addEventListener('click',event=>{if(['resetKeys','unbindKey','bindKey'].includes(event.target?.id))stopTrace(active,'controls-change');},true);
 render();if(loaded&&!romLoading)start();
})();
