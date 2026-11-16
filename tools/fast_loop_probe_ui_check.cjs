'use strict';
// Track B: the in-app fast-loop probe on the real page and core. The Android
// transports are fixtures here (a JavaScript probeFrame doing the same base64 decode
// and feature work, and a GuFrames object replying asynchronously like the WebMessage
// reply proxy); the worker transport is the real bundled worker. Host Chromium, not
// Android: this checks the probe's plumbing and report, not phone numbers.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const assets=path.resolve(__dirname,'../app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:412,height:915}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
  return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});});
 const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));demo.sha256=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');demo.name='probe fixture';
 await page.exposeFunction('probeDemo',()=>page.evaluate(d=>labLoadRom(d),demo));
 await page.addInitScript(()=>{
  window.logged=[];window.nativeCalls={bridge:0,message:0};
  const feature=(px,w,h,state)=>{const W=32,H=30,lum=new Float32Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=px[Math.floor(y*h/H)*w+Math.floor(x*w/W)];lum[y*W+x]=(c&255)*.2126+((c>>>8)&255)*.7152+((c>>>16)&255)*.0722;}
   let m=0;if(state.prev)for(let i=0;i<lum.length;i++)m+=Math.abs(lum[i]-state.prev[i]);state.prev=lum;return m/lum.length;};
  const bridgeState={},messageState={};
  window.FlyBridge={demo:()=>window.probeDemo(),acceptRom(){},orientation(){},stop(){},resume(){},controls(){},gameDisplay(){},
   probeTransports:()=>JSON.stringify({bridge:true,message:true}),
   probeMemory:()=>JSON.stringify({appTotalPssKb:123456,scope:'fixture'}),
   probeFrame(b64,w,h,frameIndex,epoch,seq){nativeCalls.bridge++;const bin=atob(b64),u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
    const t0=performance.now(),motion=feature(new Uint32Array(u8.buffer),w,h,bridgeState),t1=performance.now();
    return JSON.stringify({mask:motion>2?129:128,frameIndex,epoch,seq,visualMs:t1-t0,decisionMs:0,nativeMs:t1-t0});}};
  window.GuFrames={onmessage:null,postMessage(buffer){nativeCalls.message++;const head=new Int32Array(buffer,0,6),[w,h,frameIndex,epoch,seq]=head,px=new Uint32Array(buffer,24);
   const t0=performance.now(),motion=feature(px,w,h,messageState),t1=performance.now();
   setTimeout(()=>{if(this.onmessage)this.onmessage({data:JSON.stringify({mask:motion>2?129:128,frameIndex,epoch,seq,visualMs:t1-t0,decisionMs:0,nativeMs:t1-t0})});},1);}};
 });
 await page.goto('https://flyconsole.local/lab/index.html?system=nes');await page.waitForFunction(()=>loaded&&!romLoading,null,{timeout:60000});
 await page.evaluate(()=>{const e=guLogger.event.bind(guLogger);guLogger.event=(name,data,level)=>{logged.push({name,data});return e(name,data,level);};});
 assert.deepEqual(await page.evaluate(()=>FlyFastLoopProbe.transports()),{worker:true,bridge:true,message:true},'all three transports are detected');
 const report=await page.evaluate(()=>FlyFastLoopProbe.suite({seconds:2,hz:30}));
 assert.equal(report.type,'gu-fast-loop-probe');assert(report.baselineFps>50,'baseline FPS '+report.baselineFps);
 assert.deepEqual(report.runs.map(r=>r.transport),['worker','bridge','message']);
 for(const r of report.runs){
  assert(r.available,r.transport+' available');
  assert(r.decisionsApplied>=30,r.transport+' applied '+r.decisionsApplied+' decisions in 2 s');
  assert(r.emulatorFps>50,r.transport+' keeps the emulator running: '+r.emulatorFps);
  for(const stage of ['publishedToDispatched','publishedToReceived','receivedToApplied','publishedToApplied'])assert(Number.isFinite(r.stagesMs[stage].p95),r.transport+' '+stage+' measured');
  assert(r.stagesMs.publishedToApplied.p95<100,r.transport+' frame->applied p95 '+r.stagesMs.publishedToApplied.p95+' ms on the host');
  assert(r.appliedFrames.p50>=1,r.transport+': a decision is applied at the earliest on the next frame');
  assert(r.framesPublished>0&&r.framesDropped>=0&&Number.isFinite(r.copyMBps));
  assert(r.memory.length>=2&&r.memory[0].appTotalPssKb===123456,r.transport+' memory is sampled');
  assert.equal(r.errors.length,0,r.transport+' errors: '+r.errors.join('; '));
 }
 const worker=report.runs[0];
 assert(Number.isFinite(worker.stagesMs.dispatchedToVisualReady.p95)&&Number.isFinite(worker.stagesMs.visualReadyToDecisionReady.p95),'the worker stamps VisualReady and DecisionReady on the page clock');
 assert(report.runs[1].native&&Number.isFinite(report.runs[1].native.visualMs.p50),'native transports report their own compute time');
 assert(await page.evaluate(()=>nativeCalls.bridge>0&&nativeCalls.message>0),'both native transports were actually called');
 assert(await page.evaluate(()=>logged.some(e=>e.name==='fastloop.probe'&&e.data.runs.length===3)),'the report goes to the diagnostics journal');
 assert(await page.evaluate(()=>!window.labFrameSource&&!window.labActionSink),'the probe removes the ports it installed');
 /* an unavailable transport is reported, not substituted */
 await page.evaluate(()=>{delete window.GuFrames;});
 const missing=await page.evaluate(()=>FlyFastLoopProbe.runTransport('message',{seconds:1}));
 assert.deepEqual(missing,{transport:'message',available:false},'a missing WebMessage transport is reported as unavailable');
 /* the Diagnostics section carries the probe and the soak, and the summary names every transport */
 const text=await page.evaluate(r=>FlyFastLoopProbe.summary(r),report);
 for(const kind of ['worker','bridge','message'])assert(new RegExp('^'+kind+': \\d','m').test(text),'the summary reports '+kind+':\n'+text);
 assert(/PSS процесса приложения/.test(text),'the summary states the memory scope');
 await page.evaluate(()=>consoleNavigation.go('settings-diagnostics'));
 assert(await page.locator('#fastLoopProbe').isVisible()&&await page.locator('#fastLoopSoak').isVisible(),'the probe and soak buttons are in Diagnostics');
 assert.deepEqual(errors,[]);
 for(const r of report.runs)console.log('host '+r.transport+': '+r.decisionsPerSecond+' dec/s, FPS '+r.emulatorFps+', frame->applied p50/p95 '+r.stagesMs.publishedToApplied.p50+'/'+r.stagesMs.publishedToApplied.p95+' ms, dropped frames '+r.framesDropped+'/'+r.framesPublished);
 if(process.env.FAST_LOOP_REPORT)fs.writeFileSync(process.env.FAST_LOOP_REPORT,JSON.stringify(report,null,1));
 await browser.close();browser=null;
 console.log('PASS: in-app fast-loop probe on the real NES page: worker / bridge / WebMessage transports timed through FramePublished -> Dispatched -> VisualReady -> DecisionReady -> Received -> ActionApplied, emulator FPS kept, memory sampled, report in the diagnostics journal, ports removed after, missing transport reported; Android transports are fixtures here');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
