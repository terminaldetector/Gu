/* Reopen the same model/game paused. Never copy acquired weights between animals. */
'use strict';
(()=>{
// Console persistence is available even without a loaded connectome.
const gameStore=new FlySaveStates.Store(FlySaveStates.storage(localStorage));
const nesRevision='jsnes-sha256:84946f0dae4bcf3b2dfebe84ad3bfeb1dbcb413bd9b1a69e1f45910a95fd7b41';
const gameContext=()=>{if(!loaded)throw Error('ROM не загружен');return {system:labPlatform,hash:romHash,core:labPlatform==='nes'?nesRevision:nes.toJSON().core};};
const slotPicker=document.createElement('select');slotPicker.id='gameStateSlot';slotPicker.setAttribute('aria-label','Слот снимка игры');
for(const slot of FlySaveStates.slots){const option=document.createElement('option');option.value=slot;option.textContent=slot==='quick'?'Быстрый снимок':slot==='auto'?'Автосохранение':'Слот '+slot.slice(5);slotPicker.appendChild(option);}
$('saveState').before(slotPicker);
const slotPreview=document.createElement('img');slotPreview.id='gameStatePreview';slotPreview.alt='Превью выбранного снимка';slotPreview.width=128;slotPreview.height=120;slotPreview.hidden=true;$('saveState').before(slotPreview);
let gameRevision=null,gameRevisionKey=null,gameWriteQueue=Promise.resolve(),gameLoadJob=null;
function objectiveBoundary(reason){try{window.gameObjectiveDiscovery?.boundary(reason);}catch(error){try{window.guLogger?.event?.('goal.discovery-error',{message:String(error.message||error)},'error');}catch(_){}}}
async function gameList(){if(!loaded)return [];const c=gameContext(),core=nes,list=await gameStore.list(c);if(!loaded||nes!==core||romHash!==c.hash)return [];for(const option of slotPicker.options){const entry=list.find(v=>v.slot===option.value),base=option.value==='quick'?'Быстрый снимок':option.value==='auto'?'Автосохранение':'Слот '+option.value.slice(5);option.textContent=base+(entry?.error?' · повреждён':entry?' · '+new Date(entry.savedAt).toLocaleString()+(entry.recovered?' · резерв':''):' · пусто');}const selected=list.find(v=>v.slot===slotPicker.value);slotPreview.hidden=!selected?.preview;if(selected?.preview)slotPreview.src=selected.preview;return list;}
slotPicker.addEventListener('change',()=>{gameRevision=null;gameRevisionKey=null;gameList().catch(e=>status(e.message,true));});
function gameSave(slot=slotPicker.value,{automatic=false}={}){
 objectiveBoundary('save-state');
 // Capture state and preview together, before hashing or storage can yield to a ROM switch.
 let c,snapshot,preview=null;
 try{c=gameContext();snapshot={system:c.system,hash:c.hash,frame,...(window.flyOriginId?{originId:window.flyOriginId}:{}),state:JSON.parse(JSON.stringify(nes.toJSON()))};try{preview=screen.toDataURL('image/jpeg',.35);}catch(_){}}catch(e){return Promise.reject(e);}
 const trace=window.guLogger?.operation?.("game.save",{system:c.system,romHash:c.hash,core:c.core})||(()=>{});
 const job=gameWriteQueue.catch(()=>{}).then(async()=>{
  const previous=await gameStore.read(c,slot),k=FlySaveStates.key(c,slot);
  if(previous&&!automatic&&(gameRevisionKey!==k||gameRevision!==previous.revision)&&!window.confirm('Заменить снимок от '+new Date(previous.savedAt).toLocaleString()+'? Предыдущая версия останется резервной.'))throw Error('Сохранение отменено');
  const saved=await gameStore.save(c,slot,snapshot,{expectedRevision:previous?.revision,preview});
  gameRevision=saved.revision;gameRevisionKey=k;await gameList();return saved;
 });job.then(saved=>trace(null,{slot,revision:saved.revision}),error=>trace(error,{slot}));gameWriteQueue=job;return job;
}
function gameLoad(slot=slotPicker.value,{snapshot=null,permit=()=>true}={}){
 objectiveBoundary('load-state');
 if(gameLoadJob)return Promise.reject(Error('Дождитесь текущей загрузки снимка'));
 const trace=window.guLogger?.operation?.('game.load')||(()=>{});
 gameLoadJob=(async()=>{
  if(typeof romLoading!=='undefined'&&romLoading)throw Error('Дождитесь смены ROM');
  const c=gameContext(),core=nes,sequence=typeof romLoadSequence==='undefined'?null:romLoadSequence;
  const sameGame=()=>permit()&&loaded&&nes===core&&romHash===c.hash&&(typeof romLoading==='undefined'||!romLoading)&&(sequence===null||sequence===romLoadSequence);
  await gameWriteQueue.catch(()=>{});
  let saved;
  if(snapshot){const payload={...snapshot};delete payload.revision;delete payload.recovered;delete payload.warning;saved=await gameStore.decode(JSON.stringify({version:1,payload:JSON.stringify(payload),sha256:snapshot.revision}),c,slot);}
  else saved=await gameStore.read(c,slot);
  if(!sameGame())throw Error('ROM изменился во время загрузки');
  if(!saved&&slot==='quick'){await gameStore.migrateLegacy(c,validateSnapshot);saved=await gameStore.read(c,slot);}
  if(!saved)throw Error('Снимок для этой игры отсутствует');
  if(!sameGame())throw Error('ROM изменился во время загрузки');
  validateSnapshot(saved);window.labPause();let pauseGeneration=typeof generation==='undefined'?null:generation;
  if(!window.labNeuralSuspended&&window.dualAgents?.active()){
   try{await window.dualAgents.boundary('game-load');if(window.dualAgents.error?.())throw Error(window.dualAgents.error());}
   catch(e){
    // A late boundary failure must not pause a resumed/new game and make its guard pass.
    if(!sameGame()||playing||connected||(pauseGeneration!==null&&pauseGeneration!==generation)){
     log('Отменённая загрузка, ошибка границы: '+e.message);
     throw Error('Состояние игры изменилось; загрузка отменена: '+e.message);
    }
    window.labError({message:'Граница загрузки игры: '+e.message});pauseGeneration=typeof generation==='undefined'?null:generation;
   }
  }
  if(!sameGame()||playing||connected||(pauseGeneration!==null&&pauseGeneration!==generation))throw Error('Состояние игры изменилось; загрузка отменена');
  const before=JSON.parse(JSON.stringify(nes.toJSON()));
  try{nes.fromJSON(JSON.parse(JSON.stringify(saved.state)));}catch(e){try{nes.fromJSON(before);}catch(rollback){log('Не удалось восстановить состояние после ошибки загрузки: '+rollback.message);}throw e;}
  frame=saved.frame;window.flyOriginId=saved.originId||FlySaveStates.legacyOrigin(c.hash);window.labStartStateId=saved.revision;audioRead=audioWrite;if(labPlatform==='nes')rgbaAndRetina(nes.ppu.buffer);releasePorts();updateButtons();learningBoundary();
  gameRevision=saved.revision;gameRevisionKey=FlySaveStates.key(c,slot);await gameList();
  status((saved.recovered?'Восстановлена резервная копия. ':'Игра восстановлена. ')+'Коннектом, FDB и приобретённые веса сохранены.');return saved;
 })();gameLoadJob.then(saved=>trace(null,{slot,revision:saved.revision,recovered:saved.recovered}),error=>trace(error,{slot}));gameLoadJob=gameLoadJob.finally(()=>{gameLoadJob=null;});return gameLoadJob;
}
async function continueLast(){const list=await gameList(),valid=list.filter(s=>!s.error).sort((a,b)=>b.savedAt-a.savedAt);if(valid.length)return gameLoad(valid[0].slot);if(list.some(s=>s.error))throw Error('Снимки игры повреждены или несовместимы с ядром');return null;}
window.labGameStates={context:gameContext,capture:()=>({version:1,...gameContext(),slot:'auto',frame,state:JSON.parse(JSON.stringify(nes.toJSON())),originId:window.flyOriginId||FlySaveStates.legacyOrigin(romHash),savedAt:Date.now(),preview:null}),save:gameSave,load:gameLoad,list:gameList,read:slot=>gameStore.read(gameContext(),slot),continueLast,autosave:()=>loaded?gameSave('auto',{automatic:true}):Promise.resolve(null)};
$('saveState').onclick=()=>gameSave().then(()=>status('Снимок игры сохранён. Обученные веса хранятся отдельно.')).catch(e=>status(e.message,true));
$('loadState').onclick=()=>gameLoad().catch(e=>status(e.message,true));
const fields=['mode','clock','maxHz','thresholdHz','windowMs','gain','seed','disableInhibition','scramble','lesions','inputIds','outputIds','backend','systemButtons','learnerController','actionHoldMode','actionHoldLimit','actionHoldTimeout'];
const capture=()=>Object.fromEntries(fields.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));
const defaults=capture(),gameDefaults=Object.fromEntries([...profileFields,'learnMode','runMode','liveHints','autosavePolicy','layerAutosave'].map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));let lastGraph=null,restored=null,restoreJob=Promise.resolve(),restoring=false,saveJob=null,blocked=null;
const context=()=>ready&&loaded?labPlatform+'|'+romHash+'|'+graphIdentity.sha256:null;
function write(){if(ready&&graphIdentity?.sha256){validateConfiguration(configuration());FlySettings.write(localStorage,labPlatform,graphIdentity.sha256,capture());}}
function applyFields(values){
 const prior=capture();
 try{for(const id of fields){if(!(id in values))continue;const el=$(id),v=values[id];if(typeof v!==(el.type==='checkbox'?'boolean':'string'))throw Error('Неверное поле: '+id);if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===v&&!o.disabled))throw Error('Параметр недоступен: '+id);if(el.type==='checkbox')el.checked=v;else el.value=v;}
  validateConfiguration(configuration());
 }catch(e){for(const id of fields){const el=$(id);if(el.type==='checkbox')el.checked=prior[id];else el.value=prior[id];}throw e;}
 updateSystemButtonsInfo();updateActionHoldInfo();$('gainLabel').textContent=Number($('gain').value).toFixed(2);
}
function readyModel(data){
 if(lastGraph===graphIdentity.sha256)return;lastGraph=graphIdentity.sha256;restored=null;blocked=null;
 const base={...defaults,inputIds:data.inputs.join(', '),outputIds:data.outputs.join(', '),backend:data.backend||'cpu'};
 try{applyFields(base);const saved=FlySettings.read(localStorage,labPlatform,lastGraph);if(saved)applyFields(saved);}catch(e){status('Настройки модели не восстановлены: '+e.message,true);log(e.message);}
 // Native announcements arrive after every script and may precede or follow ROM loading.
 if(loaded)restore();
}
function restore(){
 const c=context();if(!c||restored===c)return restoreJob;
 restored=c;blocked=null;restoring=true;
 for(const [id,value]of Object.entries(gameDefaults)){if(id==='rewardMode')continue;const el=$(id);if(el.type==='checkbox')el.checked=value;else el.value=value;}
 learner.setActions(FlyGameTools.actions($('actionMasks').value,labPlatform==='sega'||labPlatform==='snes'?4095:255));
 if(window.sharedExperience)window.sharedExperience.restore(null);$('fdbJson').value='';gmodeMode='off';$('gmode').value='off';gmodeBoost=false;gmodeBoostBackup=null;$('gmodeBoost').checked=false;configurationApplied=false;restoreGrowthStatePending=false;
 restoreJob=restoreJob.catch(()=>{}).then(async()=>{
  if(context()!==c)return;
  if(window.layerExperience&&await window.layerExperience.resume())return;
  // Migrate the previous alpha's per-ROM slot after checking platform, graph and ports.
  const oldKey='fly-policy-'+romHash+'-'+graphIdentity.sha256;
  const raw=localStorage.getItem(modelStorageKey('fly-policy-'))||localStorage.getItem(oldKey);
  if(raw){const set=JSON.parse(raw);validateModelPackage(set);restoreProfile(set);restorePolicy(set);restoreGrowthStatePending=true;configurationApplied=false;status('Сохранённое обучение восстановлено. Связь остаётся на паузе.');}
 }).catch(e=>{blocked=e;status('Продолжение не восстановлено: '+e.message+'. Сохранённые веса не заменены.',true);log(e.message);}).finally(()=>{restoring=false;trainingView();updateGmodeHud();});
 return restoreJob;
}
function prepare(){
 if(saveJob)return saveJob;
 saveJob=(async()=>{
  // Pause synchronously, then save before waiting on a possibly failed neural backend.
  window.labPause();await window.labGameStates.autosave();
  await restoreJob;if(blocked)throw blocked;window.scoreRewards?.abortDraft();write();window.labPause();
  if(window.dualAgents?.active()){if(!await window.dualAgents.exit())throw Error('Не удалось сохранить два коннектома');}
  if(window.humanTeaching){await window.humanTeaching.stop();if(window.humanTeaching.error())log('Архив показа: '+window.humanTeaching.error()+'. Смена ROM сохраняет веса независимо от архива.');}
  if(window.fdbAgent){await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());}
  if(ready&&loaded&&$('autosavePolicy').checked){if(window.layerExperience)await window.layerExperience.checkpoint();persistPolicy(false);}
 })().finally(()=>{saveJob=null;});return saveJob;
}
async function checkpoint({force=false}={}){if(saveJob){await saveJob;if(!force)return;}await restoreJob;if(blocked)throw blocked;write();if(ready&&loaded&&(force||$('autosavePolicy').checked)&&window.layerExperience&&!window.dualAgents?.active())await window.layerExperience.checkpoint({force});}
let suspendJob=null;
function suspend(){
 if(suspendJob)return suspendJob;
 window.labPause();
 suspendJob=Promise.allSettled([window.labGameStates.autosave(),checkpoint({force:true})]).then(([game,learned])=>({gameSaved:game.status==='fulfilled',learnedSaved:learned.status==='fulfilled',error:[game,learned].filter(r=>r.status==='rejected').map(r=>r.reason?.message||String(r.reason)).join('; ')})).finally(()=>{suspendJob=null;});return suspendJob;
}
window.labState={ready:readyModel,restore,prepare,checkpoint,suspend,pending:()=>!!saveJob,restoring:()=>restoring,settle:()=>restoreJob,accepted:()=>{blocked=null;}};
window.labLifecycleSuspend=token=>{
 // Android can defer this script while backgrounded. An expired request must not
 // pause or save whichever game the user has already resumed in the foreground.
 try{if(window.FlyBridge?.lifecyclePending&&!FlyBridge.lifecyclePending(token)){
  window.guLogger?.event?.('lifecycle.js-save-cancelled',{token,reason:'request-not-pending'});
  return Promise.resolve({cancelled:true,gameSaved:false,learnedSaved:false,error:''});
 }}catch(e){
  const error='Проверка запроса сохранения: '+e.message;
  window.guLogger?.event?.('lifecycle.js-save-cancelled',{token,reason:'validation-failed',error},'error');
  return Promise.resolve({cancelled:true,gameSaved:false,learnedSaved:false,error});
 }
 window.guLogger?.event?.('lifecycle.js-save-start',{token});return suspend().then(result=>{window.guLogger?.event?.('lifecycle.js-save-end',{token,...result},result.error?'error':'info');void window.guLogger?.flush?.();if(result.error)status('Сохранение при уходе в фон: '+result.error,true);if(window.FlyBridge?.lifecycleSaved)FlyBridge.lifecycleSaved(JSON.stringify({token,...result}));return result;});
};
window.labLifecycleNotice=result=>status(result.error,true);
// This handshake lets Android keep the old page alive until durable storage acknowledges it.
window.labPrepareSystemSwitch=async system=>{let okay=false;try{await prepare();okay=true;}catch(e){status('Платформа не переключена: '+e.message,true);$('platformSelect').value=labPlatform;}window.FlyBridge?.finishSystemSwitch?.(system,okay);};
for(const id of fields)$(id).addEventListener('change',()=>{try{write();}catch(e){status('Настройки не сохранены: '+e.message,true);}});
for(const id of ['padP1','padP2','segaRegion']){
 const el=$(id),storageKey='fly-console-'+labPlatform+'-'+id,saved=localStorage.getItem(storageKey);if(saved!==null&&[...el.options].some(o=>o.value===saved))el.value=saved;
 el.addEventListener('change',()=>{try{localStorage.setItem(storageKey,el.value);}catch(e){status('Настройка контроллера не сохранена: '+e.message,true);}});
}
if(ready)readyModel({inputs:ids('inputIds'),outputs:ids('outputIds'),backend:$('backend').value});
setInterval(()=>{if(!playing||!ready||!loaded||saveJob)return;checkpoint().catch(e=>status('Автосохранение: '+e.message,true));},10000);
setInterval(()=>{if(playing&&loaded&&!romLoading&&!gameLoadJob)window.labGameStates.autosave().catch(e=>status('Автоснимок игры: '+e.message,true));},30000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend().then(result=>{if(result.error)status('Сохранение на паузе: '+result.error,true);});});
})();
