/* Durable observations use their own lifecycle; policy/FDB retain bounded live buffers. */
'use strict';
(() => {
 const store=new FlyTrainingSessions.Store(localStorage,window.FlyBridge);
 let capture=null,writer=null,wallStarted=0,previous=null,sessions=[],refreshSequence=0;
 window.labTrainingSessions=r=>store.receive(r);
 const active=()=>!benchmark&&document.hasFocus()&&document.visibilityState==='visible'&&loaded&&ready&&playing&&connected&&!configuring&&!romLoading&&$('learnMode').value==='teach'&&!$('freeze').checked&&gmodeMode==='off'&&document.querySelector('main').dataset.tab==='game';
 const contextMatches=m=>m.system===labPlatform&&m.romHash===romHash&&m.graphSha256===(graphIdentity&&graphIdentity.sha256);
 const round=a=>a.map(x=>Math.round(x*1e6)/1e6);
 function selection(){return sessions.find(m=>m.id===$('humanSessionSelect').value);}
 function render(){
  const select=$('humanSessionSelect'),chosen=select.value;
  select.replaceChildren();
  for(const m of sessions.filter(m=>$('humanAllSessions').checked||contextMatches(m)).sort((a,b)=>b.startedAt-a.startedAt)){
   const o=document.createElement('option');o.value=m.id;o.textContent=($('humanAllSessions').checked?m.system.toUpperCase()+' · '+m.name+' · ':'')+new Date(m.startedAt).toLocaleString()+' · '+m.accepted+' прим. · '+(m.status==='closed'?'завершена':writer&&writer.metadata.id===m.id&&!writer.closed?'записывается':'прервана');select.appendChild(o);
  }
  if([...select.options].some(o=>o.value===chosen))select.value=chosen;
  if(writer&&!writer.closed&&[...select.options].some(o=>o.value===writer.metadata.id))select.value=writer.metadata.id;
  const m=selection();$('humanSessionExport').disabled=!m;$('humanSessionDelete').disabled=!m;
  $('humanSessionStats').textContent=m?`${m.inputChanges} событий ввода · ${m.samples} исполненных действий · принято ${m.accepted}, пропущено ${m.skipped} · ${(m.gameMs/1000).toFixed(1)} с игры · ${(m.storedBytes/1024).toFixed(1)} КиБ`:'Для этой игры и коннектома сессий пока нет. Выберите «Показываю сам» и начните игру.';
  const body=$('humanCoverage');body.replaceChildren();
  if(m)for(const [i,name] of buttonNames.entries()){
   const row=document.createElement('tr'),label=document.createElement('td'),value=document.createElement('td');label.textContent=name;value.textContent=((m.buttonMs[i]||0)/1000).toFixed(2)+' с';row.append(label,value);body.appendChild(row);
  }
  $('humanNeutral').textContent=m?'Без кнопок: '+(m.neutralMs/1000).toFixed(2)+' с. Удержания сочетаний входят в каждую кнопку. Длительность не показывает качество игры.':'';
  $('humanSessionIdentity').textContent=m?m.system.toUpperCase()+' · ROM '+m.romHash.slice(0,12)+' · граф '+m.graphSha256.slice(0,12):'';
 }
 function state(w){
  const i=sessions.findIndex(m=>m.id===w.metadata.id);if(i>=0)sessions[i]=w.metadata;else if(w.metadata.events!==undefined)sessions.push(w.metadata);
  if(w.failed){$('humanSessionStatus').textContent='Ошибка записи: '+w.error+'. Сохранённая часть доступна для экспорта.';if(!w.reported){w.reported=true;log('Сессия показа: '+w.error);status('Запись показа: '+w.error,true);}}
  else $('humanSessionStatus').textContent=(w.closed?'Сессия завершена':'Запись показа')+' · подтверждено '+(w.metadata.events||0)+' событий'+(w.pending?' · сохраняется '+w.pending+' пак.':w.buffer.length?' · ожидает '+w.buffer.length+' событий':' · сохранено');
  render();
 }
 async function refresh(){
  const sequence=++refreshSequence;
  try{const list=await store.request('list');if(sequence!==refreshSequence)return;sessions=list;render();}
  catch(e){$('humanSessionStatus').textContent=e.message;}
 }
 function received(e){
  if(e.kind==='sample'){
   e.accepted=learner.teach(e.features,e.mask,e.seconds);previous=e.retina.slice();
   if(e.accepted){
    $('actionMasks').value=learner.actions.join(',');
    const example={frame:e.frame,retina:e.retina.slice(),mask:e.mask,seconds:e.seconds,human:true};
    humanExamples.push(example);if(humanExamples.length>200)humanExamples.shift();queueFdbExperience(example);
    if(learner.demonstrations%100===0&&$('autosavePolicy').checked){try{persistPolicy(false);if(window.layerExperience)window.layerExperience.autosave();}catch(error){log('Сохранение примеров: '+error.message);}}
   }
   e.retina=round(e.retina);e.features=round(e.features);e.outputs=round(e.outputs);learningStats();
  }
  writer.add(e);
 }
 function ensure(){
  if(!active())return false;if(capture)return true;
  wallStarted=performance.now();previous=null;
  const configuration=policyConfiguration();if(configuration.fdb){configuration.fdb.edgeCount=(configuration.fdb.edges||[]).length;configuration.fdb.deltaCount=(configuration.fdb.deltas||[]).length;delete configuration.fdb.edges;delete configuration.fdb.deltas;}
  writer=new FlyTrainingSessions.Writer(store,{system:labPlatform,romHash,graphSha256:graphIdentity.sha256,name:($('benchmarkGame').value.trim()||labPlatform.toUpperCase()+' · '+romHash.slice(0,12)).slice(0,100),startedAt:Date.now(),clock:$('clock').value,configuration,profile:profileValues(),captureVersion:1},state);
  capture=new FlyHumanCapture(received);return true;
 }
 function input(){if(!ensure())return;capture.input(normalizeMask(manualMask),{frame,at:Date.now(),wallMs:Math.max(0,performance.now()-wallStarted)});}
 function beforeFrame(){
  if(!active()){stop('inactive');return null;}input();
  return {frame,at:Date.now(),wallMs:Math.max(0,performance.now()-wallStarted),mask:normalizeMask(appliedMask),retina:retina.slice(),features:learner.features(retina,latestOutputs,null,previous),outputs:latestOutputs.slice(),networkAgeMs:lastResponse?Math.max(0,performance.now()-lastResponse):null};
 }
 function commit(seconds,observation){if(capture&&observation)capture.commit(seconds,observation);}
 function stop(reason='pause'){
  if(!capture)return writer?Promise.all([...writer.writes]):Promise.resolve();capture.stop();capture=null;previous=null;
  const old=writer;const done=old.close(reason);state(old);return done;
 }
 window.humanTeaching={input,beforeFrame,commit,stop,refresh,store,error:()=>writer&&writer.failed?writer.error:null};
 $('humanSessionRefresh').onclick=refresh;$('humanSessionSelect').onchange=render;
 $('humanAllSessions').onchange=render;
 $('humanSessionExport').onclick=async()=>{
  const m=selection();if(!m)return;
  try{await stop('export');const report=await store.request('export',{id:m.id});if(report.events)nativeCall('exportModel',JSON.stringify({type:'fly-human-session-report',version:1,...report}));}
  catch(e){$('humanSessionStatus').textContent='Экспорт: '+e.message;}
 };
 $('humanSessionDelete').onclick=async()=>{
  const m=selection();if(!m||!confirm('Удалить полную сессию «'+m.name+'» от '+new Date(m.startedAt).toLocaleString()+'? События исчезнут из приложения. Экспорт модели содержит только последние 200 примеров; сохраните полную сессию отдельно, если она нужна.'))return;
  try{await stop('delete');await store.request('close',{id:m.id,endedAt:Date.now(),reason:'delete'});await store.request('delete',{id:m.id});await refresh();$('humanSessionStatus').textContent='Выбранная сессия удалена. Веса обучения сохранены.';}
  catch(e){$('humanSessionStatus').textContent='Удаление: '+e.message;}
 };
 setInterval(()=>{if(writer&&!writer.closed){writer.flush();state(writer);}},1000);
 refresh();
})();
