'use strict';
// Actual emulator cores and production UI. Android bridge fixtures exercise input routing, not hardware.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser,testPage;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[],evidence=[];page.on('pageerror',e=>errors.push(e.message));
 testPage=page;
 await page.route('https://flyconsole.local/**',async route=>{const f=path.join(assets,new URL(route.request().url()).pathname.slice(1));if(!fs.existsSync(f))return route.fulfill({status:404,body:''});await route.fulfill({contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.wasm')?'application/wasm':f.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(f)});});
 await page.exposeFunction('fixtureDemo',system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.name='UI control diagnostic';d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>window.labLoadRom(d),d);});
 await page.addInitScript(()=>{window.bridgeCalls=[];window.FlyBridge={demo:()=>window.fixtureDemo(new URL(location.href).searchParams.get('system')||'nes'),acceptRom(){},orientation(){},stop:()=>bridgeCalls.push('stop'),resume:()=>bridgeCalls.push('resume'),controls:v=>bridgeCalls.push('controls:'+v),configure:()=>bridgeCalls.push('configure')};});
 const open=async system=>{await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);};
 const verifyGeometry=async label=>{
  const v=await page.evaluate(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};return{width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('[data-button],[data-pad-mask]')].filter(el=>!el.hidden).map(rect),canvas:rect(screen),ratio:screen.width/screen.height};});
  assert(v.scroll<=v.width+1,label+' no horizontal overflow');assert(v.canvas.w>70&&v.canvas.h>60,label+' usable video');assert(Math.abs(v.canvas.w/v.canvas.h-v.ratio)<.025,label+' aspect ratio');
  for(const r of v.buttons)assert(r.w>=20&&r.h>=25&&r.x>=0&&r.y>=0&&r.right<=v.width+1&&r.bottom<=v.height+1,label+' visible buttons '+JSON.stringify(r));
  evidence.push({label,viewport:[v.width,v.height],canvas:v.canvas,buttons:v.buttons.length});
 };
 const drag=async(selector,x,y)=>{const r=await page.locator(selector).boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(x,y,{steps:6});await page.mouse.up();};
 for(const system of ['nes','sega','gb','snes']){
  await open(system);await page.evaluate(()=>openGame());
  for(const [w,h]of [[280,480],[320,480],[360,640],[390,844],[480,280],[568,320],[640,360],[844,390],[1280,800]]){await page.setViewportSize({width:w,height:h});await page.waitForTimeout(80);await verifyGeometry(system+' default '+w+'x'+h);}
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>leaveGame('info'));
  await page.selectOption('#touchScale','1.4');await page.fill('#uiGap','14');await page.locator('#uiGap').blur();
  for(const id of ['uiActionScale','uiDpadScale'])await page.locator('#'+id).evaluate(el=>{el.value='1.5';el.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.evaluate(()=>openGame());for(const [w,h]of [[280,480],[568,320]]){await page.setViewportSize({width:w,height:h});await page.waitForTimeout(80);await verifyGeometry(system+' maximum size '+w+'x'+h);}
  await page.evaluate(()=>leaveGame('info'));await page.click('#resetInterface');
 }
 await open('sega');await page.setViewportSize({width:390,height:844});await page.click('[data-tab="info"]');
 for(const id of ['settings-display','settings-touch','settings-pad','settings-keyboard','settings-console','settings-appearance'])assert(await page.locator('#'+id).count());
 await page.selectOption('#touchScale','.7');await page.selectOption('#uiShape','square');await page.selectOption('#uiTheme','light');await page.selectOption('#uiAccent','blue');await page.selectOption('#uiDensity','compact');
 await page.locator('#uiOpacity').evaluate(el=>{el.value='.5';el.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.evaluate(()=>{learner.weights[0][0]=.625;learner.updates=27;$('fdbJson').value=JSON.stringify({deltas:[],edges:[{source:'1',target:'2',weight:7}]});window.beforeUI={frame,weights:JSON.stringify(learner.weights),updates:learner.updates,fdb:$('fdbJson').value};bridgeCalls.length=0;});
 await page.click('#editTouch');assert.equal(await page.evaluate(()=>userInterface.editing()),true);assert.equal(await page.evaluate(()=>playing||connected),false);
 await drag('.dpad',130,380);const portrait=await page.evaluate(()=>JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega'))).layouts.portrait);assert(portrait.dpad);
 await page.selectOption('#touchEditorMode','buttons');await drag('[data-button="0"]',220,430);
 const beforeGroup=await page.locator('[data-button="0"]').boundingBox();await page.selectOption('#touchEditorMode','groups');await drag('[data-button="0"]',beforeGroup.x+beforeGroup.width/2-20,beforeGroup.y+beforeGroup.height/2-20);
 const afterGroup=await page.locator('[data-button="0"]').boundingBox();assert(Math.abs(afterGroup.x-beforeGroup.x)+Math.abs(afterGroup.y-beforeGroup.y)>10,'group move carries independently placed children');
 await page.selectOption('#touchEditorMode','buttons');await drag('[data-button="0"]',220,430);
 assert.equal(await page.evaluate(()=>manualMask),0,'dragging never presses console inputs');await page.keyboard.press('z');assert.equal(await page.evaluate(()=>manualMask),0,'editor keyboard cannot demonstrate actions');
 assert.equal(await page.evaluate(()=>frame),await page.evaluate(()=>beforeUI.frame),'no emulated frame runs in editor');
 assert.equal(await page.evaluate(()=>JSON.stringify(learner.weights)),await page.evaluate(()=>beforeUI.weights));assert.equal(await page.evaluate(()=>learner.updates),27);assert.equal(await page.inputValue('#fdbJson'),await page.evaluate(()=>beforeUI.fdb));assert(!await page.evaluate(()=>bridgeCalls.includes('configure')),'UI never reconfigures the model');
 await page.click('#touchEditorDone');assert.equal(await page.evaluate(()=>userInterface.editing()),false);assert.equal(await page.evaluate(()=>playing),false);await verifyGeometry('sega customized portrait');
 const position=await page.locator('[data-button="0"]').boundingBox();assert(position.x>160&&position.y>300,'individual drag has real effect');
 await page.setViewportSize({width:568,height:320});await page.waitForTimeout(80);await verifyGeometry('sega fresh landscape');
 await page.click('#gameExit');await page.click('#quickTouchEdit');await drag('.actions',475,175);await page.click('#touchEditorDone');
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega'))));assert(saved.layouts.landscape.actions);assert(saved.layouts.portrait.buttons['0']);
 await page.reload();await page.waitForFunction(()=>loaded);await page.evaluate(()=>openGame());assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem(FlyInterfaceSettings.key('sega')))),saved);assert.equal(await page.inputValue('#touchScale'),'.7','legacy display preferences restore small sizes');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(80);const restored=await page.locator('[data-button="0"]').boundingBox();assert(Math.abs(restored.x-position.x)<2&&Math.abs(restored.y-position.y)<2,'position reproduces after reload/rotation');
 await page.setViewportSize({width:280,height:480});await page.waitForTimeout(80);await verifyGeometry('sega customized smaller screen');
 await page.evaluate(()=>leaveGame('info'));await page.check('#uiLeftHanded');await page.click('#resetTouchLayout');await page.evaluate(()=>openGame());
 const handed=await page.evaluate(()=>({d:document.querySelector('.dpad').getBoundingClientRect().x,a:document.querySelector('.actions').getBoundingClientRect().x}));assert(handed.d>handed.a,'left-handed groups are swapped');
 await page.evaluate(()=>leaveGame('info'));await page.uncheck('#uiVisible');await page.evaluate(()=>openGame());assert(!await page.locator('.dpad').isVisible());assert((await page.locator('.controller').boundingBox())===null,'hidden pad frees image space');await page.evaluate(()=>leaveGame('info'));await page.click('#editTouch');assert(await page.locator('.dpad').isVisible(),'hidden buttons can still be edited');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>userInterface.editing()),false);assert(!await page.locator('.dpad').isVisible());
 // Real pad packets: custom trigger -> B, all defaults retained/released, stable descriptor across IDs.
 await page.evaluate(()=>leaveGame('info'));await page.click('#resetInterface');
 const packet=(id,code=null,pressed=false,mask=0,axisMask=0)=>({id,name:'Test Pad',descriptor:'test:stable-pad',mask,axisMask,keyMasks:code===null?[]:[{code,mask:code===96?1:code===97?2:0}],defaults:[{code:96,mask:1,label:'BUTTON_A'},{code:97,mask:2,label:'BUTTON_B'},{code:104,mask:0,label:'BUTTON_L2'}],connected:true,...(code===null?{}:{keyCode:code,pressed})});
 await page.evaluate(d=>labController(d),packet(5));await page.selectOption('#padBindingTarget','1');await page.click('#bindPhysicalPad');await page.evaluate(d=>labController(d),packet(5,104,true));
 assert.equal(await page.evaluate(()=>userInterface.binding()),false);assert.equal(await page.evaluate(()=>manualMask),0);assert.equal(await page.inputValue('#controllerAB'),'direct');
 await page.evaluate(()=>openGame());await page.evaluate(d=>labController(d),packet(5,104,true,128,128));assert.equal(await page.evaluate(()=>manualMask),130);
 const actual=await page.evaluate(()=>{advanceFrame(performance.now(),true);return nes.mask;});assert.equal(actual,130,'remapped trigger+direction reaches an actual Sega frame');
 await page.evaluate(d=>labController(d),packet(5,97,true,2));assert.equal(await page.evaluate(()=>manualMask),0,'replaced default B is released');
 await page.evaluate(()=>labController({id:5,mask:0,connected:false}));assert.equal(await page.evaluate(()=>manualMask),0);await page.evaluate(d=>labController(d),packet(99,104,true));assert.equal(await page.evaluate(()=>manualMask),2,'new device ID restores stable mapping');
 await page.reload();await page.waitForFunction(()=>loaded);await page.evaluate(()=>openGame());await page.evaluate(d=>labController(d),packet(101,104,true));assert.equal(await page.evaluate(()=>manualMask),2,'raw mapping survives page reload');
 await page.evaluate(()=>leaveGame('info'));await page.click('#bindPhysicalPad');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>userInterface.binding()),false);await page.click('#bindPhysicalPad');await page.evaluate(()=>labController({id:101,mask:0,connected:false}));assert.equal(await page.evaluate(()=>userInterface.binding()),false,'disconnect cancels capture');
 await page.click('#resetPhysicalPad');await page.evaluate(()=>openGame());await page.evaluate(d=>labController(d),packet(7,97,true,2));assert.equal(await page.evaluate(()=>manualMask),2,'standard mapping restored');
 await page.evaluate(()=>leaveGame('info'));await page.selectOption('#uiLandscapeFit','integer');await page.selectOption('#uiTheme','system');await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.body.dataset.theme==='light');await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.body.dataset.theme==='dark');
 await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>openGame());const integer=await page.evaluate(()=>screen.getBoundingClientRect().width/screen.width);assert(Math.abs(integer-Math.round(integer))<.005,'integer image scaling');
 await page.evaluate(()=>leaveGame('info'));await page.evaluate(()=>document.documentElement.style.fontSize='150%');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 fs.mkdirSync('ui-preview',{recursive:true});await page.screenshot({path:'ui-preview/rc1-settings.png',fullPage:true});await page.evaluate(()=>openGame());await page.screenshot({path:'ui-preview/rc1-landscape.png'});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(80);await page.screenshot({path:'ui-preview/rc1-portrait.png'});await page.click('#gameExit');await page.click('#quickTouchEdit');await page.screenshot({path:'ui-preview/rc1-editor.png'});await page.click('#touchEditorDone');
 assert.deepEqual(errors,[]);fs.writeFileSync('ui-preview/rc1-interface.json',JSON.stringify({scope:'Production UI + real cores; native bridge fixtures, no physical device claim',cases:evidence,errors},null,2));
 await browser.close();console.log('PASS: 44 responsive core layouts, independent UI/learning, group/button drag, orientation+reload, hide/left-hand, physical trigger mapping+real frames, device reconnect, safe capture cancel, themes and integer video');
})().catch(async e=>{console.error(e);if(testPage)console.error(await testPage.evaluate(()=>({system:labPlatform,loaded,status:$('status').textContent,log:$('log').textContent})).catch(()=>null));if(browser)await browser.close();process.exitCode=1;});
