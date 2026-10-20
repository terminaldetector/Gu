/* Immutable game starts for curriculum/retention, separate from the user's eight save slots. */
(function(root){'use strict';
 const LIMIT=32*1024*1024,MAX_RECORDS=128,MAX_CONTEXT=48;
 class Archive{
  constructor(indexedDB=root.indexedDB){this.indexedDB=indexedDB;this.opening=null;this.queue=Promise.resolve();this.codec=new root.FlySaveStates.Store({});}
  open(){if(!this.indexedDB)return Promise.reject(Error('Архив стартов требует IndexedDB'));if(!this.opening)this.opening=new Promise((resolve,reject)=>{const q=this.indexedDB.open('fly-episode-starts',1);let blocked=false;q.onupgradeneeded=()=>q.result.createObjectStore('starts');q.onerror=()=>reject(q.error);q.onblocked=()=>{blocked=true;reject(Error('Архив стартов занят другой страницей'));};q.onsuccess=()=>{const db=q.result;if(blocked){db.close();return;}db.onversionchange=()=>{db.close();this.opening=null;};resolve(db);};}).catch(e=>{this.opening=null;throw e;});return this.opening;}
  domain(c){if(!['nes','sega','gb','snes'].includes(c.system)||!/^[a-f0-9]{64}$/.test(c.hash)||!c.core)throw Error('Контекст архива стартов повреждён');return JSON.stringify({system:c.system,hash:c.hash,core:c.core});}
  save(snapshot,role){
   const captured=JSON.parse(JSON.stringify(snapshot)),kind=role.role;if(kind==='excluded')return Promise.resolve(null);
   const job=this.queue.catch(()=>{}).then(async()=>{
    const domain=this.domain(captured),payload=JSON.stringify(captured),digest=await root.FlySaveStates.sha256(payload),raw=JSON.stringify({version:1,payload,sha256:digest});
    await this.codec.decode(raw,captured,'auto');const stateHash=await root.FlySaveStates.sha256(JSON.stringify(captured.state));if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(captured.originId))throw Error('Нет происхождения архивного старта');
    const db=await this.open(),bytes=new TextEncoder().encode(raw).length;if(bytes>4*1024*1024)throw Error('Архивный старт превышает 4 МиБ');
    return new Promise((resolve,reject)=>{const tx=db.transaction('starts','readwrite'),store=tx.objectStore('starts'),cursor=store.openCursor();let total=0,count=0,contexts=0,trains=0,duplicate=false,problem;
     cursor.onsuccess=()=>{try{const row=cursor.result;if(row){const v=row.value;if(!Number.isSafeInteger(v.bytes)||v.bytes<0||typeof v.domain!=='string'||typeof v.raw!=='string'||new TextEncoder().encode(v.raw).length!==v.bytes||!['train','control'].includes(v.kind)){problem=Error('Каталог стартов повреждён; прежние данные сохранены');tx.abort();return;}total+=v.bytes;count++;if(v.domain===domain){contexts++;trains+=v.kind==='train';if(v.originId===captured.originId||v.stateHash===stateHash)duplicate=true;}row.continue();return;}
      if(duplicate||kind==='train'&&trains>=2)return;
      if(count>=MAX_RECORDS||contexts>=MAX_CONTEXT||total+bytes>LIMIT){problem=Error('Архив стартов заполнен; прежние задачи контроля сохранены');tx.abort();return;}
      store.add({domain,originId:captured.originId,stateHash,kind,bytes,raw},domain+':'+stateHash);
     }catch(error){problem=error;try{tx.abort();}catch(_){reject(error);}}};tx.oncomplete=()=>resolve({retained:!duplicate});tx.onabort=()=>reject(problem||tx.error||Error('Старт не записан; прежний архив сохранён'));
    });
   });this.queue=job;return job;
  }
  async list(context){const domain=this.domain(context),db=await this.open(),raw=await new Promise((resolve,reject)=>{const tx=db.transaction('starts','readonly'),q=tx.objectStore('starts').openCursor(),found=[];q.onsuccess=()=>{const row=q.result;if(row){if(row.value.domain===domain)found.push(row.value);row.continue();}};tx.oncomplete=()=>resolve(found);tx.onabort=()=>reject(tx.error||Error('Архив стартов не прочитан'));});const starts=[];for(const row of raw){const saved=await this.codec.decode(row.raw,context,'auto');if(saved.originId!==row.originId||await root.FlySaveStates.sha256(JSON.stringify(saved.state))!==row.stateHash)throw Error('Целостность архивного старта нарушена');starts.push(saved);}return starts;}
 }
 root.FlyEpisodeStarts={Archive,LIMIT};if(root.indexedDB)root.episodeStarts=new Archive();if(typeof module!=='undefined')module.exports=root.FlyEpisodeStarts;
})(typeof window!=='undefined'?window:globalThis);
