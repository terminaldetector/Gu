'use strict';
// Real NES/MD emulation and persistence. Native FDB replies are protocol fixtures only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:412,height:915},hasTouch:true,isMobile:true}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':'text/html'});});
 await page.exposeFunction('panelDemo',system=>{const data=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));data.name='Agent panel UI fixture';data.sha256=crypto.createHash('sha256').update(Buffer.from(data.base64,'base64')).digest('hex');return page.evaluate(data=>labLoadRom(data),data);});
 await page.addInitScript(()=>{
  window.panelControls=[];window.panelSamples=[];window.panelConfiguration=null;window.panelConnectCalls=[];
  window.FlyBridge={orientation(){},acceptRom(){},stop(){},resume(){},gameDisplay(){},controls:on=>panelControls.push(on),demo:()=>panelDemo(new URL(location.href).searchParams.get('system')||'nes'),
   configure(raw){const q=JSON.parse(raw);panelConfiguration=q;setTimeout(()=>labConfigured({generation:q.generation,reset:q.reset,configVersion:1,mode:q.mode,backend:q.backend}),2);},
   sample(raw){const q=JSON.parse(raw);panelSamples.push(q);setTimeout(()=>labResult({generation:q.generation,token:q.token,sequence:panelSamples.length,buttons:1,outputs:new Array(buttonNames.length).fill(1),spikes:1,active:1,wallMs:2,simMs:20,steps:200,backend:'cpu',neuralGroups:[],...(panelConfiguration?.fdb?{fdbState:JSON.parse(JSON.stringify(panelConfiguration.fdb))}:{}),...(q.controllerSource==='exo'&&q.learningMode!=='teach'?{fdbDecision:{id:q.generation+':'+q.token,mask:1}}:{})}),2);},
   fdbFeedback(raw){const q=JSON.parse(raw);setTimeout(()=>labFdbFeedback({token:q.token,data:q.op==='bind'?{bound:true,layerId:q.layerId,configVersion:q.configVersion}:{changed:0,fdbState:JSON.parse(JSON.stringify(panelConfiguration?.fdb||null)),memoryBytes:4096}}),2);}
  };
 });
 const shot=async name=>{fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/agent-panel-'+name+'.png'});};
 const open=async()=>{await page.click('#gameAgentToggle');await page.waitForFunction(()=>$('agentQuickPanel').open);};
 const closed=async()=>page.waitForFunction(()=>!$('agentQuickPanel').open);
 const fits=async label=>{
  const state=await page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};const p=$('agentQuickPanel');return{panel:rect(p),viewport:[innerWidth,innerHeight],scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],buttons:[...p.querySelectorAll('button')].filter(el=>el.getClientRects().length).map(rect),modal:p.matches(':modal'),focused:p.contains(document.activeElement)};});
  assert(state.modal,label+' is a native modal with inert background');assert(state.focused,label+' receives keyboard focus');
  assert(state.panel.width>=260&&state.panel.width<=420,label+' stays compact');
  const r=state.panel;assert(r.x>=-1&&r.y>=-1&&r.right<=state.viewport[0]+1&&r.bottom<=state.viewport[1]+1,label+' inside viewport');
  assert(state.buttons.every(r=>r.height>=40),label+' usable touch targets');assert(state.scroll[0]<=state.viewport[0]+1&&state.scroll[1]<=state.viewport[1]+1,label+' no page scrolling');
  // Short landscape windows scroll inside the dialog; every action must remain reachable.
  for(const button of await page.locator('#agentQuickPanel button:visible').all()){
   await button.scrollIntoViewIfNeeded();const b=await button.boundingBox();assert(b.x>=r.x&&b.y>=r.y&&b.x+b.width<=r.right+1&&b.y+b.height<=r.bottom+1,label+' action reachable inside dialog');
  }
  await page.evaluate(()=>$('agentQuickPanel').scrollTop=0);
 };
 for(const system of ['nes','sega']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>window.consoleNavigation&&loaded&&!romLoading);
  await page.click('#navResume');await page.waitForFunction(()=>playing&&frame>10);
  assert.equal(await page.evaluate(()=>ready),false,'quick manual controls do not depend on a connectome');
  assert.equal(await page.getAttribute('#gameAgentToggle','aria-haspopup'),'dialog');
  await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>Boolean(manualMask&128));await open();
  assert.equal(await page.evaluate(()=>playing||connected),false,'opening the panel pauses both clocks');
  assert.equal(await page.evaluate(()=>manualMask),0,'opening the panel releases held input');
  assert.equal(await page.getAttribute('#gameAgentToggle','aria-expanded'),'true');
  await fits(system+' portrait');await shot(system+'-portrait');
  await page.evaluate(()=>{labController({id:7,mask:128,connected:true,name:'late controller fixture'});window.dispatchEvent(new Event('focus'));document.dispatchEvent(new FocusEvent('focusout'));});assert.equal(await page.evaluate(()=>manualMask),0,'late native gamepad input stays out of gameplay');assert.equal(await page.evaluate(()=>panelControls.at(-1)),false,'focus events cannot reenable native game controls through a modal');
  const paused=await page.evaluate(()=>frame);await page.keyboard.up('ArrowRight');await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>manualMask),0,'dialog navigation never becomes an in-game direction');
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>frame),paused,'real emulator stays paused while dialog is visible');
  await page.keyboard.press('Tab');assert(await page.evaluate(()=>$('agentQuickPanel').contains(document.activeElement)),'focus remains in the dialog');
  await page.keyboard.press('Escape');await closed();await page.waitForFunction(n=>playing&&frame>n,paused);
  assert.equal(await page.evaluate(()=>consoleNavigation.page()),'game','Escape closes this panel before opening game menus');
  await page.evaluate(()=>labPause());await open();await page.click('#agentQuickClose');await closed();assert.equal(await page.evaluate(()=>playing),false,'closing preserves an already paused game');
  await page.evaluate(()=>$('play').click());await open();await page.evaluate(()=>labBack());await closed();await page.waitForFunction(()=>playing);
  await open();await page.click('#agentQuickMore');await closed();assert.equal(await page.evaluate(()=>consoleNavigation.page()),'agent');assert.equal(await page.evaluate(()=>playing||connected),false,'full agent settings keep the game paused');
  await page.click('#navManualPlay');await page.waitForFunction(()=>playing);
  // The graph and FDB are explicit bridge fixtures. The frame/restart checks below use the real core.
  await page.evaluate(async()=>{labReady({kind:'agent-panel-fixture',neurons:32,edges:64,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'});await labState.settle();$('captureStart').click();window.panelStartFrame=frame;const original=connectBrain;connectBrain=function(restoreStart=true){panelConnectCalls.push(restoreStart);return original(restoreStart);};$('play').click();});
  await page.waitForFunction(()=>frame>panelStartFrame+12);await open();const before=await page.evaluate(()=>({frame,restarts:emulatorRestarts}));
  await page.click('#agentQuickAuto');await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='auto');await closed();
  const auto=await page.evaluate(()=>({frame,restarts:emulatorRestarts,calls:panelConnectCalls.slice(),source:$('learnerController').value,learning:fdbConfiguration()?.learning?.enabled}));
  assert(auto.frame>=before.frame,'AUTO resumes the current frame');assert.equal(auto.restarts,before.restarts,'AUTO never resets the real ROM');assert(auto.calls.length&&auto.calls.every(value=>value===false),'quick controls always connect without start-state restoration');assert.equal(auto.source,'exo','AUTO selects the connectome FDB controller');assert.equal(auto.learning,true,'AUTO enables acquired FDB plasticity');assert.equal(await page.evaluate(()=>panelControls.at(-1)),true,'native game controls resume after the modal closes');
  await page.waitForFunction(()=>panelSamples.some(q=>q.learningMode==='train'&&q.controllerSource==='exo'));
  await open();assert.equal(await page.getAttribute('#agentQuickAuto','aria-pressed'),'true','selected mode is retained after pausing');await shot(system+'-auto-portrait');await page.click('#agentQuickClose');await closed();await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='auto');
  // The full settings route inherits the already captured pause, rather than replacing it with disconnected state.
  await open();await page.click('#agentQuickMore');await closed();assert.equal(await page.evaluate(()=>consoleNavigation.page()),'agent');assert.equal(await page.evaluate(()=>playing||connected),false);await page.evaluate(()=>{labBack();labBack();});await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='auto');
  // A retained diagnostic failure is history; an explicit successful retry can resume again.
  await page.evaluate(()=>labError({message:'quick-panel recovery fixture'}));await open();await page.click('#agentQuickAuto');await closed();await page.waitForFunction(()=>playing&&connected&&!labNeuralSuspended);assert.match(await page.evaluate(()=>labAgentStatus().failure.message),/recovery fixture/,'recovery keeps the original failure in diagnostics');await open();await page.click('#agentQuickClose');await closed();await page.waitForFunction(()=>playing&&connected);
  await open();assert.match(await page.textContent('#agentQuickFeedback'),/награ|обратн|результат|оценк/i,'feedback status explains whether autonomous reward is available');await page.click('#agentQuickEval');await page.waitForFunction(()=>playing&&connected&&learningUI.phase()==='eval');await closed();
  await page.waitForFunction(()=>panelSamples.some(q=>q.learningMode==='eval'));assert(await page.evaluate(()=>panelSamples.filter(q=>q.learningMode==='eval').every(q=>q.experience.length===0)),'evaluation sends no learning examples');
  await open();await page.click('#agentQuickManual');await closed();await page.waitForFunction(()=>playing&&!connected);assert.equal(await page.evaluate(()=>$('learnMode').value),'off','manual play switches off agent training');assert.equal(await page.evaluate(()=>panelControls.at(-1)),true,'manual game controls resume after mode selection');
  await page.setViewportSize({width:915,height:412});await open();await fits(system+' landscape');await shot(system+'-landscape');await page.evaluate(()=>labBack());await closed();await page.waitForFunction(()=>playing);
  // A failed dual checkpoint must remain explicit; it must not silently select manual or resume either model.
  await open();await page.evaluate(()=>{window.panelRealDual=window.dualAgents;window.dualAgents={...panelRealDual,active:()=>true,running:()=>false,exit:async()=>false};});await page.click('#agentQuickManual');
  await page.waitForFunction(()=>$('agentQuickMessage').textContent.length>0);assert(await page.evaluate(()=>$('agentQuickPanel').open));assert.equal(await page.evaluate(()=>playing||connected),false,'failed dual save leaves the session paused');assert.match(await page.textContent('#agentQuickMessage'),/сохран/i);await page.evaluate(()=>{window.dualAgents=panelRealDual;});
  await page.click('#agentQuickClose');await closed();assert.equal(await page.evaluate(()=>playing||connected),false,'closing an error does not silently restart gameplay');
  // Cancel a pending model save, then reject its late answer without reopening or resuming.
  await page.evaluate(()=>{window.dualAgents={...panelRealDual,active:()=>true,running:()=>false,exit:()=>new Promise(resolve=>{window.panelFinishExit=()=>resolve(true);})};});
  await open();await page.click('#agentQuickManual');await page.waitForFunction(()=>typeof panelFinishExit==='function');await page.evaluate(()=>labBack());await closed();await page.evaluate(()=>panelFinishExit());await page.waitForTimeout(80);assert.equal(await page.evaluate(()=>playing||connected),false,'late dual save cannot restart a dismissed panel');await page.evaluate(()=>{window.dualAgents=panelRealDual;});
  // A pause arriving during a FDB drain also cancels a pending AUTO launch.
  await open();await page.evaluate(()=>{window.panelRealFdb=window.fdbAgent;window.fdbAgent={...panelRealFdb,drain:()=>new Promise(resolve=>{window.panelFinishDrain=resolve;})};});await page.click('#agentQuickAuto');await page.waitForFunction(()=>typeof panelFinishDrain==='function');await page.evaluate(()=>{labPause();panelFinishDrain();});await page.waitForFunction(()=>$('agentQuickMessage').textContent.length>0);assert.equal(await page.evaluate(()=>playing||connected),false,'external pause during FDB drain cancels AUTO');await page.evaluate(()=>{window.fdbAgent=panelRealFdb;});await page.click('#agentQuickClose');await closed();
  // A native pause/background event supersedes the panel's saved resume intent.
  await page.evaluate(()=>$('play').click());await open();await page.evaluate(()=>labPause());await page.click('#agentQuickClose');await closed();assert.equal(await page.evaluate(()=>playing||connected),false,'external pause is not undone by closing the panel');
  await page.setViewportSize({width:412,height:915});
 }
 assert.deepEqual(errors,[]);await browser.close();browser=null;
 console.log('PASS: compact modal agent controls over real NES/MD, portrait/landscape, pause/resume/Back/focus and input isolation, current-frame FDB AUTO, frozen evaluation, manual mode and explicit failed dual-save guard; native replies are fixtures, not learning evidence');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
