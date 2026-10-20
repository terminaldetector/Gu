/* Durable autonomous episode records are separate from the human imitation archive. */
'use strict';
(()=>{
 if(!window.FlyBridge||typeof FlyBridge.episodeHistory!=='function')return;
 const waiting=new Map();let sequence=0,boundaryJob=null;
 const stats=document.createElement('p');stats.id='autonomousHistory';stats.className='note';stats.setAttribute('role','status');$('trainingStatus').after(stats);
 function request(op,args={}){return new Promise((resolve,reject)=>{const token='episode-'+(++sequence),timer=setTimeout(()=>{waiting.delete(token);reject(Error('История эпизода не подтверждена'));},30000);waiting.set(token,{resolve,reject,timer});try{FlyBridge.episodeHistory(JSON.stringify({op,token,...args}));}catch(e){clearTimeout(timer);waiting.delete(token);reject(e);}});}
 window.labEpisodeHistory=reply=>{const job=waiting.get(reply.token);if(!job)return;waiting.delete(reply.token);clearTimeout(job.timer);reply.error?job.reject(Error(reply.error)):job.resolve(reply.data);};
 window.labHistoryNotice=reply=>{stats.textContent='История обучения: '+reply.error;stats.className='note error';};
 async function refresh(){const data=await request('list'),rows=data.episodes;stats.textContent='История FDB: '+rows.length+' отрезков · завершено '+rows.filter(r=>r.status==='completed').length+' · неизвестный исход '+rows.filter(r=>r.outcome==='unknown').length+' · незавершённых '+rows.filter(r=>r.status==='recording').length+'. Независимый контроль и Best ещё не подтверждены.'+(data.damagedRecords?' Повреждено записей: '+data.damagedRecords:'');}
 function boundary(result){
  if(boundaryJob)return boundaryJob;
  boundaryJob=request('close',result).then(reply=>{if(!reply.closed)throw Error('Предыдущий эпизод не закрыт');refresh().catch(e=>labHistoryNotice({error:e.message}));}).catch(e=>{labHistoryNotice({error:e.message});window.labError({message:'История эпизода: '+e.message});return {error:e.message};}).finally(()=>{boundaryJob=null;});return boundaryJob;
 }
 window.trainingHistory={boundary,pending:()=>!!boundaryJob,refresh};refresh().catch(e=>labHistoryNotice({error:e.message}));
})();
