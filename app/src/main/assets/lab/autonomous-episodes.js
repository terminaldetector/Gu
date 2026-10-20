/* Single-agent round robin over pinned game states; training weights never rewind with the game. */
'use strict';
(()=>{
 if(!window.curriculumSessions||typeof window.FlyBridge?.evaluationSeries!=='function')return;
 let run=null,sequence=0;const pending=new Map();
 const button=document.createElement('button'),stop=document.createElement('button'),info=document.createElement('p');button.id='autonomousStart';button.textContent='Автономные отрезки';stop.id='autonomousStop';stop.textContent='Остановить серию';stop.disabled=true;info.id='autonomousStatus';info.className='note';info.setAttribute('role','status');$('trainingStatus').after(button,stop,info);
 const message=(text,error=false)=>{info.textContent=text;info.className=error?'note error':'note';};
 function rpc(op,args={}){return new Promise((resolve,reject)=>{const token='evaluation-'+(++sequence),timer=setTimeout(()=>{pending.delete(token);reject(Error('Контрольная серия не подтверждена'));},30000);pending.set(token,{resolve,reject,timer});try{FlyBridge.evaluationSeries(JSON.stringify({op,token,...args}));}catch(e){clearTimeout(timer);pending.delete(token);reject(e);}});}
 window.labEvaluationSeries=reply=>{const job=pending.get(reply.token);if(!job)return;pending.delete(reply.token);clearTimeout(job.timer);reply.error?job.reject(Error(reply.error)):job.resolve(reply.data);};
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 function valid(r){if(run!==r||r.cancelled)throw Error('Серия остановлена');if(romHash!==r.romHash||romLoadSequence!==r.romSequence||graphIdentity?.sha256!==r.graph||window.dualAgents?.active()||$('quickMenu').open)throw Error('Игра или агент изменились');}
 async function ready(r){const until=performance.now()+45000;while(true){valid(r);const current=!configuring&&connected?requireDurableCurrent():null;if(current&&playing&&!window.labCurrentPending&&window.fdbAgent?.isBound(current)&&window.curriculumSessions.assignment())return;if(performance.now()>until)throw Error('Агент не подтвердил готовность отрезка');await delay(20);}}
 function feedback(){const p=profileValues();if(p.rewardMode==='diagnostic'){if(labPlatform!=='nes'||romHash!==diagnosticHash)throw Error('Диагностический источник относится к другому ROM');}
  else if(p.rewardMode==='score')FlyScoreSearch.validate(p.scoreSource,p,labPlatform,romHash,ramLimit);
  else if(p.rewardMode!=='ram'&&!(p.winEnabled||p.deathEnabled))throw Error('Нет достоверного источника результата; обучение не запускается');return p;
 }
 async function launch(r,kind){valid(r);window.learningUI.choose(kind);await window.learningUI.start();if(kind==='eval'){$('clock').value='lockstep';window.learningUI.rate(1);}await ready(r);valid(r);}
 async function scan(r){
  const metadata=await window.labGameStates.list(),starts=[];
  for(const entry of metadata){valid(r);if(entry.error)continue;const snapshot=await window.labGameStates.read(entry.slot);if(!snapshot||snapshot.revision!==entry.revision)throw Error('Снимки изменились при подготовке серии');const role=await window.curriculumSessions.classify(snapshot);starts.push({snapshot,role});}
  if(window.episodeStarts)for(const snapshot of await window.episodeStarts.list(window.labGameStates.context())){valid(r);const role=await window.curriculumSessions.classify(snapshot);starts.push({snapshot,role});}
  window.curriculumSessions.clear();r.starts=starts.filter(x=>x.role.role==='train');r.controls=starts.filter(x=>x.role.role==='control');
  // Identical states in different slots are one start, never extra samples.
  for(const key of ['starts','controls']){const seen=new Set();r[key]=r[key].filter(x=>!seen.has(x.role.stateHash)&&seen.add(x.role.stateHash));}
  if(!r.starts.length)throw Error('Нет доступных обучающих стартов. Контрольные старты автоматически защищены от обучения');
 }
 async function load(r,start,kind){
  valid(r);r.waiting=true;window.labPause();await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());
  await window.labGameStates.load(start.snapshot.slot,{snapshot:start.snapshot,permit:()=>run===r&&!r.cancelled});valid(r);window.curriculumSessions.clear();await launch(r,kind);
  const assigned=window.curriculumSessions.assignment();if(assigned.role!==(kind==='eval'?'control':'train')||assigned.groupId!==start.role.groupId)throw Error('Назначение группы изменилось; серия остановлена');
  if(kind==='eval'&&r.proofId)await rpc('arm',{id:r.proofId,originId:window.flyOriginId,stateHash:start.role.stateHash,startFrame:start.snapshot.frame,generation,seed:1});
  valid(r);r.waiting=kind==='eval'&&!r.proofId;message((kind==='eval'?'Замороженный контроль · '+(r.leg==='reference'?'контрольная модель':'Current')+' · ':'Обучающий отрезок ')+(r.index+1)+'/'+(kind==='eval'?r.controls.length:r.starts.length)+(r.controlsUsed?'. '+r.comparisonStatus:'. Приобретённые веса сохраняются автоматически.'));
 }
 async function next(r,event,boundary){
  const closed=await boundary;if(closed?.error)throw Error(closed.error);valid(r);await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());
  if(r.phase==='control'){
   const confidence=event.outcome==='unknown'?'unknown':event.source==='diagnostic'?'diagnostic':'configured';await rpc('trial',{id:r.proofId,outcome:event.outcome,confidence,boundary:event.boundary});
   if(++r.index<r.controls.length)return load(r,r.controls[r.index],'eval');
   const result=await rpc('end',{id:r.proofId});valid(r);
   if(result.nextLeg==='reference'){r.leg='reference';r.index=0;return load(r,r.controls[0],'eval');}
   r.proofId=null;r.lastProof=result.proof;r.controlsUsed=true;
   if(!result.proof.valid)throw Error('Контрольная серия не подтверждена: '+result.proof.reason);
   if(result.roles)window.layerExperience.showRoles(result.roles);
   r.comparisonStatus=result.bestUpdated?'Best обновлён после парного подтверждения.':('Парное сравнение сохранено. Best не обновлён: '+(result.promotionGate?.reasons?.join('; ')||'нет подтверждённого улучшения')+'. Для следующей проверки нужны новые независимые старты.');
   message(r.comparisonStatus);
   r.phase='train';r.index=0;return load(r,r.starts[0],'auto');
  }
  await window.layerExperience.checkpoint({force:true});valid(r);
  if(++r.index<r.starts.length)return load(r,r.starts[r.index],'auto');
  r.index=0;
  if(r.controls.length&&!r.controlsUsed){r.phase='control';r.leg='candidate';await load(r,r.controls[0],'eval');r.waiting=true;const data=await rpc('begin',{layerId:window.layerExperience.activeId(),romHash,core:window.labCoreIdentity,actions:learner.actions,speed:emulationRate,trials:r.controls.length,starts:r.controls.map(x=>({originId:x.role.originId||x.snapshot.originId||FlySaveStates.legacyOrigin(x.snapshot.hash),stateHash:x.role.stateHash,startFrame:x.snapshot.frame,seed:1}))});if(data.skipped){r.controlsUsed=true;r.comparisonStatus='Best сохранён: '+data.reason+'. Обучение продолжается.';r.phase='train';r.index=0;return load(r,r.starts[0],'auto');}r.proofId=data.id;await rpc('arm',{id:r.proofId,originId:window.flyOriginId,stateHash:r.controls[0].role.stateHash,startFrame:r.controls[0].snapshot.frame,generation,seed:1});valid(r);r.waiting=false;return;}
  message(r.comparisonStatus||'Круг обучения сохранён. Независимых контрольных стартов пока нет; Best не подтверждён.');return load(r,r.starts[0],'auto');
 }
 async function cancel(error=null,{keepPlaying=false}={}){const r=run;if(!r)return;r.cancelled=true;r.waiting=true;const same=romHash===r.romHash&&romLoadSequence===r.romSequence&&graphIdentity?.sha256===r.graph;if(same&&!keepPlaying)window.labPause();run=null;button.disabled=false;stop.disabled=true;
  if(r.proofId)try{await rpc('abort',{id:r.proofId});}catch(e){error=Error((error?.message||'')+'; запись отказа контроля: '+e.message);}
  if(same){const saved=await Promise.allSettled([window.labGameStates.autosave(),window.layerExperience.checkpoint({force:true})]);const failures=saved.filter(x=>x.status==='rejected');if(failures.length)error=Error((error?.message||'')+'; сохранение: '+failures.map(x=>x.reason.message).join('; '));}
  message(error?'Серия остановлена: '+error.message:'Серия остановлена. Приобретённые веса сохранены отдельно от игры.',Boolean(error));
 }
 async function start(){if(run)return;try{
   if(!loaded||!ready||romLoading||window.dualAgents?.active()||gmodeMode!=='off')throw Error('Нужны одна игра и один нейронный агент без ручного второго порта');feedback();if($('freeze').checked)throw Error('Для автономной игры нужны текущие наблюдения экрана');
   window.labPause();const r={romHash,romSequence:romLoadSequence,graph:graphIdentity.sha256,phase:'train',index:0,waiting:true,cancelled:false,proofId:null};run=r;button.disabled=true;stop.disabled=false;
   $('learnerController').value='exo';await launch(r,'auto');window.labPause();await window.fdbAgent.drain();await window.labGameStates.autosave();await scan(r);await load(r,r.starts[0],'auto');
  }catch(error){if(run)await cancel(error);else message(error.message,true);}}
 button.onclick=start;stop.onclick=()=>cancel();
 for(const id of ['play','resetNes','brainToggle','trainingStart','import','demo','platformOpenRom'])$(id)?.addEventListener('click',()=>{if(run)cancel(Error('Ручное действие пользователя завершило автоматическую серию'),{keepPlaying:true});});
 if(typeof MutationObserver!=='undefined')new MutationObserver(()=>{if(run&&$('quickMenu').open)cancel(Error('Открыто меню паузы'),{keepPlaying:true});}).observe($('quickMenu'),{attributes:true,attributeFilter:['open']});
 window.autonomousEpisodes={start,stop:cancel,failed:error=>cancel(error,{keepPlaying:true}),waiting:()=>Boolean(run?.waiting),active:()=>!!run,terminal:(event,boundary)=>{const r=run;if(!r||r.waiting)return false;r.waiting=true;window.labPause();next(r,event,boundary).catch(error=>cancel(error));return true;}};
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&run)cancel(Error('Приложение ушло в фон'));});
})();
