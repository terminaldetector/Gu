'use strict';
// Real frontend/NES frames; synthetic native replies test presentation/protocol only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets'),demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
const sha=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',async route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(file))return route.fulfill({status:404,body:''});const mime=file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/json';await route.fulfill({contentType:mime,body:fs.readFileSync(file)});});
 await page.exposeFunction('fixtureDemo',()=>page.evaluate(d=>window.labLoadRom(d),{...demo,name:'diagnostic / presentation fixture',sha256:sha}));
 await page.addInitScript(()=>{
  window.dualFixtureRequests=[];let agents=[],session='fixture-session';
  const receive=(name,q,more={})=>setTimeout(()=>window[name]({...q,sessionId:session,ok:true,agents,...more}),5);
  window.FlyBridge={demo:()=>window.fixtureDemo(),acceptRom(){},stop(){},resume(){},orientation(){},controls(){},
   dualConfigure(raw){const q=JSON.parse(raw);window.dualFixtureRequests.push({op:'configure',...q});agents=q.agents.map((a,i)=>({id:a.id,modelId:a.modelId,graphSha256:String(i+1).repeat(64),neurons:64,edges:0,layerId:'fixture-'+a.id,revision:0,memoryBytes:4096,saved:true,fdbState:{deltas:[],edges:[],learningState:{automatic:0}}}));receive('labDualReady',q,{paused:true,singleResetRequired:true,estimatedBytes:8192,heapAvailableBytes:1048576});},
   dualSample(raw){const q=JSON.parse(raw);window.dualFixtureRequests.push({op:'sample',...q});receive('labDualResult',q,{wallMs:2,agents:agents.map((a,i)=>({...a,spikes:0,active:0,decision:{id:session+':'+a.id+':'+q.frame,mask:i?64:128},neuralGroups:Array.from({length:16},()=>({hz:0,spikes:0,active:0,neurons:4}))}))});},
   dualBoundary(raw){const q=JSON.parse(raw);window.dualFixtureRequests.push({op:'boundary',...q});receive('labDualBoundary',q);},
   dualExit(raw){const q=JSON.parse(raw);window.dualFixtureRequests.push({op:'exit',...q});receive('labDualExited',q);}
  };
 });
 await page.goto('https://flyconsole.local/lab/index.html');await page.waitForFunction(()=>loaded);
 await page.evaluate(()=>window.labReady({modelId:'flywire-v783',kind:'64-node presentation fixture',neurons:64,edges:0,graph_sha256:'1'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17)),heapMiB:512,backend:'cpu'}));
 await page.click('[data-tab="network"]');await page.locator('#dualPanel > summary').click();await page.selectOption('#dual1Model','flywire-v783');await page.selectOption('#dual2Model','male-cns-v1.0');await page.click('#dualStart');
 await page.waitForFunction(()=>window.dualFixtureRequests.filter(q=>q.op==='sample').length>=3).catch(async e=>{console.error(await page.evaluate(()=>({status:$('dualStatus').textContent,error:dualAgents.error(),requests:dualFixtureRequests,frame,playing})));throw e;});
 const live=await page.evaluate(()=>({frame,masks:appliedDualMasks.slice(),samples:dualFixtureRequests.filter(q=>q.op==='sample'),p1:$('gmodeLeft').textContent,p2:$('gmodeRight').textContent,running:dualAgents.running()}));
 assert(live.frame>5&&live.running);assert.deepEqual(live.masks,[128,64]);assert.equal(live.p1,'P1 · FlyWire');assert.equal(live.p2,'P2 · Male CNS');
 const credit=live.samples.find(q=>q.agents.every(a=>a.outcome));assert(credit,'actual decisions acquire frame outcomes');assert.equal(credit.agents[0].outcome.frames,credit.agents[1].outcome.frames);assert.equal(credit.agents[0].outcome.mask,128);assert.equal(credit.agents[1].outcome.mask,64);
 await page.evaluate(()=>{window.labPause();leaveGame('network');});await page.waitForFunction(()=>!dualAgents.running());fs.mkdirSync('ui-preview',{recursive:true});
 for(const [w,h]of [[390,844],[844,390],[360,640]]){await page.setViewportSize({width:w,height:h});await page.waitForTimeout(80);assert(await page.locator('#dual1Model').isVisible());assert(await page.locator('#dual2Model').isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'dual cards have no horizontal overflow');await page.screenshot({path:`ui-preview/dual-models-${w}x${h}.png`,fullPage:true});}
 assert.equal(await page.evaluate(()=>dualAgents.exit()),true);assert(await page.evaluate(()=>dualFixtureRequests.some(q=>q.op==='exit')));assert.equal(await page.evaluate(()=>dualAgents.active()),false);assert.deepEqual(errors,[]);
 await browser.close();console.log('PASS: production dual model cards, real single NES frame clock, independent action outcomes, paused layout and acknowledged exit (native reply fixture only)');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
