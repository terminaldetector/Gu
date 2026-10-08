'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',async route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(file))return route.fulfill({status:404,body:''});await route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':'text/html',body:fs.readFileSync(file)});});
 const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-sega.json')));demo.sha256=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');demo.name='Fly diagnostic';
 await page.exposeFunction('fixtureDemo',()=>page.evaluate(d=>window.labLoadRom(d),demo));
 await page.addInitScript(()=>{window.fixtureConfigurations=[];window.FlyBridge={demo:()=>window.fixtureDemo(),acceptRom(){},stop(){},resume(){},orientation(){},configure:text=>{const c=JSON.parse(text);window.fixtureConfigurations.push(c);window.labConfigured({generation:c.generation,reset:c.reset,configVersion:1,mode:c.mode,backend:c.backend});}};});
 const announce=()=>page.evaluate(()=>window.labReady({kind:'UI fixture',neurons:64,edges:100,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:12},(_,i)=>String(i+17)),backend:'cpu'}));
 await page.goto('https://flyconsole.local/lab/index.html?system=sega');await page.waitForFunction(()=>loaded);await announce();
 await page.click('[data-tab="network"]');
 const expected=await page.evaluate(()=>{
  $('learnMode').value='train';$('mode').value='closed';learner.setActions(FlyGameTools.actions($('actionMasks').value,4095));learner.updates=71;learner.weights[0][0]=.62;
  const sources=ids('inputIds'),targets=ids('outputIds');$('fdbJson').value=JSON.stringify({graph_sha256:graphIdentity.sha256,deltas:[],edges:[{source:sources[0],target:targets[0],weight:4}],growth:{enabled:true,interval:10,perWindow:2,maxEdges:256,initialWeight:8,explore:true,rewardGate:false},growthState:{version:1,windows:44,rng:99,sources,targets,previous:new Array(16).fill(3)}});
  requestedConfiguration=configuration();configurationApplied=true;return {weights:JSON.stringify(learner.weights),frame,fdb:fdbConfiguration()};
 });
 await page.fill('#layerName','MK · раунд 01');await page.fill('#layerNotes','Observed, not a measured benchmark');await page.click('#layerNew');await page.waitForFunction(()=>$('layerStatus').textContent.includes('Сохранён:'));
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('fly-layer-set-'+$('layerSelect').value)));assert.equal(stored.policy.updates,71);assert.equal(stored.configuration.fdb.growthState.windows,44);
 await page.evaluate(()=>{gmodeMode='coop';$('gmode').value='coop';learner.weights[0][0]=-8;$('fdbJson').value='';});
 await page.click('#layerLoad');await page.waitForFunction(()=>$('layerStatus').textContent.includes('Загружен'));
 const restored=await page.evaluate(()=>({weights:JSON.stringify(learner.weights),frame,gmode:gmodeMode,fdb:fdbConfiguration(),playing,connected,start:startSnapshot}));
 assert.equal(restored.weights,expected.weights);assert.equal(restored.frame,expected.frame,'preset load never restores or reloads console');assert.equal(restored.gmode,'coop','trained solo preset is reusable on P2');assert.equal(restored.fdb.growthState.windows,44);assert.equal(restored.connected,false);
 await page.evaluate(()=>connectBrain());const configured=await page.evaluate(()=>fixtureConfigurations.at(-1));assert.equal(configured.reset,false);assert.equal(configured.restoreGrowthState,true,'native must apply saved growth clock even when edge lists match');assert.equal(configured.fdb.growthState.rng,99);
 await page.click('[data-tab="learning"]');await page.locator('#experiencePanel summary').click();await page.fill('#experienceNote','One round reported');await page.click('#experience-win');await page.waitForFunction(()=>$('layerStatus').textContent.includes('Автосохранён'));
 const report=await page.evaluate(()=>JSON.parse(localStorage.getItem('fly-layer-set-'+$('layerSelect').value)));assert.equal(report.journal[0].source,'manual');assert.equal(FlyCounts(report.journal).manual.win,1);
 await page.evaluate(()=>window.labImportModel({type:'fly-layer-set'}));assert((await page.textContent('#layerStatus')).includes('Неверный'));assert.equal(await page.evaluate(()=>learner.updates),71,'invalid imports retain live weights');
 await page.click('[data-tab="network"]');fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/layer-sets.png'});
 await page.reload();await page.waitForFunction(()=>loaded);await announce();await page.click('[data-tab="network"]');await page.waitForFunction(()=>$('layerSelect').options.length===2);await page.selectOption('#layerSelect',stored.id);await page.click('#layerLoad');await page.waitForFunction(()=>$('layerStatus').textContent.includes('Загружен'));assert.equal(await page.evaluate(()=>learner.weights[0][0]),.62,'named weights survive WebView reload');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: production Layer Set UI, Sega XYZ weights/FDB persistence, P2 transfer, no ROM reset, forced growth checkpoint and malformed import preservation');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
function FlyCounts(journal){return require('../app/src/main/assets/lab/layer-sets.js').stats(journal);}
