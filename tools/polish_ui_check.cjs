'use strict';
// Real production page and Sega WASM; storage bridge fixtures do not claim device testing.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',async route=>{const f=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(f))return route.fulfill({status:404,body:''});await route.fulfill({contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.wasm')?'application/wasm':f.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(f)});});
 const rom=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-sega.json')));rom.name='diagnostic polish';rom.sha256=crypto.createHash('sha256').update(Buffer.from(rom.base64,'base64')).digest('hex');
 await page.exposeFunction('fixtureDemo',()=>page.evaluate(d=>window.labLoadRom(d),rom));
 await page.addInitScript(()=>{
  window.FlyBridge={demo:()=>window.fixtureDemo(),acceptRom(){},stop(){},resume(){},orientation(){}};
 });
 const open=async()=>{await page.goto('https://flyconsole.local/lab/index.html?system=sega');await page.waitForFunction(()=>loaded);};
 await open();await page.evaluate(()=>openGame());
 const cdp=await page.context().newCDPSession(page),point=async selector=>{const r=await page.locator(selector).boundingBox();return{x:r.x+r.width/2,y:r.y+r.height/2};};
 const right=await point('[data-button="7"]'),upperLeft=await point('[data-pad-mask="80"]'),lowerRight=await point('[data-pad-mask="160"]'),action=await point('[data-button="0"]');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...right,id:1}]});await page.waitForFunction(()=>manualMask===128);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...upperLeft,id:1}]});await page.waitForFunction(()=>manualMask===80);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...upperLeft,id:1},{...action,id:2}]});await page.waitForFunction(()=>manualMask===81);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...lowerRight,id:1},{...action,id:2}]});await page.waitForFunction(()=>manualMask===161);
 const frames=await page.evaluate(()=>{const before=frame;advanceFrame(performance.now(),true);return{before,after:frame,applied:appliedMask,coreMask:nes.mask};});assert(frames.after>frames.before);assert.equal(frames.coreMask,161);assert.equal(frames.applied,161,'diagonal and action reach an actual Sega frame');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await page.waitForFunction(()=>manualMask===0);await cdp.detach();
 await page.click('#gameExit');assert(await page.locator('#consoleHeader').isVisible());assert.equal(await page.evaluate(()=>playing),false);await page.evaluate(()=>consoleNavigation.legacy('info'));
 await page.selectOption('#padP1','3');await page.selectOption('#padP2','6');await page.selectOption('#segaRegion','2');
 await page.locator('summary').filter({hasText:'Клавиатура · назначение кнопок'}).click();await page.selectOption('#keyButton','2');await page.click('#bindKey');await page.keyboard.press('a');
 assert.equal(await page.evaluate(()=>keys.KeyA),2);assert.equal(await page.evaluate(()=>keys.KeyD),undefined);
 await page.keyboard.down('a');assert.equal(await page.evaluate(()=>manualMask),0,'settings do not send gameplay keys');await page.keyboard.up('a');
 await page.click('#bindKey');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>keys.KeyA),2,'Escape cancels assignment');
 await page.reload();await page.waitForFunction(()=>loaded);
 assert.equal(await page.inputValue('#padP1'),'3');assert.equal(await page.inputValue('#padP2'),'6');assert.equal(await page.inputValue('#segaRegion'),'2');assert.equal(await page.evaluate(()=>keys.KeyA),2);assert.equal(await page.evaluate(()=>playing),false);
 // A platform switch (page reload) must wait for the asynchronous game save, and abort if it fails.
 await page.evaluate(()=>{window.switchAcks=[];FlyBridge.finishSystemSwitch=(system,okay)=>switchAcks.push({system,okay});window.originalAutosave=labGameStates.autosave;labGameStates.autosave=()=>new Promise(resolve=>{window.releaseSave=resolve;});window.switchJob=labPrepareSystemSwitch('snes');});
 await page.waitForFunction(()=>typeof window.releaseSave==='function');assert.equal(await page.evaluate(()=>switchAcks.length),0,'no reload acknowledgement before save');await page.evaluate(()=>releaseSave(true));await page.evaluate(()=>switchJob);assert.deepEqual(await page.evaluate(()=>switchAcks),[{system:'snes',okay:true}]);
 await page.evaluate(async()=>{labGameStates.autosave=async()=>{throw Error('fixture disk full');};await labPrepareSystemSwitch('gb');labGameStates.autosave=originalAutosave;});assert.deepEqual(await page.evaluate(()=>switchAcks.at(-1)),{system:'gb',okay:false});assert.equal(await page.inputValue('#platformSelect'),'sega');
 await page.evaluate(()=>consoleNavigation.legacy('info'));for(const [width,height]of [[390,844],[844,390],[1280,800]]){await page.setViewportSize({width,height});await page.waitForTimeout(80);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal menu overflow');fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:`ui-preview/material-settings-${width}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: real Sega diagonal drag + multitouch frames, hierarchical pause menu, remap/reload, Sega pad/region retention, platform switch waits for the game save and aborts on failure');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
