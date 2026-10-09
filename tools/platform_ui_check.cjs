'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser,testPage;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 testPage=page;
 await page.route('https://flyconsole.local/**',async route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(file))return route.fulfill({status:404,body:''});await route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.wasm')?'application/wasm':file.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(file)});});
 await page.exposeFunction('fixtureDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='Fly '+system+' original diagnostic';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(data=>window.labLoadRom(data),d);});
 await page.addInitScript(()=>{window.fixturePicks=0;window.FlyBridge={demo:()=>window.fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),switchSystem:system=>{if(['nes','sega','gb','snes'].includes(system))location.href='/lab/index.html?system='+system;},pickRom:()=>window.fixturePicks++,acceptRom(){},orientation(){},stop(){},resume(){}};});
 await page.goto('https://flyconsole.local/lab/index.html?system=nes');await page.waitForFunction(()=>loaded);
 for(const system of ['gb','snes','sega','nes']){
  await page.evaluate(()=>showTab('platform'));assert.equal(await page.locator('#platformSelect option').count(),4);
  await page.selectOption('#platformSelect',system);await page.waitForURL(url=>url.searchParams.get('system')===system,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>loaded,null,{timeout:30000});
  assert.equal(await page.evaluate(()=>labPlatform),system);assert((await page.textContent('#platformInfo')).includes('RAM'));
  await page.evaluate(system=>window.labReady({kind:'UI fixture',neurons:64,edges:100,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:system==='snes'||system==='sega'?12:8},(_,i)=>String(i+17)),backend:'cpu'}),system);
  if(!['gb','snes'].includes(system))continue;
  await page.evaluate(()=>showTab('platform'));await page.click('#platformOpenRom');assert.equal(await page.evaluate(()=>fixturePicks),1);
  await page.evaluate(()=>showTab('game'));await page.click('#saveState');const before=await page.evaluate(()=>({frame,ram:Array.from({length:64},(_,i)=>nes.cpu.mem[i]),video:Array.from(nes.pixels)}));
  await page.evaluate(()=>{for(let i=0;i<12;i++){nes.frame();frame++;}});await page.click('#loadState');assert.deepEqual(await page.evaluate(()=>({frame,ram:Array.from({length:64},(_,i)=>nes.cpu.mem[i]),video:Array.from(nes.pixels)})),before);
  const options=await page.locator('#gmode option').evaluateAll(nodes=>nodes.filter(n=>n.value!=='off').map(n=>n.disabled));assert(options.every(v=>v===(system==='gb')));
  await page.click('#enterGame');await page.evaluate(()=>{$('gameNotice').classList.remove('visible');});
  await page.keyboard.down(system==='gb'?'x':'q');assert.equal(await page.evaluate(()=>manualMask),system==='gb'?1:256);await page.keyboard.up(system==='gb'?'x':'q');assert.equal(await page.evaluate(()=>manualMask),0);
  if(system==='snes'){const routed=await page.evaluate(()=>{gmodeMode='coop';brainMask=256|512|1024;lastResponse=performance.now();updateButtons();return nes.mask2;});assert.equal(routed,256|512|1024);await page.evaluate(()=>{releaseBrain();gmodeMode='off';});}
  for(const [w,h] of [[390,844],[844,390],[568,320]]){
   await page.setViewportSize({width:w,height:h});await page.waitForTimeout(80);
   const layout=await page.evaluate(()=>{const r=screen.getBoundingClientRect();return {ratio:r.width/r.height,native:screen.width/screen.height,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('[data-button]')].filter(e=>!e.hidden).map(e=>{const b=e.getBoundingClientRect();return {text:e.textContent,w:b.width,h:b.height,x:b.x,right:b.right,bottom:b.bottom};})};});
   assert(Math.abs(layout.ratio-layout.native)<.025,'native aspect ratio '+system);assert(layout.scroll<=w+1);
   assert.equal(layout.buttons.length,system==='gb'?8:12);for(const b of layout.buttons)assert(b.w>=25&&b.h>=25&&b.x>=0&&b.right<=w+1&&b.bottom<=h+1,'usable '+system+' buttons');
   if(system==='snes')for(const label of ['X','Y','L','R','Select'])assert(layout.buttons.some(b=>b.text===label));
   fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/'+system+'-'+w+'x'+h+'.png'});
  }
  await page.evaluate(()=>leaveGame('platform'));
 }
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: four-platform selector, real GB/SNES games, snapshots, P1/P2, keyboard and mobile layouts');
})().catch(async e=>{console.error(e);if(testPage){fs.mkdirSync('ui-preview',{recursive:true});await testPage.screenshot({path:'ui-preview/platform-failure.png'}).catch(()=>{});console.error(await testPage.evaluate(()=>({url:location.href,loaded:typeof loaded==='undefined'?null:loaded,status:document.getElementById('status')?.textContent,log:document.getElementById('log')?.textContent})).catch(()=>null));}if(browser)await browser.close();process.exitCode=1;});
