'use strict';
// Real game cores; native OCR/controller replies and score RAM are explicit fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{const f=path.join(assets,new URL(r.request().url()).pathname.slice(1));return r.fulfill({status:fs.existsSync(f)?200:404,body:fs.existsSync(f)?fs.readFileSync(f):'',contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.wasm')?'application/wasm':'text/html'});});
 const rom=system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));return{...d,name:'diagnostic / regression',sha256:crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex')};};
 await page.exposeFunction('fixtureDemo',system=>page.evaluate(d=>labLoadRom(d),rom(system)));
 await page.addInitScript(()=>{window.ocrQueries=[];window.ocrHold=false;window.FlyBridge={demo:()=>fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},stop(){},resume(){},orientation(){},controls(){},recognizeScore(raw){const q=JSON.parse(raw);ocrQueries.push({token:q.token,frame});if(!ocrHold)setTimeout(()=>labScoreText({token:q.token,candidates:[{digits:'012340',label:'SCORE 012340'},{digits:'999999',label:'HI 999999'}]}),5);}};});
 for(const system of ['nes','sega','snes','gb']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded&&!romLoading);
  // Saved external gamepad mapping changes only the controller, with actual frame delivery.
  await page.evaluate(()=>{openGame();labController({id:7,connected:true,name:'fixture pad',mask:1});});assert.equal(await page.evaluate(()=>manualMask),1);
  await page.selectOption('#controllerAB','swap',{force:true});assert.equal(await page.evaluate(()=>manualMask),2);await page.evaluate(()=>advanceFrame(performance.now()));assert.equal(await page.evaluate(()=>appliedMask),2);
  await page.evaluate(()=>labController({id:7,connected:false,mask:0}));assert.equal(await page.evaluate(()=>manualMask),0);
  // In-game reset calls the existing console path.
  const reset=await page.evaluate(()=>{const n=emulatorRestarts;labQuickMenu();$('quickReset').click();return{frame,restarts:emulatorRestarts-n};});assert.equal(reset.frame,5);assert.equal(reset.restarts,1);await page.click('#quickDismiss');
  // Score finder captures the stopped image and memory of the same actual core frame.
  await page.evaluate(()=>{labPause();consoleNavigation.legacy('research');window.realMemory=nes.cpu.mem;window.scoreFixtureMemory=labPlatform==='nes'?nes.cpu.mem:new Uint8Array(ramLimit);for(let i=160;i<180;i++)scoreFixtureMemory[i]=0;scoreFixtureMemory[171]=0xd2;scoreFixtureMemory[172]=4;nes.cpu.mem=scoreFixtureMemory;});
  await page.click('#scoreFind');await page.waitForFunction(()=>$('scoreNumbers').options.length===2);assert.equal(await page.inputValue('#scoreVisible'),'012340');await page.click('#scoreConfirm');assert(await page.locator('#scoreUse').isDisabled(),'one observation cannot confirm a counter');
  await page.evaluate(()=>{advanceFrame(performance.now());scoreFixtureMemory[171]=0x33;scoreFixtureMemory[172]=11;});await page.click('#scoreTrack');await page.waitForFunction(()=>ocrQueries.length===2&&!$('scoreConfirm').disabled);await page.fill('#scoreVisible','28670');await page.click('#scoreConfirm');assert(await page.locator('#scoreUse').isEnabled(),await page.textContent('#scoreStatus'));await page.click('#scoreUse');await page.waitForFunction(()=>$('scoreStatus').textContent.includes('Счётчик сохранён'));
  const score=await page.evaluate(()=>{const p=scoreSearch.proof();const before=FlyScoreSearch.read(scoreFixtureMemory,p.counter);scoreFixtureMemory[171]=0x34;const after=FlyScoreSearch.read(scoreFixtureMemory,p.counter);return{proof:p,before,after,stored:JSON.parse(localStorage.getItem('fly-score-'+labPlatform+'|'+romHash)),frames:ocrQueries.map(q=>q.frame),scoreUse:$('scoreUse').disabled,reward:typeof window.fdbRewardSnapshot};});
  assert.equal(score.proof.counter.multiplier,10);assert.equal(score.before,28670);assert.equal(score.after,28680,'the confirmed counter reads the live score');assert.equal(score.proof.evidence[0].frame,score.frames[0]);assert.equal(score.proof.evidence[1].frame,score.frames[1]);assert.deepEqual(score.stored,score.proof,'the counter is kept per ROM');assert(score.scoreUse,'a saved counter cannot be saved twice');assert.equal(score.reward,'undefined','a counter is a diagnostic finding, never a reward');
  await page.evaluate(()=>{nes.cpu.mem=realMemory;scoreSearch.forget();});
  // A valid ROM transaction replaces the game.
  const swapped=await page.evaluate(async d=>{await labLoadRom({...d,name:'swapped / regression'});return{loaded,loading:romLoading,name:$('romName').textContent,status:$('status').textContent};},rom(system));assert(swapped.loaded&&!swapped.loading);assert(swapped.name.includes('swapped'));
  const old=await page.evaluate(()=>({hash:romHash,name:$('romName').textContent}));await page.evaluate(()=>labLoadRom({name:'broken',base64:'AAAA',sha256:'a'.repeat(64)}));assert.deepEqual(await page.evaluate(()=>({hash:romHash,name:$('romName').textContent})),old,'invalid ROM preserves prior console');
  await page.evaluate(async d=>{await Promise.all([labLoadRom({...d,name:'superseded'}),labLoadRom({...d,name:'latest'})]);},rom(system));assert((await page.textContent('#romName')).includes('latest'),'latest rapid ROM request wins');
  await page.reload();await page.waitForFunction(()=>loaded&&!romLoading);assert.equal(await page.inputValue('#controllerAB'),'swap','platform-specific controller mapping survives reload');
 }
 // A same-page ROM replacement invalidates an asynchronous OCR result, even with the same hash.
 await page.evaluate(()=>{ocrHold=true;scoreSearch.refresh();});await page.evaluate(()=>{scoreSearch.find();});await page.waitForFunction(()=>ocrQueries.length>0);const query=await page.evaluate(()=>ocrQueries.at(-1));await page.evaluate(async d=>{await labLoadRom(d);},rom('gb'));await page.evaluate(q=>labScoreText({token:q.token,candidates:[{digits:'999999',label:'stale'}]}),query);assert.equal(await page.locator('#scoreNumbers option').count(),0,'stale OCR cannot reach a new ROM');
 // fetch, not navigation: a 404 navigation is a status in Chromium but an error page in Chrome
 const codeLab=await page.evaluate(()=>fetch('/code/index.html').then(r=>r.status));assert.equal(codeLab,404,'the neural code lab (CodeLabActivity) is not shipped');
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: in-game reset, saved gamepad A/B mapping, score counter found from OCR + RAM and kept per ROM as a diagnostic (no reward), failed/rapid ROM replacement and stale OCR exclusion on all real cores, no code lab; native responses are fixtures');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
