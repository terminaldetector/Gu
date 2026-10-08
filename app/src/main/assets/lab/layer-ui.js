/* Named experiments share one running agent. Loading never restores or restarts a ROM. */
'use strict';
(() => {
const S=FlyLayerSets,store=new S.Store(localStorage,window.FlyBridge);
let entries=[],active=null,journal=[],busy=false,deleteId=null,saveQueue=Promise.resolve(),contextKey=null;
const ctx=()=>({system:labPlatform,romHash,graphSha256:graphIdentity&&graphIdentity.sha256});
const message=(text,error=false)=>{$('layerStatus').textContent=text;$('layerStatus').className=error?'note error':'note';};
const selected=()=>entries.find(e=>e.id===$('layerSelect').value);
function renderList(preferred=$('layerSelect').value){
 const select=$('layerSelect');select.replaceChildren(new Option('Выберите набор…',''));
 for(const entry of entries.slice().sort((a,b)=>b.updatedAt-a.updatedAt)){
  const okay=S.compatible(entry,ctx()),option=new Option(entry.name+' · '+entry.system.toUpperCase()+(okay?'':' · другой ROM / граф'),entry.id);
  select.add(option);
 }
 if(entries.some(e=>e.id===preferred))select.value=preferred;
 renderSelected();
}
function renderSelected(){
 const entry=selected(),okay=entry&&S.compatible(entry,ctx());
 $('layerLoad').disabled=busy||!okay;$('layerUpdate').disabled=busy||!okay;$('layerExport').disabled=busy||!entry;$('layerDelete').disabled=busy||!entry;
 $('layerNew').disabled=busy||!ready||!loaded;$('layerImport').disabled=busy;$('layerRefresh').disabled=busy;
 $('layerDeleteConfirm').hidden=deleteId!==$('layerSelect').value||!deleteId;
 $('layerDeleteCancel').hidden=$('layerDeleteConfirm').hidden;
 $('layerSelectedInfo').textContent=entry?`${entry.name} · обновлений ${entry.updates} · эпизодов ${entry.episodes} · FDB ${entry.fdbEdges} новых / ${entry.fdbDeltas} изменённых\nROM ${entry.romHash.slice(0,12)} · граф ${entry.graphSha256.slice(0,12)} · ${new Date(entry.updatedAt).toLocaleString()}${okay?'':'\nЗагрузите соответствующий ROM и коннектом.'}`:'Наборы хранят веса адаптера, FDB и настройки. ROM и исходный граф не копируются.';
}
async function refresh(preferred){entries=await store.request('list');renderList(preferred);}
function refreshStats(){
 const name=active?active.name:'без именованного набора';let fdb=null;try{fdb=fdbConfiguration();}catch(_){}
 $('layerLiveStats').textContent=`Текущий: ${name} · обновлений ${learner.updates} · FDB ${fdb&&fdb.edges?fdb.edges.length:0}`;
 const badge=$('layerBadge');badge.hidden=!active;badge.textContent=active?'LAYER · '+active.name:'';badge.title=active?active.name:'';
 const counts=S.stats(journal);$('experienceStats').textContent=`Ручные отметки: побед ${counts.manual.win} · поражений ${counts.manual.loss} · continue ${counts.manual.continue}\nRAM / диагностический критерий: побед ${counts.criterion.win} · поражений ${counts.criterion.loss} · границ без результата ${counts.boundaries}`;
 $('experienceLog').textContent=journal.slice(-20).reverse().map(e=>`${new Date(e.at).toLocaleTimeString()} · ${e.source} / ${e.outcome} · обновлений ${e.updates}${e.note?' · '+e.note:''}`).join('\n')||'Отметок пока нет.';
}
function append(event){journal.push({at:Date.now(),updates:learner.updates,frame,layer:active&&active.id||null,note:'',...event});if(journal.length>200)journal.shift();refreshStats();}
function packageSet(newCopy=false,automatic=false){
 const base=automatic?active:selected(),old=newCopy?null:base;
 if(!newCopy&&!old)throw Error('Выберите набор для обновления');if(old&&!S.compatible(old,ctx()))throw Error('Обновление набора другого ROM / графа запрещено');
 const packet=policyPackage(false),now=Date.now();
 return S.validate(S.clone({...packet,type:S.TYPE,layerVersion:1,id:old?old.id:S.id(),name:automatic?old.name:$('layerName').value.trim(),notes:automatic?old.notes:$('layerNotes').value.trim(),createdAt:old?old.createdAt:now,updatedAt:now,graph:graphIdentity,runtime:{clock:$('clock').value,runMode:$('runMode').value,learnMode:$('learnMode').value},journal}));
}
function save(newCopy=false,automatic=false){
 let packet;try{packet=packageSet(newCopy,automatic);}catch(e){if(!automatic)message(e.message,true);else log('Layer Set: '+e.message);return Promise.resolve(false);}
 const context=ctx();
 saveQueue=saveQueue.catch(()=>{}).then(async()=>{
  busy=true;renderSelected();
  try{const metadata=await store.request('save',{set:packet});
   if(S.compatible(metadata,ctx())&&context.romHash===romHash){active=metadata;if(!automatic){$('layerName').value=metadata.name;$('layerNotes').value=metadata.notes;}refreshStats();}
   await refresh(automatic?$('layerSelect').value:packet.id);message((automatic?'Автосохранён: ':'Сохранён: ')+packet.name);return true;
  }catch(e){message(e.message,true);log('Layer Set: '+e.message);return false;}
  finally{busy=false;renderSelected();}
 });return saveQueue;
}
function validatePortable(set){
 S.validate(set);const probe=new FlyLearner();probe.load(set.policy);
 if(JSON.stringify(probe.actions)!==JSON.stringify(FlyGameTools.actions(set.profile.actionMasks,(set.system==='sega'||set.system==='snes')?4095:255)))throw Error('Действия и веса Layer Set не совпадают');
 const expected=JSON.stringify({romHash:set.romHash,inputs:set.configuration.inputs,outputs:set.configuration.outputs,system:set.system,graph_sha256:set.graph.sha256,profile:set.profile,configuration:policyConfiguration(set.configuration),gmode:set.configuration.gmode||'off'});
 if(!keysEqual(set.key,expected))throw Error('Подписи профиля Layer Set не совпадают');
 return set;
}
async function load(){
 const entry=selected();if(!entry||!S.compatible(entry,ctx()))throw Error('Выберите набор текущего ROM и графа');
 const before=ctx();const set=validatePortable(await store.request('get',{id:entry.id}));
 if(!S.compatible(S.summary(set),ctx())||before.romHash!==romHash)throw Error('ROM или граф изменился во время загрузки');
 validateModelPackage(set);
 const prepared=S.clone(set),oldGmode=gmodeMode;
 if($('layerKeepPlayers').checked){prepared.configuration.gmode=oldGmode;const key=JSON.parse(prepared.key);key.gmode=oldGmode;key.configuration.gmode=oldGmode;prepared.key=JSON.stringify(key);}
 // Preserve the user's episode start as well as the running console frame.
 prepared.start=startSnapshot;
 const requiresReset=requestedConfiguration&&(requestedConfiguration.seed!==prepared.configuration.seed||(requestedConfiguration.backend||'cpu')!==(prepared.configuration.backend||'cpu'));
 restoreProfile(prepared);restorePolicy(prepared);
 $('clock').value=set.runtime.clock;$('runMode').value=set.runtime.runMode;$('learnMode').value=set.runtime.learnMode;
 restoreGrowthStatePending=true;configurationApplied=false;
 const diagnostic=$('rewardMode').value==='diagnostic';terminalLatch={success:diagnostic?nes.cpu.mem[0]>=200&&Math.abs(nes.cpu.mem[1]-100)<=4:$('winEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('winAddress').value,$('winValue').value,ramLimit),death:$('deathEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('deathAddress').value,$('deathValue').value,ramLimit)};
 active=S.summary(set);journal=S.clone(set.journal);$('layerName').value=set.name;$('layerNotes').value=set.notes;refreshStats();
 const text='Загружен «'+set.name+'». ROM сохранён; связь остановлена. '+(requiresReset?'Другой seed / CPU–GPU: примените кнопкой «Сбросить только сеть».':'Включите связь для применения FDB без сброса динамики.');
 message(text);status(text);
}
async function importSet(data){
 try{const imported=S.clone(validatePortable(data));imported.id=S.id();imported.createdAt=imported.updatedAt=Date.now();await store.request('save',{set:imported});await refresh(imported.id);$('layerName').value=imported.name;$('layerNotes').value=imported.notes;message('Импортирован «'+imported.name+'». Текущее обучение не изменено.');}catch(e){message(e.message,true);status(e.message,true);}
}
function autosave(){if(active&&$('layerAutosave').checked)return save(false,true);return Promise.resolve(false);}
function contextChanged(){
 const key=JSON.stringify(ctx());if(key===contextKey){renderList();refreshStats();return;}contextKey=key;
 if(active&&!S.compatible(active,ctx())){active=null;journal=[];message('Контекст изменён: выберите Layer Set нужного ROM и коннектома.');}
 if(!active)journal=[];renderList();refreshStats();
}
window.labLayerSets=response=>store.receive(response);
window.layerExperience={refreshStats,contextChanged,importSet,autosave,terminal:event=>{append(event);if(event.mode==='train')autosave();}};
const act=fn=>async()=>{if(busy)return;busy=true;renderSelected();try{await fn();}catch(e){message(e.message,true);status(e.message,true);}finally{busy=false;renderSelected();}};
// Save owns its queue and busy state; other actions are serialized by their UI controls.
 $('layerNew').onclick=()=>save(true);$('layerUpdate').onclick=()=>save(false);
 $('layerLoad').onclick=act(load);$('layerRefresh').onclick=act(()=>refresh());
 $('layerExport').onclick=act(async()=>{const entry=selected();if(!entry)throw Error('Выберите набор');const set=await store.request('get',{id:entry.id});nativeCall('exportModel',JSON.stringify(set));});
 $('layerImport').onclick=()=>nativeCall('importModel');
 $('layerSelect').onchange=()=>{deleteId=null;const entry=selected();if(entry){$('layerName').value=entry.name;$('layerNotes').value=entry.notes;}renderSelected();};
 $('layerDelete').onclick=()=>{deleteId=$('layerSelect').value;renderSelected();};
 $('layerDeleteCancel').onclick=()=>{deleteId=null;renderSelected();};
 $('layerDeleteConfirm').onclick=act(async()=>{const id=deleteId;if(!id||id!==$('layerSelect').value)throw Error('Выберите набор для удаления');await store.request('delete',{id});if(active&&active.id===id)active=null;deleteId=null;await refresh();refreshStats();message('Набор удалён; текущие веса продолжают работать.');});
 for(const outcome of ['win','loss','continue','note'])$('experience-'+outcome).onclick=()=>{if(!loaded){message('Сначала загрузите ROM',true);return;}append({source:'manual',outcome,note:$('experienceNote').value.trim().slice(0,500),mode:$('learnMode').value});$('experienceNote').value='';autosave();};
 $('experienceExport').onclick=()=>{if(!ready||!loaded){status('Дождитесь ROM и коннектома',true);return;}nativeCall('exportModel',JSON.stringify({version:1,type:'fly-experience-report',system:labPlatform,romHash,graph:graphIdentity,layer:active,configuration:configuration(),profile:profileValues(),updates:learner.updates,journal:S.clone(journal),summary:S.stats(journal)}));};
 refreshStats();refresh().catch(e=>message(e.message,true));
})();
