/* The AGOD research worker.
 *
 * WHY A WORKER. A real FlyAgodPipeline.run() on the embedded diagnostic
 * cartridge takes about 12,400 emulated frames and twenty seconds of CPU. On
 * the WebView's UI thread that is a twenty-second freeze, so the pipeline runs
 * here instead and the interface stays responsive.
 *
 * WHAT IT RECEIVES: the ROM by value, an optional start snapshot by value, the
 * pipeline configuration, a frame budget and a session id. It builds its OWN
 * emulator from those bytes - it has no access to the live game instance at
 * all, being in a separate thread with a separate global.
 *
 * WHAT IT SENDS BACK: started, progress (frames spent, so the interface can
 * show the budget being consumed), and exactly one terminal message - result,
 * error or refused-to-start.
 *
 * ON STOPPING, AND THIS IS A REAL LIMIT RATHER THAN A CHOICE.
 * FlyAgodPipeline.run() is SYNCHRONOUS. While it runs, this worker's event
 * loop never turns, so a 'cancel' message cannot be received, let alone
 * acted on: there is no yield point to check a flag at. Stopping is therefore
 * the host calling worker.terminate(), which this file cannot soften, and the
 * declared frame budget is what bounds the worst case before that. A cancel
 * message IS honoured in the one window where it can be - after the worker is
 * created and before run() is entered.
 *
 * postMessage, unlike receiving, works from inside synchronous code: the
 * messages queue and the main thread picks them up. That is why progress
 * reporting is possible when cancellation is not.
 *
 * No network: everything is importScripts of same-origin lab assets. */
'use strict';

const WORKER_REVISION='agod-worker-1';
/* The pipeline module resolves its dependencies off the global when it loads,
   so this order is the dependency order and is not cosmetic. */
const MODULES=['jsnes.min.js','agod-ram.js','agod-causal.js','agod-goals.js',
 'agod-reward.js','agod-evidence.js','agod-pipeline.js','agod-nes-driver.js',
 'agod-goal-dto.js'];

let loaded=false,loadError=null;
let currentSession=null,cancelledBeforeStart=new Set();

function load(){
 if(loaded)return true;
 if(loadError)throw loadError;
 try{
  for(const file of MODULES)self.importScripts(file);
  const missing=['FlyAgodRam','FlyAgodCausal','FlyAgodGoals','FlyAgodReward',
   'FlyAgodEvidence','FlyAgodPipeline','FlyAgodNesDriver','FlyAgodGoalDto']
   .filter(name=>!self[name]);
  if(missing.length)
   throw new Error('modules loaded but did not register: '+missing.join(', '));
  if(!self.jsnes||typeof self.jsnes.NES!=='function')
   throw new Error('jsnes did not register a usable NES core in the worker');
  loaded=true;
  return true;
 }catch(error){loadError=error;throw error;}
}

const post=message=>self.postMessage(message);

function describeError(error){
 return {message:error&&error.message?error.message:String(error),
  /* a budget overrun is a declared outcome, not an unknown failure */
  budgetExceeded:!!(error&&error.message&&/FRAME_BUDGET_EXCEEDED/.test(error.message)),
  stack:error&&error.stack?String(error.stack).split('\n').slice(0,4).join('\n'):null};
}

