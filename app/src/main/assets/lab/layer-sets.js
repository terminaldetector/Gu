/* Portable named readout/FDB checkpoints. The immutable connectome and ROM are not copied. */
(function(root){
'use strict';
const TYPE='fly-layer-set',PREFIX='fly-layer-set-',MAX_BYTES=2*1024*1024,MAX_SETS=32;
const clone=value=>JSON.parse(JSON.stringify(value));
const bytes=text=>typeof TextEncoder==='undefined'?unescape(encodeURIComponent(text)).length:new TextEncoder().encode(text).length;
function id(){return typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.floor(Math.random()*16);return (c==='x'?r:(r&3)|8).toString(16);});}
function validate(set){
 if(!set||set.type!==TYPE||![1,2].includes(set.layerVersion)||typeof set.id!=='string'||!/^[-a-f0-9]{36}$/.test(set.id))throw Error('Неверный формат Layer Set');
 if(typeof set.name!=='string'||!set.name.trim()||set.name.length>80||typeof set.notes!=='string'||set.notes.length>500)throw Error('Имя: 1–80 символов; заметка: до 500');
 if(!['nes','sega','gb','snes'].includes(set.system)||typeof set.romHash!=='string'||!/^[a-f0-9]{64}$/.test(set.romHash)||!set.graph||!/^[a-f0-9]{64}$/.test(set.graph.sha256))throw Error('Layer Set требует SHA256 ROM и графа');
 for(const k of ['createdAt','updatedAt'])if(!Number.isSafeInteger(set[k])||set[k]<0)throw Error('Неверная дата Layer Set');
 if(!set.runtime||!['async','lockstep','realtime'].includes(set.runtime.clock)||!['continuous','episodic'].includes(set.runtime.runMode)||!['off','teach','train','eval'].includes(set.runtime.learnMode))throw Error('Неверный режим Layer Set');
 if(!set.configuration||!set.profile||!set.policy||!Array.isArray(set.journal)||set.journal.length>200)throw Error('Неполный Layer Set');
 if(set.runtime.learnMode!=='off'&&(set.configuration.mode!=='closed'||set.runtime.clock==='async'))throw Error('Обучение требует closed и realtime / lockstep');
 for(const e of set.journal){
  if(!e||!['manual','ram','diagnostic','boundary'].includes(e.source)||!['win','loss','continue','note','timeout','finished'].includes(e.outcome)||typeof e.note!=='string'||e.note.length>500||!Number.isSafeInteger(e.at)||e.at<0||!Number.isSafeInteger(e.updates)||e.updates<0)throw Error('Неверная запись опыта');
 }
 if(bytes(JSON.stringify(set))>MAX_BYTES)throw Error('Layer Set превышает 2 МиБ');
 return set;
}
function summary(set){validate(set);const fdb=set.configuration.fdb;return {id:set.id,name:set.name,notes:set.notes,system:set.system,romHash:set.romHash,graphSha256:set.graph.sha256,createdAt:set.createdAt,updatedAt:set.updatedAt,updates:set.policy.updates,episodes:set.policy.episodes,fdbEdges:fdb&&fdb.edges?fdb.edges.length:0,fdbDeltas:fdb&&fdb.deltas?fdb.deltas.length:0};}
function compatible(s,context){return s.system===context.system&&s.romHash===context.romHash&&s.graphSha256===context.graphSha256;}
function stats(entries){const result={manual:{win:0,loss:0,continue:0},criterion:{win:0,loss:0},boundaries:0};for(const e of entries){if(e.source==='manual'&&e.outcome in result.manual)result.manual[e.outcome]++;else if(['ram','diagnostic'].includes(e.source)&&e.outcome in result.criterion)result.criterion[e.outcome]++;else if(e.source==='boundary')result.boundaries++;}return result;}
class Store {
 constructor(storage,bridge){this.storage=storage;this.bridge=bridge;this.pending=new Map();this.sequence=0;this.session=id();}
 receive(response){const p=this.pending.get(response.token);if(!p)return;this.pending.delete(response.token);clearTimeout(p.timer);response.error?p.reject(Error(response.error)):p.resolve(response.data);}
 request(op,payload={}){
  if(this.bridge&&typeof this.bridge.layerSets==='function')return new Promise((resolve,reject)=>{const token=this.session+':'+(++this.sequence),timer=setTimeout(()=>{this.pending.delete(token);reject(Error('Ответ хранилища задержался. Обновите список перед повторной записью.'));},30000);this.pending.set(token,{resolve,reject,timer});try{this.bridge.layerSets(JSON.stringify({token,op,...payload}));}catch(e){clearTimeout(timer);this.pending.delete(token);reject(e);}});
  try{
   const storage=this.storage,list=()=>{const sets=[];for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key&&key.startsWith(PREFIX)){try{sets.push(JSON.parse(storage.getItem(key)));}catch(_) {}}}return sets;};
   if(op==='list'){const result=[];for(const value of list())try{result.push(summary(value));}catch(_){}return Promise.resolve(result);}
   if(op==='get'){const raw=storage.getItem(PREFIX+payload.id);if(!raw)throw Error('Набор отсутствует');return Promise.resolve(validate(JSON.parse(raw)));}
   if(op==='save'){validate(payload.set);const sets=list(),old=storage.getItem(PREFIX+payload.set.id);if(!old&&sets.length>=MAX_SETS)throw Error('Максимум 32 набора');const text=JSON.stringify(payload.set);if(sets.reduce((n,s)=>n+(s.id===payload.set.id?0:bytes(JSON.stringify(s))),bytes(text))>32*1024*1024)throw Error('Хранилище Layer Set заполнено');storage.setItem(PREFIX+payload.set.id,text);return Promise.resolve(summary(payload.set));}
   if(op==='delete'){storage.removeItem(PREFIX+payload.id);return Promise.resolve({id:payload.id});}
   throw Error('Неизвестная операция Layer Set');
  }catch(e){return Promise.reject(e);}
 }
}
root.FlyLayerSets={TYPE,id,clone,validate,summary,compatible,stats,Store};if(typeof module!=='undefined')module.exports=root.FlyLayerSets;
})(typeof window==='undefined'?globalThis:window);
