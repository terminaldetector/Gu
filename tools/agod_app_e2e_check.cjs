'use strict';
// END-TO-END: the user presses «Запустить AGOD» and a real pipeline result appears.
//
// This is the functional test the integration is for, and it is deliberately
// hostile to the ways such a test can pass without the thing working:
//
//   - the driver is the REAL app driver (agod-nes-driver.js), not a stub;
//   - the pipeline is the REAL FlyAgodPipeline, asserted by its own revision
//     string coming back from the worker;
//   - the result is whatever the pipeline returned. VERIFIED is accepted only
//     if the pipeline produced it, and the test does not require it;
//   - a module-load check is NOT sufficient and is not counted as evidence;
//   - session(null) refusing is kept only as a negative control at the end.
//
// It drives the page through the real DOM: it clicks the button that a person
// clicks, and reads the panel a person reads.
//
// ISOLATION IS ASSERTED, not assumed: the live core's RAM and full serialised
// state are hashed before and after the research run and must be unchanged.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),
      os=require('node:os'),crypto=require('node:crypto'),
      {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');
const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');

const steps=[],failures=[];
const fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);
const report={type:'gu-agod-app-e2e-check',version:1,
 claim:'A person presses «Запустить AGOD» in the real GU interface, the real '
  +'FlyAgodPipeline runs on an independent emulator off the UI thread, a valid '
  +'pipeline result is displayed, the live game state is untouched, and stopping '
  +'releases the worker.',
 notEvidence:'module loading, a refusal from session(null), or any synthesised outcome',
 steps,status:'RUNNING'};
const save=()=>{if(process.env.AGOD_E2E_REPORT)
 fs.writeFileSync(process.env.AGOD_E2E_REPORT,JSON.stringify(report,null,2)+'\n');};save();
const step=(name,detail)=>{steps.push({name,...detail});save();};

