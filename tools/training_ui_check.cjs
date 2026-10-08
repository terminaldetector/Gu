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
    const data={generation:r.generation,token:r.token,sequence:trainingRequests.length,buttons:2,outputs:new Array(new URL(location.href).searchParams.get('system')==='snes'?12:8).fill(0),spikes:0,active:0,wallMs:2,simMs:20,steps:200,backend:'cpu',neuralGroups:[]};
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
  const shortTap=await page.evaluate(async()=>{
   playing=false;await window.humanTeaching.stop('fixture');const prior=new Set((await humanTeaching.store.request('list')).map(m=>m.id));
   const code=labPlatform==='snes'?'KeyA':'KeyX',event={code,target:document.body,preventDefault(){}};const before=learner.demonstrations;
   playing=true;window.onkeydown(event);window.onkeyup(event);playing=false;const added=learner.demonstrations-before;await humanTeaching.stop('fixture-tap');
   const m=(await humanTeaching.store.request('list')).find(m=>!prior.has(m.id));const report=await humanTeaching.store.request('export',{id:m.id});playing=true;return {added,report};
  });
  assert.equal(shortTap.added,0);assert.equal(shortTap.report.session.samples,0);assert.deepEqual(shortTap.report.events.map(e=>e.mask),[1,0],'same-task tap survives without inventing a game frame');
  const oneFrame=await page.evaluate(async()=>{
   playing=false;await humanTeaching.stop('fixture');const prior=new Set((await humanTeaching.store.request('list')).map(m=>m.id)),code=labPlatform==='snes'?'KeyA':'KeyX',event={code,target:document.body,preventDefault(){}};
   playing=true;window.onkeydown(event);advanceFrame(performance.now());window.onkeyup(event);playing=false;await humanTeaching.stop('fixture-one-frame');
   const m=(await humanTeaching.store.request('list')).find(m=>!prior.has(m.id));const report=await humanTeaching.store.request('export',{id:m.id});playing=true;return {fps:labPlatform==='nes'?60:nes.fps,report};
  });
  const one=oneFrame.report.events.find(e=>e.kind==='sample');assert.equal(one.mask,1);assert.equal(one.frames,1);assert(Math.abs(one.seconds-1/oneFrame.fps)<1e-10);assert.equal(oneFrame.report.session.accepted,1);
  await page.evaluate(()=>leaveGame('learning'));await page.click('#trainingPause');
  await page.waitForFunction(()=>$('humanSessionSelect').options.length>=3);assert(await page.locator('#humanSessionStats').textContent());
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(modelStorageKey('fly-policy-'))));assert.equal(saved.policy.version,3);assert(saved.experience.human.length>0);
  await page.evaluate(()=>{learner.reset();humanExamples=[];});await page.click('#loadPolicy');assert.equal(await page.evaluate(()=>learner.demonstrations),saved.policy.demonstration.samples);
  const archives=await page.evaluate(()=>humanTeaching.store.request('list')),trainArchive=archives.find(m=>m.system===system&&m.accepted>=10);
  await page.locator('#archiveSessionRoles select[data-session="'+trainArchive.id+'"]').selectOption('train');
  await page.locator('#archiveSessionRoles select[data-session="'+oneFrame.report.session.id+'"]').selectOption('test');
  const archiveBefore=await page.evaluate(()=>({policy:JSON.stringify(learner.save()),frame,fdb:JSON.stringify(fdbConfiguration())}));
  await page.click('#archiveRun');await page.waitForFunction(()=>$('archiveStatus').textContent.includes('Новый адаптер готов'));
  assert.deepEqual(await page.evaluate(()=>({policy:JSON.stringify(learner.save()),frame,fdb:JSON.stringify(fdbConfiguration())})),archiveBefore,'offline candidate and heldout leave live model, ROM and FDB intact');
  assert((await page.locator('#archiveResult').textContent()).includes('Проверка: 1 примеров'));assert.equal(await page.locator('#archiveButtons tr').count(),system==='snes'?12:8);
  await page.click('#archiveApply');await page.waitForFunction(()=>$('archiveStatus').textContent.includes('применены и сохранены'));
  const applied=await page.evaluate(()=>JSON.parse(localStorage.getItem(modelStorageKey('fly-policy-'))));
  assert.equal(applied.policy.demonstration.archive.train[0].id,trainArchive.id);assert.equal(applied.policy.demonstration.archive.test[0].id,oneFrame.report.session.id);assert.deepEqual(applied.policy.weights,JSON.parse(archiveBefore.policy).weights);assert.equal(await page.evaluate(()=>frame),archiveBefore.frame);
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
  const benchmarkFrozen=await page.evaluate(async()=>{
   $('learnMode').value='teach';$('rewardMode').value='manual';$('winEnabled').checked=true;$('winAddress').value='100';$('winValue').value=String((nes.cpu.mem[100]+1)&255);$('episodeLength').value='10';$('benchmarkCriterion').value='Fixture RAM criterion';$('benchmarkAttempts').value='1';$('benchmarkPolicy').value='random';$('captureStart').onclick();
   const before={weights:JSON.stringify([learner.weights,learner.demonstrationWeights]),samples:learner.demonstrations,sessions:(await humanTeaching.store.request('list')).length};
   $('benchmarkStart').onclick();openGame();return before;
  });
  await page.waitForFunction(()=>!configuring);await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>$('learnMode').value),'eval','benchmark explicitly owns frozen evaluation');
  assert.deepEqual(await page.evaluate(async()=>({weights:JSON.stringify([learner.weights,learner.demonstrationWeights]),samples:learner.demonstrations,sessions:(await humanTeaching.store.request('list')).length})),benchmarkFrozen,'benchmark cannot train or archive neutral frames after teaching');
  await page.evaluate(()=>{window.labPause();leaveGame('learning');});
  await page.check('#humanAllSessions');
  const allSessions=await page.evaluate(()=>humanTeaching.store.request('list'));if(system==='snes')assert(allSessions.some(m=>m.system==='nes'),'archive survives platform navigation');
  await page.selectOption('#humanSessionSelect',shortTap.report.session.id);page.once('dialog',d=>d.dismiss());await page.click('#humanSessionDelete');
  assert.equal((await page.evaluate(()=>humanTeaching.store.request('list'))).length,allSessions.length,'cancel preserves recording');
  const keptWeights=await page.evaluate(()=>JSON.stringify(learner.save()));page.once('dialog',d=>d.accept());await page.click('#humanSessionDelete');await page.waitForFunction(()=>$('humanSessionStatus').textContent.includes('Выбранная сессия удалена'));
  assert.equal((await page.evaluate(()=>humanTeaching.store.request('list'))).length,allSessions.length-1);assert.equal(await page.evaluate(()=>JSON.stringify(learner.save())),keptWeights,'archive deletion leaves learned weights intact');
  await page.uncheck('#humanAllSessions');
  fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/training-'+system+'-portrait.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'learning page fits phone');
  await page.setViewportSize({width:844,height:390});await page.screenshot({path:'ui-preview/training-'+system+'-landscape.png',fullPage:true});await page.setViewportSize({width:390,height:844});
 }
 assert.deepEqual(errors,[]);console.log('PASS: actual NES/SNES realtime teaching, raw sub-frame taps, one-frame actions, full session persistence/overview, P1 ownership, bounded FDB replay, frozen evaluation and mobile layout');
})().catch(async e=>{if(page){fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/training-failure.png',fullPage:true}).catch(()=>{});console.error(await page.evaluate(()=>({status:$('status').textContent,playing,connected,configuring,samples:learner.demonstrations})).catch(()=>null));}console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
