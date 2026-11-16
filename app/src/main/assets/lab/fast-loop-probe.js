/* Track B: the fast-loop latency probe, run inside the app on the live game.

   One decision is timed through every stage, on one clock
   (performance.timeOrigin + performance.now(), the same in the page and a worker):
     FramePublished   the core frame reaches the FrameSource
     Dispatched       the controller takes it (owned copy, sent to the transport)
     VisualReady      the visual feature is computed
     DecisionReady    the mask is decided (controller side)
     Received         the decision is back on the page and submitted to the ActionSink
     ActionApplied    the mask is applied at the start of an emulated frame
   For the native transports Java reports its own visual / decision durations; the
   rest of the round trip is transport (the Java and JS clocks are not aligned).

   Transports, each with the same stand-in work (32x30 luminance motion):
     worker   in-WebView Web Worker, transferable ArrayBuffer (fast-loop-worker.js)
     bridge   FlyBridge.probeFrame(base64, ...) - the existing JavascriptInterface path
     message  window.GuFrames.postMessage(ArrayBuffer) - androidx.webkit WebMessage,
              present only when the WebView supports ArrayBuffer messages
   A transport that is not available is reported as such, never substituted.

   Reported per transport: decisions/s, stage p50/p95, emulator FPS (against a
   baseline with no probe), dropped frames, dropped/refused actions, app PSS samples
   over the run. The report goes to the diagnostics journal (event fastloop.probe),
   so it is in the exported diagnostic report. Stand-in policy: this measures the
   LOOP, not play. */
