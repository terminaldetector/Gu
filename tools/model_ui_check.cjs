'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/assets/lab/model-ui.js','utf8');
const html=fs.readFileSync('app/src/main/assets/lab/index.html','utf8');
const FLY='flywire-v783',MALE='male-cns-v1.0';
function fixture(){
 const nodes={},calls=[],timers=new Map();let timer=0;
 const node=id=>nodes[id]||(nodes[id]={value:'',textContent:'',disabled:false,hidden:false,checked:false});
 node('connectomeModel').value=FLY;node('layerAutosave').checked=true;
 const state={$:node,ready:false,loaded:true,labPlatform:'sega',graphIdentity:{sha256:'a'.repeat(64)},window:{},
  status:(message,error)=>calls.push(['status',message,error]),persistPolicy:argument=>calls.push(['persist',argument]),
  nativeCall:(name,...args)=>{calls.push(['native',name,...args]);state.window.FlyBridge[name](...args);},
  setTimeout:(fn,ms)=>{const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
 state.window.labPause=()=>calls.push(['pause']);
 state.window.fdbAgent={drain:async()=>{calls.push(['drain']);},error:()=>null};
 state.window.layerExperience={activeId:()=>null,autosave:async()=>{calls.push(['autosave']);return false;}};
 state.window.FlyBridge={selectConnectome:id=>calls.push(['bridge',id])};
 vm.createContext(state);vm.runInContext(source,state);
 const announce=(id=FLY,extra={})=>{state.ready=true;state.window.connectomeModels.ready({modelId:id,graph_sha256:id===FLY?'a'.repeat(64):'b'.repeat(64),neurons:64,edges:90,...extra});};
 const choose=id=>{node('connectomeModel').value=id;node('connectomeModel').onchange();};
 return{state,node,calls,timers,announce,choose,apply:()=>node('applyConnectomeModel').onclick(),ack:data=>state.window.labModelSelection(data)};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
(async()=>{
 for(const id of ['connectomeModelPanel','connectomeModel','applyConnectomeModel','modelStatus','connectomePassport','importedConnectome'])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id+' is unique in production HTML');
 assert(html.indexOf('src="model-ui.js"')>html.indexOf('src="fdb-feedback.js"'),'model UI initializes after policy/FDB helpers');
 let f=fixture();assert(f.node('connectomeModel').disabled);assert(f.node('applyConnectomeModel').disabled);
 f.announce(FLY,{modelManifest:{name:'Official graph <not markup>',version:'783',sourceUrl:'https://example.test/source',license:'CC BY',neurons:640,edges:900,weights:'synapse count; signed by transmitter',neurotransmitterCoverage:'unknown: 20'}});
 assert.equal(f.node('connectomeModel').value,FLY);assert(!f.node('connectomeModel').disabled);assert(f.node('applyConnectomeModel').disabled);
 assert(f.node('connectomePassport').textContent.includes('Official graph <not markup>'),'metadata is assigned to textContent, not HTML');
 assert(f.node('connectomePassport').textContent.includes('Нейронов: 640'));assert(f.node('connectomePassport').textContent.includes('unknown: 20'));assert(f.node('connectomePassport').textContent.includes('не являются биологически проверенными'));
 f.choose(MALE);assert(!f.node('applyConnectomeModel').disabled);
 delete f.state.window.FlyBridge.selectConnectome;await f.apply();assert.equal(f.node('connectomeModel').value,FLY);assert.equal(f.calls.filter(x=>x[0]==='pause').length,0,'unsupported bridge fails before mutating running state');assert(f.node('modelStatus').textContent.includes('Android'));
 f=fixture();f.announce();const drain=deferred(),save=deferred();
 f.state.window.fdbAgent.drain=()=>{f.calls.push(['drain']);return drain.promise;};
 f.state.window.layerExperience.activeId=()=> 'fly-layer';f.state.window.layerExperience.autosave=()=>{f.calls.push(['autosave']);return save.promise;};
 f.choose(MALE);const switching=f.apply();
 assert(f.node('applyConnectomeModel').disabled);assert(f.node('connectomeModel').disabled);assert.deepEqual(f.calls.map(x=>x[0]),['pause','drain']);
 drain.resolve();await new Promise(setImmediate);assert.deepEqual(f.calls.map(x=>x[0]),['pause','drain','persist','autosave']);
 save.resolve(true);await switching;assert.deepEqual(f.calls.map(x=>x[0]),['pause','drain','persist','autosave','native','bridge']);
 assert.deepEqual(f.calls.at(-2),['native','selectConnectome',MALE]);assert.equal(f.timers.size,1);
 f.ack({ok:true,id:FLY});assert(f.node('connectomeModel').disabled,'late ack for other model is ignored');
 f.ack({ok:true,id:MALE});assert(f.node('connectomeModel').disabled,'ack alone does not prove new graph was announced');
 f.announce(MALE);assert(!f.node('connectomeModel').disabled);assert.equal(f.timers.size,0);assert(f.node('modelStatus').textContent.includes('ROM сохранён'));
 f.choose(FLY);await f.apply();f.announce(FLY);assert(f.node('connectomeModel').disabled,'ready before ack remains blocked');f.ack({ok:true,id:FLY});assert(!f.node('connectomeModel').disabled);
 f.choose(MALE);await f.apply();f.ack({ok:false,id:MALE,error:'Not enough heap'});assert.equal(f.node('connectomeModel').value,FLY);assert.equal(f.timers.size,0);assert.equal(f.node('modelStatus').textContent,'Not enough heap');
 f=fixture();f.announce();f.state.window.fdbAgent.error=()=> 'FDB save failed';f.choose(MALE);await f.apply();assert(!f.calls.some(x=>x[0]==='native'));assert.equal(f.node('connectomeModel').value,FLY);assert.equal(f.node('modelStatus').textContent,'FDB save failed');
 f=fixture();f.announce();f.state.window.layerExperience.activeId=()=> 'named';f.choose(MALE);await f.apply();assert(!f.calls.some(x=>x[0]==='native'),'failed named autosave protects previous graph');
 f=fixture();f.announce();f.state.loaded=false;f.choose(MALE);await f.apply();assert(!f.calls.some(x=>x[0]==='persist'),'no ROM means no game policy to save');assert(f.calls.some(x=>x[0]==='native'),'can choose graph before opening a ROM');
 const timeout=Array.from(f.timers.values())[0];assert.equal(timeout.ms,120000);timeout.fn();assert.equal(f.node('connectomeModel').value,FLY);assert(!f.node('connectomeModel').disabled);assert(f.node('modelStatus').textContent.includes('не подтвердил'));
 f=fixture();f.announce('imported');assert.equal(f.node('connectomeModel').value,'imported');assert(!f.node('importedConnectome').hidden);assert(f.node('applyConnectomeModel').disabled);f.choose(FLY);await f.apply();f.ack({ok:true,id:FLY});f.announce(FLY);assert(f.node('importedConnectome').hidden);
 console.log('PASS: production model selector, passport metadata, unsupported bridge, pause/drain/save ordering, both ack orders, error preservation, imported identity and timeout');
})().catch(error=>{console.error(error);process.exitCode=1;});
