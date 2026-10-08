'use strict';
const assert=require('node:assert/strict'),S=require('../app/src/main/assets/lab/layer-sets.js'),L=require('../app/src/main/assets/lab/learner.js');
class Storage{constructor(){this.data=new Map();}get length(){return this.data.size;}key(i){return [...this.data.keys()][i];}getItem(k){return this.data.get(k)||null;}setItem(k,v){this.data.set(k,v);}removeItem(k){this.data.delete(k);}}
const policy=new L(9);policy.setActions([0,1,256,1024]);policy.weights[2][3]=.4;policy.updates=18;
const set={version:2,type:S.TYPE,layerVersion:1,id:S.id(),name:'MK · P2',notes:'field observation',system:'sega',romHash:'a'.repeat(64),graph:{sha256:'b'.repeat(64)},createdAt:100,updatedAt:200,configuration:{mode:'closed',fdb:{edges:[{source:'1',target:'2',weight:8}],growthState:{rng:99,windows:21,previous:[3]}}},profile:{},policy:policy.save(),runtime:{clock:'realtime',runMode:'continuous',learnMode:'train'},journal:[{at:100,updates:18,source:'manual',outcome:'continue',note:''},{at:101,updates:18,source:'manual',outcome:'win',note:'one round'},{at:102,updates:18,source:'boundary',outcome:'timeout',note:''}]};
(async()=>{
 const disk=new Storage(),store=new S.Store(disk);await store.request('save',{set:S.clone(set)});
 const fresh=new S.Store(disk),saved=await fresh.request('get',{id:set.id});assert.deepEqual(saved.policy.weights,policy.weights);assert.deepEqual(saved.configuration.fdb,set.configuration.fdb);assert.equal((await fresh.request('list'))[0].updates,18);
 policy.weights[2][3]=9;assert.equal(saved.policy.weights[2][3],.4,'checkpoint independent of live weights');
 assert(S.compatible(S.summary(saved),{system:'sega',romHash:set.romHash,graphSha256:set.graph.sha256}));assert(!S.compatible(S.summary(saved),{system:'sega',romHash:'c'.repeat(64),graphSha256:set.graph.sha256}));
 const old=disk.getItem('fly-layer-set-'+set.id);disk.setItem=()=>{throw Error('quota');};await assert.rejects(store.request('save',{set:{...saved,name:'overwrite'}}),/quota/);assert.equal(disk.getItem('fly-layer-set-'+set.id),old,'failed replacement retains previous checkpoint');
 assert.equal(S.stats(saved.journal).manual.win,1);assert.equal(S.stats(saved.journal).criterion.win,0,'manual victory is not RAM evidence');
 await assert.rejects(store.request('save',{set:{...saved,name:''}}));await assert.rejects(store.request('save',{set:{...saved,notes:'x'.repeat(501)}}));
 const before=JSON.stringify(policy.save());assert.throws(()=>policy.load({...policy.save(),actions:[0,48]}));assert.equal(JSON.stringify(policy.save()),before,'invalid load cannot destroy weights');
 let request;const native=new S.Store(null,{layerSets:text=>request=JSON.parse(text)}),promise=native.request('get',{id:set.id});native.receive({token:request.token+1,data:'stale'});native.receive({token:request.token,data:saved});assert.deepEqual(await promise,saved);
 await fresh.request('delete',{id:set.id});assert.equal((await fresh.request('list')).length,0);
 console.log('PASS: named checkpoint persistence, independent weights/FDB, compatibility, quota rollback, outcome attribution and native request correlation');
})().catch(e=>{console.error(e);process.exitCode=1;});
