'use strict';
// Actual NES/MD cores and durable human archives; native FDB replies are protocol fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:412,height:915},hasTouch:true,isMobile:true}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://flyconsole.local/**',route=>{
  const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
  return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':'text/html'});
 });
 await page.exposeFunction('teachingDemo',system=>{
  const data=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));
  data.name='Teaching panel protocol fixture';data.sha256=crypto.createHash('sha256').update(Buffer.from(data.base64,'base64')).digest('hex');
  return page.evaluate(data=>labLoadRom(data),data);
 });
 await page.addInitScript(()=>{
  window.teachingSamples=[];window.teachingFeedback=[];window.teachingDelay=4;window.teachingBindDelay=2;window.teachingHoldBind=false;window.teachingHoldSample=false;window.teachingConfiguration=null;window.teachingFdb=null;window.teachingConnectCalls=[];
  window.FlyBridge={orientation(){},acceptRom(){},stop(){},resume(){},controls(){},gameDisplay(){},demo:()=>teachingDemo(new URL(location.href).searchParams.get('system')||'nes'),
   configure(raw){const q=JSON.parse(raw);teachingConfiguration=q;teachingFdb=q.fdb;setTimeout(()=>labConfigured({generation:q.generation,reset:q.reset,configVersion:1,mode:q.mode,backend:q.backend}),2);},
   sample(raw){const q=JSON.parse(raw);teachingSamples.push(q);const delay=teachingDelay;window.teachingPendingDelay=delay;const reply=()=>{
    if(teachingFdb?.learning){const state=teachingFdb.learningState||{version:1,sources:teachingConfiguration.inputs,targets:teachingConfiguration.outputs,observations:0,human:0,automatic:0};
     if(!q.frozen&&['teach','train'].includes(q.learningMode))for(const e of q.experience){state.observations++;state[e.human?'human':'automatic']++;}teachingFdb.learningState=state;}
    labResult({generation:q.generation,token:q.token,sequence:teachingSamples.length,buttons:1,outputs:new Array(buttonNames.length).fill(1),spikes:1,active:1,wallMs:delay,simMs:20,steps:200,backend:'cpu',neuralGroups:[],...(teachingFdb?{fdbState:JSON.parse(JSON.stringify(teachingFdb))}:{}),...(q.controllerSource==='exo'&&q.learningMode!=='teach'?{fdbDecision:{id:q.generation+':'+q.token,mask:1}}:{})});
   };if(teachingHoldSample){window.teachingReleaseSample=()=>{teachingHoldSample=false;reply();};}else setTimeout(reply,delay);},
   fdbFeedback(raw){const q=JSON.parse(raw);teachingFeedback.push(q);const reply=()=>labFdbFeedback({token:q.token,data:q.op==='bind'?{bound:true,layerId:q.layerId,configVersion:q.configVersion}:{changed:0,fdbState:JSON.parse(JSON.stringify(teachingFdb)),memoryBytes:4096}});if(q.op==='bind'&&teachingHoldBind){window.teachingReleaseBind=()=>{teachingHoldBind=false;reply();};}else setTimeout(reply,q.op==='bind'?teachingBindDelay:2);}
  };
 });
 const open=async()=>{await page.click('#gameAgentToggle');await page.waitForFunction(()=>$('agentQuickPanel').open);};
 const idle=async()=>page.waitForFunction(()=>$('agentQuickPanel').open&&!$('agentQuickRec').disabled);
 const closed=async()=>page.waitForFunction(()=>!$('agentQuickPanel').open);
 const humanTotals=()=>page.evaluate(()=>({accepted:learner.demonstrations,submitted:teachingSamples.flatMap(q=>q.experience).filter(e=>e.human).length,queue:fdbExperience.length,frame,restarts:emulatorRestarts}));
 for(const system of ['nes','sega']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>window.consoleNavigation&&loaded&&!romLoading);
  await page.evaluate(async()=>{labReady({modelId:'flywire-v783',kind:'teaching-panel-fixture',neurons:32,edges:64,heapMiB:512,graph_sha256:'d'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'});await labState.settle();const original=connectBrain;connectBrain=function(restoreStart=true){teachingConnectCalls.push(restoreStart);return original(restoreStart);};$('rewardMode').value='manual';});
  await page.click('#navResume');await page.waitForFunction(()=>playing&&frame>10);await page.evaluate(()=>learningUI.rate(5));
  await open();await idle();for(const id of ['agentQuickRec','agentQuickAssist','agentQuickNetwork'])assert(await page.locator('#'+id).isVisible(),id+' is available in the compact panel');
  await page.evaluate(()=>{teachingHoldBind=true;});
  await page.click('#agentQuickRec');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');
  assert.equal(await page.evaluate(()=>emulationRate),1,'REC uses ordinary human game time');assert.equal(await page.evaluate(()=>brainMask),0,'REC records human control without neural action');
  // A pending durable Current handshake must keep yielding to its ACK while draining teaching labels.
  await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>learner.demonstrations>=1&&window.labCurrentPending&&fdbExperience.length>0&&typeof teachingReleaseBind==='function');await open();await page.keyboard.up('ArrowRight');await page.evaluate(()=>labBack());assert(await page.evaluate(()=>$('agentQuickPanel').open&&!playing),'Back defers dismissal until the pending teaching flush is durable');await page.evaluate(()=>teachingReleaseBind());await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');await open();await idle();
  const currentPending=await humanTotals();assert.equal(currentPending.submitted,currentPending.accepted,'teaching pause waits for Current readiness and submits the executed label');await page.evaluate(()=>{teachingBindDelay=2;});await page.click('#agentQuickClose');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');
  const recBase=await page.evaluate(()=>learner.demonstrations);await page.evaluate(()=>{teachingDelay=350;});await page.keyboard.down('ArrowRight');await page.waitForFunction(n=>learner.demonstrations>=n+3&&pendingToken!==null&&fdbExperience.length>0,recBase);
  const beforePause=await humanTotals();await open();await page.waitForFunction(()=>!playing);const pausedFrame=await page.evaluate(()=>frame);await page.keyboard.up('ArrowRight');await idle();
  assert.equal(await page.evaluate(()=>frame),pausedFrame,'safe teaching flush never advances the real game');assert.equal(await page.evaluate(()=>playing||connected),false,'teaching pause completes before controls are enabled');
  const paused=await humanTotals();assert(paused.accepted>=beforePause.accepted);assert.equal(paused.submitted,paused.accepted,'opening the panel submits every executed REC label exactly once, including the partial tail');assert.equal(paused.queue,0);
  assert(await page.locator('#agentQuickStop').isVisible(),'STOP remains available after pausing REC');assert.match(await page.textContent('#agentQuickStop'),/STOP/i);
  const archive=await page.evaluate(async()=>(await humanTeaching.store.request('list')).filter(s=>s.system===labPlatform&&s.romHash===romHash&&s.graphSha256===graphIdentity.sha256));assert(archive.length&&archive.every(s=>s.status==='closed'),'the paused recording has a closed durable archive');assert.equal(archive.reduce((n,s)=>n+s.accepted,0),paused.accepted);
  await page.click('#agentQuickClose');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');
  await page.keyboard.down('ArrowLeft');await page.waitForFunction(n=>learner.demonstrations>n+1,paused.accepted);await page.keyboard.up('ArrowLeft');await open();await idle();const stopTotals=await humanTotals();
  await page.click('#agentQuickStop');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='auto');
  const stopped=await humanTotals();assert.equal(stopped.submitted,stopped.accepted,'STOP flushes labels once without replaying the recording');assert.equal(stopped.accepted,stopTotals.accepted);assert.equal(stopped.restarts,stopTotals.restarts);assert(stopped.frame>=stopTotals.frame,'STOP continues from the displayed frame');
  assert.equal(await page.evaluate(()=>teachingFeedback.filter(q=>q.op==='reward').length),0,'unknown feedback does not become a fabricated reward');assert.equal(await page.evaluate(()=>rewardPending),0,'ordinary human buttons do not award positive reward');
  await page.evaluate(()=>{teachingDelay=4;});await open();await idle();await page.click('#agentQuickAssist');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='assist');
  const hintBase=await page.evaluate(()=>learner.demonstrations);await page.keyboard.down('ArrowUp');await page.waitForFunction(n=>learner.demonstrations>n,hintBase);assert.equal(await page.evaluate(()=>appliedAgentMask),16,'streaming hints replace the agent action with executed human input');await page.keyboard.up('ArrowUp');
  await open();await idle();const hinted=await humanTotals();assert.equal(hinted.submitted,hinted.accepted,'executed hints and their tail reach FDB exactly once');assert(await page.evaluate(()=>teachingSamples.some(q=>q.learningMode==='train'&&q.experience.some(e=>e.human&&e.mask===16))));
  const modeBefore=await page.evaluate(()=>({mode:$('learnMode').value,hints:$('liveHints').checked}));await page.click('#agentQuickNetwork');await closed();await page.waitForFunction(()=>playing&&!connected);
  assert.deepEqual(await page.evaluate(()=>({mode:$('learnMode').value,hints:$('liveHints').checked})),modeBefore,'network disconnect preserves the selected teaching mode');
  const disconnected=await page.evaluate(()=>({samples:teachingSamples.length,accepted:learner.demonstrations,frame}));await page.keyboard.down('ArrowRight');await page.waitForFunction(n=>frame>n+5,disconnected.frame);await page.keyboard.up('ArrowRight');
  assert.equal(await page.evaluate(()=>teachingSamples.length),disconnected.samples,'disconnected network does not sample');assert.equal(await page.evaluate(()=>learner.demonstrations),disconnected.accepted,'manual play with disconnected network is not an implicit hint');
  await open();await idle();await page.click('#agentQuickNetwork');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='assist');
  assert(await page.evaluate(()=>teachingConnectCalls.length&&teachingConnectCalls.every(value=>value===false)),'all quick teaching/network actions keep the current game frame');
  await open();await idle();await page.click('#agentQuickManual');await closed();await page.waitForFunction(()=>playing&&!connected&&learningUI.phase()==='off');
  // The ordinary game menu must use the same teaching-safe suspension as the compact panel.
  await open();await idle();await page.evaluate(()=>{teachingHoldSample=true;teachingReleaseSample=null;});await page.click('#agentQuickRec');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');
  const menuBase=await page.evaluate(()=>learner.demonstrations);await page.keyboard.down('ArrowRight');await page.waitForFunction(n=>learner.demonstrations>=n+3&&pendingToken!==null&&fdbExperience.length>0&&typeof teachingReleaseSample==='function',menuBase);
  await page.click('#gameExit');await page.waitForFunction(()=>consoleNavigation.pending()&&!playing);const menuFrame=await page.evaluate(()=>frame);await page.keyboard.up('ArrowRight');
  assert.equal(await page.evaluate(()=>consoleNavigation.page()),'game','the menu is committed only after the recording is durable');assert.equal(await page.evaluate(()=>labBack()),true,'Back is consumed during the same pending menu transition');assert(await page.locator('#gameExit').isDisabled(),'repeated menu requests cannot create concurrent teaching flushes');
  await page.evaluate(()=>teachingReleaseSample());await page.waitForFunction(()=>consoleNavigation.page()==='game-actions'&&!consoleNavigation.pending());const menuTotals=await humanTotals();
  assert.equal(menuTotals.frame,menuFrame,'menu save does not advance the real game');assert.equal(menuTotals.submitted,menuTotals.accepted,'gameExit submits the pending REC tail exactly once');assert.equal(menuTotals.queue,0);
  // A fresh native configuration models the unresolved Current gate after changing a backend/graph.
  await page.evaluate(()=>{teachingHoldBind=true;teachingReleaseBind=null;configurationApplied=false;});await page.click('#navPlay');await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');
  const backBase=await page.evaluate(()=>learner.demonstrations);await page.keyboard.down('ArrowLeft');await page.waitForFunction(n=>learner.demonstrations>n&&window.labCurrentPending&&fdbExperience.length>0&&typeof teachingReleaseBind==='function',backBase);
  assert.equal(await page.evaluate(()=>labBack()),true,'hardware Back begins a teaching-safe menu transition');await page.waitForFunction(()=>consoleNavigation.pending()&&!playing);const backFrame=await page.evaluate(()=>frame);await page.keyboard.up('ArrowLeft');assert.equal(await page.evaluate(()=>labBack()),true,'repeated hardware Back stays on the pending transition');
  await page.evaluate(()=>teachingReleaseBind());await page.waitForFunction(()=>consoleNavigation.page()==='game-actions'&&!consoleNavigation.pending());const backTotals=await humanTotals();
  assert.equal(backTotals.frame,backFrame,'Current ACK during Back does not advance the game');assert.equal(backTotals.submitted,backTotals.accepted,'hardware Back submits all executed REC labels exactly once');assert.equal(backTotals.queue,0);
  await page.click('#navPlay');await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='rec');await open();await idle();await page.click('#agentQuickManual');await closed();await page.waitForFunction(()=>playing&&!connected&&learningUI.phase()==='off');
 }
 assert.deepEqual(errors,[]);await browser.close();browser=null;
 console.log('PASS: actual NES/MD REC at x1, pending Current ACK and deferred Back, pending inference and partial-tail flush exactly once, durable recording pause/reopen, STOP to AUTO without ROM reset or archive replay, executed hints, unknown reward isolation, separate network disconnect/reconnect preserving mode, ordinary gameExit and hardware Back with pending sample/Current preserving REC; native FDB replies are explicit protocol fixtures');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