(function(root){'use strict';
const clock=()=>performance.timeOrigin+performance.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(xs,q)=>{const s=xs.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?+s[Math.min(s.length-1,Math.floor(q*(s.length-1)+.5))].toFixed(2):null;};
const dist=xs=>({n:xs.filter(Number.isFinite).length,p50:pct(xs,.5),p95:pct(xs,.95),max:xs.length?+Math.max(...xs.filter(Number.isFinite)).toFixed(2):null});
function transports(){
 return {worker:typeof Worker==='function',
  bridge:!!(root.FlyBridge&&typeof root.FlyBridge.probeFrame==='function'),
  message:!!(root.GuFrames&&typeof root.GuFrames.postMessage==='function')};
}
function memory(){
 const out={atMs:Math.round(clock())};
 try{if(root.FlyBridge&&typeof root.FlyBridge.probeMemory==='function')Object.assign(out,JSON.parse(root.FlyBridge.probeMemory()));}catch(_){}
 try{if(performance.memory)out.jsHeapUsedKb=Math.round(performance.memory.usedJSHeapSize/1024);}catch(_){}
 return out;
}
function base64(u8){let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s);}
/* lab.js state lives in the shared global scope of the page's classic scripts; it is
   read at call time (this module also loads in Node for its schema checks) */
function hooks(){
 /* global frame, playing, loaded, romLoading, buttonNames */
 return {frame:()=>frame,playing:()=>playing,loaded:()=>loaded&&!romLoading,
  play:()=>{if(!playing)document.getElementById('play').click();},
  pause:()=>root.labPause(),buttons:()=>buttonNames.length};
}
/* one transport for `seconds` at `hz`; the ports are installed for the run and removed after */
async function runTransport(kind,{seconds=10,hz=30,memoryEveryMs=5000}={}){
 const H=hooks(),available=transports();
 if(!available[kind])return {transport:kind,available:false};
 if(!H.loaded())throw Error('Сначала откройте игру');
 const records=new Map(),applied=[];
 const ownSource=!root.labFrameSource,ownSink=!root.labActionSink;
 const source=root.labFrameSource||(root.labFrameSource=FlyFrameSource.create({now:()=>performance.now()}));
 const sink=root.labActionSink||(root.labActionSink=FlyActionSink.create({buttons:H.buttons(),ports:[1,2],maxStaleFrames:6,
  now:()=>performance.now(),onApplied:r=>{const rec=records.get(r.token);if(rec){rec.applied=clock();rec.appliedFrames=r.appliedFrameIndex-r.sourceFrameIndex;applied.push(rec);}}}));
 const toAbs=t=>performance.timeOrigin+t;
 let seq=0,busy=false,lastIndex=-1,worker=null,timer=null,memTimer=null;const memorySamples=[memory()],codes={},errors=[];
 const finish=(rec,reply)=>{
  busy=false;rec.received=clock();
  if(reply.error){errors.push(String(reply.error));return;}
  if(Number.isFinite(reply.visualReady))rec.visual=reply.visualReady;
  if(Number.isFinite(reply.decisionReady))rec.decided=reply.decisionReady;
  if(Number.isFinite(reply.visualMs)){rec.nativeVisualMs=reply.visualMs;rec.nativeDecisionMs=reply.decisionMs;rec.nativeMs=reply.nativeMs;}
  const r=sink.submit({port:1,mask:reply.mask,sourceFrameIndex:rec.frameIndex,epoch:rec.epoch,holdFrames:Math.max(1,Math.round(60/hz)),createdAt:rec.publishedLocal,token:rec.seq,modelRevision:'probe-motion-stand-in'});
  codes[r.code]=(codes[r.code]||0)+1;
 };
 if(kind==='worker'){worker=new Worker('fast-loop-worker.js');worker.onmessage=e=>{const rec=records.get(e.data.seq);if(rec)finish(rec,e.data);};}
 let onMessage=null;
 if(kind==='message'){onMessage=e=>{let reply;try{reply=JSON.parse(e.data);}catch(_){reply={error:'unparsable reply'};}const rec=records.get(reply.seq);if(rec)finish(rec,reply);};root.GuFrames.onmessage=onMessage;}
 const tick=()=>{
  if(busy)return;const f=source.takeCopy();if(!f||f.frameIndex===lastIndex)return;lastIndex=f.frameIndex;
  const rec={seq:++seq,frameIndex:f.frameIndex,epoch:f.epoch,published:toAbs(f.wallTimeMs),publishedLocal:f.wallTimeMs,dispatched:clock()};
  records.set(rec.seq,rec);if(records.size>8192)records.delete(rec.seq-8192);busy=true;
  try{
   if(kind==='worker')worker.postMessage({buffer:f.buffer,width:f.width,height:f.height,frameIndex:f.frameIndex,epoch:f.epoch,seq:rec.seq},[f.buffer]);
   else if(kind==='bridge')finish(rec,JSON.parse(root.FlyBridge.probeFrame(base64(new Uint8Array(f.buffer)),f.width,f.height,f.frameIndex,f.epoch,rec.seq)));
   else{const msg=new ArrayBuffer(24+f.data.byteLength),head=new Int32Array(msg,0,6);head.set([f.width,f.height,f.frameIndex,f.epoch,rec.seq,0]);new Uint32Array(msg,24).set(f.data);root.GuFrames.postMessage(msg);}
  }catch(error){busy=false;errors.push(String(error.message||error));}
 };
 const wasPlaying=H.playing();if(!wasPlaying)H.play();
 await sleep(800);
 const f0=H.frame(),t0=performance.now(),s0=source.stats(),k0=JSON.parse(JSON.stringify(sink.stats().counts));
 timer=setInterval(tick,1000/hz);memTimer=setInterval(()=>memorySamples.push(memory()),memoryEveryMs);
 await sleep(seconds*1000);
 clearInterval(timer);clearInterval(memTimer);
 const elapsed=performance.now()-t0,fps=(H.frame()-f0)*1000/elapsed,s1=source.stats(),k1=sink.stats().counts;
 memorySamples.push(memory());
 await sleep(100);if(worker)worker.terminate();if(onMessage&&root.GuFrames)root.GuFrames.onmessage=null;
 if(ownSink)delete root.labActionSink;if(ownSource)delete root.labFrameSource;
 if(!wasPlaying)H.pause();
 const d=(a,b)=>applied.map(r=>Number.isFinite(r[a])&&Number.isFinite(r[b])?r[b]-r[a]:NaN);
 const refused={};for(const [k,v]of Object.entries(k1.rejected||{}))refused[k]=v-((k0.rejected||{})[k]||0);
 return {transport:kind,available:true,seconds,targetHz:hz,emulatorFps:+fps.toFixed(2),
  decisionsPerSecond:+(applied.length*1000/elapsed).toFixed(2),decisionsApplied:applied.length,submitCodes:codes,errors:errors.slice(0,5),
  stagesMs:{publishedToDispatched:dist(d('published','dispatched')),dispatchedToVisualReady:dist(d('dispatched','visual')),
   visualReadyToDecisionReady:dist(d('visual','decided')),publishedToReceived:dist(d('published','received')),
   receivedToApplied:dist(d('received','applied')),publishedToApplied:dist(d('published','applied')),
   dispatchedToReceived:dist(d('dispatched','received'))},
  native:kind==='worker'?null:{visualMs:dist(applied.map(r=>r.nativeVisualMs)),decisionMs:dist(applied.map(r=>r.nativeDecisionMs)),computeMs:dist(applied.map(r=>r.nativeMs))},
  appliedFrames:dist(applied.map(r=>r.appliedFrames)),featureAgeAtApplyMs:dist(d('published','applied')),
  framesPublished:s1.published-s0.published,framesDropped:s1.dropped-s0.dropped,copyMBps:+(((s1.bytesCopied-s0.bytesCopied)/1048576)/(elapsed/1000)).toFixed(1),
  actionsDropped:{superseded:k1.superseded-k0.superseded,cancelled:k1.cancelled-k0.cancelled,refused},
  memory:memorySamples};
}
/* baseline emulator FPS with no probe, then every available transport */
async function suite({seconds=10,hz=30,only=null,onProgress=null}={}){
 const H=hooks();if(!H.loaded())throw Error('Сначала откройте игру');
 const wasPlaying=H.playing();if(!wasPlaying)H.play();
 await sleep(800);const f0=H.frame(),t0=performance.now();await sleep(Math.min(5,seconds)*1000);
 const baselineFps=+((H.frame()-f0)*1000/(performance.now()-t0)).toFixed(2);
 const report={type:'gu-fast-loop-probe',schema:1,policy:'motion stand-in (measures the loop, not play)',platform:root.labPlatform,
  startedAt:new Date().toISOString(),available:transports(),baselineFps,memoryBefore:memory(),runs:[]};
 for(const kind of only||['worker','bridge','message']){
  if(typeof onProgress==='function')onProgress(kind);
  report.runs.push(await runTransport(kind,{seconds,hz}));
 }
 report.memoryAfter=memory();
 if(!wasPlaying)H.pause();
 try{root.guLogger?.event?.('fastloop.probe',report);}catch(_){}
 return report;
}
function summary(report){
 const lines=['Платформа '+report.platform+' · базовый FPS '+report.baselineFps];
 for(const r of report.runs){
  if(!r.available){lines.push(r.transport+': недоступен в этом WebView');continue;}
  const s=r.stagesMs;
  lines.push(r.transport+': '+r.decisionsPerSecond+' реш/с, FPS '+r.emulatorFps+', кадр→действие p50/p95 '+s.publishedToApplied.p50+'/'+s.publishedToApplied.p95+' мс, кадров пропущено '+r.framesDropped+'/'+r.framesPublished+(r.errors.length?' · ошибки: '+r.errors[0]:''));
 }
 const pss=report.memoryAfter&&report.memoryAfter.appTotalPssKb;
 if(pss)lines.push('PSS процесса приложения (без рендерера WebView): '+Math.round(pss/1024)+' МиБ');
 return lines.join('\n');
}
/* the Diagnostics buttons */
function bind(){
 const doc=root.document;if(!doc)return;
 const button=doc.getElementById('fastLoopProbe'),soak=doc.getElementById('fastLoopSoak'),out=doc.getElementById('fastLoopResult');
 if(!button||!out)return;
 let running=false;
 const guard=async job=>{if(running)return;running=true;button.disabled=soak.disabled=true;
  try{await job();}catch(error){out.textContent='Замер не выполнен: '+(error.message||error);}
  finally{running=false;button.disabled=soak.disabled=false;}};
 button.onclick=()=>guard(async()=>{out.textContent='Идёт замер…';
  const report=await suite({seconds:10,hz:30,onProgress:kind=>{out.textContent='Идёт замер: '+kind+'…';}});
  out.textContent=summary(report)+'\nПодробный результат сохранён в диагностическом отчёте.';});
 soak.onclick=()=>guard(async()=>{const t=transports(),kind=t.message?'message':t.worker?'worker':'bridge';
  out.textContent='Длительный замер ('+kind+', 20 мин): держите приложение открытым…';
  const run=await runTransport(kind,{seconds:1200,hz:30,memoryEveryMs:30000});
  const report={type:'gu-fast-loop-soak',schema:1,platform:root.labPlatform,startedAt:new Date().toISOString(),run};
  try{root.guLogger?.event?.('fastloop.soak',report);}catch(_){}
  const first=run.memory[0]||{},last=run.memory[run.memory.length-1]||{};
  out.textContent='Длительный замер '+kind+': '+run.decisionsPerSecond+' реш/с, FPS '+run.emulatorFps+', кадр→действие p95 '+run.stagesMs.publishedToApplied.p95+' мс'
   +(first.appTotalPssKb&&last.appTotalPssKb?', PSS '+Math.round(first.appTotalPssKb/1024)+' → '+Math.round(last.appTotalPssKb/1024)+' МиБ':'')+'\nСохранено в диагностическом отчёте.';});
}
if(root.document&&root.document.readyState!=='loading')bind();else if(root.document)root.document.addEventListener('DOMContentLoaded',bind);
const api={transports,runTransport,suite,summary,memory};
root.FlyFastLoopProbe=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
