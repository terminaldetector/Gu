'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser,page;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{const file=path.join(assets,new URL(r.request().url()).pathname.slice(1));return r.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':'text/html'});});
 await page.exposeFunction('fixtureDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='Original diagnostic';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>window.labLoadRom(d),d);});
 await page.addInitScript(()=>{
  window.trainingRequests=[];window.configRequests=[];window.fixtureFdb=null;
  window.FlyBridge={demo:()=>window.fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},stop(){},resume(){},orientation(){},
   configure:raw=>{const c=JSON.parse(raw);configRequests.push(c);fixtureFdb=c.fdb;setTimeout(()=>window.labConfigured({generation:c.generation,reset:c.reset,configVersion:1,mode:c.mode,backend:c.backend}),0);},
   sample:raw=>{const r=JSON.parse(raw);trainingRequests.push(r);setTimeout(()=>{
    const data={generation:r.generation,token:r.token,sequence:trainingRequests.length,buttons:2,outputs:new Array(new URL(location.href).searchParams.get('system')==='snes'?12:8).fill(0),spikes:0,active:0,wallMs:2,neuralGroups:[]};
    if(fixtureFdb&&fixtureFdb.learning){const old=fixtureFdb.learningState||{version:1,observations:0,human:0,automatic:0,sources:configRequests.at(-1).inputs,targets:configRequests.at(-1).outputs};if(fixtureFdb.learning.enabled&&['teach','train'].includes(r.learningMode)&&!r.frozen)for(const e of r.experience){old.observations++;old[e.human?'human':'automatic']++;}fixtureFdb.learningState=old;data.fdbLearningState=old;}
    window.labResult(data);
   },5);}
  };
 });
 for(const system of ['nes','snes']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);
  await page.evaluate(()=>{window.labReady({kind:'fixture',neurons:64,edges:100,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'});showTab('learning');$('rewardMode').value='manual';});
  await page.selectOption('#learnMode','teach');await page.click('#trainingStart');await page.waitForFunction(()=>playing&&connected);
  await page.keyboard.down('ArrowRight');await page.waitForFunction(()=>learner.demonstrations>=10);await page.keyboard.up('ArrowRight');
  const taught=await page.evaluate(()=>({samples:learner.demonstrations,human:humanExamples.slice(),updates:learner.updates,policy:JSON.stringify(learner.save()),frame}));
  assert(taught.human.some(e=>e.mask===128));assert.equal(taught.updates,0,'teacher never creates reward updates');assert.equal(await page.evaluate(()=>brainMask),0,'neural buttons cannot interfere with the teacher');
  await page.evaluate(()=>leaveGame('learning'));await page.click('#trainingPause');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('fly-policy-'+romHash)));assert.equal(saved.policy.version,3);assert(saved.experience.human.length>0);
  await page.evaluate(()=>{learner.reset();humanExamples=[];});await page.click('#loadPolicy');assert.equal(await page.evaluate(()=>learner.demonstrations),saved.policy.demonstration.samples);
  await page.locator('#fdbLearningPanel summary').click();await page.click('#trainingFdb');await page.waitForFunction(()=>connected&&!configuring);await page.click('#trainingStart');
  await page.waitForFunction(()=>trainingRequests.some(r=>r.experience.length>0));assert(await page.evaluate(()=>trainingRequests.every(r=>r.experience.length<=16)),'bounded native batches');
  await page.waitForFunction(()=>fdbConfiguration().learningState?.human>0);
  await page.evaluate(()=>leaveGame('learning'));await page.selectOption('#learnMode','eval');
  const frozen=await page.evaluate(()=>({weights:JSON.stringify([learner.weights,learner.demonstrationWeights]),samples:learner.demonstrations,state:JSON.stringify(fdbConfiguration().learningState)}));
  await page.click('#trainingStart');await page.waitForFunction(()=>playing&&connected);await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(()=>({weights:JSON.stringify([learner.weights,learner.demonstrationWeights]),samples:learner.demonstrations,state:JSON.stringify(fdbConfiguration().learningState)})),frozen);
  await page.evaluate(()=>leaveGame('learning'));await page.selectOption('#learnMode','train');await page.click('#trainingStart');await page.waitForFunction(()=>playing&&connected);
  await page.evaluate(()=>{manualMask=128;updateButtons();agentIntervened=true;});
  const before=await page.evaluate(()=>learner.updates);await page.evaluate(()=>{rewardPending=1;learnedButtons({buttons:0,outputs:new Array(buttonNames.length).fill(0)});});
  assert.equal(await page.evaluate(()=>learner.updates),before,'manual intervention never receives automatic reward credit');
  await page.evaluate(()=>{manualMask=0;window.labPause();leaveGame('learning');});
  fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/training-'+system+'-portrait.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'learning page fits phone');
  await page.setViewportSize({width:844,height:390});await page.screenshot({path:'ui-preview/training-'+system+'-landscape.png',fullPage:true});await page.setViewportSize({width:390,height:844});
 }
 assert.deepEqual(errors,[]);console.log('PASS: actual NES/SNES realtime teaching, P1 ownership, persistence, bounded FDB replay, frozen evaluation, manual reward exclusion and mobile learning layout');
})().catch(async e=>{if(page){fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/training-failure.png',fullPage:true}).catch(()=>{});console.error(await page.evaluate(()=>({status:$('status').textContent,playing,connected,configuring,samples:learner.demonstrations})).catch(()=>null));}console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
