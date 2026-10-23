/* Experimental read-only goal discovery. No reward, controller or learned-state writes. */
'use strict';
(()=>{
 const node=document.createElement('p');node.id='gameObjectiveStatus';node.className='note';node.setAttribute('role','status');$('trainingStatus').after(node);
 const preference='gu-agod-experimental-v1';let saved=false;try{saved=localStorage.getItem(preference)==='true';}catch(_){}
 const runId=crypto.randomUUID();let enabled=typeof window.GU_AGOD_ENABLED==='boolean'?window.GU_AGOD_ENABLED:saved,active=null,serial=0,store=null,lastState='UNKNOWN',reason='disabled';
 const clock=()=>performance.now(),trajectory=()=>crypto.randomUUID();
 const log=(name,data={},level='info')=>{try{window.guLogger?.event?.(name,data,level);}catch(_){}};
 const option=document.createElement('label'),toggle=document.createElement('input');toggle.type='checkbox';toggle.id='experimentalGoalDiscovery';toggle.checked=enabled;option.append(toggle,document.createTextNode(' Автоанализ NES (эксперимент, без награды)'));$('trainingResearch').append(option);toggle.onchange=()=>setEnabled(toggle.checked);
 const same=s=>active===s&&s.core===nes&&s.hash===romHash&&s.revision===window.labCoreIdentity;
 function status(){
  const running=Boolean(enabled&&active&&!active.stopped&&!active.inhibited&&playing&&!romLoading&&!document.hidden),state=!enabled||active?.inhibited?'UNKNOWN':lastState;
  return {version:1,source:'auto-discovery',enabled,state,running,rewardStatus:'UNKNOWN',reason:!enabled?'disabled':active?.inhibited?active.inhibitedReason:reason,cache:active?.cacheStatus||'not-loaded',observations:active?.observations||0,text:!enabled?'Цель не подтверждена.':state==='UNSUPPORTED'?'Автоматический поиск цели для этой системы пока недоступен.':running?'Поиск игровых событий. Цель не подтверждена.':'Цель не подтверждена. Анализ приостановлен.'};
 }
 function render(){node.textContent=status().text;}
 function fail(s,error,kind='observer-error'){
  if(!same(s))return;try{s.miner?.boundary(kind);}catch(_){}
  s.stopped=true;lastState='UNKNOWN';reason=kind;render();
  log('goal.discovery-stopped',{reason:kind,message:String(error?.message||error||kind),observations:s.observations,computeMs:s.computeMs},kind==='resource-budget'?'warn':'error');
 }
 function report(){
  try{return {...(active?.miner?.report()||{version:1,context:null,candidates:[],phase:{value:'unknown'}}),runtime:status(),rewardStatus:'UNKNOWN',observerComputeMs:active?.computeMs||0};}
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
  if(!enabled){lastState='UNKNOWN';reason='disabled';render();return null;}
  if(!loaded||romLoading)return null;
  if(labPlatform!=='nes'){active=null;lastState='UNSUPPORTED';reason='platform';render();return null;}
  const s={serial:++serial,core:nes,hash:romHash,revision:window.labCoreIdentity,trajectoryId:trajectory(),lastObservedAt:-Infinity,lastGeneration:null,observations:0,computeMs:0,lastSummaryAt:clock(),stopped:false,cacheReady:false,cacheRevision:0,cacheStatus:'not-loaded',cachePending:false,lastCacheAt:Date.now()};active=s;
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
  try{s.miner?.boundary(value);s.trajectoryId=trajectory();s.lastObservedAt=-Infinity;s.lastGeneration=null;s.interval=null;persist(s,true);render();}
  catch(error){fail(s,error);}
 }
 function observeFrame(meta){
  if(!enabled||!loaded||romLoading||labPlatform!=='nes')return;
  let s=active;if(!s||!same(s))s=start();if(!s||s.stopped)return;
  let inhibitedReason;try{
   // Restored snapshots have no persistent discovery/control classification in
   // PR1. Do not mine them even after their curriculum assignment is cleared.
   const startId=window.labStartStateId;
   inhibitedReason=startId!=null&&startId!=='rom-boot'?'unclassified-restored-start':document.hidden||$('freeze').checked||benchmark||$('learnMode').value==='eval'||window.autonomousEpisodes?.active?.()||window.curriculumSessions?.assignment?.()?.role==='control'||window.dualAgents?.active?.()||gmodeMode!=='off'?'evaluation-or-context':null;
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
   if(!observation){lastState='UNSUPPORTED';reason='observation-unavailable';s.stopped=true;render();return;}
   const result=s.miner.observe(observation);s.computeMs+=clock()-began;
   if(result.accepted){s.observations++;s.interval=null;}
   lastState=result.status||lastState;reason=result.reason||null;
   if(s.computeMs>s.limits.maxTotalWorkMs||clock()-began>s.limits.maxWorkMsPerObservation){fail(s,'Превышен бюджет наблюдателя','resource-budget');return;}
   if(lastState==='UNKNOWN'&&!result.accepted){const stats=s.miner.report().stats;fail(s,result.reason||'Наблюдение отклонено',stats.stoppedReason?'resource-budget':'observation-rejected');return;}
   if(at-s.lastSummaryAt>=15000){const stats=s.miner.report().stats;s.lastSummaryAt=at;log('objective.discovery-window',{state:lastState,rewardStatus:'UNKNOWN',observations:s.observations,computeMs:s.computeMs,accepted:stats.accepted,skipped:stats.skipped,decodeEvaluations:stats.decodeEvaluations,budgetExceeded:stats.budgetExceeded});}
   render();persist(s);
  }catch(error){s.computeMs+=clock()-began;fail(s,error);}
 }
 function setEnabled(value){
  if(typeof value!=='boolean')throw Error('Переключатель анализатора должен быть boolean');
  boundary(value?'engine-restart':'engine-disabled');enabled=value;toggle.checked=value;try{localStorage.setItem(preference,String(value));}catch(error){log('goal.profile-error',{operation:'preference',message:error.message},'warn');}active=null;lastState='UNKNOWN';reason=value?'waiting-for-rom':'disabled';render();if(value)start();
 }
 window.gameObjectiveDiscovery={observeFrame,boundary,status,report,setEnabled};
 window.addEventListener('lab-rom-loaded',()=>{active=null;start();});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)boundary('background');});
 render();if(loaded&&!romLoading)start();
})();