function runSession(request){
 const sessionId=request.sessionId;
 const started=Date.now();
 if(cancelledBeforeStart.has(sessionId)){
  cancelledBeforeStart.delete(sessionId);
  post({type:'cancelled',sessionId,workerRevision:WORKER_REVISION,
   when:'before the pipeline was entered'});
  return;
 }
 let host=null;
 try{
  load();
 }catch(error){
  post({type:'error',sessionId,workerRevision:WORKER_REVISION,
   phase:'load',error:describeError(error)});
  return;
 }
 try{
  const frameBudget=Number.isInteger(request.frameBudget)?request.frameBudget:2000000;
  const progressEvery=Number.isInteger(request.progressEveryFrames)
   ?request.progressEveryFrames:2000;
  let sinceReport=0;
  host=self.FlyAgodNesDriver.create({
   romBase64:request.romBase64,romBinaryString:request.romBinaryString,
   jsnes:self.jsnes,frameBudget,
   startSnapshot:request.startSnapshot||null,
   entry:request.entry||{bootFrames:60,startPulses:0},
   onFrames(count){
    sinceReport+=count;
    if(sinceReport>=progressEvery){
     sinceReport=0;
     /* queued now, delivered to the main thread while run() is still inside
        its synchronous work - this is the only live signal available */
     post({type:'progress',sessionId,workerRevision:WORKER_REVISION,
      framesRun:host?host.framesRun():null,frameBudget,
      elapsedMs:Date.now()-started});
    }
   }});
  post({type:'started',sessionId,workerRevision:WORKER_REVISION,
   driverRevision:self.FlyAgodNesDriver.DRIVER_REVISION,
   pipelineRevision:self.FlyAgodPipeline.PIPELINE_REVISION,
   frameBudget,
   framesAfterEntryProcedure:host.framesRun(),
   startedFrom:request.startSnapshot?'a snapshot of the live game state, by value'
    :'this worker own boot of the same ROM'});

  /* THE REAL PIPELINE. No stub, no mock, no substitute. */
  const result=self.FlyAgodPipeline.run(host.driver,request.config||{});

  /* A VERIFIED result carries readResource (a function) and broker and
     registry (objects with methods). Posting it verbatim throws
     DataCloneError, which is why the positive branch had never crossed this
     boundary. Only the DTO crosses; the mechanism stays here. */
  const config=request.config||{};
  const dto=self.FlyAgodGoalDto.fromPipelineResult(result,{
   romHash:config.romHash||null,coreRevision:config.coreRevision||null,
   profileRevision:config.profileRevision||null,
   contextKey:config.contextKey===undefined?null:config.contextKey,
   platform:request.platform||'nes',
   driverRevision:self.FlyAgodNesDriver.DRIVER_REVISION,
   producedAtMs:Date.now()});
  /* Checked HERE, before posting, so a transport bug is caught in the context
     that can still describe it rather than becoming a silent DataCloneError. */
  let cloneable=true,cloneError=null;
  try{if(typeof structuredClone==='function')structuredClone(dto);}
  catch(error){cloneable=false;cloneError=String(error&&error.message||error).slice(0,200);}

  post({type:'result',sessionId,workerRevision:WORKER_REVISION,
   dto,dtoRevision:self.FlyAgodGoalDto.DTO_REVISION,
   dtoCloneable:cloneable,dtoCloneError:cloneError,
   /* kept so the interface can show status/stage/reason without reaching into
      the DTO, and so nothing here depends on the full result surviving */
   summary:{status:result.status||null,stage:result.stage||null,
    reason:result.reason===undefined?null:result.reason},
   cost:{framesRun:host.framesRun(),frameBudget,
    budgetRemaining:host.budgetRemaining(),
    wallClockMs:Date.now()-started},
   pipelineRevision:self.FlyAgodPipeline.PIPELINE_REVISION});
 }catch(error){
  post({type:'error',sessionId,workerRevision:WORKER_REVISION,phase:'run',
   error:describeError(error),
   cost:host?{framesRun:host.framesRun(),frameBudget:host.frameBudget,
    wallClockMs:Date.now()-started}:null});
 }finally{
  if(host)host.dispose();
  currentSession=null;
 }
}

self.onmessage=event=>{
 const request=event.data||{};
 if(request.type==='run'){
  if(currentSession){
   post({type:'error',sessionId:request.sessionId,workerRevision:WORKER_REVISION,
    phase:'dispatch',
    error:{message:'this worker is already running session '+currentSession,
     budgetExceeded:false,stack:null}});
   return;
  }
  currentSession=request.sessionId;
  runSession(request);
  return;
 }
 if(request.type==='cancel'){
  /* Only reachable before run() is entered; see the note at the top of this
     file. The host stops a running pipeline with terminate(). */
  cancelledBeforeStart.add(request.sessionId);
  post({type:'cancel-acknowledged',sessionId:request.sessionId,
   workerRevision:WORKER_REVISION,
   effective:currentSession!==request.sessionId,
   note:currentSession===request.sessionId
    ?'the pipeline is already running synchronously and cannot be interrupted from here; the host must terminate this worker'
    :'the session will refuse to start'});
  return;
 }
 if(request.type==='ping'){
  post({type:'pong',workerRevision:WORKER_REVISION,modulesLoaded:loaded});
  return;
 }
 post({type:'error',sessionId:request.sessionId||null,workerRevision:WORKER_REVISION,
  phase:'dispatch',
  error:{message:'unknown message type: '+String(request.type),
   budgetExceeded:false,stack:null}});
};
