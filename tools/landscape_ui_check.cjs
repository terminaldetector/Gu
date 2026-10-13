'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:844,height:390},hasTouch:true,isMobile:true}),errors=[],cases=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',async route=>{const f=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(f))return route.fulfill({status:404,body:''});await route.fulfill({contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.wasm')?'application/wasm':f.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(f)});});
 await page.exposeFunction('fixtureDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='Landscape diagnostic';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>window.labLoadRom(d),d);});
 await page.addInitScript(()=>{window.bridgeCalls=[];window.FlyBridge={demo:()=>window.fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},orientation(){},gameDisplay:v=>bridgeCalls.push('display:'+v),stop:()=>bridgeCalls.push('stop'),resume:()=>bridgeCalls.push('resume'),controls:v=>bridgeCalls.push('controls:'+v),configure:()=>bridgeCalls.push('configure')};});
 const open=async system=>{await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);await page.evaluate(()=>openGame());};
 const setting=async(id,value)=>{await page.evaluate(({id,value})=>{const el=document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=String(value);el.dispatchEvent(new Event('change',{bubbles:true}));},{id,value});await page.waitForTimeout(60);};
 const geometry=async label=>{
  const v=await page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};return{viewport:[innerWidth,innerHeight],scroll:document.documentElement.scrollWidth,canvas:rect(screen),space:rect(screen.parentElement),ratio:screen.width/screen.height,toolbar:rect($('gameToolbar')),monitors:[...$('landscapeHud').children].filter(el=>!el.hidden).map(rect),buttons:[...document.querySelectorAll('#gameToolbar button')].filter(el=>el.getBoundingClientRect().width).map(rect)};});
  assert(v.scroll<=v.viewport[0]+1,label+' no overflow');assert(v.canvas.w>70&&v.canvas.h>60,label+' usable video');assert(Math.abs(v.canvas.w/v.canvas.h-v.ratio)<.025,label+' proportions');
  assert(v.canvas.x>=v.space.x-1&&v.canvas.y>=v.space.y-1&&v.canvas.right<=v.space.right+1&&v.canvas.bottom<=v.space.bottom+1,label+' image stays inside its region');
  assert(v.toolbar.h<=38,label+' compact top row');assert(v.monitors.length<=3,label+' bounded indicators');
  for(const r of [...v.buttons,...v.monitors])assert(r.x>=0&&r.y>=0&&r.right<=v.viewport[0]+1&&r.bottom<=v.viewport[1]+1,label+' bounded toolbar');
  cases.push({label,...v});return v;
 };
 const packet=(connected=true)=>({id:9,name:'Landscape Pad',descriptor:'landscape-pad',mask:connected?130:0,axisMask:connected?128:0,keyMasks:connected?[{code:97,mask:2}]:[],defaults:[{code:97,mask:2,label:'BUTTON_B'}],connected});
 for(const system of ['nes','sega','snes','gb']){
  await open(system);
  for(const [w,h]of [[480,280],[568,320],[844,390],[1024,600]]){
   await page.setViewportSize({width:w,height:h});await page.waitForTimeout(60);const touch=await geometry(system+' compact touch '+w+'x'+h);
   assert(!await page.locator('#liveTrainingBar').isVisible(),'training is collapsed');
   await page.evaluate(d=>labController(d),packet());await page.waitForFunction(()=>document.body.classList.contains('landscape-gamepad'));
   const pad=await geometry(system+' automatic pad '+w+'x'+h);assert(pad.canvas.w*pad.canvas.h>=touch.canvas.w*touch.canvas.h-2,'pad reclaims touch rails');assert(!await page.locator('.controller').isVisible());assert(!await page.locator('.system-pad').isVisible());
   assert.equal(await page.evaluate(()=>manualMask),130);assert((await page.locator('#landscapeP1 span').textContent()).includes('B'),'actual action indicator');
   await page.evaluate(d=>labController(d),packet(false));await page.waitForFunction(()=>!document.body.classList.contains('landscape-gamepad'));assert(await page.locator('.controller').isVisible());assert.equal(await page.evaluate(()=>manualMask),0,'disconnect releases inputs');
  }
 }
 await open('sega');await page.setViewportSize({width:844,height:390});
 await setting('uiLandscapePanel','full');const full=await page.locator('#screen').boundingBox();await setting('uiLandscapePanel','compact');const compact=await geometry('one row replaces two rows');assert(compact.canvas.w*compact.canvas.h>full.width*full.height*1.08,'compact panel materially enlarges this view');
 await page.evaluate(()=>{learner.weights[0][0]=.625;learner.updates=27;$('fdbJson').value=JSON.stringify({deltas:[],edges:[{source:'1',target:'2',weight:7}]});window.beforeLayout={weights:JSON.stringify(learner.weights),updates:learner.updates,fdb:$('fdbJson').value,positions:JSON.stringify(JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega'))).layouts)};bridgeCalls.length=0;});
 await setting('uiLandscapeLayout','overlay');await geometry('overlay controls use full image region');
 await setting('uiLandscapeScale',.7);await setting('uiLandscapeX',1);await setting('uiLandscapeY',-1);await geometry('smaller shifted image remains inside');
 await setting('uiLandscapeMonitorPosition','bottom');await geometry('bottom indicators');
 await setting('uiLandscapeInput','gamepad');await geometry('forced pad without connected device');assert(!await page.locator('.controller').isVisible());
 await setting('uiVisible',false);await setting('uiLandscapeInput','touch');assert(await page.locator('.controller').isVisible(),'explicit landscape touch view overrides inherited hidden pad');await setting('uiLandscapeInput','gamepad');await setting('uiVisible',true);
 await page.evaluate(()=>userInterface.layout());assert(await page.evaluate(()=>bridgeCalls.includes('display:true'))===false,'unchanged immersive state avoids repeated native calls');
 await setting('uiLandscapeFullscreen',false);assert(await page.evaluate(()=>bridgeCalls.filter(v=>v.startsWith('display:')).at(-1)==='display:false'));await setting('uiLandscapeFullscreen',true);assert(await page.evaluate(()=>bridgeCalls.filter(v=>v.startsWith('display:')).at(-1)==='display:true'));
 await page.click('#landscapeTraining');assert(await page.locator('#liveTrainingBar').isVisible());assert(await page.locator('#liveAuto').isVisible());await page.keyboard.press('Escape');assert(!await page.locator('#liveTrainingBar').isVisible());
 await page.click('#landscapeTraining');await page.click('#gameExit');assert(!await page.locator('#liveTrainingBar').isVisible());await page.click('#quickDismiss');
 await setting('uiLandscapeMonitors',0);assert.equal(await page.locator('#landscapeHud > :visible').count(),0);await setting('uiLandscapeMonitors',3);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega'))));assert.equal(saved.version,2);
 assert.equal(await page.evaluate(()=>JSON.stringify(learner.weights)),await page.evaluate(()=>beforeLayout.weights));assert.equal(await page.evaluate(()=>learner.updates),27);assert.equal(await page.inputValue('#fdbJson'),await page.evaluate(()=>beforeLayout.fdb));assert.equal(JSON.stringify(saved.layouts),await page.evaluate(()=>beforeLayout.positions));assert(!await page.evaluate(()=>bridgeCalls.includes('configure')),'layout never reconfigures connectome');
 await page.evaluate(()=>leaveGame('info'));assert.equal(await page.evaluate(()=>bridgeCalls.filter(v=>v.startsWith('display:')).at(-1)),'display:false','settings restore system bars');
 await page.reload();await page.waitForFunction(()=>loaded);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega')))),saved);await page.evaluate(()=>openGame());await geometry('restored customized landscape');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(60);assert(await page.locator('.controller').isVisible(),'portrait keeps its touch controls');assert(!await page.locator('#landscapeHud').isVisible());assert.equal(await page.evaluate(()=>bridgeCalls.filter(v=>v.startsWith('display:')).at(-1)),'display:false','portrait restores system bars');assert.equal(await page.inputValue('#uiVideoScale'),'1','landscape size never changes portrait');
 await page.setViewportSize({width:844,height:390});await page.waitForTimeout(60);await page.click('#gameExit');await page.click('#quickTouchEdit');assert(!await page.evaluate(()=>document.body.classList.contains('landscape-gamepad')));assert(await page.locator('.controller').isVisible(),'editor always exposes touch controls');assert.equal(await page.evaluate(()=>playing||connected),false);await page.click('#touchEditorDone');assert(!await page.locator('.controller').isVisible());
 await setting('uiLandscapeFit','fit');await setting('uiLandscapeScale',1);await setting('uiLandscapeX',0);await setting('uiLandscapeY',0);await setting('uiLandscapeMonitorPosition','top');
 await page.evaluate(()=>{learner.updates=27;$('fdbJson').value=JSON.stringify({deltas:[],edges:[{source:'1',target:'2',weight:7}]});gmodeMode='coop-reverse';manualMask=130;brainMask=1;updateButtons();updateGmodeHud();});assert((await page.locator('#landscapeP1 span').textContent()).includes('A'));assert((await page.locator('#landscapeP2 span').textContent()).includes('B'),'human P2 indicator follows actual reversed port');
 const frame=await page.evaluate(()=>frame);await page.click('#landscapePlay');await page.waitForFunction(()=>playing);await page.click('#landscapePlay');assert.equal(await page.evaluate(()=>playing),false);assert(await page.evaluate(()=>frame)>frame,'compact start/pause runs real core frames');
 await page.click('#landscapeReset');assert.equal(await page.evaluate(()=>playing||connected),false);assert.equal(await page.evaluate(()=>learner.updates),27);assert.equal(await page.inputValue('#fdbJson'),JSON.stringify({deltas:[],edges:[{source:'1',target:'2',weight:7}]}),'game reset retains FDB');
 fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/landscape-gamepad.png'});await setting('uiLandscapeInput','touch');await page.screenshot({path:'ui-preview/landscape-touch.png'});
 assert.deepEqual(errors,[]);fs.writeFileSync('ui-preview/landscape-final.json',JSON.stringify({scope:'Production UI and real cores; native/controller/model bridge fixtures; physical Android bars not certified',cases,errors},null,2));
 await browser.close();console.log('PASS: compact landscape, real port indicators, automatic/forced pad, disconnect, portrait isolation, offsets, persistence, editor override, reset retention and immersive bridge transitions');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
