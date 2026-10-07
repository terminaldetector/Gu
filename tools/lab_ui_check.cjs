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
  window.FlyBridge={acceptRom(){},demo:()=>window.testBridge('demo'),configure:raw=>window.testBridge('configure',raw),sample:raw=>window.testBridge('sample',raw),resume(){},stop(){},pickRom(){},recording(){},exportCsv(){},console(){}};
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
 const regressions=await page.evaluate(()=>{
  window.labPause();
  rgbaAndRetina(new Array(61440).fill(0x0000ff));const color=Array.from(context.getImageData(0,0,1,1).data).slice(0,3);
  $('captureStart').onclick();const x=nes.cpu.mem[0];nes.cpu.mem[0]=17;restartEpisode();const first=nes.cpu.mem[0];nes.cpu.mem[0]=29;restartEpisode();const second=nes.cpu.mem[0];
  const pack=JSON.parse(JSON.stringify(policyPackage(true))),weights=JSON.stringify(learner.weights);learner.reset(99);window.labImportModel(pack);const imported=JSON.stringify(learner.weights)===weights;
  const validNes=nes;window.labLoadRom({base64:'TkVTGgEAAAAAAAAAAAAAAA==',name:'bad',sha256:'bad'});const preserved=loaded&&nes===validNes;
  $('rewardMode').value='manual';$('learnMode').value='train';$('episodeLength').value='10';$('autoEpisode').checked=false;
  learner.reset(1);learner.setActions(FlyGameTools.actions($('actionMasks').value));learningBoundary();connected=true;playing=true;
  for(let i=0;i<10;i++)learnedButtons({buttons:0,outputs:new Array(8).fill(0)});const steps=trials.at(-1).steps;
  $('rewardMode').value='ram';$('rewardAddress').value='0';$('ramWidth').value='1';$('rewardScale').value='1';learningBoundary();nes.cpu.mem[0]=100;nes.cpu.mem[1]=5;learnedButtons({buttons:0,outputs:new Array(8).fill(0)});
  $('rewardAddress').value='1';$('rewardAddress').dispatchEvent(new Event('change'));const boundary=learner.previous===null&&lastRewardValue===null&&learnReward===0&&!connected;
  $('rewardMode').value='manual';$('deathEnabled').checked=true;$('deathAddress').value='20';$('deathValue').value='3';$('deathReward').value='-4';nes.cpu.mem[20]=3;learningBoundary();learnedButtons({buttons:0,outputs:new Array(8).fill(0)});const death=trials.at(-1);
  $('deathEnabled').checked=false;$('winEnabled').checked=true;$('winAddress').value='21';$('winValue').value='7';$('winReward').value='5';nes.cpu.mem[21]=7;learningBoundary();learnedButtons({buttons:0,outputs:new Array(8).fill(0)});const win=trials.at(-1);
  return {color,x,first,second,imported,preserved,steps,boundary,death,win,actions:pack.policy.actions};
 });
 assert.deepEqual(regressions.color,[255,0,0],'NES BGR decodes to actual red');
 assert.equal(regressions.first,regressions.x);assert.equal(regressions.second,regressions.x,'start snapshot remains immutable across restores');
 assert(regressions.imported,'profile+policy import roundtrip');assert(regressions.preserved,'malformed import retains working emulator');
 assert.equal(regressions.steps,10,'exact episode limit');assert(regressions.boundary,'reward edit stops and clears stale transition');
 assert(regressions.death.death&&regressions.death.reward===-4);assert(regressions.win.success&&regressions.win.reward===5);
 assert(regressions.actions.includes(8)&&regressions.actions.includes(4),'Start and Select are available');
 await page.screenshot({path:process.env.UI_SCREENSHOT||'lab-ui-test.png',fullPage:true});
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log('PASS: Java coupling, training/evaluation, BGR, exact episodes, immutable starts, profile import, invalid ROM rollback, reward edits');
 await browser.close();java.stdin.end();
})().catch(e=>{console.error(e);java.kill();process.exit(1);});
