'use strict';
// F0/F1 host proof of concept: the full fast loop on the real page and core, in Chromium.
//   frame published (FrameSource) -> owned copy transferred to a Web Worker controller
//   -> cheap motion feature (32x30 luminance difference) -> button mask
//   -> ActionSink.submit -> applied at the start of an emulated frame.
// createdAt is the SOURCE FRAME's publish time, so the sink's latencyMs is
// frame-published -> mask-applied, end to end. HOST NUMBERS (desktop Chromium), not
// Android: they show the plumbing adds little, not what a phone does.
// Usage: node tools/fast_loop_host_bench.cjs [system=nes] [seconds=10] [hz=30]
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright');
const assets=path.resolve(__dirname,'../app/src/main/assets');
const [system='nes',seconds='10',hz='30']=process.argv.slice(2);
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://flyconsole.local/**',route=>{const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
   return route.fulfill({status:fs.existsSync(file)?200:404,body:fs.existsSync(file)?fs.readFileSync(file):'',contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});});
  const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));
  demo.sha256=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');demo.name='bench';
  await page.exposeFunction('benchDemo',()=>page.evaluate(d=>labLoadRom(d),demo));
  await page.addInitScript(()=>{window.FlyBridge={demo:()=>window.benchDemo(),acceptRom(){},orientation(){},stop(){},resume(){},controls(){},gameDisplay(){}};});
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded&&!romLoading,null,{timeout:60000});
  const result=await page.evaluate(async({seconds,hz})=>{
   openGame();if(!playing)$('play').click();
   const sleep=ms=>new Promise(r=>setTimeout(r,ms));
   /* baseline: emulated frames per second with no controller and no ports */
   await sleep(1500);let f0=frame,t0=performance.now();await sleep(seconds*500);
   const baselineFps=(frame-f0)*1000/(performance.now()-t0);
   /* install the ports and the worker controller */
   window.labFrameSource=FlyFrameSource.create();
   window.labActionSink=FlyActionSink.create({buttons:buttonNames.length,ports:[1,2],maxStaleFrames:6});
   const worker=new Worker(URL.createObjectURL(new Blob([`
    let prev=null;
    onmessage=e=>{const {data,width,height,frameIndex,epoch,wallTimeMs,postedAt}=e.data,px=new Uint32Array(data);
     const W=32,H=30,lum=new Float32Array(W*H);
     for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=px[Math.floor(y*height/H)*width+Math.floor(x*width/W)];lum[y*W+x]=(c&255)*.2126+((c>>>8)&255)*.7152+((c>>>16)&255)*.0722;}
     let motion=0;if(prev)for(let i=0;i<lum.length;i++)motion+=Math.abs(lum[i]-prev[i]);prev=lum;motion/=lum.length;
     const mask=motion>2?(128|1):128;   /* Right, plus A when the screen moves: a stand-in policy, not a player */
     postMessage({mask,frameIndex,epoch,wallTimeMs,postedAt,motion});};`],{type:'application/javascript'})));
   const decisions=[],ages=[],rtts=[];let busy=false,lastIndex=-1;
   worker.onmessage=e=>{busy=false;const d=e.data,now=performance.now();rtts.push(now-d.postedAt);
    const r=labActionSink.submit({port:1,mask:d.mask,sourceFrameIndex:d.frameIndex,epoch:d.epoch,holdFrames:Math.max(1,Math.round(60/hz)),createdAt:d.wallTimeMs,modelRevision:'host-motion-stand-in'});
    decisions.push(r.code);};
   const tick=()=>{if(busy)return;const f=labFrameSource.takeCopy();if(!f||f.frameIndex===lastIndex)return;lastIndex=f.frameIndex;busy=true;
    const postedAt=performance.now();ages.push(postedAt-f.wallTimeMs);
    worker.postMessage({data:f.buffer,width:f.width,height:f.height,frameIndex:f.frameIndex,epoch:f.epoch,wallTimeMs:f.wallTimeMs,postedAt},[f.buffer]);};
   const timer=setInterval(tick,1000/hz);
   await sleep(500);f0=frame;t0=performance.now();const s0=labFrameSource.stats();
   await sleep(seconds*1000);
   const elapsed=performance.now()-t0,controlledFps=(frame-f0)*1000/elapsed,s1=labFrameSource.stats();
   clearInterval(timer);worker.terminate();labPause();
   const pct=(xs,q)=>{const s=xs.slice().sort((a,b)=>a-b);return s.length?+s[Math.min(s.length-1,Math.floor(q*(s.length-1)+.5))].toFixed(2):null;};
   const sink=labActionSink.stats(),codes={};for(const c of decisions)codes[c]=(codes[c]||0)+1;
   return {platform:labPlatform,seconds,targetHz:hz,baselineFps:+baselineFps.toFixed(2),controlledFps:+controlledFps.toFixed(2),
    decisionsPerSecond:+(decisions.length*1000/(elapsed+500)).toFixed(2),decisionCodes:codes,
    frameAgeAtDispatchMs:{p50:pct(ages,.5),p95:pct(ages,.95)},workerRoundTripMs:{p50:pct(rtts,.5),p95:pct(rtts,.95)},
    frameToAppliedFrames:sink.latencyFrames,frameToAppliedMs:sink.latencyMs,
    framesPublished:s1.published-s0.published,framesDropped:s1.dropped-s0.dropped,
    copyMBps:+(((s1.bytesCopied-s0.bytesCopied)/1048576)/(elapsed/1000)).toFixed(1)};
  },{seconds:Number(seconds),hz:Number(hz)});
  result.pageErrors=errors;result.environment={host:'desktop Chromium (Playwright), not Android',browser:browser.version(),node:process.version};
  console.log(JSON.stringify(result,null,1));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
