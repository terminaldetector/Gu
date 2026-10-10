'use strict';
// Production UI and real game cores. Native replies are explicit fixtures, not biological tests.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{const p=path.join(assets,new URL(r.request().url()).pathname.slice(1));return r.fulfill({status:fs.existsSync(p)?200:404,body:fs.existsSync(p)?fs.readFileSync(p):'',contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.wasm')?'application/wasm':'text/html'});});
 await page.exposeFunction('fixtureDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='diagnostic / flow fixture';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>window.labLoadRom(d),d);});
 await page.addInitScript(()=>{
  window.flowRequests=[];window.flowFeedback=[];window.flowDelay=4;window.flowConfig=null;window.flowFdb=null;
  window.flowAnnounce=id=>{const male=id==='male-cns-v1.0',offset=male?100:0;labReady({modelId:id,kind:id,neurons:64,edges:100,heapMiB:512,graph_sha256:(male?'c':'b').repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1+offset)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17+offset)),backend:'cpu'});};
  window.FlyBridge={demo:()=>fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},stop(){},resume(){},orientation(){},
   configure(raw){const q=JSON.parse(raw);flowConfig=q;flowFdb=q.fdb;setTimeout(()=>labConfigured({generation:q.generation,reset:q.reset,configVersion:1,mode:q.mode,backend:q.backend}),1);},
   sample(raw){const q=JSON.parse(raw);flowRequests.push(q);const delay=flowDelay;setTimeout(()=>{
    if(flowFdb?.learning){const s=flowFdb.learningState||{version:1,sources:flowConfig.inputs,targets:flowConfig.outputs,observations:0,human:0,automatic:0};if(!q.frozen&&['teach','train'].includes(q.learningMode))for(const e of q.experience){s.observations++;s[e.human?'human':'automatic']++;}flowFdb.learningState=s;}
    labResult({generation:q.generation,token:q.token,sequence:flowRequests.length,buttons:1,outputs:new Array(buttonNames.length).fill(1),spikes:1,active:1,wallMs:delay,simMs:20,steps:200,backend:'cpu',neuralGroups:[],...(flowFdb?{fdbState:JSON.parse(JSON.stringify(flowFdb))}:{}),...(q.controllerSource==='exo'&&q.learningMode!=='teach'?{fdbDecision:{id:q.generation+':'+q.token,mask:1}}:{})});
   },delay);},
   fdbFeedback(raw){const q=JSON.parse(raw);flowFeedback.push(q);setTimeout(()=>labFdbFeedback({token:q.token,data:{changed:0,fdbState:JSON.parse(JSON.stringify(flowFdb)),memoryBytes:4096}}),2);},
   selectConnectome(id){localStorage.setItem('flow-model',id);setTimeout(()=>{flowAnnounce(id);labModelSelection({id,ok:true});},10);}
  };
 });
 for(const system of ['nes','sega','snes','gb']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);
  await page.evaluate(()=>flowAnnounce(localStorage.getItem('flow-model')||'flywire-v783'));await page.evaluate(()=>labState.settle());
  await page.evaluate(()=>{window.labPause();$('learnMode').value='off';$('liveHints').checked=false;$('learnerController').value='exo';$('rewardMode').value='manual';openGame();});
  // Fast-forward really advances the emulator, without changing policy or network seed.
  const baseline=await page.evaluate(()=>({policy:JSON.stringify(learner.save()),seed:$('seed').value,frame}));
  await page.evaluate(()=>{learningUI.rate(10);$('play').click();});await page.waitForTimeout(350);await page.evaluate(()=>labPause());
  const fast=await page.evaluate(()=>({frames:frame,policy:JSON.stringify(learner.save()),seed:$('seed').value}));
  assert(fast.frames-baseline.frame>65,'×10 advances real '+system+' core frames');assert.equal(fast.policy,baseline.policy);assert.equal(fast.seed,baseline.seed);
  await page.click('#liveRecord');await page.waitForFunction(()=>playing&&connected&&$('learnMode').value==='teach');assert.equal(await page.evaluate(()=>emulationRate),1,'REC always uses human time');
  await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>learner.demonstrations>=3);await page.keyboard.up('ArrowRight');
  const rec=await page.evaluate(()=>({frame,restarts:emulatorRestarts,count:learner.demonstrations,mask:brainMask}));assert.equal(rec.mask,0);
  assert((await page.textContent('#liveRecord')).includes('STOP'));
  await page.click('#liveRecord');await page.waitForFunction(()=>playing&&connected&&$('learnMode').value==='train'&&!learningUI.busy());
  const after=await page.evaluate(async()=>({frame,restarts:emulatorRestarts,sessions:await humanTeaching.store.request('list'),submitted:flowRequests.flatMap(r=>r.experience).filter(e=>e.human),taught:learner.demonstrations,kind:learningUI.phase()}));
  assert(after.frame>=rec.frame);assert.equal(after.restarts,rec.restarts,'STOP -> AUTO preserves ROM');assert.equal(after.kind,'auto');assert(after.sessions.some(s=>s.accepted>=rec.count&&s.status==='closed'));assert.equal(after.submitted.length,after.taught,'STOP submits every executed label once');assert(after.submitted.some(e=>e.mask===128),'executed REC labels reach native FDB');
  await page.waitForFunction(()=>flowRequests.some(r=>r.learningMode==='train'));
  const humanCount=await page.evaluate(()=>learner.demonstrations);
  await page.keyboard.down('ArrowLeft');await page.waitForTimeout(130);
  assert.equal(await page.evaluate(()=>appliedAgentMask&64),0,'pure automation ignores human gameplay hints');assert.equal(await page.evaluate(()=>learner.demonstrations),humanCount);await page.keyboard.up('ArrowLeft');
  // Accelerated closed loop never stretches a cached decision past its eligibility interval.
  await page.evaluate(()=>{flowFeedback=[];flowDelay=120;learningUI.rate(10);});await page.waitForTimeout(700);
  const outcomes=await page.evaluate(()=>flowFeedback.filter(q=>q.op==='reward'));
  assert(outcomes.length>1);assert(outcomes.every(q=>q.seconds>0&&q.seconds<=.12&&q.frames>0),'accelerated rewards follow bounded executed game intervals');
  await page.click('#liveHintsButton');await page.waitForFunction(()=>playing&&connected&&$('liveHints').checked);await page.evaluate(()=>learningUI.rate(1));
  const assisted=await page.evaluate(()=>learner.demonstrations);await page.keyboard.down('ArrowLeft');await page.waitForFunction(n=>learner.demonstrations>n,assisted);
  assert.equal(await page.evaluate(()=>appliedAgentMask),64,'teacher action replaces, rather than labels a mixture with agent A');await page.keyboard.up('ArrowLeft');
  await page.waitForFunction(()=>flowRequests.some(q=>q.learningMode==='train'&&q.experience.some(e=>e.mask===64&&e.human)));
  const pure=await page.evaluate(()=>flowRequests.filter(q=>q.learningMode==='train').flatMap(q=>q.experience).filter(e=>e.mask===64&&e.human));assert(pure.length>0,'streaming executed hints reach FDB');
  await page.evaluate(()=>{labPause();leaveGame('learning');});await page.selectOption('#trainingKind','eval');const snapshot=await page.evaluate(()=>JSON.stringify(learner.save()));await page.click('#trainingStart');await page.waitForFunction(()=>playing&&connected);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>JSON.stringify(learner.save())),snapshot,'Eval freezes learned policy');
  await page.evaluate(()=>{labPause();learningUI.choose('assist');});await page.evaluate(()=>labState.checkpoint());
  await page.reload();await page.waitForFunction(()=>loaded);await page.evaluate(()=>flowAnnounce(localStorage.getItem('flow-model')||'flywire-v783'));await page.evaluate(()=>labState.settle());assert.equal(await page.evaluate(()=>learningUI.phase()),'assist');assert.equal(await page.evaluate(()=>playing||connected),false);assert.equal(await page.evaluate(()=>emulationRate),1,'reopen cannot accidentally fast-forward');
  if(system==='sega'){
   await page.click('[data-tab="network"]');await page.selectOption('#partnerModel','male-cns-v1.0');await page.selectOption('#gmode','coop');await page.click('#gmodeLaunch');await page.waitForFunction(()=>playing&&connected&&graphIdentity.modelId==='male-cns-v1.0');assert.equal(await page.evaluate(()=>gmodeMode),'coop');await page.waitForFunction(()=>brainMask===1);assert.equal(await page.evaluate(()=>nes.mask2),1,'selected Male CNS model routes to actual Sega P2');
   await page.click('#liveHintsButton');await page.waitForFunction(()=>playing&&connected&&$('liveHints').checked);await page.click('#liveHintTarget');const n=await page.evaluate(()=>learner.demonstrations);await page.keyboard.down('ArrowRight');await page.waitForFunction(n=>learner.demonstrations>n,n);assert.equal(await page.evaluate(()=>nes.mask2),128);assert.equal(await page.evaluate(()=>nes.mask),0,'explicit P2 hint does not masquerade as human P1');await page.keyboard.up('ArrowRight');
   await page.evaluate(()=>labPause());await page.screenshot({path:'ui-preview/alpha18-sega-flow-landscape.png'});
  }
 }
 // Large pad and optional instrumentation must remain clear of all touch targets.
 await page.setViewportSize({width:844,height:390});await page.evaluate(()=>openGame());await page.click('#liveDetails');
 const geometry=await page.evaluate(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};return{plot:rect($('gamePlot')),video:rect(screen),buttons:[...document.querySelectorAll('[data-button]')].filter(e=>!e.hidden).map(rect)};});
 assert(geometry.buttons.every(b=>b.w>=36&&b.h>=30));assert(geometry.plot.right<=geometry.video.x+1);for(const b of geometry.buttons)assert(b.right<=geometry.plot.x||b.x>=geometry.plot.right||b.y>=geometry.plot.bottom||b.bottom<=geometry.plot.y);
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: real NES/MD/SNES/GB acceleration, paced reward intervals, durable REC -> AUTO, pure automation, exclusive streaming hints, frozen evaluation, paused guidance restore, selected Male CNS Sega P2 and explicit P2 demonstration');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
