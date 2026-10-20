'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),S=require('../app/src/main/assets/lab/layer-sets.js'),L=require('../app/src/main/assets/lab/learner.js'),G=require('../app/src/main/assets/lab/game-tools.js');
const source=fs.readFileSync('app/src/main/assets/lab/layer-ui.js','utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
class Storage{
 constructor(){this.map=new Map();this.markerFailure=false;}
 get length(){return this.map.size;}key(i){return [...this.map.keys()][i];}getItem(k){return this.map.get(k)??null;}
 setItem(k,v){if(this.markerFailure&&k.startsWith('fly-resume-'))throw Error('resume marker failure');this.map.set(k,v);}removeItem(k){this.map.delete(k);}
}
function fixture(storage=new Storage()){
 const elements={},events=[],control={failSave:false,failBind:false,gate:null},learner=new L(7);learner.setActions([0,1]);learner.updates=13;
 function element(){return {value:'',checked:false,disabled:false,hidden:false,options:[],replaceChildren(...o){this.options=o;this.value=o[0]?.value||'';},add(o){this.options.push(o);}};}
 class InstrumentedStore extends S.Store{
  async request(op,payload){
   if(op==='checkpointRoles'){
    events.push('archive:'+payload.id);if(control.archiveGate){control.archiveGate.entered.resolve();await control.archiveGate.release.promise;}
    if(control.failArchive)throw Error('immutable checkpoint failure');return {available:true,current:'d'.repeat(64),recovery:'e'.repeat(64),best:null,layerId:payload.id};
   }
   if(op==='resumeRoles'){events.push('resume-archive');return control.archiveSet||null;}
   if(op==='roles')return {available:true,current:'d'.repeat(64),recovery:'e'.repeat(64),best:null,layerId:payload.id};
   if(op==='save'){events.push('save-start');if(control.gate){const g=control.gate;control.gate=null;g.entered.resolve();await g.release.promise;}if(control.failSave)throw Error('durable storage failure');}
   const result=await super.request(op,payload);if(op==='save')events.push('save-durable');return result;
  }
 }
 const c={FlyLayerSets:{...S,Store:InstrumentedStore},localStorage:storage,$:id=>elements[id]||(elements[id]=element()),Option:function(text,value){return {textContent:text,value};},labPlatform:'nes',romHash:'a'.repeat(64),graphIdentity:{sha256:'b'.repeat(64),modelId:'fixture'},ready:true,loaded:true,learner,frame:7,fdbConfiguration:()=>({edges:[],deltas:[]}),log:message=>events.push('log:'+message),status:message=>events.push('status:'+message),FlyGameTools:G,FlyLearner:L,gmodeMode:'off',startSnapshot:null,requestedConfiguration:null,restoreGrowthStatePending:false,configurationApplied:false,terminalLatch:null,ramLimit:2048,nes:{cpu:{mem:new Array(2048).fill(0)}}};
 c.window=c;c.labPause=()=>events.push('pause');c.nativeCall=()=>{};c.validateModelPackage=()=>{};c.keysEqual=(a,b)=>a===b;c.policyConfiguration=x=>S.clone(x);c.restoreProfile=p=>events.push('restore-profile:'+p.id);c.restorePolicy=p=>{learner.load(p.policy);events.push('restore-policy:'+p.id);};
 c.policyPackage=()=>{const configuration={mode:'closed',inputs:['1'],outputs:['2'],gmode:'off',fdb:{edges:[],deltas:[]}},profile={actionMasks:'0,1'};return {version:2,system:c.labPlatform,romHash:c.romHash,configuration,profile,policy:learner.save(),key:JSON.stringify({romHash:c.romHash,inputs:configuration.inputs,outputs:configuration.outputs,system:c.labPlatform,graph_sha256:c.graphIdentity.sha256,profile,configuration,gmode:'off'})};};
 c.fdbAgent={drain:async()=>{events.push('drain');if(control.drainGate){control.drainGate.entered.resolve();await control.drainGate.release.promise;}},error:()=>null,bindCurrent:async id=>{events.push('bind:'+id);assert(storage.getItem('fly-layer-set-'+id),'Current must be durable before binding');assert.equal(storage.getItem(resumeKey()),id,'resume pointer must be durable before binding');if(control.bindGate){control.bindGate.entered.resolve();await control.bindGate.release.promise;}if(control.failBind)throw Error('binding acknowledgement failure');return true;}};
 function resumeKey(){return 'fly-resume-v1-'+c.labPlatform+'-'+c.romHash+'-'+c.graphIdentity.sha256;}
 c.$('clock').value='realtime';c.$('runMode').value='continuous';c.$('learnMode').value='train';c.$('rewardMode').value='off';c.$('layerName').value='Existing manual checkpoint';c.$('layerNotes').value='';
 vm.runInNewContext(source,c);
 return {c,storage,events,control,resumeKey};
}
(async()=>{
 {
  const {c,storage,events,resumeKey}=fixture();assert.equal(typeof c.layerExperience.ensureCurrent,'function','production layerExperience must expose ensureCurrent');assert.equal(c.$('autosavePolicy').checked,false);assert.equal(c.$('layerAutosave').checked,false);
  const id=await c.layerExperience.ensureCurrent();assert.equal(typeof id,'string');assert.equal(c.layerExperience.activeId(),id);assert.equal(storage.getItem(resumeKey()),id);assert(events.indexOf('save-durable')<events.indexOf('bind:'+id),'durable save precedes bind ACK');
  const set=JSON.parse(storage.getItem('fly-layer-set-'+id));assert.equal(set.policy.updates,13);assert(!/best/i.test(set.name),'Current must not claim validated Best status');
  const reloaded=fixture(storage);assert.equal(await reloaded.c.layerExperience.resume(),true,'reload resumes the persisted pointer');assert.equal(reloaded.c.layerExperience.activeId(),id);assert(reloaded.events.includes('restore-policy:'+id));
 }
 for(const failure of ['storage','marker','bind']){
  const {c,storage,control,events}=fixture();control.failSave=failure==='storage';storage.markerFailure=failure==='marker';control.failBind=failure==='bind';
  await assert.rejects(c.layerExperience.ensureCurrent(),failure==='bind'?/binding/:/сохран/);
  if(failure!=='bind')assert(events.some(e=>e.includes(failure==='storage'?'durable storage failure':'resume marker failure')),'original storage diagnosis is logged');
  if(failure!=='bind')assert(!events.some(e=>e.startsWith('bind:')),failure+' failure must prevent binding');
 }
 {
  const {c,control,events}=fixture(),gate={entered:deferred(),release:deferred()};control.gate=gate;
  const a=c.layerExperience.ensureCurrent(),b=c.layerExperience.ensureCurrent();assert.equal(a,b,'concurrent callers share the same pending job');await gate.entered.promise;gate.release.resolve();const [id,other]=await Promise.all([a,b]);assert.equal(id,other);assert.equal(events.filter(e=>e==='save-durable').length,1,'concurrent ensure coalesces one durable Current');assert.equal(events.filter(e=>e.startsWith('bind:')).length,1,'concurrent ensure uses one bind acknowledgement');
 }
 {
  const {c,control,events}=fixture(),gate={entered:deferred(),release:deferred()};control.gate=gate;const pending=c.layerExperience.ensureCurrent();await gate.entered.promise;c.romHash='c'.repeat(64);c.layerExperience.contextChanged();gate.release.resolve();await assert.rejects(pending,/контекст|ROM|изменил/i);assert(!events.some(e=>e.startsWith('bind:')),'stale Current must not bind a different game');
 }
 {
  const {c,control,events}=fixture(),gate={entered:deferred(),release:deferred()};control.drainGate=gate;const pending=c.layerExperience.ensureCurrent();await gate.entered.promise;c.graphIdentity={...c.graphIdentity,sha256:'d'.repeat(64)};gate.release.resolve();await assert.rejects(pending,/изменил/);assert(!events.includes('save-durable'),'graph change during drain prevents stale snapshot');
 }
 {
  const {c,control,storage,resumeKey}=fixture(),gate={entered:deferred(),release:deferred()};control.bindGate=gate;const originalKey=resumeKey(),pending=c.layerExperience.ensureCurrent();await gate.entered.promise;assert(storage.getItem(originalKey),'resume marker exists while bind ACK is pending');c.romHash='c'.repeat(64);c.layerExperience.contextChanged();gate.release.resolve();await assert.rejects(pending,/изменил/);assert.equal(storage.getItem(resumeKey()),null,'late bind cannot assign Current pointer to another ROM');
 }
 {
  const {c,control}=fixture();control.failBind=true;await assert.rejects(c.layerExperience.ensureCurrent(),/binding/);control.failBind=false;assert.equal(typeof await c.layerExperience.ensureCurrent(),'string','failed ensure releases coalescing job for a safe retry');
 }
 {
  const {c,storage}=fixture();await c.$('layerNew').onclick();const existing=c.layerExperience.activeId();assert(existing);const name=JSON.parse(storage.getItem('fly-layer-set-'+existing)).name;const id=await c.layerExperience.ensureCurrent();assert.equal(id,existing,'existing compatible active checkpoint remains Current');assert.equal(JSON.parse(storage.getItem('fly-layer-set-'+id)).name,name,'ensure does not rename active model Best');
 }
 {
  const {c,events,control}=fixture();c.FlyBridge={layerSets(){}};
  const id=await c.layerExperience.ensureCurrent();assert(events.indexOf('bind:'+id)<events.indexOf('archive:'+id),'immutable archive ACK precedes gate completion after binding');assert(c.$('layerRoles').textContent.includes('Best: ещё не подтверждён'));
  control.failArchive=true;await assert.rejects(c.layerExperience.ensureCurrent(),/immutable checkpoint failure/,'archive failure must prevent successful Current gate');
 }
 {
  const {c,storage,control,resumeKey}=fixture();const id=await c.layerExperience.ensureCurrent(),set=JSON.parse(storage.getItem('fly-layer-set-'+id));storage.removeItem(resumeKey());
  const reopened=fixture(storage);reopened.c.FlyBridge={layerSets(){}};reopened.control.archiveSet=set;
  assert.equal(await reopened.c.layerExperience.resume(),true,'missing marker resumes archive-selected native Current');assert.equal(reopened.c.layerExperience.activeId(),id);assert.equal(storage.getItem(resumeKey()),id);
 }
 {
  const {c,control}=fixture();c.FlyBridge={layerSets(){}};control.archiveGate={entered:deferred(),release:deferred()};
  const job=c.layerExperience.ensureCurrent();await control.archiveGate.entered.promise;c.romHash='f'.repeat(64);control.archiveGate.release.resolve();await assert.rejects(job,e=>e.stale===true,'late archive ACK cannot bind another ROM');
 }
 {
  const {c,events}=fixture();c.FlyBridge={layerSets(){}};await c.layerExperience.ensureCurrent();const before=events.filter(e=>e==='save-durable').length;
  c.$('autosavePolicy').checked=false;c.$('layerAutosave').checked=false;
  await c.layerExperience.checkpoint();assert.equal(events.filter(e=>e==='save-durable').length,before,'optional checkpoint respects disabled periodic autosave');
  await c.layerExperience.checkpoint({force:true});assert.equal(events.filter(e=>e==='save-durable').length,before+1,'explicit/lifecycle checkpoint remains durable with both periodic toggles disabled');
 }
 console.log('PASS: durable Current before bind ACK, disabled autosave, storage/marker/bind failures, coalescing, context guard, active identity, reload resume, immutable archive ACK/failure and missing-marker recovery');
})().catch(e=>{console.error(e);process.exitCode=1;});
