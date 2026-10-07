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
const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
const sha=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',route=>{
  const url=new URL(route.request().url());const file=path.join(assets,url.pathname.substring(1));
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const type=file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'text/html';
  route.fulfill({body:fs.readFileSync(file),contentType:type,headers:{'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"}});
 });
 await page.exposeFunction('testBridge',async(op,raw)=>{
  if(op==='demo'){await page.evaluate(data=>window.labLoadRom(data),{base64:demo.base64,name:'Original diagnostic ROM',sha256:sha});return;}
  if(op==='configure'){const data=await command('configure',JSON.parse(raw));await page.evaluate(data=>window.labConfigured(data),data);return;}
  if(op==='sample'){const data=await command('sample',JSON.parse(raw));await page.evaluate(data=>window.labResult(data),data);return;}
 });
 await page.addInitScript(()=>{
  window.FlyBridge={demo:()=>window.testBridge('demo'),configure:raw=>window.testBridge('configure',raw),sample:raw=>window.testBridge('sample',raw),resume(){},stop(){},pickRom(){},recording(){},exportCsv(){},console(){}};
 });
 await page.goto('https://flyconsole.local/lab/index.html');
 await page.waitForFunction(()=>document.getElementById('romName').textContent.includes('Original diagnostic'));
 // Instrumentation reads real emulator state; application source is unchanged.
 // Global lexical bindings from classic scripts are available to page evaluation.
 assert.equal(await page.evaluate(()=>nes.cpu.mem[0]),120);
 await page.evaluate(()=>window.labReady({neurons:24,edges:16,kind:'TEST FIXTURE / Java LIF',heapMiB:256,inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17))}));
 await page.selectOption('#mode','closed');await page.selectOption('#clock','lockstep');
 await page.fill('#maxHz','500');await page.fill('#thresholdHz','1');
 await page.click('#brainToggle');await page.waitForFunction(()=>connected);
 await page.click('#play');await page.waitForTimeout(900);
 assert((await page.evaluate(()=>nes.cpu.mem[0]))>120,'screen -> Java spikes -> Right -> sprite motion');
 assert(Number(await page.textContent('#spikes'))>0,'real engine telemetry');
 await page.click('#play');await page.waitForFunction(()=>pendingToken===null);
 const before=await page.evaluate(()=>nes.cpu.mem[0]);
 await page.selectOption('#mode','observe');await page.click('#apply');await page.waitForFunction(()=>!configuring);
 await page.click('#brainToggle');await page.waitForFunction(()=>connected);await page.click('#play');await page.waitForTimeout(400);await page.click('#play');
 assert(Math.abs((await page.evaluate(()=>nes.cpu.mem[0]))-before)<=1,'observe cannot drive buttons');
 await page.selectOption('#mode','closed');await page.locator('#gain').evaluate(el=>{el.value='0';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.click('#apply');await page.waitForFunction(()=>!configuring);
 await page.click('#brainToggle');await page.waitForFunction(()=>connected);await page.click('#play');await page.waitForTimeout(400);await page.click('#play');
 assert.equal(await page.evaluate(()=>brainMask),0,'gain zero stops motor output');
 await page.click('#saveState');const saved=await page.evaluate(()=>nes.cpu.mem[0]);
 await page.locator('[data-button=\"7\"]').hover();await page.mouse.down();
 await page.evaluate(()=>{for(let i=0;i<8;i++)advanceFrame(performance.now());});
 await page.mouse.up();
 assert((await page.evaluate(()=>nes.cpu.mem[0]))>saved,'manual controller works');
 await page.click('#loadState');await page.waitForFunction(()=>!configuring);
 assert.equal(await page.evaluate(()=>nes.cpu.mem[0]),saved,'NES snapshot restores position');
 await page.click('#resetNes');await page.waitForFunction(()=>!configuring);
 assert.equal(await page.evaluate(()=>nes.cpu.mem[0]),120,'reset releases held controller input');
 assert.equal(await page.evaluate(()=>nes.cpu.mem[1]),100);
 await page.evaluate(()=>window.labError({message:'Test error'}));
 assert.equal(await page.evaluate(()=>brainMask),0);assert.equal(await page.evaluate(()=>connected),false);
 assert.equal(await page.locator('#outputs .on').count(),0);
 await page.selectOption('#learnMode','train');await page.fill('#episodeLength','10');await page.uncheck('#autoEpisode');
 await page.click('#brainToggle');await page.waitForFunction(()=>connected&&!configuring);await page.click('#play');
 await page.waitForFunction(()=>learner.episodes>=1,{timeout:15000});
 assert((await page.evaluate(()=>learner.updates))>=8,'real UI learns from Java neural features');
 await page.click('#savePolicy');const weights=await page.evaluate(()=>JSON.stringify(learner.weights));
 await page.click('#clearPolicy');await page.click('#loadPolicy');assert.equal(await page.evaluate(()=>JSON.stringify(learner.weights)),weights,'UI policy restores');
 await page.selectOption('#learnMode','eval');const updates=await page.evaluate(()=>learner.updates);
 await page.click('#brainToggle');await page.waitForFunction(()=>connected&&!configuring);await page.click('#play');await page.waitForFunction(()=>learner.episodes>=2,{timeout:15000});
 assert.equal(await page.evaluate(()=>learner.updates),updates,'evaluation does not train');
 await page.screenshot({path:process.env.UI_SCREENSHOT||'lab-ui-test.png',fullPage:true});
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log('PASS: mobile UI, real screen->Java Engine->NES movement, observe, gain=0, snapshots, reset, errors');
 await browser.close();java.stdin.end();
})().catch(e=>{console.error(e);java.kill();process.exit(1);});
