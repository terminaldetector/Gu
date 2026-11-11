/* Experimental AGOD + neural contour, behind a flag (Sol decision: milestone 1).

   The research modules were reachable only from check scripts. This is the one
   place the running lab can reach them from, and it is built so that the
   flag-off path costs the production contour nothing at all: the modules are
   not fetched, not parsed and not registered until the flag is on. That is why
   this file loads them on demand instead of index.html listing all seven.

   With the flag off every entry point returns a named refusal. Nothing is
   patched, no listener is installed and no element is added, so a lab session
   that never enables this is byte-identical in behaviour to one without the
   file - which the accompanying check verifies by serving the page twice, with
   and without this script, and comparing what the page does.

   No user-facing toggle yet, deliberately: the research panel is asserted on by
   existing UI checks, and adding a control there is a product decision, not a
   research one. The flag is set through setEnabled() or localStorage. */
(function(root){'use strict';
const FLAG='gu-agod-neural-experimental-v1',BRIDGE_REVISION='agod-experimental-s1-1';
const MODULES=Object.freeze(['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js',
 'agod-evidence.js','agod-pipeline.js','agod-dqn.js']);
const GLOBALS=Object.freeze(['FlyAgodRam','FlyAgodCausal','FlyAgodGoals','FlyAgodReward',
 'FlyAgodEvidence','FlyAgodPipeline','FlyAgodDqn']);
const frozen=Object.freeze.bind(Object);
let override=null,loading=null;

function stored(){try{return !!root.localStorage&&root.localStorage.getItem(FLAG)==='true';}catch(_){return false;}}
const enabled=()=>override===null?stored():override;
function setEnabled(value){
 override=!!value;
 try{if(root.localStorage)root.localStorage.setItem(FLAG,override?'true':'false');}catch(_){}
 return enabled();
}
const disabled=what=>frozen({status:'DISABLED',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
 reason:'the experimental AGOD and neural contour is off; '+what+' is not available'});

function inject(file){
 return new Promise((resolve,reject)=>{
  const element=root.document.createElement('script');
  element.src=file;element.async=false;
  element.onload=()=>resolve(file);
  element.onerror=()=>reject(new Error('could not load experimental module '+file));
  root.document.head.appendChild(element);
 });
}

/* Loads the stages in dependency order, once. The pipeline module reads its
   dependencies off the global at load time, so the order here matters. */
function ready(){
 if(!enabled())return Promise.resolve(disabled('loading the research stages'));
 if(!loading)loading=(async()=>{
  const loaded=[];
  for(const file of MODULES){if(!root.document)throw new Error('no document to load into');loaded.push(await inject(file));}
  const missing=GLOBALS.filter(name=>!root[name]);
  if(missing.length)throw new Error('modules loaded but did not register: '+missing.join(', '));
  return frozen({status:'READY',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
   modules:loaded.slice(),globals:GLOBALS.slice(),
   pipelineRevision:root.FlyAgodPipeline.PIPELINE_REVISION,
   learnerRevision:root.FlyAgodDqn.LEARNER_REVISION});
 })().catch(error=>{loading=null;throw error;});
 return loading;
}

/* The single research entry point. It refuses rather than guesses: off, not
   loaded, or whatever the pipeline itself refuses. */
function session(driver,options){
 if(!enabled())return disabled('a research session');
 if(!root.FlyAgodPipeline)
  return frozen({status:'NOT-LOADED',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
   reason:'call ready() and await it before starting a session'});
 return root.FlyAgodPipeline.run(driver,options);
}

/* ---- the executable path: a real pipeline run, off the UI thread ----

   session() above runs the pipeline on THIS thread, which for a real
   cartridge is about twenty seconds of frozen interface. runInWorker() is the
   one the interface uses. It differs from session() in three ways that matter:

   1. It needs no flag. The flag exists so that a lab session which never asks
      for research costs the production contour nothing - the seven modules are
      not fetched, parsed or registered, and the S1 check proves the page is
      byte-identical with the bridge file removed. A worker injects nothing into
      the page and registers no global here, so that guarantee is untouched;
      and the caller is an explicit button press, which is the user asking.
   2. It never receives the live emulator. It is handed the ROM by value and,
      optionally, a snapshot of the live state by value. The worker builds its
      own core from those bytes in its own thread.
   3. Stopping terminates the worker. FlyAgodPipeline.run() is synchronous, so
      a running pipeline has no yield point at which a cancel flag could be
      read; the frame budget bounds the worst case and terminate() is the stop.
      stop() is safe to call at any time and more than once.

   onEvent receives the worker's messages unchanged: started, progress, result,
   error, cancelled. VERIFIED is whatever the pipeline returned and is never
   synthesised here. */
const WORKER_FILE='agod-worker.js';
function runInWorker(request){
 const options=request||{};
 if(typeof root.Worker!=='function')
  return frozen({status:'NOT-SUPPORTED',bridgeRevision:BRIDGE_REVISION,
   reason:'this context has no Worker constructor, so AGOD cannot run off the UI thread'});
 if(!options.romBase64&&!options.romBinaryString)
  return frozen({status:'REFUSED',bridgeRevision:BRIDGE_REVISION,
   reason:'runInWorker needs the cartridge by value: romBase64 or romBinaryString'});
 const sessionId=options.sessionId
  ||('agod-'+Date.now().toString(36)+'-'+Math.floor(Math.random()*1e6).toString(36));
 const onEvent=typeof options.onEvent==='function'?options.onEvent:()=>{};
 let worker,stopped=false;
 try{worker=new root.Worker(options.workerFile||WORKER_FILE);}
 catch(error){
  return frozen({status:'FAILED',bridgeRevision:BRIDGE_REVISION,
   reason:'could not start the research worker: '+error.message});
 }
 const finish=()=>{if(worker){worker.terminate();worker=null;}};
 worker.onmessage=event=>{
  const message=event.data||{};
  try{onEvent(message);}catch(_){}
  /* one terminal message per session, then the worker is done */
  if(message.type==='result'||message.type==='error'||message.type==='cancelled')finish();
 };
 worker.onerror=error=>{
  try{onEvent({type:'error',sessionId,phase:'worker',
   error:{message:error.message||'the research worker failed',
    budgetExceeded:false,stack:null}});}catch(_){}
  finish();
 };
 worker.postMessage({type:'run',sessionId,
  platform:options.platform||'nes',
  romBase64:options.romBase64||null,romBinaryString:options.romBinaryString||null,
  startSnapshot:options.startSnapshot||null,
  entry:options.entry||null,
  background:options.background===true,
  config:options.config||{},
  frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:2000000,
  progressEveryFrames:Number.isInteger(options.progressEveryFrames)
   ?options.progressEveryFrames:2000});
 return frozen({status:'RUNNING',bridgeRevision:BRIDGE_REVISION,sessionId,
  workerFile:options.workerFile||WORKER_FILE,
  stoppingNote:'the pipeline is synchronous, so stop() terminates the worker',
  stop(){
   if(stopped)return frozen({status:'ALREADY-STOPPED',sessionId});
   stopped=true;
   if(worker){try{worker.postMessage({type:'cancel',sessionId});}catch(_){}}
   finish();
   try{onEvent({type:'stopped',sessionId,bridgeRevision:BRIDGE_REVISION,
    reason:'stopped by the operator; the worker was terminated'});}catch(_){}
   return frozen({status:'STOPPED',sessionId});
  },
  stopped(){return stopped;}});
}

const api={FLAG,BRIDGE_REVISION,MODULES,GLOBALS,WORKER_FILE,enabled,setEnabled,ready,session,
 runInWorker,
 loadedModules(){return GLOBALS.filter(name=>!!root[name]);}};
root.FlyAgodExperimental=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
