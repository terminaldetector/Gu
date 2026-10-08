'use strict';
const assert=require('node:assert/strict');
globalThis.FlyLearner=require('../app/src/main/assets/lab/learner.js');
globalThis.FlyTrainingSessions=require('../app/src/main/assets/lab/training-sessions.js');
const A=require('../app/src/main/assets/lab/archive-replay.js'),{Store}=FlyTrainingSessions;
class Disk{constructor(){this.map=new Map();}get length(){return this.map.size;}key(i){return [...this.map.keys()][i];}getItem(k){return this.map.get(k)||null;}setItem(k,v){this.map.set(k,v);}removeItem(k){this.map.delete(k);}}
const context={system:'snes',romHash:'a'.repeat(64),graphSha256:'b'.repeat(64),inputs:['1','2'],outputs:['3','4']};
const features=right=>[1,...Array.from({length:44},(_,i)=>i===0?(right?1:-1):0)];
const sample=(sequence)=>({kind:'sample',human:true,sequence,frame:sequence,at:1000,gameMs:sequence*100,wallMs:sequence*100,mask:sequence%2?128:64,seconds:sequence%2?.1:.05,frames:6,accepted:true,retina:new Array(16).fill(.5),features:features(sequence%2)});
(async()=>{
 const store=new Store(new Disk());
 async function session(id,n=288){await store.request('begin',{session:{type:'fly-human-session',version:1,id,system:context.system,romHash:context.romHash,graphSha256:context.graphSha256,name:'Trial',startedAt:1000,configuration:{inputs:context.inputs,outputs:context.outputs}}});for(let i=0;i<n;i+=32)await store.request('append',{id,sequence:i/32,events:Array.from({length:Math.min(32,n-i)},(_,j)=>sample(i+j))});return store.request('close',{id,endedAt:2000,reason:'test'});}
 const train=await session('00000000-0000-4000-8000-000000000001'),test=await session('00000000-0000-4000-8000-000000000002');
 const base=new FlyLearner();base.setActions([0,64,128]);for(let i=0;i<20;i++)base.teach(features(false),128);base.weights[1][0]=.7;
 const saved=JSON.stringify(base.save()),options={train:[train],test:[test],context,base:base.save(),allowedMask:4095,passes:2};
 const r=await A.run(store,options);assert.equal(r.report.training.uniqueSamples,288);assert.equal(r.policy.demonstration.samples,576);assert.equal(r.recent.length,200);assert.equal(r.report.test.samples,288);assert.equal(r.report.test.correct,288);assert.equal(r.report.test.baselineCorrect,144);assert.equal(JSON.stringify(base.save()),saved,'candidate does not mutate live weights or RNG');assert.deepEqual(r.policy.weights,base.weights,'reward weights retained');
 assert.equal(r.report.test.buttons[7].fp,0);assert(Math.abs(r.report.test.buttons[7].tp-14.4)<1e-8);
 const loaded=new FlyLearner();loaded.load(r.policy);assert.equal(loaded.archive.additionalSamples,0);loaded.teach(features(true),128);assert.equal(loaded.archive.additionalSamples,1);loaded.reset();assert(!loaded.archive);
 const invalid=structuredClone(r.policy);invalid.demonstration.archive.test=invalid.demonstration.archive.train;assert.throws(()=>loaded.load(invalid));
 await assert.rejects(A.run(store,{...options,test:[train]}));await assert.rejects(A.run(store,{...options,context:{...context,outputs:['9']}}));
 let pages=0;await assert.rejects(A.run(store,options,{cancelled:()=>pages===2,progress:()=>pages++}),/отменена/);assert.equal(JSON.stringify(base.save()),saved);
 const corrupted={request:async(op,args)=>{const page=await store.request(op,args);page.events[0].sequence++;return page;}};await assert.rejects(A.run(corrupted,options),/порядок/);
 const first=await store.request('read',{id:train.id,snapshot:A.snapshot(train)});assert.equal(first.events.length,32);assert.equal(first.next.event,32);await assert.rejects(store.request('read',{id:train.id,snapshot:'stale'}));await assert.rejects(store.request('read',{id:train.id,snapshot:A.snapshot(train),cursor:{chunk:1,index:0,event:31}}));
 const holdoutFrozen=JSON.stringify(r.policy),p=new FlyLearner();p.load(r.policy);for(let i=0;i<50;i++)A.predict(p,features(i%2));assert.equal(JSON.stringify(p.save()),holdoutFrozen,'evaluation does not touch policy counters or RNG');
 console.log('PASS: paged full-archive replay, clean imitation candidate, disjoint holdout, exact/time/button metrics, immutable reward/live policy, cancellation and provenance migration');
})().catch(e=>{console.error(e);process.exitCode=1;});
