/* Serializable worker bootstrap. Only structured messages cross the boundary. */
function codeWorkerMain(){
 'use strict';let sequence=0;const pending=new Map(),cache=new Map();let modules={};
 const call=(method,payload)=>new Promise((resolve,reject)=>{if(sequence>=64){reject(Error('Лимит: 64 API-вызова'));return;}const id=++sequence;pending.set(id,{resolve,reject});postMessage({kind:'request',id,method,payload});});
 const fly=Object.freeze({info:()=>call('info',{}),run:p=>call('run',p),log:value=>{const text=JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v);if(typeof text!=='string'||text.length>262144)throw Error('Журнал: JSON до 256 КиБ на событие');postMessage({kind:'log',value:JSON.parse(text)});},plot:(name,values)=>{if(typeof name!=='string'||name.length>100||!Array.isArray(values)||values.length<1||values.length>2000||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('График: 1–2000 конечных чисел');postMessage({kind:'plot',name,values});},sleep:ms=>new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(30000,Number(ms)||0))))});
 function load(id,file){const pkg=Object.hasOwn(modules,id)?modules[id]:null;if(!pkg)throw Error('Модуль не установлен: '+id);const key=id+'/'+file;if(cache.has(key))return cache.get(key).exports;const source=pkg.files[file];if(typeof source!=='string')throw Error('Файл модуля отсутствует: '+key);const m={exports:{}};cache.set(key,m);
  try{if(file.endsWith('.json'))m.exports=JSON.parse(source);else{
   const require=name=>{if(typeof name!=='string')throw Error('require: строка');if(name.startsWith('./')||name.startsWith('../')){const parts=file.split('/');parts.pop();for(const part of name.split('/')){if(part==='.'||!part)continue;if(part==='..'){if(!parts.length)throw Error('Путь вне модуля');parts.pop();}else parts.push(part);}let next=parts.join('/');if(!pkg.files[next]&&pkg.files[next+'.js'])next+='.js';return load(id,next);}const other=Object.hasOwn(modules,name)?modules[name]:null;if(!other)throw Error('Модуль не установлен: '+name);return load(name,other.entry);};
   new Function('module','exports','require','fly',source)(m,m.exports,require,fly);
  }return m.exports;}catch(error){cache.delete(key);throw error;}
 }
 globalThis.onmessage=async event=>{const data=event.data;if(data.kind==='reply'){const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.value);return;}
  if(data.kind!=='start')return;modules=data.modules;
  try{const require=id=>{const m=Object.hasOwn(modules,id)?modules[id]:null;if(!m)throw Error('Модуль не установлен: '+id);return load(id,m.entry);};const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;await new AsyncFunction('fly','require',data.source)(fly,require);if(pending.size)throw Error('Незавершённые API-вызовы: используйте await fly.run / await fly.info');postMessage({kind:'done'});}catch(error){postMessage({kind:'error',value:String(error.message||error)});}
 };
}
if(typeof module!=='undefined')module.exports=codeWorkerMain;
