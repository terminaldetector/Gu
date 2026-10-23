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
 await play(off);await off.waitForTimeout(220);assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().observations),0);
 assert(!await off.locator('#experimentalGoalDiscovery').isVisible(),'engine experiment control is absent from the clean game screen');
 assert(!await off.locator('#gameObjectiveStatus').isVisible(),'discovery adds no game HUD');
 await off.evaluate(()=>consoleNavigation.go('agent-training'));assert(await off.locator('#gameObjectiveStatus').isVisible(),'one compact status is available in agent settings');assert(!await off.locator('#rewardAddress').isVisible(),'ordinary agent settings request no RAM address');
 await off.evaluate(()=>{consoleNavigation.legacy('learning');$('trainingResearch').open=true;});await off.check('#experimentalGoalDiscovery');assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().enabled),true);
 await off.reload();await off.waitForFunction(()=>loaded&&!romLoading&&window.gameObjectiveDiscovery);assert.equal(await off.evaluate(()=>gameObjectiveDiscovery.status().enabled),true,'one global laboratory preference survives reload without per-ROM setup');
 await first.context.close();
 const second=await pageFor(true),page=second.page;
 const prior=await page.evaluate(()=>JSON.stringify(learner.save()));await play(page);
 for(const key of ['KeyX','KeyZ','ArrowRight','ArrowDown','ArrowUp','ArrowLeft','KeyX','KeyZ']){await page.keyboard.down(key);await page.waitForTimeout(110);await page.keyboard.up(key);await page.waitForTimeout(130);}
 await page.waitForFunction(()=>gameObjectiveDiscovery.report().stats.accepted>=5&&gameObjectiveDiscovery.report().candidates.length>0);
 const discovered=await plain(page);assert.equal(discovered.context.platform,'nes');assert.equal(discovered.context.ramLayout.length,2048);assert.equal(discovered.rewardStatus,'UNKNOWN');assert.equal(discovered.phase.value,'unknown');assert.equal(discovered.stats.independentConfirmations,0);assert(discovered.candidates.every(row=>row.role==='unknown'&&row.polarity==='unknown'&&row.confidence===null&&!['VERIFIED','OBSERVED'].includes(row.status)),'candidate ranking is never goal meaning or reward');
 assert.equal(await page.evaluate(()=>JSON.stringify(learner.save())),prior,'read-only manual discovery leaves policy state unchanged');assert.deepEqual(nativeCalls,[],'discovery neither configures nor rewards a neural model');
 await page.evaluate(()=>{labPause();gameObjectiveDiscovery.boundary('cache-fixture');});await page.waitForFunction(()=>gameObjectiveDiscovery.status().cache==='saved');
 const cached=await page.evaluate(async()=>{const r=gameObjectiveDiscovery.report();return(new FlyObjectiveProfiles.Store({indexedDB,crypto})).get(r.context);});assert(cached.profile.goalEvidence.observations>0);assert.notEqual(cached.profile.status,'verified');assert.equal(cached.profile.rewardScales.length,0);
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
 await page.evaluate(()=>{window.GU_AGOD_LIMITS.maxObservations=1;gameObjectiveDiscovery.setEnabled(true);});await page.waitForFunction(()=>gameObjectiveDiscovery.status().reason==='resource-budget');const atStop=await page.evaluate(()=>frame);await page.waitForFunction(n=>playing&&frame>n,atStop);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().observations),1);assert.equal(await page.evaluate(()=>Boolean(window.labNeuralSuspended)),false);
 await page.evaluate(()=>{window.GU_AGOD_LIMITS.maxObservations=600;window.objectiveCreate=FlyCoreProbe.create;FlyCoreProbe.create=()=>{throw Error('objective observer fixture failure');};gameObjectiveDiscovery.setEnabled(true);});
 assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().reason),'observer-error');assert.equal(await page.evaluate(()=>playing),true);await page.evaluate(()=>{FlyCoreProbe.create=objectiveCreate;gameObjectiveDiscovery.setEnabled(true);});
 const isolated=await page.evaluate(()=>{
  const observer=window.gameObjectiveDiscovery,event=window.guLogger.event,before={frame,playing,connected,suspended:Boolean(window.labNeuralSuspended)};
  try{window.gameObjectiveDiscovery={...observer,observeFrame(){throw Error('observer fixture failure');},boundary(){throw Error('boundary fixture failure');}};window.guLogger.event=()=>{throw Error('logger fixture failure');};advanceFrame(performance.now(),true);learningBoundary();return{frameDelta:frame-before.frame,playing,connected,suspended:Boolean(window.labNeuralSuspended),before};}
  finally{window.gameObjectiveDiscovery=observer;window.guLogger.event=event;}
 });assert.equal(isolated.frameDelta,1,'simultaneous observer/logger failures cannot break a real NES frame');assert.equal(isolated.playing,isolated.before.playing);assert.equal(isolated.connected,isolated.before.connected);assert.equal(isolated.suspended,isolated.before.suspended);
 await page.goto('https://flyconsole.local/lab/index.html?system=sega');await page.waitForFunction(()=>loaded&&!romLoading&&window.gameObjectiveDiscovery);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().state),'UNSUPPORTED');await play(page);assert.equal(await page.evaluate(()=>gameObjectiveDiscovery.status().observations),0,'other cores stay independent and unsupported by PR1');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(nativeCalls,[]);await browser.close();browser=null;
 console.log('PASS: real NES automatic read-only cold start without address/graph/oracle, global gated opt-in/persistence, unknown candidate report and provisional cache, executed sub-sample action coverage, eval/control/autonomous/dual/freeze/restored-start exclusion, resource/fault and logger isolation, clean game/settings UI and unsupported MD; native methods/control assignments are explicit fixtures, DEVICE-PENDING');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
