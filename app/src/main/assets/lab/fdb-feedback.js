/* Correlate a native neural decision with the game interval actually observed. */
'use strict';
(() => {
 let current=null,gameSeconds=0,capturedAt=0,counter=0,error=null,linked=false,blocked=false,recovering=false,recoveryFailed=false,configurationVersion=null,bound=null,automaticCheckpoint=null;const waiting=new Map();
 const now=()=>typeof performance==='undefined'?Date.now():performance.now();
 const context=()=>JSON.stringify({system:labPlatform,romHash,graph:graphIdentity&&graphIdentity.sha256,inputs:ids('inputIds'),outputs:ids('outputIds')});
 function rewardCopy(state){if(state===null)return null;const copy=JSON.parse(JSON.stringify(state));const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};return freeze(copy);}
 function invalidate(message){error=message;bound=null;current=null;linked=false;gameSeconds=capturedAt=0;blocked=true;status('FDB: '+error,true);}
 // A dropped or timed-out reward makes temporal credit ambiguous. Resume only
 // after the serialized native worker confirms that its eligibility was cleared.
 function recover(){if(!blocked||recovering||recoveryFailed||waiting.size>=8)return;recovering=true;send('boundary',{},true,true);}
 function send(op,args={},recovery=false,retryPersistence=false){
  if(!window.FlyBridge||typeof FlyBridge.fdbFeedback!=='function')return Promise.resolve();
  if(waiting.size>=8){invalidate('очередь оценки отстаёт');recover();return Promise.resolve();}
  const token='fdb-'+(++counter),identity=context();
  return new Promise(resolve=>{
   const timer=setTimeout(()=>{const pending=waiting.get(token);if(!pending)return;waiting.delete(token);if(pending.op==='bind'&&(pending.identity!==context()||pending.version!==configurationVersion)){pending.resolve({error:'Прежний Current: подтверждение не получено'});return;}if(pending.recovery){recovering=false;recoveryFailed=true;}invalidate('сохранение не подтверждено');pending.resolve();recover();},30000);
   waiting.set(token,{resolve,timer,identity,recovery,retryPersistence,op,version:args.configVersion,started:now()});
   try{FlyBridge.fdbFeedback(JSON.stringify({op,token,layerId:window.layerExperience&&window.layerExperience.activeId?window.layerExperience.activeId():null,...args}));}
   catch(e){labFdbFeedback({token,error:e.message});}
  });
 }
 window.labFdbFeedback=r=>{
  const pending=waiting.get(r.token);if(!pending)return;waiting.delete(r.token);clearTimeout(pending.timer);
  if(pending.op==='bind'&&(pending.identity!==context()||pending.version!==configurationVersion)){if(typeof log==='function')log('Прежний Current: '+(r.error||r.saveError||'контекст изменился'));pending.resolve(r);return;}
  window.fdbDiagnostics?.record('feedback',{roundTripMs:now()-pending.started,feedbackMs:r.feedbackMs,stateAssemblyMs:r.stateAssemblyMs,saveMs:r.saveMs,workerQueueMs:r.workerQueueMs});const jsStarted=now();
  let localSaveFailed=false;
  if(r.error)invalidate(r.error);
  if(pending.identity===context()&&r.data&&r.data.fdbState){
   $('fdbJson').value=JSON.stringify(r.data.fdbState,null,2);if(requestedConfiguration)requestedConfiguration.fdb=r.data.fdbState;
   $('fdbStatus').textContent='W₀ фиксирован · ΔW '+r.data.fdbState.deltas.length+' · Wexo '+r.data.fdbState.edges.length+' · изменений '+r.data.changed+' · память слоя ≈ '+(r.data.memoryBytes/1024).toFixed(1)+' КиБ';
   const automatic=r.data.fdbState.learningState?.automatic,checkpoint=JSON.stringify([pending.identity,configurationVersion,window.layerExperience?.activeId?.()||null,automatic]);
   // Unknown/expired intervals still wait for the native boundary and its durable
   // trace reset. Adopting that full state above must not also enqueue a Layer
   // Set save/list on every interval. Actual errors retain their persistence retry.
   const milestone=pending.op==='reward'&&Number.isSafeInteger(automatic)&&automatic>0&&automatic%16===0&&checkpoint!==automaticCheckpoint;
   if(pending.op!=='bind'&&(pending.retryPersistence||r.data.changed||milestone)){try{persistPolicy(false);if(window.layerExperience)window.layerExperience.autosave();automaticCheckpoint=checkpoint;}catch(e){localSaveFailed=true;invalidate(e.message);status('FDB применён; сохранение модели: '+error,true);}}
   if(pending.op==='bind'&&r.data.bound&&!r.error&&!r.saveError)automaticCheckpoint=checkpoint;
   trainingView();
  }
  if(r.saveError){invalidate(r.saveError);status('FDB применён; сохранение Layer Set: '+error,true);}
  if(pending.recovery){recovering=false;recoveryFailed=Boolean(r.error||r.saveError||localSaveFailed);if(!recoveryFailed&&pending.identity===context()){blocked=false;error=null;status('FDB: сохранение подтверждено, временная связь восстановлена');}}
  window.fdbDiagnostics?.record('webview',{applyMs:now()-jsStarted});pending.resolve(r);
  recover();
 };
 function boundary(){const existed=linked;linked=false;current=null;gameSeconds=capturedAt=0;if(blocked){recoveryFailed=false;recover();}else if(existed||waiting.size)send('boundary');}
 function remember(data,rewardState=null){
  if(!blocked&&$('learnerController').value==='exo'&&$('learnMode').value==='train'&&!$('freeze').checked&&data.fdbDecision){if(!linked)capturedAt=gameSeconds;linked=true;current={id:data.fdbDecision.id,mask:data.fdbDecision.mask,frames:0,seconds:0,valid:true,rewardStart:rewardCopy(rewardState)};}
 }
 function frame(mask,seconds){gameSeconds+=seconds;if(current){current.frames++;current.seconds+=seconds;if(mask!==current.mask||(gmodeMode==='off'&&manualMask&&$('liveHints')?.checked!==false)||agentIntervened)current.valid=false;}}
 function capture(rewardState=null){const previous=current;current=null;if(!previous||!previous.frames)return null;const elapsed=gameSeconds-capturedAt;capturedAt=gameSeconds;return {...previous,elapsed,rewardEnd:rewardCopy(rewardState)};}
 function settle(outcome,reward,interrupted,evidenceKnown=true){
  if(!outcome||blocked)return Promise.resolve();
  // Unknown is not a numerical zero: a learned baseline can turn zero into a
  // negative advantage. Clear the native temporal link without calling reward.
  // Block captures until the serialized worker acknowledges the boundary so an
  // already-produced next decision cannot inherit credit across this gap.
  if(!evidenceKnown){linked=false;current=null;gameSeconds=capturedAt=0;blocked=true;recovering=true;return send('boundary',{unknown:true},true);}
  if(outcome.elapsed>2){linked=false;current=null;gameSeconds=capturedAt=0;blocked=true;recovering=true;return send('boundary',{},true);}
  if(outcome.elapsed<=0){invalidate('интервал результата вне окна пластичности');recover();return Promise.resolve();}
  return send('reward',{decision:outcome.id,mask:outcome.mask,frames:outcome.frames,seconds:outcome.elapsed,reward,valid:outcome.valid&&!interrupted,frozen:$('freeze').checked||$('learnMode').value!=='train'});
 }
 async function drain(){while(waiting.size){await Promise.all([...waiting.values()].map(p=>new Promise(resolve=>{const old=p.resolve;p.resolve=value=>{old(value);resolve();};})));}}
 function configured(version){configurationVersion=Number.isSafeInteger(version)?version:null;bound=null;automaticCheckpoint=null;}
 function isBound(id){return Boolean(bound&&bound.id===id&&bound.context===context()&&bound.version===configurationVersion);}
 async function bindCurrent(id){
  if(!window.FlyBridge||typeof FlyBridge.fdbFeedback!=='function'){bound={id,context:context(),version:configurationVersion};return id;}
  await drain();if(isBound(id))return id;
  if(typeof id!=='string'||!id||configurationVersion===null)throw Error('FDB Current: дождитесь сохранения слоя и подтверждения конфигурации');
  const identity=context(),version=configurationVersion;
  const r=await send('bind',{layerId:id,context:JSON.parse(identity),configVersion:version});
  if(!r||r.error||r.saveError||!r.data?.bound||r.data.layerId!==id||r.data.configVersion!==version||identity!==context()||version!==configurationVersion)throw Error(r?.error||r?.saveError||'FDB Current: привязка не подтверждена для текущей конфигурации');
  bound={id,context:identity,version};blocked=false;recovering=false;recoveryFailed=false;error=null;return id;
 }
 window.fdbAgent={configured,isBound,bindCurrent,diagnostics:()=>send('diagnostics'),remember,frame,capture,settle,boundary,drain,error:()=>error};
})();
