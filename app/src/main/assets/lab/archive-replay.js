/* Offline imitation experiment. Frozen holdout sessions never update the candidate. */
(function(root){'use strict';
const clone=x=>JSON.parse(JSON.stringify(x)),snapshot=m=>m.events+':'+m.storedBytes;
function compatible(m,c){return m.system===c.system&&m.romHash===c.romHash&&m.graphSha256===c.graphSha256&&m.configuration&&JSON.stringify(m.configuration.inputs)===JSON.stringify(c.inputs)&&JSON.stringify(m.configuration.outputs)===JSON.stringify(c.outputs);}
function predict(learner,f){
 const eligible=learner.eligible();let best=eligible[0],score=-Infinity;
 for(const a of eligible){const s=f.reduce((v,x,i)=>v+x*learner.demonstrationWeights[a][i],0);if(s>score+1e-9){best=a;score=s;}}
 return learner.actions[best]; // Fixed action-order ties; no RNG or reward weights.
}
async function run(store,options,control={}){
 const {train,test,context,base,allowedMask,passes=1}=options,all=[...train,...test];
 if(!train.length||!test.length||all.length>32||new Set(all.map(m=>m.id)).size!==all.length)throw Error('Выберите разные сессии для обучения и проверки');
 if(!Number.isInteger(passes)||passes<1||passes>5)throw Error('Число проходов: от 1 до 5');
 for(const m of all)if(m.status!=='closed'||!compatible(m,context)||!m.accepted)throw Error('Нужны завершённые сессии этой игры, графа и портов с принятыми примерами');
 const check=()=>{if(control.cancelled&&control.cancelled())throw Error('Обработка отменена. Действующая модель сохранена.');};
 const candidate=new root.FlyLearner();candidate.load(clone(base));candidate.setAllowedMask(allowedMask);
 candidate.demonstrationWeights=candidate.actions.map(()=>new Array(45).fill(0));candidate.demonstrations=0;candidate.demonstrationSeconds=0;candidate.skippedDemonstrations=0;candidate.archive=null;
 const counts=new Map(),recent=[];let trained=0,skipped=0,trainingSeconds=0;
 async function visit(m,phase,pass,accept){
  let cursor=null,expected=0;
  do{
   check();const page=await store.request('read',{id:m.id,snapshot:snapshot(m),cursor});check();
   if(!page||page.snapshot!==snapshot(m)||!Array.isArray(page.events)||page.events.length>32||(!page.events.length&&expected<m.events))throw Error('Неверная страница архива');
   if(page.events.length)root.FlyTrainingSessions.validateEvents(page.events);
   for(const e of page.events){if(e.sequence!==expected++)throw Error('Повреждён порядок архива');if(e.kind==='sample')accept(e);}
   if(page.next&&(page.next.event!==expected||expected>=m.events))throw Error('Неверное продолжение архива');
   cursor=page.next;control.progress&&control.progress({phase,pass,session:m.id,events:expected,total:m.events,trained});
   // Yield between pages on WebView; cancellation and UI remain responsive.
   await new Promise(resolve=>setTimeout(resolve,0));
  }while(cursor);
  if(expected!==m.events)throw Error('Архив прочитан не полностью');
 }
 for(let pass=1;pass<=passes;pass++)for(const m of train)await visit(m,'train',pass,e=>{
  if(!e.accepted||(e.mask&~allowedMask)){skipped++;return;}
  if(!candidate.teach(e.features,e.mask,e.seconds)){skipped++;return;}trained++;
  if(pass===1){trainingSeconds+=e.seconds;counts.set(e.mask,(counts.get(e.mask)||0)+1);recent.push({frame:e.frame,retina:e.retina.slice(),mask:e.mask,seconds:e.seconds,human:true});if(recent.length>200)recent.shift();}
 });
 if(!trained)throw Error('В выбранном обучении нет разрешённых примеров');
 const majority=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0][0];
 const metrics={samples:0,seconds:0,correct:0,correctSeconds:0,baselineCorrect:0,baselineSeconds:0,neutral:0,unseen:0,skipped:0,buttons:Array.from({length:12},()=>({tp:0,fp:0,fn:0}))};
 const before=JSON.stringify(candidate.save());
 for(const m of test)await visit(m,'test',1,e=>{
  if(!e.accepted||(e.mask&~allowedMask)){metrics.skipped++;return;}
  const predicted=predict(candidate,e.features);metrics.samples++;metrics.seconds+=e.seconds;
  if(e.mask===0)metrics.neutral++;if(!candidate.actions.includes(e.mask))metrics.unseen++;
  if(predicted===e.mask){metrics.correct++;metrics.correctSeconds+=e.seconds;}
  if(majority===e.mask){metrics.baselineCorrect++;metrics.baselineSeconds+=e.seconds;}
  for(let b=0;b<12;b++){const actual=!!(e.mask&(1<<b)),guess=!!(predicted&(1<<b)),v=metrics.buttons[b];if(actual&&guess)v.tp+=e.seconds;else if(guess)v.fp+=e.seconds;else if(actual)v.fn+=e.seconds;}
 });
 if(!metrics.samples)throw Error('В проверке нет разрешённых примеров');
 if(JSON.stringify(candidate.save())!==before)throw Error('Проверка изменила модель');check();
 const refs=ms=>ms.map(m=>({id:m.id,events:m.events,storedBytes:m.storedBytes}));
 const provenance={version:1,train:refs(train),test:refs(test),createdAt:Date.now(),passes,system:context.system,romHash:context.romHash,graphSha256:context.graphSha256,additionalSamples:0};
 candidate.archive=clone(provenance);
 return {policy:clone(candidate.save()),recent,report:{type:'fly-archive-evaluation',version:1,context:clone(context),provenance,training:{updates:trained,uniqueSamples:trained/passes,seconds:trainingSeconds,skipped,majority},test:metrics,scope:'imitation-only on stored pre-action features; fixed ties; no game or FDB evaluation'}};
}
root.FlyArchiveReplay={run,compatible,predict,snapshot};if(typeof module!=='undefined')module.exports=root.FlyArchiveReplay;
})(typeof window==='undefined'?globalThis:window);
