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
      crypto=require('node:crypto');
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
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 const pageErrors=[],workerUrls=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('worker',worker=>workerUrls.push(worker.url()));
 await page.route('https://flyconsole.local/**',async route=>{
  const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const type=file.endsWith('.js')?'application/javascript'
   :file.endsWith('.json')?'application/json'
   :file.endsWith('.css')?'text/css':'text/html';
  await route.fulfill({contentType:type,body:fs.readFileSync(file)});
 });

 try{
  /* ---- 1. the real interface ---- */
  await page.goto('https://flyconsole.local/lab/index.html');
  step('1. the real GU interface loads',{pageErrors:pageErrors.slice()});

  /* ---- 2. the embedded synthetic cartridge ---- */
  await page.evaluate(data=>window.labLoadRom(data),
   {base64:demo.base64,name:demo.name,sha256:'e2e-'+sha(demo.base64).slice(0,32)});
  await page.waitForFunction(()=>loaded===true,null,{timeout:30000});
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
  await page.evaluate(()=>{
   /* The route a person takes. Two things had to be established by looking
      rather than guessing: showTab() alone leaves the console-home shell in
      place so the enclosing <section class="panel tab-panel"> stays hidden,
      and <details id="trainingResearch"> is on the LEARNING page, not the
      research one, despite its name - which is also where the existing
      passive-observer toggle lives. */
   window.consoleNavigation.go('legacy-learning');
   const section=document.getElementById('trainingResearch');
   if(section&&!section.open)section.open=true;
  });
  await page.waitForSelector('#agodRunButton',{state:'visible',timeout:30000});
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

  /* Collect the worker's own messages, so the test reads what the worker said
     rather than only what the panel rendered. */
  await page.evaluate(()=>{
   window.__agodEvents=[];
   const original=window.FlyAgodExperimental.runInWorker;
   window.FlyAgodExperimental.runInWorker=request=>original({...request,
    onEvent(message){window.__agodEvents.push(message);
     if(request&&typeof request.onEvent==='function')request.onEvent(message);}});
  });
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
    pipelineRevision:startedMessage.pipelineRevision,
    frameBudget:startedMessage.frameBudget,
    startedFrom:startedMessage.startedFrom,
    workerUrls:workerUrls.slice()});
  expect(startedMessage.pipelineRevision&&/^agod-pipeline-/.test(startedMessage.pipelineRevision),
   'the worker did not report a real FlyAgodPipeline revision: '
   +JSON.stringify(startedMessage.pipelineRevision));
  expect(startedMessage.driverRevision==='agod-nes-driver-1',
   'the worker did not use the app driver: '+startedMessage.driverRevision);
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
  const pipelineStatus=terminal.type==='result'&&terminal.result
   ?terminal.result.status:null;
  step('8. a valid pipeline result came back',
   {terminalType:terminal.type,pipelineStatus,
    stage:terminal.result?terminal.result.stage:null,
    reason:terminal.result?String(terminal.result.reason||'').slice(0,200):null,
    schemaVersion:terminal.result?terminal.result.schemaVersion:null,
    pipelineRevision:terminal.pipelineRevision||null,
    discoveredKeys:terminal.result&&terminal.result.discovered
     ?Object.keys(terminal.result.discovered):null,
    traceStages:terminal.result&&terminal.result.trace
     ?terminal.result.trace.map(t=>t.stage):null,
    cost:terminal.cost||null,
    progressMessages:progressCount,
    error:terminal.error||null});
  expect(terminal.type==='result',
   'the run did not produce a pipeline result: '+JSON.stringify(terminal.error||terminal));
  expect(VALID.includes(pipelineStatus),
   'the pipeline status is not one of the declared outcomes: '+pipelineStatus);
  expect(terminal.result&&terminal.result.pipelineRevision
   &&/^agod-pipeline-/.test(terminal.result.pipelineRevision),
   'the result does not carry a real pipeline revision');
  expect(terminal.result&&Array.isArray(terminal.result.trace)&&terminal.result.trace.length>0,
   'the result has no pipeline trace, so no stage actually ran');
  expect(terminal.cost&&terminal.cost.framesRun>1000,
   'too few frames were emulated for a real run: '
   +JSON.stringify(terminal.cost&&terminal.cost.framesRun));
  expect(progressCount>0,'no progress was reported, so the budget could not be shown');
  /* VERIFIED must come from the pipeline, never from the interface */
  if(pipelineStatus==='VERIFIED')
   expect(!!(terminal.result.goal&&terminal.result.actions),
    'VERIFIED was reported without a goal and actions, which the pipeline always supplies');

  /* ---- 9. the panel shows it ---- */
  const panel=await page.evaluate(()=>({
   status:document.getElementById('agodRunStatus').textContent,
   result:document.getElementById('agodRunResult').textContent,
   budget:document.getElementById('agodRunBudget').textContent,
   candidates:document.getElementById('agodRunCandidates').textContent}));
  step('9. the interface displays the result',panel);
  expect(panel.result.includes(pipelineStatus),
   'the panel does not show the pipeline status "'+pipelineStatus+'": '+panel.result);
  expect(/\d+\s+из\s+\d+\s+кадров/.test(panel.budget),
   'the panel does not show the frame budget spend: '+panel.budget);
  expect(!/VERIFIED/.test(panel.result)||pipelineStatus==='VERIFIED',
   'the panel showed VERIFIED when the pipeline did not return it');

  /* ---- 10. the live game is untouched ---- */
  const liveAfter=await page.evaluate(()=>({
   ram:window.FlyAgodNesDriver.ramHash(nes.cpu.mem.slice(0,0x800)),
   fullState:JSON.stringify(nes.toJSON())}));
  step('10. the live game state is unchanged by the research run',
   {ramHashBefore:liveBefore.ram,ramHashAfter:liveAfter.ram,
    fullStateShaBefore:sha(liveBefore.fullState),
    fullStateShaAfter:sha(liveAfter.fullState),
    identical:liveBefore.ram===liveAfter.ram
     &&sha(liveBefore.fullState)===sha(liveAfter.fullState)});
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

  /* ---- 12. the negative control, kept as a control only ---- */
  const negative=await page.evaluate(()=>{
   const out=window.FlyAgodExperimental.session(null);
   return {status:out.status,reason:String(out.reason||'').slice(0,120)};
  });
  step('12. negative control: session(null) still refuses',
   {...negative,
    note:'kept as a control. This alone was the previous check and is NOT evidence '
     +'that AGOD runs; steps 5 to 11 are.'});
  expect(negative.status==='DISABLED'||negative.status==='NOT-LOADED'
   ||negative.status==='REFUSED',
   'session(null) did not refuse: '+JSON.stringify(negative));

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
  cost:(steps.find(s=>/valid pipeline result/.test(s.name))||{}).cost||null,
  liveStateIdentical:(steps.find(s=>/live game state is unchanged/.test(s.name))||{}).identical,
  failures},null,1));
 if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
})();
