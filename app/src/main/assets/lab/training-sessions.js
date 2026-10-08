/* Session archives are separate from compact policies and the live FDB queue. */
(function(root){'use strict';
const PREFIX='fly-human-session-',TYPE='fly-human-session',ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,clone=x=>JSON.parse(JSON.stringify(x));
const uuid=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return(c==='x'?r:(r&3)|8).toString(16);});
const bytes=s=>new TextEncoder().encode(s).length;
function validateMetadata(m){
 if(!m||m.type!==TYPE||m.version!==1||!ID.test(m.id)||!['nes','sega','gb','snes'].includes(m.system)||! /^[a-f0-9]{64}$/.test(m.romHash)||! /^[a-f0-9]{64}$/.test(m.graphSha256)||!Number.isSafeInteger(m.startedAt)||m.startedAt<0||typeof m.name!=='string'||!m.name.trim()||m.name.length>100)throw Error('Неверная сессия показа');
}
function validateEvents(events){
 if(!Array.isArray(events)||!events.length||events.length>64||bytes(JSON.stringify(events))>256*1024)throw Error('Неверный пакет показа');
 for(const e of events){
  if(!e||!['input','sample'].includes(e.kind)||e.human!==true||!Number.isSafeInteger(e.sequence)||e.sequence<0||!Number.isSafeInteger(e.frame)||e.frame<0||!Number.isSafeInteger(e.at)||e.at<0||!Number.isFinite(e.gameMs)||e.gameMs<0||!Number.isFinite(e.wallMs)||e.wallMs<0||!Number.isInteger(e.mask)||e.mask<0||e.mask>4095||(e.mask&48)===48||(e.mask&192)===192)throw Error('Неверное событие показа');
  if(e.kind==='sample'&&(!Number.isFinite(e.seconds)||e.seconds<=0||e.seconds>1||!Number.isInteger(e.frames)||e.frames<1||typeof e.accepted!=='boolean'||!Array.isArray(e.retina)||e.retina.length!==16||e.retina.some(x=>!Number.isFinite(x)||x<0||x>1)||!Array.isArray(e.features)||e.features.length!==45||e.features.some(x=>!Number.isFinite(x)||Math.abs(x)>2)))throw Error('Неверное исполненное действие');
 }
}
function validateSummary(m){
 validateMetadata(m);
 for(const key of ['events','inputChanges','samples','accepted','skipped','nextSeq','storedBytes'])if(!Number.isSafeInteger(m[key])||m[key]<0)throw Error('Повреждённые счётчики сессии');
 if(m.accepted+m.skipped!==m.samples||m.inputChanges+m.samples!==m.events||m.lastEvent!==m.events-1||m.nextSeq>m.events||!['closed','recording'].includes(m.status)||!Number.isFinite(m.gameMs)||m.gameMs<0||!Number.isFinite(m.neutralMs)||m.neutralMs<0||!Array.isArray(m.buttonMs)||m.buttonMs.length!==12||m.buttonMs.some(x=>!Number.isFinite(x)||x<0))throw Error('Повреждённая сессия');
}
function stats(m,events){
 const out=clone(m);for(const e of events){out.events++;out.lastEvent=e.sequence;
  if(e.kind==='input')out.inputChanges++;
  else{out.samples++;out[e.accepted?'accepted':'skipped']++;out.gameMs+=e.seconds*1000;
   if(e.accepted){if(e.mask===0)out.neutralMs+=e.seconds*1000;for(let b=0;b<12;b++)if(e.mask&(1<<b))out.buttonMs[b]+=e.seconds*1000;}
  }
 }return out;
}
class Store {
 constructor(storage,bridge=null){this.storage=storage;this.bridge=bridge;this.waiting=new Map();this.counter=0;}
 receive(r){const p=this.waiting.get(r.token);if(!p)return;this.waiting.delete(r.token);clearTimeout(p.timer);r.error?p.reject(Error(r.error)):p.resolve(r.data);}
 request(op,args={}){
  if(this.bridge&&typeof this.bridge.trainingSessions==='function')return new Promise((resolve,reject)=>{const token='session-'+(++this.counter),timer=setTimeout(()=>{this.waiting.delete(token);reject(Error('Хранилище показа не ответило'));},30000);this.waiting.set(token,{resolve,reject,timer});try{this.bridge.trainingSessions(JSON.stringify({op,token,...args}));}catch(e){this.receive({token,error:e.message});}});
  try{return Promise.resolve(this.local(op,args));}catch(e){return Promise.reject(e);}
 }
 local(op,a){
  const disk=this.storage,key=PREFIX+a.id;if(!disk)throw Error('Хранилище показа недоступно');
  if(op==='list'){const out=[];for(let i=0;i<disk.length;i++){const k=disk.key(i);if(k.startsWith(PREFIX)&&k.endsWith('-meta'))try{const m=JSON.parse(disk.getItem(k));validateSummary(m);out.push(m);}catch(_){} }return out;}
  if(op==='begin'){
   validateMetadata(a.session);const k=PREFIX+a.session.id+'-meta';if(disk.getItem(k))throw Error('Сессия уже существует');if(this.local('list',{}).length>=32)throw Error('Хранилище: максимум 32 сессии');
   const m={...clone(a.session),events:0,inputChanges:0,samples:0,accepted:0,skipped:0,gameMs:0,neutralMs:0,buttonMs:new Array(12).fill(0),nextSeq:0,lastEvent:-1,storedBytes:0,status:'recording'};disk.setItem(k,JSON.stringify(m));return m;
  }
  if(!ID.test(a.id))throw Error('Неверный ID сессии');const m=JSON.parse(disk.getItem(key+'-meta'));validateSummary(m);
  if(op==='append'){
   validateEvents(a.events);const text=JSON.stringify(a.events);if(a.sequence===m.nextSeq-1&&disk.getItem(key+'-'+a.sequence)===text)return m;
   if(a.sequence!==m.nextSeq||m.status!=='recording'||a.events[0].sequence!==m.lastEvent+1||a.events.some((e,i)=>e.sequence!==m.lastEvent+i+1))throw Error('Неверная последовательность записи');
   if(m.storedBytes+bytes(text)>2*1024*1024)throw Error('Сессия браузера заполнена; ранее записанное сохранено');
   const next=stats(m,a.events);next.nextSeq++;next.storedBytes+=bytes(text);disk.setItem(key+'-'+a.sequence,text);
   try{disk.setItem(key+'-meta',JSON.stringify(next));}catch(e){disk.removeItem(key+'-'+a.sequence);throw e;}return next;
  }
  if(op==='close'){if(!Number.isSafeInteger(a.endedAt)||a.endedAt<m.startedAt||typeof a.reason!=='string'||a.reason.length>100)throw Error('Неверное завершение');if(m.status==='closed')return m;const n={...m,status:'closed',endedAt:a.endedAt,reason:a.reason};disk.setItem(key+'-meta',JSON.stringify(n));return n;}
  if(op==='export'){const events=[];for(let i=0;i<m.nextSeq;i++)events.push(...JSON.parse(disk.getItem(key+'-'+i)));return {session:m,events};}
  if(op==='delete'){if(m.status!=='closed')throw Error('Сначала завершите сессию');for(let i=0;i<m.nextSeq;i++)disk.removeItem(key+'-'+i);disk.removeItem(key+'-meta');return {id:a.id};}
  throw Error('Неизвестная операция сессии');
 }
}
class Writer {
 constructor(store,metadata,onState=()=>{}){
  this.store=store;this.metadata={...metadata,type:TYPE,version:1,id:uuid()};this.buffer=[];this.sequence=0;this.failed=false;this.closed=false;this.pending=0;this.writes=new Set();this.onState=onState;
  this.send('begin',{session:this.metadata});
 }
 send(op,args){
  this.pending++;const p=this.store.request(op,args).then(m=>{if(m&&m.id)this.metadata=m;this.pending--;this.onState(this);return m;}).catch(e=>{this.pending--;this.failed=true;this.error=e.message;this.onState(this);return null;});this.writes.add(p);p.then(()=>this.writes.delete(p));return p;
 }
 add(e){if(this.failed||this.closed)return;this.buffer.push(clone(e));if(this.buffer.length>=32)this.flush();}
 flush(){if(!this.buffer.length||this.failed)return;if(this.pending>=16){this.failed=true;this.error='Запись не успевает: сохранённая часть сессии доступна';this.onState(this);return;}const events=this.buffer.splice(0,64);this.send('append',{id:this.metadata.id,sequence:this.sequence++,events});}
 close(reason='pause'){if(this.closed)return Promise.all([...this.writes]);this.flush();this.closed=true;this.send('close',{id:this.metadata.id,endedAt:Date.now(),reason});return Promise.all([...this.writes]);}
}
root.FlyTrainingSessions={Store,Writer,validateMetadata,validateEvents,stats,TYPE};if(typeof module!=='undefined')module.exports=root.FlyTrainingSessions;
})(typeof window==='undefined'?globalThis:window);
