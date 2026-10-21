'use strict';
// Production layout and actual NES/MD cores. Graph/device metadata are explicit UI fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:406,height:846},isMobile:true,hasTouch:true}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://flyconsole.local/**',route=>{const p=path.join(assets,new URL(route.request().url()).pathname.slice(1));return route.fulfill({status:fs.existsSync(p)?200:404,body:fs.existsSync(p)?fs.readFileSync(p):'',contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.wasm')?'application/wasm':p.endsWith('.json')?'application/json':'text/html'});});
 await page.exposeFunction('rotationDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='Portrait rotation fixture';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>labLoadRom(d),d);});
 await page.addInitScript(()=>{window.rotationBridge=[];window.FlyBridge={demo:()=>rotationDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},orientation(){},controls(){},stop(){},resume(){},gameDisplay:value=>rotationBridge.push(value),configure:()=>{throw Error('Layout must not configure the graph');}};});
 const setting=async(id,value)=>page.evaluate(({id,value})=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('change'));},{id,value});
 const packet=(id,mask=0,virtual=false)=>({id,mask,axisMask:mask&240,keyMasks:mask&2?[{code:97,mask:2}]:[],defaults:[{code:97,mask:2,label:'BUTTON_B'}],connected:true,descriptor:'rotation-device-'+id,name:id===5?'Neutral system input fixture':'Physical gamepad fixture',virtual});
 const checkPortrait=async label=>{
  const state=await page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height};};return{viewport:[innerWidth,innerHeight],scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],video:rect(screen),ratio:screen.width/screen.height,buttons:[...document.querySelectorAll('.controller button,.system-pad button')].filter(el=>!el.hidden&&el.getClientRects().length).map(rect)};});
  assert.equal(state.buttons.length,await page.evaluate(()=>buttonNames.length+4),label+' complete touch controls, including four diagonals');
  assert(state.video.w>100&&state.video.h>100,label+' usable video');assert(Math.abs(state.video.w/state.video.h-state.ratio)<.025,label+' video proportions');
  for(const r of [state.video,...state.buttons])assert(r.x>=-1&&r.y>=-1&&r.right<=state.viewport[0]+1&&r.bottom<=state.viewport[1]+1,label+' bounded controls/video');
  assert(state.scroll[0]<=state.viewport[0]+1&&state.scroll[1]<=state.viewport[1]+1,label+' no page scrolling');
 };
 for(const system of ['nes','sega']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded&&!romLoading&&window.userInterface);await page.evaluate(()=>{openGame();labPause();});
  await checkPortrait(system+' initial portrait');
  await page.evaluate(d=>labController(d),packet(5));await page.setViewportSize({width:862,height:406});await page.waitForTimeout(80);
  assert(await page.locator('.controller').isVisible(),'neutral system enumeration does not remove touch controls');assert(!await page.evaluate(()=>document.body.classList.contains('landscape-gamepad')));
  await page.evaluate(d=>labController(d),packet(5,130,true));await page.waitForTimeout(50);assert(await page.locator('.controller').isVisible(),'virtual gamepad input remains usable without automatic touch removal');assert.equal(await page.evaluate(()=>manualMask),130);await page.evaluate(d=>labController(d),packet(5,0,true));
  await page.evaluate(d=>labController(d),packet(7));await page.waitForTimeout(50);assert(await page.locator('.controller').isVisible(),'even a neutral physical enumeration keeps touch until actual use');
  await page.evaluate(d=>labController(d),packet(7,130));await page.waitForFunction(()=>document.body.classList.contains('landscape-gamepad'));assert(!await page.locator('.controller').isVisible(),'actual gamepad use reclaims landscape space');assert.equal(await page.evaluate(()=>selectedController),7,'actual input replaces the neutral service device in automatic selection');assert.equal(await page.evaluate(()=>manualMask),130);
  await page.evaluate(d=>labController(d),packet(5));assert.equal(await page.evaluate(()=>selectedController),7,'neutral service announcements cannot steal a used controller');assert.equal(await page.evaluate(()=>manualMask),130);
  await page.evaluate(()=>{const before=frame;advanceFrame(performance.now(),true);if(frame<=before||appliedMask!==130)throw Error('Physical fixture must reach a real emulated frame');});
  await page.evaluate(d=>labController(d),packet(7,0));
  // Android may resize CSS before the queued profile callback runs. Simulate that ordering.
  await page.evaluate(()=>{window.rotationRAF=requestAnimationFrame;window.rotationPending=[];window.requestAnimationFrame=callback=>{rotationPending.push(callback);return rotationPending.length;};});
  await page.setViewportSize({width:406,height:846});await page.waitForTimeout(40);
  assert(await page.evaluate(()=>document.body.classList.contains('landscape-gamepad')),'fixture retains the old profile until queued layout');
  await checkPortrait(system+' portrait before deferred profile callback');
  await page.evaluate(async()=>{const announce=(modelId,sha)=>labReady({modelId,kind:'rotation graph metadata fixture',neurons:32,edges:64,heapMiB:512,graph_sha256:sha.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'});await announce('flywire-v783','b');await labState.settle();await announce('male-cns-v1.0','c');await labState.settle();});
  await checkPortrait(system+' graph change while portrait layout is deferred');
  await page.evaluate(()=>{window.requestAnimationFrame=rotationRAF;for(const callback of rotationPending.splice(0))rotationRAF(callback);});await page.waitForTimeout(80);assert(!await page.evaluate(()=>document.body.classList.contains('landscape-gamepad')));await checkPortrait(system+' settled portrait');
  fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/rotation-'+system+'-portrait.png'});
  // Explicit preferences remain authoritative and each orientation keeps its own layout.
  await setting('uiLandscapeInput','gamepad');await page.setViewportSize({width:862,height:406});await page.waitForTimeout(60);assert(!await page.locator('.controller').isVisible());await page.evaluate(()=>labController({id:7,mask:0,connected:false}));await setting('uiLandscapeInput','auto');await page.waitForTimeout(60);assert(await page.locator('.controller').isVisible(),'disconnect restores touch despite a remaining neutral system device');
  await page.setViewportSize({width:406,height:846});await page.waitForTimeout(60);await checkPortrait(system+' final roundtrip');assert.equal(await page.evaluate(()=>rotationBridge.at(-1)),false,'portrait restores native system bars');
 }
 assert.deepEqual(errors,[]);await browser.close();browser=null;
 console.log('PASS: actual NES/MD portrait-landscape-portrait, deferred profile/graph-change restoration, neutral and virtual device handling, real gamepad auto-selection/input/disconnect, explicit preference preservation and bounded video/controls; native graph/device replies are fixtures');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
