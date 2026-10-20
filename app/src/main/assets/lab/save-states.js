/* Game snapshots only. Acquired neural weights and training history never enter this store. */
(function(root){'use strict';
const slots=['quick','auto','slot-1','slot-2','slot-3','slot-4','slot-5','slot-6'];
const fail=message=>{throw Error(message);};
function legacyOrigin(hash){if(!/^[a-f0-9]{64}$/.test(hash))fail('Неверный ROM для происхождения');return hash.slice(0,8)+'-'+hash.slice(8,12)+'-'+hash.slice(12,16)+'-'+hash.slice(16,20)+'-'+hash.slice(20,32);}
function identity(c){if(!c||!['nes','sega','gb','snes'].includes(c.system)||! /^[a-f0-9]{64}$/.test(c.hash)||typeof c.core!=='string'||!c.core)fail('Неверная идентичность ROM/ядра');return {system:c.system,hash:c.hash,core:c.core};}
function key(c,slot){identity(c);if(!slots.includes(slot))fail('Неверный слот');return 'fly-game-state-v1:'+c.system+':'+c.hash+':'+slot;}
async function sha(text){const crypto=root.crypto||(typeof require==='function'?require('node:crypto').webcrypto:null);if(!crypto?.subtle)fail('SHA256 недоступен; снимок не записан');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');}
// Both generations commit in one transaction. Legacy localStorage is read only:
// migrating a slot never deletes the only copy created by an earlier version.
class IndexedStorage{
 constructor(legacy,indexedDB=root.indexedDB){this.legacy=legacy;this.indexedDB=indexedDB;this.opening=null;}
 open(){
  if(!this.opening)this.opening=new Promise((resolve,reject)=>{
   const request=this.indexedDB.open('fly-game-states',1);let rejected=false;
   request.onupgradeneeded=()=>request.result.createObjectStore('slots');
   request.onerror=()=>reject(request.error||Error('Хранилище снимков недоступно'));
   request.onblocked=()=>{rejected=true;reject(Error('Хранилище снимков занято другой страницей'));};
   request.onsuccess=()=>{const db=request.result;if(rejected){db.close();return;}db.onversionchange=()=>{db.close();this.opening=null;};resolve(db);};
  }).catch(e=>{this.opening=null;throw e;});
  return this.opening;
 }
 async getItem(key){
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('slots','readonly'),request=tx.objectStore('slots').get(key);let value;
   request.onsuccess=()=>{value=request.result;};
   tx.oncomplete=()=>{try{resolve(value===undefined?this.legacy.getItem(key):value);}catch(e){reject(e);}};
   tx.onabort=()=>reject(tx.error||Error('Чтение снимка прервано'));
  });
 }
 async commit(key,before,current,recovery){
  const db=await this.open();return new Promise((resolve,reject)=>{
   const tx=db.transaction('slots','readwrite'),store=tx.objectStore('slots'),request=store.get(key);let failure;
   request.onsuccess=()=>{try{
    const actual=request.result===undefined?this.legacy.getItem(key):request.result;
    if(actual!==before)throw Error('Слот изменён во время сохранения');
    if(recovery!==null)store.put(recovery,key+':recovery');
    store.put(current,key);
   }catch(e){failure=e;tx.abort();}};
   tx.oncomplete=()=>resolve();
   tx.onabort=()=>reject(failure||tx.error||Error('Запись снимка прервана; предыдущая версия сохранена'));
  });
 }
}
class Store{
 constructor(storage){this.storage=storage;this.queue=Promise.resolve();}
 async decode(raw,c,slot){if(!raw)return null;const box=JSON.parse(raw);if(box.version!==1||typeof box.payload!=='string'||await sha(box.payload)!==box.sha256)fail('Нарушена целостность снимка');const v=JSON.parse(box.payload);if(v.version!==1||v.system!==c.system||v.hash!==c.hash||v.core!==c.core||v.slot!==slot)fail('Снимок другого ROM, платформы или версии ядра');if(!Number.isSafeInteger(v.frame)||v.frame<0||!Number.isSafeInteger(v.savedAt)||v.savedAt<0||!v.state||typeof v.state!=='object'||Array.isArray(v.state))fail('Неверный формат снимка');if(v.originId!==undefined&&(typeof v.originId!=='string'||!v.originId.match(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)))fail('Неверное происхождение снимка');return {...v,revision:box.sha256};}
 async read(c,slot){identity(c);const k=key(c,slot),raw=await this.storage.getItem(k);let error;try{const v=await this.decode(raw,c,slot);if(v)return {...v,recovered:false};}catch(e){error=e;}try{const v=await this.decode(await this.storage.getItem(k+':recovery'),c,slot);if(v)return {...v,recovered:true,warning:error?.message||'Восстановлена резервная копия'};}catch(e){error=error||e;}if(error)throw error;return null;}
 async list(c){const result=[];for(const slot of slots){try{const v=await this.read(c,slot);if(v){const {state,...metadata}=v;result.push(metadata);}}catch(e){result.push({slot,error:e.message});}}return result;}
 save(c,slot,snapshot,options={}){
  // Clone synchronously, before a caller can advance the emulator or switch ROM.
  const captured=JSON.parse(JSON.stringify(snapshot)),ctx=identity(c),opts={...options};
  const job=this.queue.catch(()=>{}).then(async()=>{
   const k=key(ctx,slot),before=await this.storage.getItem(k),existing=await this.read(ctx,slot);
   if(existing&&opts.expectedRevision!==existing.revision)fail('Слот уже занят или изменён; выберите новый слот');
   if(!existing&&opts.expectedRevision)fail('Слот изменён');
   if(!Number.isSafeInteger(captured.frame)||captured.frame<0||!captured.state||typeof captured.state!=='object'||Array.isArray(captured.state))fail('Неверный снимок');
   if(captured.hash!==ctx.hash||captured.system!==ctx.system)fail('Снимок другого ROM или платформы');
   const preview=typeof opts.preview==='string'&&/^data:image\/(jpeg|png);base64,/.test(opts.preview)&&opts.preview.length<150000?opts.preview:null;
   const v={version:1,...ctx,slot,frame:captured.frame,state:captured.state,savedAt:Date.now(),preview};
   if(captured.originId!==undefined){if(typeof captured.originId!=='string'||!captured.originId.match(/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/))fail('Неверное происхождение снимка');v.originId=captured.originId;}
   const payload=JSON.stringify(v),raw=JSON.stringify({version:1,payload,sha256:await sha(payload)});
   const recovery=existing?(existing.recovered?null:before):raw;
   if(this.storage.commit)await this.storage.commit(k,before,raw,recovery);
   else{
    // Compatibility/test adapter; production uses IndexedDB's atomic pair.
    if(this.storage.getItem(k)!==before)fail('Слот изменён во время сохранения');
    if(recovery!==null)this.storage.setItem(k+':recovery',recovery);
    this.storage.setItem(k,raw);
   }
   return this.decode(raw,ctx,slot);
  });this.queue=job;return job;
 }
 async migrateLegacy(c,validate){
  identity(c);const raw=await this.storage.getItem(c.system+'-slot');if(!raw)return null;const old=JSON.parse(raw);
  // Legacy records have no trustworthy core revision. Caller must validate against the running core.
  if(old.hash!==c.hash||(old.system||'nes')!==c.system)return null;
  if(typeof validate!=='function')fail('Для переноса требуется проверка ядром');await validate(old);
  if(await this.read(c,'quick'))return null;
  return this.save(c,'quick',{...old,system:c.system}); // Never remove the user's legacy copy.
 }
}
const api={Store,IndexedStorage,storage:legacy=>root.indexedDB?new IndexedStorage(legacy):legacy,slots,key,legacyOrigin,sha256:sha};root.FlySaveStates=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
