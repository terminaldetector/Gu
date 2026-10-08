'use strict';
const assert=require('node:assert/strict'),{Store,Writer}=require('../app/src/main/assets/lab/training-sessions.js');
class Disk{constructor(){this.map=new Map();this.fail=false;}get length(){return this.map.size;}key(i){return [...this.map.keys()][i];}getItem(k){return this.map.get(k)||null;}setItem(k,v){if(this.fail&&k.endsWith('-meta'))throw Error('quota');this.map.set(k,v);}removeItem(k){this.map.delete(k);}}
const meta={type:'fly-human-session',version:1,id:'00000000-0000-4000-8000-000000000001',system:'snes',romHash:'a'.repeat(64),graphSha256:'b'.repeat(64),name:'Human round',startedAt:1000};
const sample=(sequence,mask=128,accepted=true)=>({kind:'sample',sequence,frame:sequence,at:1000+sequence,gameMs:sequence*100,wallMs:sequence*100,human:true,mask,seconds:.1,frames:6,retina:new Array(16).fill(.5),features:new Array(45).fill(.5),accepted});
(async()=>{
 const disk=new Disk(),store=new Store(disk);await store.request('begin',{session:meta});
 const batch=[sample(0,129),sample(1,0),sample(2,8,false)];const saved=await store.request('append',{id:meta.id,sequence:0,events:batch});
 assert.equal(saved.accepted,2);assert.equal(saved.skipped,1);assert.equal(saved.buttonMs[0],100);assert.equal(saved.buttonMs[7],100);assert.equal(saved.neutralMs,100);assert(Math.abs(saved.gameMs-300)<1e-8);
 const restored=new Store(disk);assert.deepEqual(await restored.request('append',{id:meta.id,sequence:0,events:batch}),saved,'latest retry is idempotent');
 await assert.rejects(store.request('append',{id:meta.id,sequence:2,events:[sample(3)]}));
 await assert.rejects(store.request('append',{id:meta.id,sequence:1,events:[sample(4)]}));
 await assert.rejects(store.request('append',{id:meta.id,sequence:1,events:[sample(3,48)]}));
 await assert.rejects(store.request('begin',{session:{...meta,id:'../escape'}}));
 disk.fail=true;await assert.rejects(store.request('append',{id:meta.id,sequence:1,events:[sample(3)]}));disk.fail=false;
 assert.equal(disk.getItem('fly-human-session-'+meta.id+'-1'),null,'failed metadata commit rolls back new chunk');
 assert.deepEqual((await restored.request('export',{id:meta.id})).events,batch,'old prefix survives failure and reopen');
 await store.request('close',{id:meta.id,endedAt:2000,reason:'pause'});await assert.rejects(store.request('append',{id:meta.id,sequence:1,events:[sample(3)]}));
 const longMeta={...meta,id:'00000000-0000-4000-8000-000000000002'};await store.request('begin',{session:longMeta});
 for(let i=0;i<9;i++)await store.request('append',{id:longMeta.id,sequence:i,events:Array.from({length:32},(_,j)=>sample(i*32+j))});
 assert.equal((await new Store(disk).request('export',{id:longMeta.id})).events.length,288,'full archives survive beyond the compact 200-example model');
 await assert.rejects(store.request('delete',{id:longMeta.id}));await store.request('delete',{id:meta.id});assert.equal((await store.request('list')).length,1);assert.equal((await store.request('export',{id:longMeta.id})).events.length,288,'deleting one archive preserves the other');
 const requests=[],native=new Store(null,{trainingSessions:raw=>requests.push(JSON.parse(raw))});const w=new Writer(native,{...meta,id:undefined});w.add(sample(0));const closing=w.close('background');
 assert.deepEqual(requests.map(r=>r.op),['begin','append','close'],'background flush submits FIFO without waiting for WebView callbacks');
 native.receive({token:'stale',data:{}});for(const r of requests)native.receive({token:r.token,data:{...meta,id:r.session?.id||r.id,events:r.op==='begin'?0:1,status:r.op==='close'?'closed':'recording'}});
 await closing;await Promise.resolve();assert.equal(w.pending,0);assert.equal(w.writes.size,0,'settled promise references stay bounded');
 const denied=new Writer(new Store(new Disk()),{...meta,romHash:'wrong'});await Promise.all([...denied.writes]);assert.equal(denied.failed,true);denied.add(sample(0));assert.equal(denied.buffer.length,0);
 console.log('PASS: session reopen/export, action coverage, ordered/idempotent chunks, rejected gaps, quota rollback, old-prefix retention and background bridge FIFO');
})().catch(e=>{console.error(e);process.exitCode=1;});