(async()=>{
 const browser=await chromium.launch({headless:true,
  executablePath:process.env.CHROMIUM_EXECUTABLE||'/opt/pw-browsers/chromium',
  args:['--no-sandbox']});
 const pageErrors=[],workerUrls=[];
 const openPage=async()=>{
  const fresh=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  fresh.on('pageerror',error=>pageErrors.push(error.message));
  fresh.on('worker',worker=>workerUrls.push(worker.url()));
  await fresh.route('https://flyconsole.local/**',async route=>{
   const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type=file.endsWith('.js')?'application/javascript'
    :file.endsWith('.json')?'application/json'
    :file.endsWith('.css')?'text/css':'text/html';
   await route.fulfill({contentType:type,body:fs.readFileSync(file)});
  });
  await fresh.goto('https://flyconsole.local/lab/index.html');
  return fresh;
 };
 /* Reaches the control the way a person does, and installs the event tap. */
 const prepare=async(target,rom,label,shaTag)=>{
  await target.evaluate(data=>window.labLoadRom(data),
   {base64:rom,name:label,sha256:shaTag});
  await target.waitForFunction(()=>loaded===true,null,{timeout:60000});
  await target.evaluate(()=>{
   window.consoleNavigation.go('legacy-learning');
   const section=document.getElementById('trainingResearch');
   if(section&&!section.open)section.open=true;
  });
  await target.waitForSelector('#agodRunButton',{state:'visible',timeout:30000});
  await target.evaluate(()=>{
   window.__agodEvents=[];
   const original=window.FlyAgodExperimental.runInWorker;
   window.FlyAgodExperimental.runInWorker=request=>original({...request,
    onEvent(message){window.__agodEvents.push(message);
     if(request&&typeof request.onEvent==='function')request.onEvent(message);}});
  });
 };
 const page=await openPage();

 try{
  /* ---- 1. the real interface ---- */
  step('1. the real GU interface loads',{pageErrors:pageErrors.slice()});

  /* ---- 2. the embedded synthetic cartridge ---- */
  await prepare(page,demo.base64,demo.name,'e2e-'+sha(demo.base64).slice(0,32));
  const cartridge=await page.evaluate(()=>({
   loaded,platform:typeof labPlatform!=='undefined'?labPlatform:null,
   romBytes:(typeof nes!=='undefined'&&nes&&nes.romData)?nes.romData.length:0,
   driverPresent:!!window.FlyAgodNesDriver,
   bridgePresent:!!(window.FlyAgodExperimental&&window.FlyAgodExperimental.runInWorker)}));
  step('2. the embedded synthetic NES ROM is loaded',cartridge);
  expect(cartridge.loaded&&cartridge.platform==='nes'&&cartridge.romBytes>0,
   'the cartridge did not load: '+JSON.stringify(cartridge));
  expect(cartridge.driverPresent,'FlyAgodNesDriver is not present in the page');
  expect(cartridge.bridgePresent,'FlyAgodExperimental.runInWorker is not present');

  /* ---- 3. the live state, before ---- */
  const liveBefore=await page.evaluate(()=>({
   ram:window.FlyAgodNesDriver.ramHash(nes.cpu.mem.slice(0,0x800)),
   serialised:JSON.stringify(nes.toJSON()).length,
   fullState:JSON.stringify(nes.toJSON())}));
  step('3. the live game state is recorded before the run',
   {ramHash:liveBefore.ram,serialisedBytes:liveBefore.serialised,
    fullStateSha256:sha(liveBefore.fullState)});

  /* ---- 4. navigate to the control the way a person does ----
     The research panel is a collapsed <details> inside the research tab, so a
     person opens that tab and expands the section. The first run of this test
     clicked a button that existed but was not visible, and Playwright was
     right to refuse: an invisible control is not a usable one. */
  const control=await page.evaluate(()=>{
   const run=document.getElementById('agodRunButton');
   const stop=document.getElementById('agodStopButton');
   return {runExists:!!run,runText:run?run.textContent:null,
    stopExists:!!stop,stopDisabled:stop?stop.disabled:null,
    panelExists:!!document.getElementById('agodRunPanel'),
    runVisible:!!(document.getElementById('agodRunButton')
     &&document.getElementById('agodRunButton').offsetParent!==null),
    separateFromObserver:!!document.getElementById('experimentalGoalDiscovery')};
  });
  step('4. the «Запустить AGOD» control exists and is distinct from the passive observer',control);
  expect(control.runExists&&control.panelExists,'the AGOD run control is not in the page');
  expect(control.runVisible,'the AGOD run control is in the page but not visible to a person');
  expect(control.separateFromObserver,
   'the passive observer toggle is gone, so the two were merged rather than kept apart');

  /* the event tap was installed by prepare(), so the test reads what the
     worker said and not only what the panel rendered */
  await page.click('#agodRunButton');
  const afterClick=await page.evaluate(()=>({
   status:document.getElementById('agodRunStatus').textContent,
   runDisabled:document.getElementById('agodRunButton').disabled,
   stopDisabled:document.getElementById('agodStopButton').disabled}));
  step('5. pressing it starts a run',afterClick);
  expect(afterClick.runDisabled===true&&afterClick.stopDisabled===false,
   'the controls did not enter the running state: '+JSON.stringify(afterClick));

  /* ---- 6. off the UI thread, and progressing ---- */
  await page.waitForFunction(()=>window.__agodEvents.some(e=>e.type==='started'),
   null,{timeout:60000});
  const startedMessage=await page.evaluate(()=>
   window.__agodEvents.find(e=>e.type==='started'));
  step('6. the worker started the real pipeline',
   {driverRevision:startedMessage.driverRevision,
    platform:startedMessage.platform,coreName:startedMessage.coreName,
    observedRamBytes:(startedMessage.capabilities||{}).observedRamBytes,
    buttonCount:((startedMessage.capabilities||{}).actionSpec||{}).buttonCount,
    memoryWrite:((startedMessage.capabilities||{}).supports||{}).memoryWrite,
    pipelineRevision:startedMessage.pipelineRevision,
    frameBudget:startedMessage.frameBudget,
    startedFrom:startedMessage.startedFrom,
    workerUrls:workerUrls.slice()});
  expect(startedMessage.pipelineRevision&&/^agod-pipeline-/.test(startedMessage.pipelineRevision),
   'the worker did not report a real FlyAgodPipeline revision: '
   +JSON.stringify(startedMessage.pipelineRevision));
  /* the driver is now the common platform driver, so the revision is asserted
     by prefix and the CAPABILITY surface is what gets checked - that the
     worker knows which platform and core it drove, and what that core can do */
  expect(/^agod-(platform|nes)-driver-/.test(startedMessage.driverRevision||''),
   'the worker did not use an app driver: '+startedMessage.driverRevision);
  expect(startedMessage.platform==='nes'&&startedMessage.coreName==='JSNES',
   'the worker did not report the platform and core it drove: '
   +startedMessage.platform+' / '+startedMessage.coreName);
  const caps=startedMessage.capabilities||{};
  expect(caps.observedRamBytes===2048,
   'the NES capability surface reports the wrong observed RAM width: '
   +caps.observedRamBytes);
  expect(caps.supports&&caps.supports.memoryWrite===true,
   'the NES capability surface should allow a memory write');
  expect(caps.actionSpec&&caps.actionSpec.buttonCount===8,
   'the NES action specification should declare 8 buttons, got '
   +(caps.actionSpec&&caps.actionSpec.buttonCount));
  /* G3. The pipeline now ASKS the driver for the action set, and the driver's
     own copy of the specification carries maskAllowed, a function. The copy
     that crosses postMessage must not, or the whole `started` message dies as
     a DataCloneError. The worker checks before posting and names the loss, so
     a null here is the assertion that nothing was lost. */
  expect(startedMessage.capabilitiesCloneError===null
   ||startedMessage.capabilitiesCloneError===undefined,
   'the capability surface did not survive postMessage: '
   +startedMessage.capabilitiesCloneError);
  expect(caps.actionSpec&&typeof caps.actionSpec.maskAllowed==='undefined'
   &&caps.actionSpec.combinationRuleAvailable===true,
   'the reported action specification should name the combination rule without '
   +'carrying the function');
  expect(caps.actionSpec&&Array.isArray(caps.actionSpec.singleButtonMasks)
   &&caps.actionSpec.singleButtonMasks.join(',')==='1,2,4,8,16,32,64,128',
   'the reported single-button masks are not the eight NES ones: '
   +JSON.stringify(caps.actionSpec&&caps.actionSpec.singleButtonMasks));
  expect(workerUrls.some(url=>/agod-worker\.js/.test(url)),
   'no agod-worker.js worker was created, so the pipeline did not run off the UI thread');

  /* the UI thread stays responsive while the pipeline runs */
  const responsive=await page.evaluate(async()=>{
   const began=performance.now();
   await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
   return performance.now()-began;
  });
  step('7. the UI thread answers while the pipeline runs',
   {animationFrameLatencyMs:Math.round(responsive)});
  expect(responsive<2000,
   'the UI thread was blocked for '+Math.round(responsive)+' ms, so the work is not off-thread');

  /* ---- 8. a real pipeline result ---- */
  await page.waitForFunction(
   ()=>window.__agodEvents.some(e=>e.type==='result'||e.type==='error'),
   null,{timeout:600000});
  const terminal=await page.evaluate(()=>
   window.__agodEvents.find(e=>e.type==='result'||e.type==='error'));
  const progressCount=await page.evaluate(()=>
   window.__agodEvents.filter(e=>e.type==='progress').length);
  const VALID=['VERIFIED','REFUSED','INDUCED','NOT-SUPPORTED','INCONCLUSIVE'];
  const pipelineStatus=terminal.type==='result'
   ?((terminal.dto&&terminal.dto.status)
     ||(terminal.summary&&terminal.summary.status)||null):null;
  step('8. a valid pipeline result came back',
   {terminalType:terminal.type,pipelineStatus,
    stage:terminal.dto?terminal.dto.stage:null,
    reason:terminal.dto?String(terminal.dto.reason||'').slice(0,200):null,
    schemaVersion:terminal.dto?terminal.dto.schemaVersion:null,
    pipelineRevision:terminal.pipelineRevision||null,
    dtoRevision:terminal.dtoRevision||null,
    dtoCloneable:terminal.dtoCloneable,
    dtoCloneError:terminal.dtoCloneError||null,
    rewardMechanismExcluded:terminal.dto?terminal.dto.rewardMechanismExcluded:null,
    discoveredKeys:terminal.dto&&terminal.dto.discovered
     ?Object.keys(terminal.dto.discovered):null,
    traceStages:terminal.dto&&terminal.dto.trace
     ?terminal.dto.trace.map(t=>t.stage):null,
    cost:terminal.cost||null,
    progressMessages:progressCount,
    error:terminal.error||null});
  expect(terminal.type==='result',
   'the run did not produce a pipeline result: '+JSON.stringify(terminal.error||terminal));
  expect(VALID.includes(pipelineStatus),
   'the pipeline status is not one of the declared outcomes: '+pipelineStatus);
  expect(terminal.dto&&terminal.dto.pipelineRevision
   &&/^agod-pipeline-/.test(terminal.dto.pipelineRevision),
   'the DTO does not carry a real pipeline revision');
  expect(terminal.dto&&Array.isArray(terminal.dto.trace)&&terminal.dto.trace.length>0,
   'the DTO has no pipeline trace, so no stage actually ran');
  /* the defect this guards: a function anywhere would have thrown DataCloneError */
  expect(terminal.dtoCloneable!==false,
   'the worker reported its own payload as unclonable: '+terminal.dtoCloneError);
  expect(terminal.dto&&terminal.dto.rewardMechanismExcluded===true,
   'the DTO does not declare the reward mechanism excluded');
  expect(terminal.dto&&!('broker' in terminal.dto)&&!('registry' in terminal.dto)
   &&!('readResource' in terminal.dto),
   'the DTO carried the executable mechanism across the worker boundary');
  expect(terminal.cost&&terminal.cost.framesRun>1000,
   'too few frames were emulated for a real run: '
   +JSON.stringify(terminal.cost&&terminal.cost.framesRun));
  expect(progressCount>0,'no progress was reported, so the budget could not be shown');
  /* VERIFIED must come from the pipeline, never from the interface */
  if(pipelineStatus==='VERIFIED')
   expect(!!(terminal.dto.goal&&terminal.dto.goal.id&&terminal.dto.actions),
    'VERIFIED was reported without a goal identity and actions');

  /* ---- 9. the panel shows it ---- */
  const panel=await page.evaluate(()=>({
   status:document.getElementById('agodRunStatus').textContent,
   result:document.getElementById('agodRunResult').textContent,
   budget:document.getElementById('agodRunBudget').textContent,
   candidates:document.getElementById('agodRunCandidates').textContent,
   record:window.agodRunPanel.record()?{
    status:window.agodRunPanel.record().dto?window.agodRunPanel.record().dto.status:null,
    validated:window.agodRunPanel.record().validated
     ?window.agodRunPanel.record().validated.valid:null,
    problems:window.agodRunPanel.record().validated
     ?window.agodRunPanel.record().validated.problems:null}:null}));
  step('9. the interface displays the result',panel);
  expect(panel.result.includes(pipelineStatus),
   'the panel does not show the pipeline status "'+pipelineStatus+'": '+panel.result);
  expect(/\d+\s+из\s+\d+\s+кадров/.test(panel.budget),
   'the panel does not show the frame budget spend: '+panel.budget);
  /* G3: the operator can see WHAT was driven and read, from the platform
     rather than from a NES-shaped default baked into the pipeline */
  expect(/8 кнопок/.test(panel.budget)&&/RAM 2048 Б/.test(panel.budget),
   'the panel does not state the platform action set and RAM width: '+panel.budget);
  expect(!/VERIFIED/.test(panel.result)||pipelineStatus==='VERIFIED',
   'the panel showed VERIFIED when the pipeline did not return it');
  expect(/запись цели/.test(panel.result),
   'the panel does not report whether the goal record validated: '+panel.result);
  expect(panel.record&&panel.record.validated===true,
   'the panel holds no validated goal record: '+JSON.stringify(panel.record));

  /* ---- 10. the live game is untouched ---- */
  const liveAfter=await page.evaluate(()=>({
   ram:window.FlyAgodNesDriver.ramHash(nes.cpu.mem.slice(0,0x800)),
   fullState:JSON.stringify(nes.toJSON())}));
  const panelLive=await page.evaluate(()=>
   document.getElementById('agodRunBudget').textContent);
  step('10. the live game state is unchanged by the research run',
   {ramHashBefore:liveBefore.ram,ramHashAfter:liveAfter.ram,
    fullStateShaBefore:sha(liveBefore.fullState),
    fullStateShaAfter:sha(liveAfter.fullState),
    identical:liveBefore.ram===liveAfter.ram
     &&sha(liveBefore.fullState)===sha(liveAfter.fullState),
    panelWording:panelLive,
    note:'this page is not running the emulator loop, so the live core does not '
     +'advance and the two states ARE comparable. The panel states that '
     +'condition rather than claiming interference whenever a hash differs.'});
  /* the corrected diagnostic must never say «ИЗМЕНЕНА» on its own */
  expect(!/ИЗМЕНЕНА/.test(panelLive),
   'the panel still reports the live game as changed: '+panelLive);
  expect(liveBefore.ram===liveAfter.ram,
   'the research run changed the live RAM: '+liveBefore.ram+' -> '+liveAfter.ram);
  expect(sha(liveBefore.fullState)===sha(liveAfter.fullState),
   'the research run changed the live serialised console state');

  /* ---- 11. stopping releases the worker ---- */
  await page.evaluate(()=>{window.__agodEvents=[];});
  await page.click('#agodRunButton');
  await page.waitForFunction(()=>window.__agodEvents.some(e=>e.type==='started'),
   null,{timeout:60000});
  const workersBefore=workerUrls.length;
  await page.click('#agodStopButton');
  const stopped=await page.evaluate(()=>({
   status:document.getElementById('agodRunStatus').textContent,
   result:document.getElementById('agodRunResult').textContent,
   runDisabled:document.getElementById('agodRunButton').disabled,
   stopDisabled:document.getElementById('agodStopButton').disabled,
   running:window.agodRunPanel.running()}));
  /* a terminated worker produces no further messages */
  const before=await page.evaluate(()=>window.__agodEvents.length);
  await page.waitForTimeout(3000);
  const after=await page.evaluate(()=>window.__agodEvents.length);
  step('11. stopping terminates the worker and releases the controls',
   {...stopped,workersCreated:workersBefore,
    messagesAtStop:before,messagesThreeSecondsLater:after,
    noFurtherMessages:before===after});
  expect(stopped.runDisabled===false&&stopped.stopDisabled===true&&stopped.running===false,
   'the controls did not return to the stopped state: '+JSON.stringify(stopped));
  expect(before===after,
   'the worker kept sending messages after being stopped: '+before+' -> '+after);

  /* ---- 12. THE POSITIVE PATH: Real Pipeline -> VERIFIED -> Worker -> UI ----
     The embedded cartridge is a UI diagnostic fixture and can only ever
     produce REFUSED, so the branch that carries functions across the worker
     boundary had never been exercised in the app. An MIT AGOD fixture with a
     real decreasing resource is generated locally for this step.

     It runs on a FRESH PAGE rather than by swapping cartridges: labLoadRom
     returns false for a second call once a cartridge is committed, which is
     the app's own behaviour and not something a test should work around. An
     earlier version of this step ignored that - `loaded` was already true, so
     the wait returned at once and the run used the PREVIOUS ROM, reporting
     REFUSED with the previous cartridge's exact frame count. A positive claim
     about the wrong cartridge is precisely the kind of pass this directive
     forbids, so the swap attempt is kept below as its own observation. */
  const swapRefused=await page.evaluate(async data=>{
   const out=await window.labLoadRom(data);
   return {returned:out,romHashStillFirst:romHash};
  },{base64:demo.base64,name:'swap attempt',sha256:'swap-attempt'});
  step('12a. the app refuses to swap a committed cartridge',
   {...swapRefused,
    note:'recorded, not worked around. The positive path therefore runs on a '
     +'fresh page with the fixture as the first cartridge.'});

  const work=fs.mkdtempSync(path.join(os.tmpdir(),'gu-e2e-'));
  const fixtureJson=path.join(work,'fixture.json');
  execFileSync(process.env.PYTHON||'python3',
   ['tools/make_agod_test_rom.py','--seed','0','--out',fixtureJson]);
  const fixture=JSON.parse(fs.readFileSync(fixtureJson));
  /* the cartridge's REAL SHA-256, as the app computes it for an imported ROM.
     An objective profile binds to it and refuses anything that is not one. */
  const fixtureSha=crypto.createHash('sha256')
   .update(Buffer.from(fixture.base64,'base64')).digest('hex');
  const positivePage=await openPage();
  await prepare(positivePage,fixture.base64,
   'AGOD positive fixture (MIT, generated locally)',fixtureSha);
  const loadedFixture=await positivePage.evaluate(()=>({romHash,
   romBytes:nes&&nes.romData?nes.romData.length:0}));
  expect(loadedFixture.romHash===fixtureSha,
   'the fixture is not the cartridge in the page: '+loadedFixture.romHash);
  const liveBeforePositive=await positivePage.evaluate(()=>
   window.FlyAgodNesDriver.ramHash(nes.cpu.mem.slice(0,0x800)));
  await positivePage.click('#agodRunButton');
  await positivePage.waitForFunction(
   ()=>window.__agodEvents.some(e=>e.type==='result'||e.type==='error'),
   null,{timeout:900000});
  const positive=await positivePage.evaluate(()=>
   window.__agodEvents.find(e=>e.type==='result'||e.type==='error'));
  const positivePanel=await positivePage.evaluate(()=>({
   result:document.getElementById('agodRunResult').textContent,
   budget:document.getElementById('agodRunBudget').textContent,
   candidates:document.getElementById('agodRunCandidates').textContent,
   record:window.agodRunPanel.record()}));
  const positiveStatus=positive.type==='result'
   ?((positive.dto&&positive.dto.status)||null):null;
  const liveAfterPositive=await positivePage.evaluate(()=>
   window.FlyAgodNesDriver.ramHash(nes.cpu.mem.slice(0,0x800)));
  step('12. the positive path: a real VERIFIED reaches the interface as a validated goal record',
   {pipelineStatus:positiveStatus,
    romHashInPage:loadedFixture.romHash,romBytesInPage:loadedFixture.romBytes,
    dtoCloneable:positive.dtoCloneable,dtoCloneError:positive.dtoCloneError||null,
    goalId:positive.dto&&positive.dto.goal?positive.dto.goal.id:null,
    lifecycle:positive.dto&&positive.dto.goal?positive.dto.goal.lifecycle:null,
    polarity:positive.dto&&positive.dto.goal?positive.dto.goal.polarity:null,
    addressSpec:positive.dto?positive.dto.resource:null,
    evidenceRecords:positive.dto&&positive.dto.evidence&&positive.dto.evidence.registryState
     ?positive.dto.evidence.registryState.records.length:null,
    evidenceRefs:positive.dto&&positive.dto.evidence
     ?positive.dto.evidence.evidenceRefs.length:null,
    provenance:positive.dto?positive.dto.provenance:null,
    rewardMechanismExcluded:positive.dto?positive.dto.rewardMechanismExcluded:null,
    recordValidated:positivePanel.record&&positivePanel.record.validated
     ?positivePanel.record.validated.valid:null,
    recordProblems:positivePanel.record&&positivePanel.record.validated
     ?positivePanel.record.validated.problems:null,
    panelResult:positivePanel.result,panelBudget:positivePanel.budget,
    cost:positive.cost||null,
    liveRamBefore:liveBeforePositive,liveRamAfter:liveAfterPositive,
    error:positive.error||null});
  expect(positive.type==='result',
   'the positive run failed: '+JSON.stringify(positive.error||positive));
  expect(positiveStatus==='VERIFIED',
   'the AGOD fixture did not reach VERIFIED through the app: '+positiveStatus
   +' / '+String((positive.dto&&positive.dto.reason)||'').slice(0,160));
  expect(positive.dtoCloneable!==false,
   'the VERIFIED payload did not survive structuredClone: '+positive.dtoCloneError);
  expect(!!(positive.dto&&positive.dto.goal&&positive.dto.goal.id
   &&positive.dto.goal.lifecycle==='VERIFIED'
   &&['POSITIVE','NEGATIVE'].includes(positive.dto.goal.polarity)),
   'the VERIFIED DTO lacks a complete goal identity: '
   +JSON.stringify(positive.dto&&positive.dto.goal));
  expect(!!(positive.dto&&positive.dto.resource
   &&Number.isInteger(positive.dto.resource.address)
   &&Number.isInteger(positive.dto.resource.width)),
   'the VERIFIED DTO lacks an address specification');
  expect(!!(positive.dto&&positive.dto.resource
   &&positive.dto.resource.encodingDetermined!==null),
   'the VERIFIED DTO does not say whether the field encoding was determined');
  expect(!!(positive.dto&&positive.dto.evidence
   &&positive.dto.evidence.registryState
   &&positive.dto.evidence.registryState.records.length>0
   &&positive.dto.evidence.evidenceRefs.length>0),
   'the VERIFIED DTO carries no evidence source');
  expect(!!(positive.dto&&!('broker' in positive.dto)&&!('registry' in positive.dto)
   &&!('readResource' in positive.dto)),
   'the VERIFIED DTO carried the executable mechanism across the boundary');
  expect(!!(positivePanel.record&&positivePanel.record.validated
   &&positivePanel.record.validated.valid===true),
   'the interface did not validate the VERIFIED goal record: '
   +JSON.stringify(positivePanel.record&&positivePanel.record.validated));
  expect(/VERIFIED/.test(positivePanel.result),
   'the panel does not show VERIFIED: '+positivePanel.result);
  expect(liveBeforePositive===liveAfterPositive,
   'the positive run changed the live RAM: '+liveBeforePositive+' -> '+liveAfterPositive);

  /* ---- 14. L1 in the app: the verified result becomes the reward source ----
     The same functions lab.js runs on every decision are called here on the
     page's own live core: fdbRewardSnapshot before and after a real button
     press, then fdbOutcomeReward. No RAM address is typed anywhere. */
  const l1=await positivePage.evaluate(async()=>{
   const objective=window.agodObjective.status();
   const mode=document.getElementById('rewardMode').value;
   const dto=window.agodRunPanel.record().dto;
   const cost=dto.actions.cost,press=mask=>{
    for(let b=0;b<8;b++)(mask&(1<<b)?nes.buttonDown:nes.buttonUp).call(nes,1,b);
    for(let i=0;i<4;i++)nes.frame();
    for(let b=0;b<8;b++)nes.buttonUp(1,b);
    for(let i=0;i<8;i++)nes.frame();};
   const snap=()=>fdbRewardSnapshot(sampleRewardMemory());
   const interval=(mask,valid)=>{const rewardStart=snap();press(mask);frame+=12;
    return {rewardStart,rewardEnd:snap(),mask,frames:12,valid};};
   /* the aggressive tier first, on a fresh interval: the effect action raises
      the field the game destroys on reversal */
   const gain=fdbOutcomeReward(interval(dto.actions.effect,true),0);
   const loss=interval(cost,true);
   const paid=fdbOutcomeReward(loss,0);
   const again=fdbOutcomeReward(loss,0);
   const idle=fdbOutcomeReward(interval(0,true),0);
   const overridden=fdbOutcomeReward(interval(cost,false),0);
   const before=window.agodObjective.status().counts;
   window.agodObjective.revoke('e2e: withdrawn');
   const afterRevoke=fdbOutcomeReward(interval(cost,true),0);
   let autonomous=null;
   try{document.getElementById('rewardMode').value='agod';}catch(_){}
   return {objective,mode,cost,resourceBefore:loss.rewardStart.value,resourceAfter:loss.rewardEnd.value,
    gain,paid,again,idle,overridden,afterRevoke,counts:before,
    stored:Object.keys(localStorage).filter(k=>k.startsWith('gu.agod.objective')).length,
    panel:document.getElementById('agodRunResult').textContent,
    status:document.getElementById('agodRunStatus').textContent};
  });
  step('14. L1 in the app: a verified objective pays through the app reward path',l1);
  expect(l1.objective.state==='VERIFIED','the live objective is not VERIFIED: '+JSON.stringify(l1.objective));
  expect(l1.mode==='agod','the reward source was not switched from manual to agod: '+l1.mode);
  expect(/Подтверждено/.test(l1.status),'the indicator does not say Подтверждено: '+l1.status);
  expect(l1.resourceAfter===l1.resourceBefore-1,'the cost action did not lower the discovered resource on the live core: '
   +l1.resourceBefore+' -> '+l1.resourceAfter);
  expect(l1.objective.policy==='aggressive'&&l1.objective.progressFields>=1,
   'the app does not run the aggressive policy with a progress field: '+JSON.stringify(l1.objective));
  expect(l1.gain.valid===true&&l1.gain.reward>0&&l1.gain.reward<1&&l1.gain.tier==='PROVISIONAL',
   'a rise in the progress field did not pay as PROVISIONAL below a verified loss: '+JSON.stringify(l1.gain));
  expect(l1.paid.tier==='VERIFIED','the loss was not paid on the verified tier: '+JSON.stringify(l1.paid));
  expect(l1.paid.valid===true&&l1.paid.reward===-1,'the verified loss did not pay -1: '+JSON.stringify(l1.paid));
  expect(l1.again.valid===false&&l1.again.reward===0,'the same event paid twice: '+JSON.stringify(l1.again));
  expect(l1.idle.valid===false,'an interval with no event was reported as known: '+JSON.stringify(l1.idle));
  expect(l1.overridden.valid===false,'an invalid (interrupted) interval was paid: '+JSON.stringify(l1.overridden));
  expect(l1.afterRevoke.valid===false,'a revoked objective still paid: '+JSON.stringify(l1.afterRevoke));
  expect(l1.stored===1,'the objective was not stored for this cartridge: '+l1.stored);

  /* ---- 13. the negative control, kept as a control only ---- */
  const negative=await page.evaluate(()=>{
   const out=window.FlyAgodExperimental.session(null);
   return {status:out.status,reason:String(out.reason||'').slice(0,120)};
  });
  step('13. negative control: session(null) still refuses',
   {...negative,
    note:'kept as a control. This alone was the previous check and is NOT evidence '
     +'that AGOD runs; steps 5 to 11 are.'});
  expect(negative.status==='DISABLED'||negative.status==='NOT-LOADED'
   ||negative.status==='REFUSED',
   'session(null) did not refuse: '+JSON.stringify(negative));

  /* ---- 15. discovery follows the game ----
     A cartridge whose boot state gives discovery nothing. With background
     discovery on, the first run starts by itself and does not verify. A retry
     must NOT fire while the live game stands still, and MUST fire once it has
     advanced - from the state the game is in now. */
  const seqJson=path.join(work,'sequence.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_sequence_rom.py','--out',seqJson]);
  const seq=JSON.parse(fs.readFileSync(seqJson));
  const followPage=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  followPage.on('pageerror',error=>pageErrors.push(error.message));
  await followPage.addInitScript(()=>{window.GU_AGOD_AUTOSTART=true;window.GU_AGOD_RETRY_SECONDS=2;});
  await followPage.route('https://flyconsole.local/**',async route=>{
   const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type=file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json'
    :file.endsWith('.css')?'text/css':'text/html';
   return route.fulfill({status:200,contentType:type,body:fs.readFileSync(file)});
  });
  await followPage.goto('https://flyconsole.local/lab/index.html');
  await followPage.waitForFunction(()=>typeof window.labLoadRom==='function',null,{timeout:60000});
  await followPage.evaluate(data=>window.labLoadRom(data),{base64:seq.base64,
   name:'AGOD sequence fixture (MIT, generated locally)',
   sha256:crypto.createHash('sha256').update(Buffer.from(seq.base64,'base64')).digest('hex')});
  await followPage.waitForFunction(()=>loaded===true,null,{timeout:60000});
  const defaultMode=await followPage.evaluate(()=>document.getElementById('rewardMode').value);
  const statusOf=()=>followPage.evaluate(()=>document.getElementById('agodRunStatus').textContent);
  /* first run: starts by itself, ends without a verified goal */
  await followPage.waitForFunction(()=>/Недостаточно данных/.test(document.getElementById('agodRunStatus').textContent),
   null,{timeout:300000});
  const afterFirst=await statusOf();
  await followPage.waitForTimeout(7000);          /* well past the 2 s retry delay */
  const stillWaiting=await statusOf();
  /* now the game moves */
  await followPage.evaluate(()=>{for(let i=0;i<120;i++)nes.frame();frame+=120;});
  await followPage.waitForFunction(()=>/попытка 2/.test(document.getElementById('agodRunStatus').textContent)
   ||/попытка 2/.test(window.__lastAgodPhase||''),null,{timeout:60000}).catch(()=>{});
  const afterAdvance=await statusOf();
  const objective=await followPage.evaluate(()=>window.agodObjective.status());
  step('15. discovery follows the game',{defaultMode,afterFirst,stillWaiting,afterAdvance,objective});
  expect(defaultMode==='agod','an imported cartridge does not default to the automatic reward source: '+defaultMode);
  expect(/Недостаточно данных/.test(afterFirst),'background discovery did not start and finish by itself: '+afterFirst);
  expect(!/попытка 2/.test(stillWaiting),'a retry fired although the live game had not advanced: '+stillWaiting);
  expect(/попытка 2|Недостаточно данных/.test(afterAdvance)&&afterAdvance!==stillWaiting||/попытка 2/.test(afterAdvance),
   'no second attempt after the game advanced: '+afterAdvance);
  expect(objective.state!=='VERIFIED','a cartridge with no single-action goal was given an objective: '+JSON.stringify(objective));
  await followPage.close();

  report.pageErrors=pageErrors.slice();
  expect(pageErrors.length===0,'the page reported errors: '+pageErrors.join(' | '));
 }catch(error){
  failures.push('the check threw: '+error.message);
  report.threw={message:error.message,stack:String(error.stack||'').split('\n').slice(0,6)};
 }finally{
  await browser.close();
 }

 report.totals={steps:steps.length,failures:failures.length};
 report.failures=failures;
 report.status=failures.length===0?'PASS':'FAIL';
 save();
 console.log(JSON.stringify({type:report.type,status:report.status,
  totals:report.totals,
  steps:steps.map(s=>s.name),
  pipelineStatus:(steps.find(s=>/valid pipeline result/.test(s.name))||{}).pipelineStatus||null,
  positivePath:(()=>{const p=steps.find(s=>/positive path/.test(s.name))||{};
   return {pipelineStatus:p.pipelineStatus||null,goalId:p.goalId||null,
    lifecycle:p.lifecycle||null,polarity:p.polarity||null,
    addressSpec:p.addressSpec||null,evidenceRecords:p.evidenceRecords||null,
    recordValidated:p.recordValidated===undefined?null:p.recordValidated,
    dtoCloneable:p.dtoCloneable===undefined?null:p.dtoCloneable,
    cost:p.cost||null};})(),
  cost:(steps.find(s=>/valid pipeline result/.test(s.name))||{}).cost||null,
  liveStateIdentical:(steps.find(s=>/live game state is unchanged/.test(s.name))||{}).identical,
  failures},null,1));
 if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
})();
