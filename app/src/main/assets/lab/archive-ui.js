'use strict';
(() => {
 const A=FlyArchiveReplay,roles=new Map();let sessions=[],job=null,result=null,baseFingerprint=null,applying=false;
 const context=()=>({system:labPlatform,romHash,graphSha256:graphIdentity&&graphIdentity.sha256,inputs:ids('inputIds'),outputs:ids('outputIds')});
 const fingerprint=()=>JSON.stringify({policy:learner.save(),key:learningKey()});
 const message=s=>$('archiveStatus').textContent=s;
 const percent=(a,b)=>b?(100*a/b).toFixed(1)+'%':'—';
 function controls(){
  const busy=!!job||applying;$('archiveRun').disabled=busy;$('archiveCancel').disabled=!job;$('archivePasses').disabled=busy;
  $('archiveApply').disabled=busy||!result||result.applied;$('archiveExport').disabled=busy||!result;
  document.querySelectorAll('#archiveSessionRoles select').forEach(s=>s.disabled=busy);
 }
 function renderSessions(list){
  sessions=list;const panel=$('archiveSessionRoles');panel.replaceChildren();const c=context();
  const eligible=list.filter(m=>m.status==='closed'&&m.accepted&&A.compatible(m,c)).sort((a,b)=>a.startedAt-b.startedAt);
  for(const m of eligible){
   const label=document.createElement('label'),select=document.createElement('select');
   label.textContent=m.name+' · '+new Date(m.startedAt).toLocaleString()+' · '+m.accepted+' прим.';
   select.dataset.session=m.id;select.setAttribute('aria-label','Роль сессии '+m.name+' '+new Date(m.startedAt).toLocaleString());
   for(const [value,text] of [['ignore','Не использовать'],['train','Обучение'],['test','Контрольная проверка']]){const o=document.createElement('option');o.value=value;o.textContent=text;select.appendChild(o);}
   select.value=roles.get(m.id)||'ignore';select.onchange=()=>{roles.set(m.id,select.value);result=null;$('archiveResult').textContent='';$('archiveButtons').replaceChildren();message('Набор изменён. Запустите новое обучение и проверку.');controls();};
   label.appendChild(select);panel.appendChild(label);
  }
  if(!eligible.length){const p=document.createElement('p');p.className='note';p.textContent='Здесь появятся завершённые сессии этой игры, графа и текущих входных/выходных портов.';panel.appendChild(p);}
  controls();
 }
 function renderReport(){
  const {training:t,test:m}=result.report;
  $('archiveResult').textContent=`Обучение: ${t.uniqueSamples} примеров, ${t.updates} обновлений, ${t.seconds.toFixed(2)} с; пропущено за все проходы ${t.skipped}. Проверка: ${m.samples} примеров, ${m.seconds.toFixed(2)} с. Полная маска совпала в ${percent(m.correct,m.samples)} случаев (${percent(m.correctSeconds,m.seconds)} по времени). Базовый результат: ${percent(m.baselineCorrect,m.samples)}. Без кнопок: ${percent(m.neutral,m.samples)}; неизвестных масок: ${m.unseen}; пропущено: ${m.skipped}.`;
  const body=$('archiveButtons');body.replaceChildren();
  for(const [i,name] of buttonNames.entries()){
   const b=m.buttons[i],tr=document.createElement('tr');
   for(const text of [name,percent(b.tp,b.tp+b.fp),percent(b.tp,b.tp+b.fn),(b.tp+b.fn).toFixed(2)+' с']){const td=document.createElement('td');td.textContent=text;tr.appendChild(td);}body.appendChild(tr);
  }
  controls();
 }
 function cancel(){if(job)job.cancelled=true;}
 window.humanArchive={sessions:renderSessions,cancel};
 $('archivePasses').onchange=()=>{result=null;controls();message('Число проходов изменено. Запустите новое обучение.');};
 $('archiveCancel').onclick=cancel;
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')cancel();});
 window.addEventListener('blur',cancel);
 $('archiveRun').onclick=async()=>{
  if(job||applying)return;result=null;$('archiveResult').textContent='';$('archiveButtons').replaceChildren();window.labPause();
  const current={cancelled:false};job=current;controls();message('Завершаю запись и читаю выбранные сессии…');
  try{
   if(!loaded||!ready||romLoading)throw Error('Дождитесь ROM и коннектома');
   await humanTeaching.stop('archive');const list=await humanTeaching.store.request('list');
   const pick=role=>list.filter(m=>roles.get(m.id)===role&&A.compatible(m,context()));baseFingerprint=fingerprint();
   result=await A.run(humanTeaching.store,{train:pick('train'),test:pick('test'),context:context(),base:learner.save(),allowedMask:agentAllowedMask(),passes:Number($('archivePasses').value)},{cancelled:()=>current.cancelled,progress:p=>message((p.phase==='train'?'Обучение · проход '+p.pass:'Контрольная проверка')+' · '+p.events+'/'+p.total+' событий сессии · '+p.trained+' обновлений')});
   if(current.cancelled)throw Error('Обработка отменена. Действующая модель сохранена.');
   message('Новый адаптер готов. Просмотрите проверку и примените веса, чтобы использовать их в игре.');renderReport();
  }catch(e){result=null;message(e.message);}
  finally{job=null;controls();}
 };
 $('archiveApply').onclick=async()=>{
  if(!result||result.applied||job||applying)return;const candidate=result;applying=true;controls();
  try{
   window.labPause();await humanTeaching.stop('archive-apply');
   const list=await humanTeaching.store.request('list');
   for(const ref of [...candidate.report.provenance.train,...candidate.report.provenance.test]){
    const m=list.find(m=>m.id===ref.id);if(!m||m.status!=='closed'||A.snapshot(m)!==A.snapshot(ref))throw Error('Исходная сессия удалена или изменилась. Повторите обработку.');
   }
   if(fingerprint()!==baseFingerprint)throw Error('Модель или настройки изменились. Повторите обучение по архиву.');
   const backup=JSON.parse(JSON.stringify(learner.save())),oldExamples=humanExamples,oldActions=$('actionMasks').value;
   try{
    learner.load(candidate.policy);learner.setAllowedMask(agentAllowedMask());$('actionMasks').value=learner.actions.join(',');humanExamples=JSON.parse(JSON.stringify(candidate.recent));persistPolicy(false);
   }catch(e){learner.load(backup);learner.setAllowedMask(agentAllowedMask());humanExamples=oldExamples;$('actionMasks').value=oldActions;throw e;}
   pendingFdbReplay=null;learningBoundary();learningStats();candidate.applied=true;controls();
   message('Новые веса подражания применены и сохранены. Для проверки в игре выберите режим «Проверка». FDB подключается отдельной кнопкой.');
   if(window.layerExperience)window.layerExperience.autosave();
  }catch(e){message('Применение: '+e.message);}finally{applying=false;controls();}
 };
 $('archiveExport').onclick=()=>{
  if(!result)return;
  if(window.FlyBridge&&typeof FlyBridge.exportModel==='function')nativeCall('exportModel',JSON.stringify(result.report));
  else{const url=URL.createObjectURL(new Blob([JSON.stringify(result.report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='fly-archive-evaluation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 };
 humanTeaching.refresh();
})();
