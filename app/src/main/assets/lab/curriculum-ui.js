/* Automatic trajectory assignment; the native store enforces the training boundary. */
'use strict';
(()=>{
 if(!window.FlyBridge||typeof FlyBridge.curriculum!=='function')return;
 let sequence=0,assignment=null,job=null;const pending=new Map();
 const info=document.createElement('p');info.id='curriculumStatus';info.className='note';info.setAttribute('role','status');$('trainingStatus').after(info);
 const context=()=>JSON.stringify({system:labPlatform,romHash,graph:graphIdentity?.sha256,originId:window.flyOriginId,layerId:window.layerExperience?.activeId(),generation});
 function request(op,args={}){return new Promise((resolve,reject)=>{const token='curriculum-'+(++sequence),timer=setTimeout(()=>{pending.delete(token);reject(Error('Разделение отрезков не подтверждено'));},30000);pending.set(token,{resolve,reject,timer});try{FlyBridge.curriculum(JSON.stringify({op,token,romHash,graphSha256:graphIdentity?.sha256,layerId:window.layerExperience?.activeId(),...args}));}catch(e){clearTimeout(timer);pending.delete(token);reject(e);}});}
 window.labCurriculum=reply=>{const task=pending.get(reply.token);if(!task)return;pending.delete(reply.token);clearTimeout(task.timer);reply.error?task.reject(Error(reply.error)):task.resolve(reply.data);};
 function show(role){info.textContent=role.role==='train'?'Отрезок: обучение. Связанные старты остаются в одной группе.':role.role==='control'?'Отрезок: автоматический контроль. Пластичность запрещена.':'Связанные train/control данные исключены из проверки. Пластичность запрещена.';}
 function guard(role){if(role.degraded)throw Error('Происхождение восстановлено из резерва; обучение запрещено');if(!['train','control','excluded'].includes(role.role))throw Error('Неизвестная роль отрезка');}
 function ensure(id){
  if(assignment?.key===context())return Promise.resolve(assignment);
  if(job)return job;
  const originId=window.flyOriginId||FlySaveStates.legacyOrigin(romHash);window.flyOriginId=originId;const key=context();
  const captured=window.labGameStates.capture(),snapshot=captured.state;
  job=FlySaveStates.sha256(JSON.stringify(snapshot)).then(stateHash=>request('register',{layerId:id,originId,stateHash})).then(async role=>{
   if(key!==context())throw Object.assign(Error('Контекст отрезка изменился'),{stale:true,code:'STALE_CURRENT'});guard(role);
   if(window.episodeStarts)await window.episodeStarts.save(captured,role);
   if(key!==context())throw Object.assign(Error('Контекст изменился во время архивации старта'),{stale:true,code:'STALE_CURRENT'});
   if(role.role!=='train'&&['train','teach'].includes($('learnMode').value)){$('learnMode').value='eval';$('liveHints').checked=false;learningBoundary();window.learningUI?.refresh();trainingView();}
   assignment={...role,key:context(),originId};show(role);return assignment;
  }).finally(()=>{job=null;});return job;
 }
 async function classify(saved){const key=context(),originId=saved.originId||FlySaveStates.legacyOrigin(saved.hash),stateHash=await FlySaveStates.sha256(JSON.stringify(saved.state));const result=await request('classify',{originId,stateHash});if(key!==context())throw Error('Игра изменилась во время распределения отрезков');guard(result);return {...result,stateHash,originId};}
 window.curriculumSessions={ensure,classify,assignment:()=>assignment,request,clear:()=>{assignment=null;}};
})();
