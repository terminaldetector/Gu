'use strict';
// Production UI in Chromium, bridge fixture only; no claim about biological behavior.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets'),demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
let browser;
async function checkHeldTouch(page){
 const cdp=await page.context().newCDPSession(page);
 const point=async(button,id)=>{const r=await page.locator(`[data-button="${button}"]`).boundingBox();return {x:r.x+r.width/2,y:r.y+r.height/2,id};};
 const right=await point(7,1),action=await point(0,2);
 try{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[right]});
  await page.waitForFunction(()=>manualMask===128);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[right,action]});
  await page.waitForFunction(()=>manualMask===129);
  await page.waitForTimeout(1100);
  assert.equal(await page.evaluate(()=>manualMask),129,'long hold keeps direction and action pressed');
  assert.equal(await page.evaluate(()=>getSelection().toString()),'','holding controller text cannot select it');
  // This protocol path names the released contact, not the remaining finger.
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[action]});
  await page.waitForFunction(()=>manualMask===128);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  await page.waitForFunction(()=>manualMask===0);
  const defaults=await page.evaluate(()=>{
   const button=document.querySelector('[data-button="7"]'),field=$('scoreVisible');
   const prevented=['contextmenu','selectstart','dragstart'].every(type=>!button.dispatchEvent(new Event(type,{bubbles:true,cancelable:true})));
   return {prevented,selection:getComputedStyle(button).userSelect,fieldSelection:getComputedStyle(field).userSelect,fieldContext:field.dispatchEvent(new Event('contextmenu',{bubbles:true,cancelable:true}))};
  });
  assert(defaults.prevented,'gamepad blocks native text menu, selection and drag');assert.equal(defaults.selection,'none');
  assert.notEqual(defaults.fieldSelection,'none','settings fields remain selectable');assert(defaults.fieldContext,'settings retain their text context menu');
  await page.mouse.move(right.x,right.y);await page.mouse.down();await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>manualMask),128,'mouse hold remains input');assert.equal(await page.evaluate(()=>getSelection().toString()),'');
  await page.mouse.move(1,1);await page.mouse.up();await page.waitForFunction(()=>manualMask===0);
 }finally{await cdp.detach();}
}
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',async route=>{
  const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
  if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const type=file.endsWith('.wasm')?'application/wasm':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html';
  await route.fulfill({contentType:type,body:fs.readFileSync(file)});
 });
 const segaDemo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-sega.json')));
 await page.exposeFunction('fixtureDemo',system=>page.evaluate(d=>window.labLoadRom({base64:d.base64,name:'Diagnostic / UI fixture',sha256:'fixture'}),system==='sega'?segaDemo:demo));
 await page.addInitScript(()=>{window.FlyBridge={demo:()=>window.fixtureDemo(new URL(location.href).searchParams.get('system')),acceptRom(){},orientation(){},stop(){},resume(){}};});
 await page.goto('https://flyconsole.local/lab/index.html');await page.waitForFunction(()=>loaded);
 await page.evaluate(()=>consoleNavigation.legacy('research'));assert(await page.locator('#agodResearch').isVisible());assert(!await page.locator('#gamePanel').isVisible());
 await page.evaluate(()=>consoleNavigation.legacy('info'));assert(await page.locator('#passport').count());
 const preservation=await page.evaluate(()=>{const before={frame,generation};openGame();leaveGame('research');openGame();return before.frame===frame&&before.generation===generation;});
 assert(preservation,'presentation navigation must not reset the console session');
 await checkHeldTouch(page);
 fs.mkdirSync('ui-preview',{recursive:true});
 for(const [w,h] of [[390,844],[844,390],[360,640],[640,360],[568,320],[1280,800]]){
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(100);
  const boxes=await page.evaluate(()=>{
   const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
   return {canvas:rect(screen),plot:rect($('gamePlot')),toolbar:rect($('gameToolbar')),buttons:[...document.querySelectorAll('[data-button]')].filter(el=>!el.hidden).map(rect),scroll:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight,frame,generation};
  });
  assert(boxes.canvas.w>80&&boxes.canvas.h>80,`usable video ${w}x${h}`);
  assert(Math.abs(boxes.canvas.w/boxes.canvas.h-256/240)<.025,`preserve video ratio ${w}x${h}`);
  assert.equal(boxes.plot.h,0,'research trace is hidden on the default play surface');assert(boxes.toolbar.h<=44,'small game toolbar');
  const plot=boxes.plot,video=boxes.canvas;assert(plot.right<=video.x+1||plot.bottom<=video.y+1||plot.y>=video.bottom-1,'trace does not cover the ROM');
  assert(boxes.scroll<=w+1,`no horizontal overflow ${w}x${h}`);
  for(const b of boxes.buttons)assert(b.w>=25&&b.h>=25&&b.x>=0&&b.right<=w+1&&b.bottom<=h+1,`all human buttons visible ${w}x${h}`);
  await page.evaluate(()=>$('gameNotice').classList.remove('visible'));
  for(const b of boxes.buttons){const p=boxes.plot;assert(b.right<=p.x||b.x>=p.right||b.y>=p.bottom||b.bottom<=p.y,`trace clear of controls ${w}x${h}`);}
  if(w===390||w===844)await page.screenshot({path:`ui-preview/${w>h?'landscape':'portrait'}.png`});
 }
 await page.click('#gameExit');assert(await page.locator('#consoleHeader').isVisible());assert(!await page.locator('#quickMenu').isVisible(),'normal pause menu uses the full-screen hierarchy');await page.screenshot({path:'ui-preview/menu.png'});await page.evaluate(()=>consoleNavigation.legacy('info'));assert(await page.locator('#orientation').isVisible());
 await page.selectOption('#orientation','portrait');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('fly-display')).orientation),'portrait');
 await page.goto('https://flyconsole.local/lab/index.html?system=sega');await page.waitForFunction(()=>loaded,null,{timeout:30000});
 await page.evaluate(()=>openGame());await page.evaluate(()=>{for(let i=0;i<25;i++)nes.frame();$('gameNotice').classList.remove('visible');});
 assert.equal(await page.locator('[data-button="2"]').textContent(),'C','Sega must retain its third game button');
 await checkHeldTouch(page);
 await page.keyboard.down('q');await page.keyboard.down('e');assert.equal(await page.evaluate(()=>manualMask),256|1024,'Sega dedicated keyboard X/Z');await page.keyboard.up('q');assert.equal(await page.evaluate(()=>manualMask),1024,'releasing one key preserves the other');await page.keyboard.up('e');
 await page.evaluate(()=>window.labController({id:5,name:'Fixture pad',mask:512|128,connected:true}));assert.equal(await page.evaluate(()=>manualMask),512|128);await page.evaluate(()=>window.labController({id:5,name:'Fixture pad',mask:0,connected:false}));assert.equal(await page.evaluate(()=>manualMask),0,'disconnected controller releases all inputs');
 const routed=await page.evaluate(()=>{manualMask=256;updateButtons();const ports=[nes.mask,nes.mask2];manualMask=0;updateButtons();return ports;});assert.equal(routed[0],256,'the human X reaches port 1');assert.equal(routed[1],0,'nothing reaches port 2');

 for(const [w,h] of [[390,844],[844,390],[568,320],[640,360]]){
  await page.setViewportSize({width:w,height:h});await page.waitForTimeout(100);
  const video=await page.evaluate(()=>{const r=screen.getBoundingClientRect();return {ratio:r.width/r.height,native:screen.width/screen.height,buttons:[...document.querySelectorAll('[data-button]')].filter(el=>!el.hidden).map(el=>{const b=el.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,w:b.width,h:b.height};})};});
  assert.equal(video.buttons.length,12,'complete Sega action and system pad');for(const b of video.buttons){assert(b.w>=25&&b.h>=25&&b.x>=0&&b.right<=w+1&&b.bottom<=h+1,'Sega buttons visible');}
  assert(Math.abs(video.ratio-video.native)<.025,'Sega dynamic resolution must keep its aspect ratio');
  await page.screenshot({path:`ui-preview/sega-${w>h?'landscape':'portrait'}.png`});
 }
 assert.deepEqual(errors,[],'no JavaScript page errors');
 await browser.close();console.log('PASS: research navigation, clean game composition, held multitouch, state preservation, human-only port 1 and 6 portrait/landscape layouts');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
