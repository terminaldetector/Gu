'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),S=require('../app/src/main/assets/lab/save-states.js');
const source=fs.readFileSync('app/src/main/assets/lab/state-ui.js','utf8');
const revision='jsnes-sha256:84946f0dae4bcf3b2dfebe84ad3bfeb1dbcb413bd9b1a69e1f45910a95fd7b41';
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)},events={},elements={},readControl={gate:null};
 class ControlledStore extends S.Store{async read(c,slot){if(readControl.gate){const gate=readControl.gate;readControl.gate=null;gate.entered.resolve();await gate.release.promise;}return super.read(c,slot);}}
 const element=()=>({type:'text',value:'quick',options:[],checked:false,addEventListener(){},before(){},appendChild(e){this.options.push(e);},setAttribute(){}});
 const hash='a'.repeat(64),restores=[],messages=[],context={FlySaveStates:{...S,Store:ControlledStore},localStorage:storage,document:{createElement:element,addEventListener:(k,v)=>events[k]=v},$:id=>elements[id]||(elements[id]=element()),profileFields:[],ready:false,loaded:true,labPlatform:'nes',romHash:hash,romLoading:false,romLoadSequence:1,generation:0,connected:false,frame:7,screen:{toDataURL:()=>null},setInterval(){},console,log:message=>messages.push(message),status:message=>messages.push(message),playing:false,audioRead:0,audioWrite:12,rgbaAndRetina(){},releasePorts(){},updateButtons(){},learningBoundary(){},validateSnapshot:s=>assert.equal(s.hash,context.romHash)};
 function core(value=7){return {value,ppu:{buffer:[]},toJSON(){return {ram:[this.value]};},fromJSON(s){this.value=s.ram[0];restores.push(this.value);}};}
 context.nes=core();context.window=context;context.confirm=()=>true;context.labPause=()=>{context.playing=false;context.connected=false;context.generation++;};
 context.labError=e=>{messages.push(e.message);context.labNeuralSuspended=true;context.labPause();};
 vm.runInNewContext(source,context);
 const store=new S.Store(storage),identity={system:'nes',hash,core:revision};
 const blockRead=()=>{const gate={entered:deferred(),release:deferred()};readControl.gate=gate;return gate;};
 const seed=()=>store.save(identity,'quick',{system:'nes',hash,frame:42,state:{ram:[42]}});
 return {context,store,identity,events,blockRead,seed,core,restores,messages};
}
(async()=>{
 {
  const {context:c,store,identity,events}=fixture();c.fdbAgent={drain:async()=>{throw Error('neural failure');}};c.playing=true;
  const preparing=c.labState.prepare();assert.equal(c.playing,false,'native prepare pauses synchronously before snapshot');await assert.rejects(preparing,/neural failure/);
  assert.equal((await store.read(identity,'auto')).frame,7,'native switch saves console before neural failure without graph');
  c.frame=9;c.document.hidden=true;events.visibilitychange();await c.labGameStates.autosave();
  assert.equal((await store.read(identity,'auto')).frame,9,'background saves console independently of neural checkpoint');
 }
 {
  const {context:c,store,identity}=fixture();const first=c.labGameStates.autosave();c.frame=8;c.nes.value=8;const second=c.labGameStates.autosave();await Promise.all([first,second]);assert.equal((await store.read(identity,'auto')).frame,8,'overlapping autosaves serialize revision lookup and commit');
  c.frame=9;c.nes.value=9;const pending=c.labGameStates.save('slot-1');c.romHash='b'.repeat(64);c.nes.value=99;await pending;const saved=await store.read(identity,'slot-1');assert.equal(saved.frame,9);assert.equal(saved.state.ram[0],9,'ROM switch cannot relabel queued snapshot');
 }
 {
  const {context:c,seed,blockRead,restores}=fixture();await seed();const gate=blockRead(),load=c.labGameStates.load('quick');await gate.entered.promise;
  await assert.rejects(c.labGameStates.load('quick'),/текущей загрузки/,'overlapping load is rejected');c.romHash='b'.repeat(64);c.romLoadSequence++;gate.release.resolve();await assert.rejects(load,/ROM изменился/);assert.deepEqual(restores,[],'pending read cannot restore across ROM switch');
  c.romLoading=true;await assert.rejects(c.labGameStates.load('quick'),/смены ROM/);
 }
 {
  const {context:c,seed,restores}=fixture();await seed();const entered=deferred(),ack=deferred(),weights={delta:[1,2],exo:[3]},prior=JSON.stringify(weights);c.learnedWeights=weights;
  c.dualAgents={active:()=>true,boundary:async kind=>{assert.equal(kind,'game-load');entered.resolve();await ack.promise;},error:()=>null};
  const load=c.labGameStates.load('quick');await entered.promise;assert.deepEqual(restores,[],'snapshot waits for dual boundary ACK');assert.equal(c.playing,false);ack.resolve();await load;assert.deepEqual(restores,[42]);assert.equal(c.frame,42);assert.equal(c.audioRead,c.audioWrite);assert.equal(JSON.stringify(weights),prior,'game restoration retains learned deltas and Wexo');
 }
 {
  const {context:c,seed,restores}=fixture();await seed();c.validateSnapshot=()=>{throw Error('invalid core snapshot');};await assert.rejects(c.labGameStates.load('quick'),/invalid core/);assert.deepEqual(restores,[],'semantic snapshot validation precedes mutation');
 }
 {
  const {context:c,seed}=fixture();await seed();const original=c.nes.fromJSON.bind(c.nes);c.nes.fromJSON=s=>{original(s);if(s.ram[0]===42)throw Error('partial core restore failure');};await assert.rejects(c.labGameStates.load('quick'),/partial core/);assert.equal(c.nes.value,7,'partially failed restore rolls back console state');assert.equal(c.frame,7,'failed restore leaves frame counter intact');
 }
 for(const action of ['resume','connect','new-generation','rom-switch']){
  const {context:c,seed,restores,core}=fixture();await seed();const entered=deferred(),ack=deferred();c.dualAgents={active:()=>true,boundary:async()=>{entered.resolve();await ack.promise;}};
  const load=c.labGameStates.load('quick');await entered.promise;
  if(action==='resume')c.playing=true;if(action==='connect')c.connected=true;if(action==='new-generation')c.generation++;if(action==='rom-switch'){c.nes=core(99);c.romLoadSequence++;}
  ack.resolve();await assert.rejects(load,/изменил/);assert.deepEqual(restores,[],action+' while ACK pending cancels restoration');
 }
 {
  const {context:c,seed,restores,messages}=fixture();await seed();c.dualAgents={active:()=>true,boundary:async()=>{throw Error('boundary failure');}};await c.labGameStates.load('quick');assert(c.labNeuralSuspended);assert(messages.some(m=>m.includes('boundary failure')),'boundary failure is recorded');assert.deepEqual(restores,[42],'failed neural boundary suspends agent while allowing console restore');
 }
 {
  const {context:c,seed,restores,messages}=fixture();await seed();const entered=deferred(),ack=deferred();c.dualAgents={active:()=>true,boundary:async()=>{entered.resolve();await ack.promise;}};
  const load=c.labGameStates.load('quick');await entered.promise;c.playing=true;c.generation++;ack.reject(Error('late failed boundary'));
  await assert.rejects(load,/изменил/,'failed ACK must not erase the resumed-game cancellation guard');assert.deepEqual(restores,[]);assert.equal(c.playing,true,'late failure leaves resumed game running');assert(messages.some(m=>m.includes('late failed boundary')),'late failure is still recorded');
 }
 {
  const {context:c,seed,blockRead,restores}=fixture();await seed();let allowed=true;const gate=blockRead(),load=c.labGameStates.load('quick',{permit:()=>allowed});await gate.entered.promise;allowed=false;c.playing=true;gate.release.resolve();await assert.rejects(load,/измен/);assert.equal(c.playing,true,'cancelled scheduler load cannot pause a resumed manual session');assert.deepEqual(restores,[]);
 }
 console.log('PASS: lifecycle without graph, serialized autosaves, ROM identity capture, overlapping loads, ROM switch cancellation, boundary ACK, resume/reconnect/generation guards, preserved learned weights, logged neural boundary failure');
})().catch(e=>{console.error(e);process.exitCode=1;});
