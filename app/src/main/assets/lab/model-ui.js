/* Graph selection is a boundary, never a transfer of learned weights between animals. */
'use strict';
(() => {
 const labels={'flywire-v783':'FlyWire v783 · мозг самки','male-cns-v1.0':'Male CNS v1.0 · мозг + VNC самца',imported:'Импортированный граф'};
 const builtins=new Set(['flywire-v783','male-cns-v1.0']);
 let activeId=null,manifest=null,pending=null,sequence=0;
 const say=(text,error=false)=>{$('modelStatus').textContent=text;$('modelStatus').className=error?'note error':'note';};
 function controls(){
  const disabled=!ready||!activeId||!!pending;
  $('connectomeModel').disabled=disabled;
  $('applyConnectomeModel').disabled=disabled||$('connectomeModel').value===activeId||!builtins.has($('connectomeModel').value);
 }
 function textValue(value){
  if(value===null||value===undefined)return null;
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')return String(value).slice(0,2000);
  if(Array.isArray(value))return value.map(textValue).filter(Boolean).join(', ').slice(0,2000);
  if(typeof value==='object')return JSON.stringify(value).slice(0,2000);
  return null;
 }
 function passport(data){
  const m=manifest||{},g=m.graph||{},lines=[labels[activeId]||'Неизвестная модель: '+activeId];
  const row=(name,value)=>{const text=textValue(value);if(text!==null&&text!=='')lines.push(name+': '+text);};
  row('Набор',m.name||m.title);row('Релиз',m.release||m.source_manifest&&m.source_manifest.release||m.version);
  row('Источник',m.source_page||m.sourceUrl||m.source_url||m.source);row('Лицензия',m.license);
  row('Нейронов',m.neurons??g.neurons??data.neurons);row('Связей',m.edges??g.edges??data.edges);
  row('SHA256 графа',data.graph_sha256||graphIdentity&&graphIdentity.sha256);
  row('Веса',m.weight_policy||m.weightConvention||m.weight_convention||m.weights);
  row('Нейромедиаторы',m.neurotransmitter_counts||m.neurotransmitterCoverage||m.neurotransmitter_coverage);
  row('Охват',m.selection||m.coverage);row('Порты',m.port_policy);
  row('Граф и одно CPU-состояние, МиБ',m.runtime_array_budget_bytes?Number((m.runtime_array_budget_bytes/1048576).toFixed(1)):null);
  row('Знаки связей',m.signs||m.signConvention||m.sign_convention);
  if(!manifest)lines.push('Метаданные источника не предоставлены этой сборкой.');
  lines.push('LIF и технические порты — вычислительная модель. Неизвестные / предварительные знаки весов не являются биологически проверенными.');
  $('connectomePassport').textContent=lines.join('\n');
 }
 function finish(){
  if(!pending||!pending.ack||!pending.announced)return;
  clearTimeout(pending.timer);pending=null;$('connectomeModel').value=activeId;controls();
  say('Выбран '+(labels[activeId]||activeId)+'. ROM сохранён; сеть и обучение остановлены. Загрузите Layer Set этого графа или начните новый опыт.');
 }
 function failure(message){
  if(pending)clearTimeout(pending.timer);pending=null;
  if(activeId)$('connectomeModel').value=activeId;controls();say(message,true);status(message,true);
 }
 async function select(){
  if(pending||!ready||!activeId)return;
  const id=$('connectomeModel').value;if(id===activeId)return;
  if(!builtins.has(id)){failure('Эту модель нельзя выбрать из встроенных наборов.');return;}
  if(!window.FlyBridge||typeof window.FlyBridge.selectConnectome!=='function'){
   failure('Выбор коннектома требует Android-сборку с поддержкой двух моделей. Текущий граф не изменён.');return;
  }
  const request={id,sequence:++sequence,ack:false,announced:false,timer:null};pending=request;controls();
  say('Останавливаю опыт и сохраняю обучение текущего графа…');
  try{
   window.labPause();
   if(window.labState)await window.labState.prepare();
   if(window.dualAgents&&window.dualAgents.active()&&!await window.dualAgents.exit())throw Error('Не удалось сохранить обе сети перед выбором одиночной модели.');
   if(window.fdbAgent){await window.fdbAgent.drain();if(window.fdbAgent.error&&window.fdbAgent.error())throw Error(window.fdbAgent.error());}
   // No game policy exists until a ROM is loaded. Model choice must also work before that.
   if(typeof loaded!=='undefined'&&loaded)persistPolicy(false);
   if(window.layerExperience){
    const active=window.layerExperience.activeId&&window.layerExperience.activeId();
    const saved=await window.layerExperience.autosave();
    if(active&&$('layerAutosave').checked&&saved===false)throw Error('Не удалось сохранить активный Layer Set; граф не переключён.');
   }
   if(pending!==request)return;
   say('Загружаю '+labels[id]+'…');
   request.timer=setTimeout(()=>{if(pending===request)failure('Коннектом не подтвердил загрузку. Проверьте паспорт модели; опыт остаётся остановленным.');},120000);
   nativeCall('selectConnectome',id);
  }catch(error){if(pending===request)failure(error.message||String(error));}
 }
 window.labModelSelection=data=>{
  if(!pending||!data||data.id!==pending.id)return;
  if(data.ok!==true){failure(data.error||'Модель не загружена; текущий граф сохранён.');return;}
  pending.ack=true;finish();
 };
 window.connectomeModels={select(id){$('connectomeModel').value=id;return select();},pending:()=>!!pending,ready(data){
  if(!data||typeof data!=='object')return;
  // Older UI fixtures have no model ID; they describe the pre-existing FlyWire build.
  activeId=typeof data.modelId==='string'?data.modelId:'flywire-v783';
  manifest=data.modelManifest&&typeof data.modelManifest==='object'&&!Array.isArray(data.modelManifest)?data.modelManifest:null;
  const imported=$('importedConnectome');imported.hidden=activeId!=='imported';
  $('connectomeModel').value=pending?pending.id:activeId;
  passport(data);
  if(pending&&pending.id===activeId){pending.announced=true;finish();}
  else if(!pending)say('Активный граф: '+(labels[activeId]||activeId)+'. Веса и Layer Sets другой модели не переносятся автоматически.');
  controls();
 }};
 $('connectomeModel').onchange=controls;$('applyConnectomeModel').onclick=select;
 controls();
})();
