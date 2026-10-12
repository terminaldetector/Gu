'use strict';
// Real cores and production scheduler/UI; native acknowledgements are fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[],rows=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{const p=path.join(assets,new URL(r.request().url()).pathname.slice(1));return r.fulfill({status:fs.existsSync(p)?200:404,body:fs.existsSync(p)?fs.readFileSync(p):'',contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.wasm')?'application/wasm':'text/html'});});
 await page.exposeFunction('clockDemo',async system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>labLoadRom(d),d);});
 await page.addInitScript(()=>{
  window.lastRootConfig=null;
  window.FlyBridge={demo:()=>clockDemo(new URL(location.href).searchParams.get('system')),acceptRom(){},stop(){},resume(){},orientation(){},
   configure(raw){const q=JSON.parse(raw);lastRootConfig=q;setTimeout(()=>labConfigured({generation:q.generation,reset:q.reset,mode:q.mode,backend:q.backend,configVersion:1}),1);},
   fdbFeedback(raw){const q=JSON.parse(raw);setTimeout(()=>labFdbFeedback({token:q.token,data:{changed:0,...(lastRootConfig?.fdb?{fdbState:JSON.parse(JSON.stringify(lastRootConfig.fdb))}: {})}}),1);},
   sample(){}
  };
 });
 async function measure(rate,pending=false){
  await page.evaluate(({rate,pending})=>{labPause();learningUI.rate(rate);$('learnMode').value='off';$('clock').value='realtime';openGame();$('play').click();if(pending){connected=true;pendingToken=100;pendingSince=performance.now();}}, {rate,pending});
  await page.waitForTimeout(250);
  const first=await page.evaluate(()=>({frame,at:performance.now(),fps:labPlatform==='nes'?60:nes.fps}));
  await page.waitForTimeout(2000);
  const last=await page.evaluate(()=>({frame,at:performance.now(),label:$('gameBoost').textContent,live:$('liveSpeed').textContent}));
  await page.evaluate(()=>labPause());return{rate,pending,frames:last.frame-first.frame,seconds:(last.at-first.at)/1000,actual:(last.frame-first.frame)/first.fps/((last.at-first.at)/1000),label:last.label,live:last.live};
 }
 for(const system of ['nes','sega','snes','gb']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);
  await page.evaluate(()=>labReady({modelId:'flywire-v783',kind:'scheduler fixture',neurons:30,edges:1,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'}));await page.evaluate(()=>labState.settle());
  if(system==='nes')await page.evaluate(()=>{window.realCoreFrame=nes.frame.bind(nes);nes.frame=()=>{const at=performance.now();realCoreFrame();while(performance.now()-at<3){}};});
  for(const rate of [1,3]){const r=await measure(rate,rate===3);rows.push({system,...r});assert(Math.abs(r.actual-rate)<rate*.10,'real core ×'+rate+' '+system+': '+JSON.stringify(r));}
  if(system==='nes'){
   const limited=await measure(10,true);rows.push({system,artificialCoreCostMs:3,...limited});assert(limited.actual<7&&limited.actual>1,'overload must not fabricate speed');assert.notEqual(limited.label,'×10','toolbar reports achieved speed when limited');assert(limited.label.includes('/ 10×'));
   await page.evaluate(()=>{nes.frame=realCoreFrame;connected=false;pendingToken=null;});
   // Root choice is an actual configuration, survives storage and stays paused.
   await page.evaluate(()=>{$('fdbJson').value=JSON.stringify({version:2,graph_sha256:graphIdentity.sha256,deltas:[],edges:[],learning:{enabled:true,rate:.05,maxEdges:256,maxWeight:32}});$('trainingBase').checked=false;return $('trainingBase').onchange();});
   assert.equal(await page.evaluate(()=>lastRootConfig.fdb.learning.trainBase),false);
   assert.equal(await page.evaluate(()=>playing||connected),false);
   await page.reload();await page.waitForFunction(()=>loaded);await page.evaluate(()=>labReady({modelId:'flywire-v783',kind:'fixture',neurons:30,edges:1,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17)),backend:'cpu'}));await page.evaluate(()=>labState.settle());
   assert.equal(await page.isChecked('#trainingBase'),false,'root choice restored from Layer Set');
   await page.evaluate(()=>{const f=fdbConfiguration();f.neuronDynamics={version:1,thresholdOffsets:[{neuron:'17',offsetMv:-1.25}]};$('fdbJson').value=JSON.stringify(f);$('trainingPlasticity').value='expanded';return $('trainingPlasticity').onchange();});
   assert.equal(await page.evaluate(()=>lastRootConfig.fdb.learning.plasticityMode),'expanded');
   assert.equal(await page.evaluate(()=>lastRootConfig.fdb.learning.maxEdges),2048);
   await page.reload();await page.waitForFunction(()=>loaded);await page.evaluate(()=>labReady({modelId:'flywire-v783',kind:'fixture',neurons:30,edges:1,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17)),backend:'cpu'}));await page.evaluate(()=>labState.settle());
   assert.equal(await page.inputValue('#trainingPlasticity'),'expanded','expanded mode restored from Layer Set');
   await page.evaluate(()=>{$('trainingPlasticity').value='base';return $('trainingPlasticity').onchange();});
   assert.equal(await page.evaluate(()=>lastRootConfig.fdb.neuronDynamics.thresholdOffsets[0].offsetMv),-1.25,'disabling expanded mode retains acquired threshold');

  }
  if(system!=='gb'){
   const config=await page.evaluate(()=>{$('dual1Base').checked=false;$('dual2Base').checked=true;$('dual1Plasticity').value='root';$('dual2Plasticity').value='expanded';$('dual1Base').dispatchEvent(new Event('change'));return JSON.parse(localStorage.getItem('fly-dual-preferences-'+labPlatform+'-'+romHash));});
   assert.equal(config.agents[0].trainBase,false);assert.equal(config.agents[1].trainBase,true);assert.equal(config.agents[0].plasticityMode,'root');assert.equal(config.agents[1].plasticityMode,'expanded');
  }
 }
 assert.deepEqual(errors,[]);fs.mkdirSync('ui-preview',{recursive:true});fs.writeFileSync('ui-preview/alpha20-speed.json',JSON.stringify({kind:'real-core-wall-clock-speed',native:'acknowledgement fixtures',rows},null,2));console.log(JSON.stringify(rows));await browser.close();console.log('PASS: measured ×1/×3 on real NES/MD/SNES/GB, pending GPU fixture, overloaded speed honesty, persisted root choice and independent P1/P2 configuration, expanded mode reload and retained thresholds when disabled');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
