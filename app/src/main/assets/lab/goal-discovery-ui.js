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

/* ---------------------------------------------------------------------------
   «Запустить AGOD» — the executable research action.

   SEPARATE FROM THE PASSIVE OBSERVER ABOVE, deliberately. That observer watches
   frames of the live game as they happen and never writes anything. This runs
   the whole FlyAgodPipeline on an INDEPENDENT emulator in a worker thread, on
   explicit request, and can take tens of seconds. Mixing the two into one
   control would make it impossible to tell which produced a given statement.

   The live game is never handed to the research contour: the worker gets the
   cartridge and, optionally, a snapshot of the current state BY VALUE, and
   builds its own core from those bytes in its own thread.

   VERIFIED is displayed only when FlyAgodPipeline returns it. Nothing here
   synthesises an outcome, and a REFUSED is shown with the stage and the reason
   the pipeline gave. */
(()=>{
 const host=document.getElementById('trainingResearch');
 if(!host)return;
 const box=document.createElement('div');
 box.id='agodRunPanel';
 const title=document.createElement('p');
 title.className='note';
 title.textContent='AGOD: исполняемый поиск цели (отдельный поток, независимый эмулятор)';
 const runButton=document.createElement('button');
 runButton.id='agodRunButton';runButton.type='button';
 runButton.textContent='Запустить AGOD';
 const stopButton=document.createElement('button');
 stopButton.id='agodStopButton';stopButton.type='button';
 stopButton.textContent='Остановить';stopButton.disabled=true;
 const phase=document.createElement('p');
 phase.id='agodRunStatus';phase.className='note';phase.setAttribute('role','status');
 phase.textContent='AGOD не запущен';
 const budget=document.createElement('p');
 budget.id='agodRunBudget';budget.className='note';
 const outcome=document.createElement('p');
 outcome.id='agodRunResult';outcome.className='note';
 const candidates=document.createElement('pre');
 candidates.id='agodRunCandidates';candidates.className='note';
 box.append(title,runButton,stopButton,phase,budget,outcome,candidates);
 host.append(box);

 let session=null,liveHashBefore=null;
 const set=(element,text)=>{element.textContent=text||'';};

 /* THE LIVE-GAME DIAGNOSTIC, CORRECTED.
    The first version hashed the live RAM before and after the run and printed
    «ИЗМЕНЕНА» on any difference. That was wrong: a running emulator advances
    on its own, so a changed hash is the game playing, not the research worker
    reaching into it. The comparison is only meaningful when the live core did
    NOT advance, so the frame counter is recorded too and the panel says
    plainly when the two states are not comparable. */
 const liveFrame=()=>{try{return typeof frame==='undefined'?null:frame;}catch(_){return null;}};
 let liveFrameBefore=null,lastRecord=null;
 function liveComparison(){
  const after=liveStateHash(),frameAfter=liveFrame();
  if(liveHashBefore===null||after===null)return 'живая игра: состояние не прочитано';
  if(liveFrameBefore===null||frameAfter===null)
   return 'живая игра: сравнение невозможно, счётчик кадров недоступен';
  if(frameAfter!==liveFrameBefore)
   return 'живая игра: продвинулась на '+(frameAfter-liveFrameBefore)
    +' кадров, состояния несопоставимы (изоляция обеспечена отдельным ядром в worker)';
  return 'живая игра: не изменена при остановленном эмуляторе';
 }

 /* The live core's RAM identity. Used only for the comparison above, which is
    reported only when the live core did not advance. */
 const liveStateHash=()=>{
  try{
   if(typeof nes==='undefined'||!nes||!nes.cpu||!nes.cpu.mem)return null;
   const api=window.FlyAgodPlatformDriver||window.FlyAgodNesDriver;
   if(!api)return null;
   const width=(window.FlyPlatforms&&window.FlyPlatforms[labPlatform]
    &&window.FlyPlatforms[labPlatform].ram)||0x800;
   return api.ramHash(nes.cpu.mem.slice(0,Math.min(width,nes.cpu.mem.length||width)));
  }catch(_){return null;}
 };

 function describeCandidates(dto){
  const found=dto&&dto.discovered?dto.discovered:null;
  if(!found)return 'кандидаты: не сформированы';
  const lines=[];
  if(found.resource){
   const r=found.resource;
   lines.push('ресурс: адрес '+(r.field?r.field.address:r.address)
    +(r.mask!==undefined?' · маска '+r.mask:'')
    +(r.field&&r.field.width?' · ширина '+r.field.width:''));
  }
  if(Array.isArray(found.increasingFields)&&found.increasingFields.length)
   lines.push('растущие поля: '+found.increasingFields.length);
  if(Array.isArray(found.neutralMovedAddresses))
   lines.push('адресов, двигавшихся без действия: '+found.neutralMovedAddresses.length);
  if(found.effect&&found.effect.polarity)
   lines.push('полярность: '+found.effect.polarity);
  return lines.length?lines.join('\n'):'кандидаты: сформированы, без деталей';
 }

 /* The worker sends a GoalEvidenceDTO, not the pipeline result: a VERIFIED
    result carries readResource, broker and registry, which structuredClone
    refuses. The DTO is validated HERE before anything is called a goal. */
 /* the `started` message of the current run: the identity an objective is bound to */
 let lastStarted=null;
 const PHASE_LABEL=p=>({PLAYING:'игра',MENU:'меню/титул',TRANSITION:'переход',INERT:'без реакции'})[p]||p;
 /* The platform's own shape, as the worker reported it; '' until it does.
    Declared above showResult because all three writers of the budget line
    append it. */
 let platformShape='';

 function showResult(message){
  const dto=message.dto||null;
  const summary=message.summary||{};
  const status=(dto&&dto.status)||summary.status||'(без статуса)';
  const parts=['итог pipeline: '+status];
  if(dto&&dto.stage||summary.stage)parts.push('стадия: '+((dto&&dto.stage)||summary.stage));
  const reason=(dto&&dto.reason)||summary.reason;
  if(reason)parts.push('причина: '+reason);
  if(dto&&dto.goal&&dto.goal.polarity)parts.push('цель: '+dto.goal.polarity);

  /* The validated goal record. VERIFIED is the pipeline's word AND must
     survive validation against this ROM, core and profile; a DTO that does
     not validate is reported as such and grants nothing. */
  let validated=null;
  if(dto&&window.FlyAgodGoalDto){
   validated=window.FlyAgodGoalDto.validate(dto,{
    romHash:(typeof romHash!=='undefined'&&romHash)||undefined,
    coreRevision:window.labCoreIdentity||undefined,
    profileRevision:'agod-app-1'});
   parts.push('запись цели: '+(validated.valid?'проверена'
    :'НЕ проверена — '+validated.problems.slice(0,2).join('; ')));
   if(status==='VERIFIED'&&validated.valid)
    parts.push('VERIFIED получен от FlyAgodPipeline и доказательства сохранены');
   /* HAND THE RESULT TO THE LIVE OBJECTIVE. Only a VERIFIED, validated record
      can become one; anything else leaves the game without a reward source,
      and says so. The reward mode is switched to AGOD only from "manual" - a
      source the user configured by hand is not overridden. */
   if(window.agodObjective){
    const live=window.agodObjective.adopt(validated.valid?dto:null,lastStarted);
    if(live.state==='VERIFIED'){
     parts.push('источник награды: подтверждён автоматически (ресурс @'+live.resourceAddress+', '+live.polarity+')');
     /* THE DECISION PRIOR (real-ROM track). Survival discovery measured which
        buttons a seeded random player held just before progress rose; those
        are ADDED to the agent's action set (the default set is kept). Only
        when the field still holds a platform default or a set AGOD put there
        itself - a set the person typed is theirs. GU_AGOD_DECISION=false
        turns it off. */
     try{
      const field=document.getElementById('actionMasks');
      const prior=window.FlyAgodObjective&&typeof window.FlyAgodObjective.decisionPrior==='function'
       ?window.FlyAgodObjective.decisionPrior(dto.discovered&&dto.discovered.buttonAttribution,
         lastStarted&&lastStarted.capabilities&&lastStarted.capabilities.actionSpec):null;
      const defaults=['0,1,2,16,32,64,128,129,17,3,65,33,66,130,18,34,19,67,131,35,4,8',
       '0,1,2,4,16,32,64,128,129,17,256,512,1024,257,513,1025'];
      const current=field?field.value.replace(/\s+/g,''):'';
      if(prior&&field&&window.GU_AGOD_DECISION===true
       &&(defaults.includes(current)||field.dataset.agodActions===current)){
       const text=prior.actions.join(',');field.value=text;field.dataset.agodActions=text;
       try{if(typeof learner!=='undefined'&&learner&&typeof learner.setActions==='function')learner.setActions(prior.actions.slice());}catch(_){}
       parts.push('действия агента: набор из AGOD ('+prior.actions.length+' масок'
        +(prior.priors.length?'; кнопки, за которые платит игра: '+prior.priors.map(p=>p.button).join(', '):'')+')');
      }
     }catch(_){}
     const mode=document.getElementById('rewardMode');
     if(mode&&mode.value==='manual'){mode.value='agod';
      try{mode.dispatchEvent(new Event('change'));}catch(_){}}
    }else parts.push('источник награды: не подтверждён — обучение по игре не начнётся');
   }
  }else if(message.dtoCloneable===false){
   parts.push('результат не сериализуется: '+(message.dtoCloneError||''));
  }
  set(outcome,parts.join(' · '));
  set(candidates,describeCandidates(dto));
  lastRecord={dto,validated,cost:message.cost||null};

  const cost=message.cost||{};
  /* platformShape is appended here too: this is the THIRD writer of this line
     (started, progress, and the final cost line), and the first version of the
     G3 panel change only covered the first two - so the platform shape was on
     screen during the run and gone the moment the result arrived, which is
     exactly when an operator reads it. The E2E check caught that. */
  set(budget,'бюджет: '+(cost.framesRun||0)+' из '+(cost.frameBudget||0)+' кадров'
   +' · время '+Math.round((cost.wallClockMs||0)/100)/10+' с'
   +platformShape
   +' · '+liveComparison());
 }

 function finished(label){
  session=null;runButton.disabled=false;stopButton.disabled=true;
  if(label)set(phase,label);
 }

 function onEvent(message){
  if(!message||typeof message!=='object')return;
  if(message.type==='started'){
   lastStarted=message;
   /* this build's detector revision settles any objective restored from storage */
   if(window.agodObjective)window.agodObjective.detector(message);
   set(phase,'AGOD выполняется · driver '+(message.driverRevision||'?')
    +' · pipeline '+(message.pipelineRevision||'?'));
   /* What the run will actually drive and read, from the platform rather than
      from a NES-shaped default: shown so the operator can see the action set
      and the observed RAM width instead of inferring them. Held, because the
      progress messages overwrite this line several times a second and the
      platform shape has to survive them. */
   const caps=message.capabilities||null;
   const spec=caps&&caps.actionSpec?caps.actionSpec:null;
   platformShape=caps
    ?' · '+(spec&&spec.buttonCount?spec.buttonCount+' кнопок':'кнопки не описаны')
     +' · RAM '+(caps.observedRamBytes||'?')+' Б'
     +(caps.bulkReadVia?' · чтение: '+caps.bulkReadVia:'')
    :(message.capabilitiesCloneError
      ?' · возможности ядра не переданы: '+message.capabilitiesCloneError:'');
   set(budget,'бюджет: 0 из '+(message.frameBudget||0)+' кадров'
    +' · старт: '+(message.startedFrom||'')+platformShape);
   return;
  }
  if(message.type==='progress'){
   if(message.phase)lastPhase=message.phase;
   set(budget,'бюджет: '+(message.framesRun||0)+' из '+(message.frameBudget||0)
    +' кадров · '+Math.round((message.elapsedMs||0)/100)/10+' с'
    +(lastPhase?' · фаза игры: '+PHASE_LABEL(lastPhase):'')+platformShape);
   return;
  }
  if(message.type==='result'){showResult(message);
   const live=window.agodObjective?window.agodObjective.status():null;
   const verified=live&&live.state==='VERIFIED';
   /* the live game was at a title or a menu: nothing was searched, nothing
      is concluded, and the next look comes soon and costs no attempt */
   if(!verified&&message.summary&&message.summary.notInPlay){
    finished('Ждёт игры · AGOD начнёт поиск, когда начнётся игровой процесс');
    scheduleRetry(true);
    return;
   }
   finished(verified?'Подтверждено · AGOD завершён':'Недостаточно данных · AGOD завершён');
   /* DISCOVERY FOLLOWS THE GAME. A cartridge examined from its title screen has
      nothing to find: no resource moves there. So a run that did not verify is
      tried again later FROM WHEREVER THE PLAYER OR THE AGENT HAS GOT TO, as
      long as the live game has actually advanced since the last attempt. The
      attempts are bounded and spaced out, and stop for good on a verified
      goal, a new cartridge or the stop button. */
   if(!verified)scheduleRetry();
   return;}
  if(message.type==='error'){
   const error=message.error||{};
   set(outcome,(error.budgetExceeded?'бюджет исчерпан: ':'ошибка: ')
    +(error.message||'неизвестная ошибка')+(message.phase?' (фаза '+message.phase+')':''));
   finished('AGOD остановлен с ошибкой');
   return;
  }
  if(message.type==='cancelled'){finished('AGOD отменён до запуска');return;}
  if(message.type==='stopped'){
   set(outcome,'остановлено оператором; worker завершён, результата нет');
   finished('AGOD остановлен');
   return;
  }
 }

 let autoTimer=null,retryTimer=null,attempts=0,lastAttemptFrame=-1,userStopped=false;
 let backgroundRun=false,waits=0,lastPhase=null;
 const RETRY_LIMIT=8,RETRY_DELAYS=[20,30,45,60,90,120,180,240],WAIT_LIMIT=60,WAIT_SECONDS=20;
 const autoEnabled=()=>window.GU_AGOD_AUTOSTART===true
  ||(window.GU_AGOD_AUTOSTART!==false&&!!window.FlyBridge);
 function scheduleRetry(notInPlay){
  clearTimeout(retryTimer);
  if(!autoEnabled()||userStopped)return;
  /* waiting for play is not a failed attempt: it has its own, larger bound */
  if(notInPlay){attempts=Math.max(0,attempts-1);if(++waits>WAIT_LIMIT)return;}
  else if(attempts>=RETRY_LIMIT)return;
  const wait=(window.GU_AGOD_RETRY_SECONDS||(notInPlay?WAIT_SECONDS:RETRY_DELAYS[Math.min(attempts,RETRY_DELAYS.length-1)]))*1000;
  retryTimer=setTimeout(()=>{
   if(session||userStopped||(window.agodObjective&&window.agodObjective.active()))return;
   const now=liveFrame();
   /* the game has not moved since the last attempt: the same state would
      give the same answer, so wait for play rather than spend the budget */
   if(now!==null&&now===lastAttemptFrame){scheduleRetry(notInPlay);return;}
   backgroundRun=true;runButton.onclick();
  },wait);
 }
 runButton.onclick=()=>{
  if(session)return;
  if(typeof loaded==='undefined'||!loaded||typeof romLoading!=='undefined'&&romLoading){
   set(phase,'AGOD не запущен: картридж не загружен');return;
  }
  const supported=window.FlyAgodPlatformDriver
   ?window.FlyAgodPlatformDriver.SUPPORTED:['nes'];
  if(typeof labPlatform!=='undefined'&&!supported.includes(labPlatform)){
   set(phase,'AGOD не запущен: платформа '+labPlatform+' не поддерживается контуром');
   return;
  }
  if(!window.FlyAgodExperimental||typeof window.FlyAgodExperimental.runInWorker!=='function'){
   set(phase,'AGOD не запущен: мост FlyAgodExperimental недоступен');return;
  }
  const rom=(typeof nes!=='undefined'&&nes&&nes.romData)?nes.romData:null;
  if(!rom){set(phase,'AGOD не запущен: байты картриджа недоступны');return;}
  liveHashBefore=liveStateHash();liveFrameBefore=liveFrame();
  set(outcome,'');set(candidates,'');
  /* cleared per run: a shape left over from the previous cartridge would be a
     claim about this one */
  platformShape='';
  attempts++;lastAttemptFrame=liveFrame();
  set(phase,'Ищет · AGOD запускается…'+(attempts>1?' (попытка '+attempts+', из текущего состояния игры)':''));
  /* The live state is passed BY VALUE as a serialised snapshot, so the research
     core starts where the player is without the live instance being shared. */
  /* jsnes restores from a JSON string; the WASM cores restore from their own
     state object. Stringifying every platform's snapshot made the worker's
     restore fail on Sega, Game Boy and SNES, so the run could only ever start
     from that worker's own boot - the title screen. */
  let startSnapshot=null;
  try{const state=nes.toJSON();
   startSnapshot=(typeof labPlatform==='undefined'||labPlatform==='nes')?JSON.stringify(state):state;
  }catch(_){startSnapshot=null;}
  const started=window.FlyAgodExperimental.runInWorker({
   platform:typeof labPlatform!=='undefined'?labPlatform:'nes',
   romBinaryString:rom,
   startSnapshot,
   background:backgroundRun,
   frameBudget:(window.GU_AGOD_FRAME_BUDGET|0)||2000000,
   config:{romHash:(typeof romHash!=='undefined'&&romHash)||'unknown-rom',
    coreRevision:window.labCoreIdentity||'unknown-core',
    profileRevision:'agod-app-1',
    ...(window.GU_AGOD_CONFIG||{})},
   onEvent});
  backgroundRun=false;
  if(!started||started.status!=='RUNNING'){
   set(phase,'AGOD не запущен: '+((started&&started.reason)||'мост отказал'));
   return;
  }
  session=started;runButton.disabled=true;stopButton.disabled=false;
 };

 stopButton.onclick=()=>{
  /* a stop from the user also stops the background retries, until a new cartridge */
  userStopped=true;clearTimeout(retryTimer);
  if(!session)return;
  try{session.stop();}catch(_){}
  finished('AGOD остановлен');
 };

 /* Changing the cartridge or leaving the page must not leave a worker running
    on the previous ROM. */
 const abandon=reason=>{
  if(!session)return;
  try{session.stop();}catch(_){}
  finished(reason);
 };
 window.addEventListener('lab-rom-loaded',()=>{
  abandon('AGOD остановлен: загружен другой картридж');
  /* BACKGROUND DISCOVERY. The game is playable at once; discovery runs in the
     worker on its own core. On by default inside the Android app, where the
     native bridge exists; a page without it (the host test bench) starts a run
     only when asked, or when GU_AGOD_AUTOSTART is set. */
  clearTimeout(retryTimer);attempts=0;waits=0;lastPhase=null;lastAttemptFrame=-1;userStopped=false;
  if(!autoEnabled())return;
  clearTimeout(autoTimer);
  autoTimer=setTimeout(()=>{
   if(session||(window.agodObjective&&window.agodObjective.active()))return;
   backgroundRun=true;runButton.onclick();
  },1500);
 });
 window.addEventListener('pagehide',()=>abandon('AGOD остановлен: страница закрыта'));
 window.agodRunPanel={status:()=>phase.textContent,
  result:()=>outcome.textContent,budget:()=>budget.textContent,
  candidates:()=>candidates.textContent,
  running:()=>!!session,
  /* the validated goal record, as data, for the learning contour (G5) and for
     the functional test - never the mechanism, which stays in the worker */
  record:()=>lastRecord};
})();
