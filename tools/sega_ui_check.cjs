'use strict';
// The Android bridge is replaced by a real Java Engine over a tiny test graph.
// This checks browser protocol/control behavior, not biological validity or Android lifecycle.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {spawn}=require('node:child_process');const readline=require('node:readline');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');const assets=path.join(root,'app/src/main/assets');
const pending=[];
const java=spawn('java',['-cp',process.env.FIXTURE_CLASSPATH,'org.node.flyconsole.FixtureBridge']);
java.stderr.on('data',b=>process.stderr.write(b));
readline.createInterface({input:java.stdout}).on('line',line=>{const next=pending.shift();if(next)next(JSON.parse(line));});
function command(op,data){return new Promise(resolve=>{pending.push(resolve);java.stdin.write(JSON.stringify({op,data})+'\n');});}
const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-sega.json')));
const sha=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',route=>{
  const url=new URL(route.request().url());const file=path.join(assets,url.pathname.substring(1));
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const type=file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'text/html';
  route.fulfill({body:fs.readFileSync(file),contentType:type,headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"}});
 });
 await page.exposeFunction('testBridge',async(op,raw)=>{
  if(op==='demo'){await page.evaluate(data=>window.labLoadRom(data),{base64:demo.base64,name:'Original MD diagnostic',sha256:sha});return;}
  if(op==='configure'){const data=await command('configure',JSON.parse(raw));await page.evaluate(data=>window.labConfigured(data),data);return;}
  if(op==='sample'){const data=await command('sample',JSON.parse(raw));await page.evaluate(data=>window.labResult(data),data);return;}
 });
 await page.addInitScript(()=>{
  window.FlyBridge={acceptRom(){},demo:()=>window.testBridge('demo'),configure:raw=>window.testBridge('configure',raw),sample:raw=>window.testBridge('sample',raw),resume(){},stop(){},pickRom(){},recording(){},exportCsv(){},console(){}};
 });
 await page.goto('https://flyconsole.local/lab/index.html?system=sega');
 await page.waitForFunction(()=>document.getElementById('romName').textContent.includes('Original MD diagnostic'));
 // Instrumentation reads real emulator state; application source is unchanged.
 // Global lexical bindings from classic scripts are available to page evaluation.
 assert.equal(await page.evaluate(()=>nes.fps),60);
 await page.evaluate(()=>window.labReady({neurons:24,edges:16,kind:'TEST FIXTURE / Java LIF',heapMiB:256,inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17))}));
 await page.selectOption('#mode','closed');await page.selectOption('#clock','lockstep');await page.fill('#maxHz','500');await page.fill('#thresholdHz','1');
 await page.click('#brainToggle');await page.waitForFunction(()=>connected);await page.click('#play');await page.waitForTimeout(700);await page.click('#play');
 const score=await page.evaluate(()=>FlyGameTools.readRam(nes.cpu.mem,{address:0,width:2,format:'signed',endian:'big'},65536));assert(score>5,'Sega screen->actual Java spikes->Right->68K RAM');
 await page.getByText('Профиль внешней игры',{exact:true}).click();await page.click('#captureStart');const start=await page.evaluate(()=>nes.cpu.mem[1]);
 await page.evaluate(()=>{nes.buttonDown(1,7);for(let i=0;i<12;i++)nes.frame();});
 await page.evaluate(()=>restartEpisode());assert.equal(await page.evaluate(()=>nes.cpu.mem[1]),start,'Sega episode restores captured RAM');
 await page.selectOption('#learnMode','train');await page.selectOption('#rewardMode','ram');await page.selectOption('#ramFormat','signed');await page.fill('#episodeLength','10');await page.uncheck('#autoEpisode');
 await page.click('#brainToggle');await page.waitForFunction(()=>connected&&!configuring);await page.click('#play');await page.waitForFunction(()=>learner.episodes>=1,null,{timeout:15000});assert((await page.evaluate(()=>learner.updates))>=8);
 const roundtrip=await page.evaluate(()=>{const saved=JSON.parse(JSON.stringify(policyPackage(true))),weights=JSON.stringify(learner.weights);learner.reset(99);window.labImportModel(saved);return JSON.stringify(learner.weights)===weights;});assert(roundtrip,'Sega profile/snapshot/policy roundtrip');
 assert.equal(await page.textContent('[data-button="2"]'),'C');assert.equal(await page.textContent('#navSega'),'2 / SEGA');assert.deepEqual(errors,[]);
 await page.screenshot({path:process.env.UI_SCREENSHOT||'sega-ui.png',fullPage:true});console.log('PASS: browser WASM/CSP, Sega video->Java network->controller/RAM, episode snapshot, training and model import');await browser.close();java.stdin.end();
})().catch(e=>{console.error(e);java.kill();process.exit(1);});
