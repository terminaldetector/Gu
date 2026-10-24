'use strict';
// Production observer and real NES/MD cores. No oracle data enter the page.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 const generated=spawnSync('python',['tools/make_agod_test_rom.py','--seed','101'],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);const nesFixture=JSON.parse(generated.stdout);
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const errors=[],external=[],nativeCalls=[];
 async function pageFor(enabled){
  const context=await browser.newContext({viewport:{width:406,height:846},isMobile:true,hasTouch:true}),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith('https://flyconsole.local/'))external.push(request.url());});
  await page.route('https://flyconsole.local/**',route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':'text/html'});});
  await page.exposeFunction('objectiveDemo',system=>{const fixture=system==='sega'?JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-sega.json'))):nesFixture;return page.evaluate(value=>labLoadRom(value),{...fixture,name:'Unlabelled game fixture',sha256:crypto.createHash('sha256').update(Buffer.from(fixture.base64,'base64')).digest('hex')});});
  await page.exposeFunction('objectiveNative',method=>nativeCalls.push(method));
  await page.addInitScript(value=>{
   if(typeof value==='boolean')window.GU_AGOD_ENABLED=value;
   // Host protocol test bounds; product defaults are separately benchmarked.
   window.GU_AGOD_LIMITS={maxWorkMsPerObservation:50,maxTotalWorkMs:30000,maxElapsedMs:120000};
   window.FlyBridge={demo:()=>objectiveDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},orientation(){},stop(){},resume(){},controls(){},gameDisplay(){},configure:()=>objectiveNative('configure'),sample:()=>objectiveNative('sample'),fdbFeedback:()=>objectiveNative('fdbFeedback')};
  },enabled);
  await page.goto('https://flyconsole.local/lab/index.html');await page.waitForFunction(()=>loaded&&!romLoading&&window.gameObjectiveDiscovery);
  return {page,context};
 }
 const play=async page=>{await page.evaluate(()=>{openGame();if(!playing)$('play').click();});await page.waitForFunction(()=>playing&&frame>10);};
 const plain=async page=>page.evaluate(()=>gameObjectiveDiscovery.report());
 const first=await pageFor(undefined),off=first.page;
 assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().enabled),false,'the release gate defaults off before Android acceptance');
 assert.match(await off.textContent('#gameObjectiveStatus'),/Цель не подтверждена/);assert(!/Поиск/.test(await off.textContent('#gameObjectiveStatus')),'disabled is never displayed as active discovery');
 await off.evaluate(()=>{window.objectiveIdleEmulate=nes.cpu.emulate;});await play(off);await off.waitForTimeout(220);assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().observations),0);assert.equal(await off.evaluate(()=>nes.cpu.emulate===objectiveIdleEmulate),true,'default-off executes the original CPU method');assert.equal((await plain(off)).trace.pilotAttempted,false);
 assert(!await off.locator('#experimentalGoalDiscovery').isVisible(),'engine experiment control is absent from the clean game screen');
 assert(!await off.locator('#gameObjectiveStatus').isVisible(),'discovery adds no game HUD');
 await off.evaluate(()=>consoleNavigation.go('agent-training'));assert(await off.locator('#gameObjectiveStatus').isVisible(),'one compact status is available in agent settings');assert(!await off.locator('#rewardAddress').isVisible(),'ordinary agent settings request no RAM address');
 await off.evaluate(()=>{consoleNavigation.legacy('learning');$('trainingResearch').open=true;});await off.check('#experimentalGoalDiscovery');assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().enabled),true);
 await off.reload();await off.waitForFunction(()=>loaded&&!romLoading&&window.gameObjectiveDiscovery);assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().enabled),true,'one global laboratory preference survives reload without per-ROM setup');
 await first.context.close();
 const second=await pageFor(true),page=second.page;
 const prior=await page.evaluate(()=>{window.objectiveFastEmulate=nes.cpu.emulate;return JSON.stringify(learner.save());});await play(page);
 for(const key of ['KeyX','KeyZ','ArrowRight','ArrowDown','ArrowUp','ArrowLeft','KeyX','KeyZ']){await page.keyboard.down(key);await page.waitForTimeout(110);await page.keyboard.up(key);await page.waitForTimeout(130);}
 await page.waitForFunction(()=>gameObjectiveDiscovery.report().stats.accepted>=5&&gameObjectiveDiscovery.report().candidates.length>0);
 const discovered=await plain(page);assert.equal(discovered.context.platform,'nes');assert.equal(discovered.context.ramLayout.length,2048);assert.equal(discovered.rewardStatus,'UNKNOWN');assert.equal(discovered.phase.value,'unknown');assert.equal(discovered.stats.independentConfirmations,0);assert(discovered.candidates.every(row=>row.role==='unknown'&&row.polarity==='unknown'&&row.confidence===null&&!['VERIFIED','OBSERVED'].includes(row.status)),'candidate ranking is never goal meaning or reward');
 assert.equal(discovered.capabilities.cpuWriteTrace,true,'the local source helper is available without patching the default CPU');assert.equal(discovered.trace.pilotAttempted,true,'a mined candidate automatically opens one diagnostic pilot');assert.equal(discovered.trace.active,false);assert(discovered.trace.frames<=16&&discovered.trace.eventCount<=128&&discovered.trace.watchpointCount<=4);assert.equal(discovered.trace.queuedEvents,0,'runtime drops transient values when its pilot finishes');assert.equal(discovered.trace.rewardStatus,'UNKNOWN');assert(discovered.trace.workMs>=discovered.trace.installMs);assert.equal(await page.evaluate(()=>nes.cpu.emulate===objectiveFastEmulate),true,'a completed pilot restores the original CPU fast path');assert(!/"(?:writerPC|oldValue|newValue|writes|watchpoints)"\s*:/.test(JSON.stringify(discovered.trace)),'runtime summaries disclose no write addresses or values');
 assert.equal(await page.evaluate(()=>JSON.stringify(learner.save())),prior,'read-only manual discovery leaves policy state unchanged');assert.deepEqual(nativeCalls,[],'discovery neither configures nor rewards a neural model');
 await page.evaluate(()=>{labPause();gameObjectiveDiscovery.boundary('cache-fixture');});await page.waitForFunction(()=>gameObjectiveDiscovery.status().cache==='saved');
 const cached=await page.evaluate(async()=>{const r=gameObjectiveDiscovery.report();return(new FlyObjectiveProfiles.Store({indexedDB,crypto})).get(r.context);});assert(cached.profile.goalEvidence.observations>0);assert.notEqual(cached.profile.status,'verified');assert.equal(cached.profile.rewardScales.length,0);
 assert(!/writerPC|oldValue|newValue|traceReport|queuedEvents/.test(JSON.stringify(cached.profile)),'persistent objective profiles contain no raw write traces');
 await page.reload();await page.waitForFunction(()=>loaded&&!romLoading&&gameObjectiveDiscovery.status().cache==='compatible-provisional');assert.equal((await plain(page)).stats.accepted,0,'compatible cached candidates are not restored as fresh evidence');assert.equal((await plain(page)).candidates.length,0);
 // Preserve a left/right tap that begins and ends between two RAM samples.
 await page.evaluate(()=>{
  labPause();window.objectiveProbeCreate=FlyCoreProbe.create;window.objectiveIntervals=[];
  FlyCoreProbe.create=options=>{const adapter=objectiveProbeCreate(options),observe=adapter.observe;return{...adapter,observe(meta){const result=observe(meta);objectiveIntervals.push(result.action);return result;}};};
  gameObjectiveDiscovery.setEnabled(true);manualMask=0;advanceFrame(performance.now(),true);manualMask=64;advanceFrame(performance.now(),true);manualMask=128;advanceFrame(performance.now(),true);manualMask=0;for(let i=0;i<3;i++)advanceFrame(performance.now(),true);
 });await page.waitForTimeout(220);await page.evaluate(()=>advanceFrame(performance.now(),true));
 const interval=await page.evaluate(()=>objectiveIntervals.at(-1));assert.equal(interval.mask,0);assert.equal(interval.interval.unionMask,192,'opposite directions over different actual frames remain interval coverage, never an applied combined direction');assert(interval.interval.changes>=2);assert.equal(interval.interval.manualOverrideSeen,false,'ordinary disconnected manual play is not a neural intervention');assert.equal(interval.agentMask,0);assert.equal(interval.interval.complete,true);assert.equal(interval.interval.frames,interval.interval.lastFrame-interval.interval.firstFrame+1);
 await page.evaluate(()=>{gameObjectiveDiscovery.setEnabled(true);connected=true;brainMask=0;manualMask=0;advanceFrame(performance.now(),true);manualMask=128;advanceFrame(performance.now(),true);manualMask=0;for(let i=0;i<4;i++)advanceFrame(performance.now(),true);});await page.waitForTimeout(220);await page.evaluate(()=>advanceFrame(performance.now(),true));
 const override=await page.evaluate(()=>objectiveIntervals.at(-1));assert.equal(override.manualOverride,false);assert.equal(override.interval.manualOverrideSeen,true,'an actual connected manual tap remains visible after release');
 await page.evaluate(()=>{for(let i=0;i<6;i++)advanceFrame(performance.now(),true);});await page.waitForTimeout(220);await page.evaluate(()=>advanceFrame(performance.now(),true));assert.equal(await page.evaluate(()=>objectiveIntervals.at(-1).interval.manualOverrideSeen),false,'the next neutral interval does not inherit sticky FDB intervention state');
 await page.evaluate(()=>{$('learnMode').value='train';$('liveHints').checked=false;manualMask=128;for(let i=0;i<6;i++)advanceFrame(performance.now(),true);});await page.waitForTimeout(220);await page.evaluate(()=>advanceFrame(performance.now(),true));const ignored=await page.evaluate(()=>objectiveIntervals.at(-1));assert.equal(ignored.mask,0);assert.equal(ignored.humanMask,0);assert.equal(ignored.manualOverride,false,'ignored pure-AUTO buttons are not labelled as executed human control');
 await page.evaluate(()=>{window.labNeuralSuspended=true;for(let i=0;i<6;i++)advanceFrame(performance.now(),true);});await page.waitForTimeout(220);await page.evaluate(()=>advanceFrame(performance.now(),true));const recovered=await page.evaluate(()=>objectiveIntervals.at(-1));assert.equal(recovered.mask,128);assert.equal(recovered.humanMask,128);assert.equal(recovered.agentMask,0,'neural failure fallback routes actual manual input without attributing it to the agent');await page.evaluate(()=>{window.labNeuralSuspended=false;});
 await page.evaluate(()=>{connected=false;manualMask=0;$('learnMode').value='off';FlyCoreProbe.create=objectiveProbeCreate;});
 await page.evaluate(()=>{labPause();gameObjectiveDiscovery.boundary('expiry-fixture');});await page.waitForFunction(()=>gameObjectiveDiscovery.status().cache==='saved');
 const expiredRevision=await page.evaluate(async()=>{
  const report=gameObjectiveDiscovery.report(),at=Date.now()-FlyObjectiveProfiles.TTL_MS-1000,cache=new FlyObjectiveProfiles.Store({indexedDB,crypto});
  const previous=await cache.get(report.context),key=FlyGoalDiscovery.contextKey(report.context),profile=FlyObjectiveProfiles.createProfile(report.context,report,{now:at}),payload=JSON.stringify(profile),bytes=new TextEncoder().encode(payload),hash=await crypto.subtle.digest('SHA-256',bytes),revision=(previous?.revision||0)+1;
  const envelope={version:1,key,revision,updatedAt:at,payload,bytes:bytes.length,sha256:Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('')},db=await cache.open();
  // Explicit historical-cache fixture: product Store.put must reject attempts
  // to overwrite a newer profile by moving its clock backwards.
  await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),read=store.get(key);let problem;read.onsuccess=()=>{if((read.result?.revision||0)!==(previous?.revision||0)){problem=Error('expired fixture revision conflict');tx.abort();return;}store.put(envelope,key);};tx.oncomplete=resolve;tx.onabort=()=>reject(problem||tx.error);});
  await cache.close();return revision;
 });
 await page.reload();await page.waitForFunction(()=>loaded&&!romLoading&&gameObjectiveDiscovery.status().cache==='refresh-required');assert.equal((await plain(page)).stats.accepted,0,'expired cached observations remain historical rather than fresh evidence');
 await page.evaluate(()=>gameObjectiveDiscovery.boundary('expired-cache-fixture'));await page.waitForFunction(()=>gameObjectiveDiscovery.status().cache==='saved');
 assert(await page.evaluate(async previous=>{const report=gameObjectiveDiscovery.report(),cache=new FlyObjectiveProfiles.Store({indexedDB,crypto});try{return(await cache.get(report.context)).revision>previous;}finally{await cache.close();}},expiredRevision),'fresh discovery can replace an intact expired profile using CAS');
 // Frozen/control namespaces are explicit fixtures; ordinary frames still run.
 await play(page);
 for(const kind of ['eval','control','autonomous','dual','freeze','restored']){
  const proof=await page.evaluate(async kind=>{
   const old={mode:$('learnMode').value,freeze:$('freeze').checked,curriculum:window.curriculumSessions,autonomous:window.autonomousEpisodes,dual:window.dualAgents,startId:window.labStartStateId};
   const before=gameObjectiveDiscovery.report(),start=frame;
   try{
    if(kind==='eval')$('learnMode').value='eval';
    if(kind==='control')window.curriculumSessions={assignment:()=>({role:'control'})};
    if(kind==='autonomous')window.autonomousEpisodes={...old.autonomous,active:()=>true,waiting:()=>false};
    if(kind==='dual')window.dualAgents={...old.dual,active:()=>true,running:()=>false,route:()=>[0,0],manualPort:()=>1,frame(){},sample(){},waiting:()=>true};
    if(kind==='freeze')$('freeze').checked=true;
    if(kind==='restored'){window.curriculumSessions={assignment:()=>null};window.labStartStateId='unclassified-restored-fixture';}
    advanceFrame(performance.now(),true);await new Promise(resolve=>setTimeout(resolve,240));const after=gameObjectiveDiscovery.report();
    const inhibited=gameObjectiveDiscovery.status();let resumed=null;
    if(kind==='restored'){window.labStartStateId='rom-boot';advanceFrame(performance.now(),true);const fresh=gameObjectiveDiscovery.report();resumed={accepted:fresh.stats.accepted,boundaries:fresh.stats.boundaries,priorBoundaries:after.stats.boundaries,ramChanges:fresh.stats.ramChanges,priorRamChanges:after.stats.ramChanges};}
    return{before:before.stats.accepted,after:after.stats.accepted,candidatesBefore:before.candidates.length,candidatesAfter:after.candidates.length,advanced:frame>start,running:inhibited.running,reason:inhibited.reason,resumed,suspended:Boolean(window.labNeuralSuspended),failure:window.labAgentStatus?.().failure?.message};
   }finally{$('learnMode').value=old.mode;$('freeze').checked=old.freeze;window.curriculumSessions=old.curriculum;window.autonomousEpisodes=old.autonomous;window.dualAgents=old.dual;window.labStartStateId=old.startId;}
  },kind);assert.equal(proof.after,proof.before,kind+' cannot enter discovery evidence');assert.equal(proof.candidatesAfter,proof.candidatesBefore);assert(proof.advanced,kind+' keeps ordinary core frames running');assert.equal(proof.running,false,kind+' is shown as inhibited');assert.equal(proof.suspended,false,kind+' fixture preserves a healthy neural boundary: '+proof.failure);
  if(kind==='restored'){assert.equal(proof.reason,'unclassified-restored-start');assert.equal(proof.resumed.accepted,proof.after+1,'ROM boot resumes with a fresh first observation');assert(proof.resumed.boundaries>proof.resumed.priorBoundaries,'ROM boot explicitly clears the restored-state comparator');assert.equal(proof.resumed.ramChanges,proof.resumed.priorRamChanges,'resuming cannot compare RAM across excluded restored gameplay');}
 }
 // Lifecycle fixtures reuse a genuinely mined candidate only as the trigger.
 // An untouched RAM watchpoint keeps the real trace open until each boundary;
 // no fixture address or semantics enter the production detector.
 await page.evaluate(candidate=>{
  labPause();window.objectiveFastEmulate=nes.cpu.emulate;window.objectiveTraceCreate=FlyCoreProbe.create;window.objectiveTraceMiner=FlyGoalDiscovery.CandidateMiner;window.objectiveTraceBegins=0;window.objectiveTraceLogs=[];window.objectiveTraceEvent=guLogger.event;
  guLogger.event=function(name,data,...rest){if(name==='goal.trace-window')objectiveTraceLogs.push(data);return objectiveTraceEvent.call(this,name,data,...rest);};
  FlyGoalDiscovery.CandidateMiner=class extends objectiveTraceMiner{report(){const result=super.report();if(result.stats.accepted)result.candidates=[candidate];return result;}};
  FlyCoreProbe.create=options=>{const adapter=objectiveTraceCreate(options);window.objectiveTraceAdapter=adapter;return{...adapter,beginWriteTrace(options){objectiveTraceBegins++;const result=adapter.beginWriteTrace({...options,watchpoints:[2047]});if(window.objectiveTraceThrow)throw Error('trace fixture fault');return result;}};};
 },discovered.candidates.find(row=>row.status==='CANDIDATE'));
 const tracedFrames=await page.evaluate(()=>{
  gameObjectiveDiscovery.setEnabled(true);advanceFrame(performance.now(),true);const before=gameObjectiveDiscovery.report(),begins=objectiveTraceBegins;
  for(let i=0;i<16;i++)advanceFrame(performance.now(),true);const after=gameObjectiveDiscovery.report();for(let i=0;i<20;i++)advanceFrame(performance.now(),true);
  return{before:before.trace,after:after.trace,acceptedBefore:before.stats.accepted,acceptedAfter:after.stats.accepted,begins,finalBegins:objectiveTraceBegins,restored:nes.cpu.emulate===objectiveFastEmulate};
 });assert.equal(tracedFrames.before.active,true);assert.equal(tracedFrames.after.frames,16);assert.equal(tracedFrames.after.reason,'frame-limit');assert.equal(tracedFrames.after.active,false);assert.equal(tracedFrames.acceptedAfter,tracedFrames.acceptedBefore,'actual trace frames advance below the 5Hz RAM throttle');assert.equal(tracedFrames.finalBegins,tracedFrames.begins,'a finished pilot never repeatedly reinstalls instrumentation');assert.equal(tracedFrames.restored,true);
 for(const kind of ['pause','generation','eval','control','holdout','excluded','restored','background','controls','manual-override','context','rom-loaded','disabled','save','load']){
  const result=await page.evaluate(async kind=>{
   const old={mode:$('learnMode').value,curriculum:window.curriculumSessions,startId:window.labStartStateId,core:window.labCoreIdentity,playing,hidden:Object.getOwnPropertyDescriptor(document,'hidden')};let serializedDetached=null,cancelledBeforeWait=null;
   connected=false;manualMask=0;gameObjectiveDiscovery.setEnabled(true);advanceFrame(performance.now(),true);const adapter=objectiveTraceAdapter,before=gameObjectiveDiscovery.report().trace,emulate=objectiveFastEmulate;
   try{
    if(kind==='pause')labPause();
    if(kind==='generation')generation++;
    if(kind==='eval')$('learnMode').value='eval';
    if(['control','holdout','excluded'].includes(kind))window.curriculumSessions={assignment:()=>({role:kind})};
    if(kind==='restored')window.labStartStateId='restored-trace-fixture';
    if(kind==='background'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}
    if(kind==='controls')$('controllerAB').dispatchEvent(new Event('change',{bubbles:true}));
    if(kind==='manual-override'){connected=true;brainMask=0;manualMask=128;}
    if(kind==='context'){window.labCoreIdentity=old.core+'-fixture';gameObjectiveDiscovery.beforeFrame({frame:frame+1,generation,action:{manualOverride:false}});}
    if(kind==='rom-loaded')window.dispatchEvent(new CustomEvent('lab-rom-loaded'));
    if(kind==='disabled')gameObjectiveDiscovery.setEnabled(false);
    if(kind==='save'){const serialize=nes.toJSON;nes.toJSON=function(...args){serializedDetached=nes.cpu.emulate===emulate;return serialize.apply(this,args);};try{playing=true;await labGameStates.save('auto',{automatic:true});}finally{nes.toJSON=serialize;}}
    if(kind==='load'){const job=labGameStates.load('auto');cancelledBeforeWait=!adapter.traceReport().active;await job;}
    if(!['pause','background','controls','context','rom-loaded','disabled','save','load'].includes(kind))advanceFrame(performance.now(),true);
    return{before,after:adapter.traceReport(),empty:adapter.drainWriteTrace().length===0,restored:nes.cpu.emulate===emulate,suspended:Boolean(window.labNeuralSuspended),serializedDetached,cancelledBeforeWait};
   }finally{$('learnMode').value=old.mode;window.curriculumSessions=old.curriculum;window.labStartStateId=old.startId;window.labCoreIdentity=old.core;playing=old.playing;connected=false;manualMask=0;if(old.hidden)Object.defineProperty(document,'hidden',old.hidden);else delete document.hidden;gameObjectiveDiscovery.boundary('trace-fixture-cleanup');}
  },kind);
  assert.equal(result.before.active,true,kind+' fixture opens one real trace');assert.equal(result.after.active,false,kind+' detaches before excluded execution');assert.equal(result.after.eventCount,0,kind+' captures no excluded-frame write');assert.equal(result.empty,true,kind+' discards transient trace values');assert.equal(result.restored,true,kind+' restores CPU methods');assert.equal(result.suspended,false,kind+' preserves emulator/neural isolation');
  if(kind==='save')assert.equal(result.serializedDetached,true,'an actual running autosave detaches before serialization');if(kind==='load')assert.equal(result.cancelledBeforeWait,true,'actual load detaches synchronously before storage waits');
 }
 const fault=await page.evaluate(()=>{
  window.objectiveTraceThrow=true;const start=frame,begins=objectiveTraceBegins,logCount=objectiveTraceLogs.length;gameObjectiveDiscovery.setEnabled(true);advanceFrame(performance.now(),true);for(let i=0;i<20;i++)advanceFrame(performance.now(),true);window.objectiveTraceThrow=false;const report=gameObjectiveDiscovery.report();return{frames:frame-start,starts:objectiveTraceBegins-begins,trace:report.trace,restored:nes.cpu.emulate===objectiveFastEmulate,suspended:Boolean(window.labNeuralSuspended),logs:objectiveTraceLogs,completionLogs:objectiveTraceLogs.slice(logCount)};
 });assert.equal(fault.frames,21);assert.equal(fault.starts,1,'a trace installation failure stays stopped until explicit engine restart');assert.equal(fault.trace.active,false);assert.equal(fault.restored,true);assert.equal(fault.suspended,false);assert.equal(fault.completionLogs.length,1,'each window logs its completion once');assert(fault.logs.every(row=>Object.keys(row).every(key=>['reason','frames','eventCount','droppedEvents','overflow','installMs','workMs','costScope'].includes(key))),'trace logs contain only bounded counts/drop/reason and wall costs');assert(fault.logs.every(row=>Number.isFinite(row.installMs)&&row.installMs>=0&&Number.isFinite(row.workMs)&&row.workMs>=row.installMs&&row.costScope==='adapter calls and complete instrumented core frames'),'completion logs expose finite measured costs without write addresses or values');assert.equal(fault.completionLogs[0].installMs,fault.trace.installMs,'attach-failure logging follows install cost accounting');assert.equal(fault.completionLogs[0].workMs,fault.trace.workMs,'completion logging follows final trace cost accounting');
 await page.evaluate(()=>{FlyCoreProbe.create=objectiveTraceCreate;FlyGoalDiscovery.CandidateMiner=objectiveTraceMiner;guLogger.event=objectiveTraceEvent;gameObjectiveDiscovery.setEnabled(true);});await play(page);
 await page.evaluate(()=>{window.GU_AGOD_LIMITS.maxObservations=1;gameObjectiveDiscovery.setEnabled(true);});await page.waitForFunction(()=>gameObjectiveDiscovery.status().reason==='resource-budget');const atStop=await page.evaluate(()=>frame);await page.waitForFunction(n=>playing&&frame>n,atStop);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().observations),1);assert.equal(await page.evaluate(()=>Boolean(window.labNeuralSuspended)),false);
 await page.evaluate(()=>{window.GU_AGOD_LIMITS.maxObservations=600;window.objectiveCreate=FlyCoreProbe.create;FlyCoreProbe.create=()=>{throw Error('objective observer fixture failure');};gameObjectiveDiscovery.setEnabled(true);});
 assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().reason),'observer-error');assert.equal(await page.evaluate(()=>playing),true);await page.evaluate(()=>{FlyCoreProbe.create=objectiveCreate;gameObjectiveDiscovery.setEnabled(true);});
 const isolated=await page.evaluate(()=>{
  const observer=window.gameObjectiveDiscovery,event=window.guLogger.event,before={frame,playing,connected,suspended:Boolean(window.labNeuralSuspended)};
  try{window.gameObjectiveDiscovery={...observer,beforeFrame(){throw Error('trace guard fixture failure');},observeFrame(){throw Error('observer fixture failure');},boundary(){throw Error('boundary fixture failure');}};window.guLogger.event=()=>{throw Error('logger fixture failure');};advanceFrame(performance.now(),true);learningBoundary();return{frameDelta:frame-before.frame,playing,connected,suspended:Boolean(window.labNeuralSuspended),before};}
  finally{window.gameObjectiveDiscovery=observer;window.guLogger.event=event;}
 });assert.equal(isolated.frameDelta,1,'simultaneous observer/logger failures cannot break a real NES frame');assert.equal(isolated.playing,isolated.before.playing);assert.equal(isolated.connected,isolated.before.connected);assert.equal(isolated.suspended,isolated.before.suspended);
 await page.goto('https://flyconsole.local/lab/index.html?system=sega');await page.waitForFunction(()=>loaded&&!romLoading&&window.gameObjectiveDiscovery);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().state),'UNSUPPORTED');await play(page);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().observations),0,'other cores stay independent and unsupported by PR1');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(nativeCalls,[]);await browser.close();browser=null;
 console.log('PASS: real NES automatic cold start without address/graph/oracle, default-off global opt-in, one bounded trace pilot and original CPU restoration, sub-sample trace frame budgets, all lifecycle/eval/holdout/override cancellations, redacted report/log/cache, unknown candidates and provisional cache, executed action coverage, resource/fault and logger isolation, clean UI and unsupported MD; lifecycle/API fixtures are explicit, DEVICE-PENDING');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
