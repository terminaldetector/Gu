/* Reopen the same model/game paused. Never copy acquired weights between animals. */
'use strict';
(()=>{
const fields=['mode','clock','maxHz','thresholdHz','windowMs','gain','seed','disableInhibition','scramble','lesions','inputIds','outputIds','backend','systemButtons','learnerController'];
const capture=()=>Object.fromEntries(fields.map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));
const defaults=capture(),gameDefaults=Object.fromEntries([...profileFields,'learnMode','runMode','liveHints','autosavePolicy','layerAutosave'].map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]));let lastGraph=null,restored=null,restoreJob=Promise.resolve(),restoring=false,saveJob=null,blocked=null;
const context=()=>ready&&loaded?labPlatform+'|'+romHash+'|'+graphIdentity.sha256:null;
function write(){if(ready&&graphIdentity?.sha256){validateConfiguration(configuration());FlySettings.write(localStorage,labPlatform,graphIdentity.sha256,capture());}}
function applyFields(values){
 const prior=capture();
 try{for(const id of fields){if(!(id in values))continue;const el=$(id),v=values[id];if(typeof v!==(el.type==='checkbox'?'boolean':'string'))throw Error('Неверное поле: '+id);if(el.tagName==='SELECT'&&![...el.options].some(o=>o.value===v&&!o.disabled))throw Error('Параметр недоступен: '+id);if(el.type==='checkbox')el.checked=v;else el.value=v;}
  validateConfiguration(configuration());
 }catch(e){for(const id of fields){const el=$(id);if(el.type==='checkbox')el.checked=prior[id];else el.value=prior[id];}throw e;}
 updateSystemButtonsInfo();$('gainLabel').textContent=Number($('gain').value).toFixed(2);
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
 $('fdbJson').value='';gmodeMode='off';$('gmode').value='off';gmodeBoost=false;gmodeBoostBackup=null;$('gmodeBoost').checked=false;configurationApplied=false;restoreGrowthStatePending=false;
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
  await restoreJob;if(blocked)throw blocked;write();window.labPause();
  if(window.dualAgents?.active()){if(!await window.dualAgents.exit())throw Error('Не удалось сохранить два коннектома');}
  if(window.humanTeaching){await window.humanTeaching.stop();if(window.humanTeaching.error())throw Error(window.humanTeaching.error());}
  if(window.fdbAgent){await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());}
  if(ready&&loaded&&$('autosavePolicy').checked){if(window.layerExperience)await window.layerExperience.checkpoint();persistPolicy(false);}
 })().finally(()=>{saveJob=null;});return saveJob;
}
async function checkpoint(){if(saveJob)return saveJob;await restoreJob;if(blocked)throw blocked;write();if(ready&&loaded&&$('autosavePolicy').checked&&window.layerExperience&&!window.dualAgents?.active())await window.layerExperience.checkpoint();}
window.labState={ready:readyModel,restore,prepare,checkpoint,pending:()=>!!saveJob,restoring:()=>restoring,settle:()=>restoreJob,accepted:()=>{blocked=null;}};
// This handshake lets Android keep the old page alive until durable storage acknowledges it.
window.labPrepareSystemSwitch=async system=>{let okay=false;try{await prepare();okay=true;}catch(e){status('Платформа не переключена: '+e.message,true);$('platformSelect').value=labPlatform;}window.FlyBridge?.finishSystemSwitch?.(system,okay);};
for(const id of fields)$(id).addEventListener('change',()=>{try{write();}catch(e){status('Настройки не сохранены: '+e.message,true);}});
for(const id of ['padP1','padP2','segaRegion']){
 const el=$(id),storageKey='fly-console-'+labPlatform+'-'+id,saved=localStorage.getItem(storageKey);if(saved!==null&&[...el.options].some(o=>o.value===saved))el.value=saved;
 el.addEventListener('change',()=>{try{localStorage.setItem(storageKey,el.value);}catch(e){status('Настройка контроллера не сохранена: '+e.message,true);}});
}
if(ready)readyModel({inputs:ids('inputIds'),outputs:ids('outputIds'),backend:$('backend').value});
setInterval(()=>{if(!playing||!ready||!loaded||saveJob)return;checkpoint().catch(e=>status('Автосохранение: '+e.message,true));},10000);
document.addEventListener('visibilitychange',()=>{if(document.hidden){window.labPause();checkpoint().catch(e=>status('Сохранение на паузе: '+e.message,true));}});
})();
