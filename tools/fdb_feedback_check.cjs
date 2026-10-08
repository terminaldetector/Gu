'use strict';
// Test production WebView interval/protocol code, not a substitute neural engine.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../app/src/main/assets/lab/fdb-feedback.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
 const nodes={learnerController:{value:'exo'},learnMode:{value:'train'},freeze:{checked:false},fdbJson:{value:''},fdbStatus:{textContent:''}};
 const calls=[],statuses=[],timers=new Map();let timerCounter=0,persisted=0,autosaved=0,views=0;
 const context={JSON,Map,Promise,Number,setTimeout:fn=>{const id=++timerCounter;timers.set(id,()=>{timers.delete(id);fn();});return id;},clearTimeout:id=>timers.delete(id),
  labPlatform:'sega',romHash:'rom-A',graphIdentity:{sha256:'graph-A'},requestedConfiguration:{},gmodeMode:'off',manualMask:0,agentIntervened:false,
  $:id=>nodes[id],ids:id=>id==='inputIds'?['11','12']:['21','22'],status:(message,error)=>statuses.push({message,error}),
  persistPolicy:()=>{persisted++;},trainingView:()=>{views++;},FlyBridge:{fdbFeedback:packet=>calls.push(JSON.parse(packet))},
  layerExperience:{activeId:()=> 'layer-A',autosave:()=>{autosaved++;return Promise.resolve(true);}}};
 context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'fdb-feedback.js'});
 const state=(automatic=1)=>({version:2,deltas:[],edges:[{source:'11',target:'21',weight:2}],learningState:{automatic}});
 function ack(call=calls.at(-1),response={}){context.labFdbFeedback({token:call.token,...response});}
 function decision(id='decision-A',mask=128){context.fdbAgent.remember({fdbDecision:{id,mask,probability:.5}});}
 function frames(mask=128,n=6,seconds=1/60){for(let i=0;i<n;i++)context.fdbAgent.frame(mask,seconds);}
 function outcome(id='decision-A',mask=128){decision(id,mask);frames(mask);return context.fdbAgent.capture();}
 return {context,nodes,calls,statuses,timers,state,ack,decision,frames,outcome,agent:context.fdbAgent,counts:()=>({persisted,autosaved,views})};
}
let checks=0;function check(name,fn){return Promise.resolve().then(fn).then(()=>{checks++;console.log('PASS: '+name);});}
(async()=>{
 await check('captured outcome is an immutable interval snapshot, excluding backend tail',async()=>{
  const f=fixture();f.frames(0,3);f.decision();f.frames();const result=f.agent.capture();f.frames(128,12);
  assert.equal(result.frames,6);assert.ok(Math.abs(result.seconds-.1)<1e-12);assert.ok(Math.abs(result.elapsed-.1)<1e-12);assert.equal(result.valid,true);
  const settling=f.agent.settle(result,.25,false),packet=f.calls.at(-1);
  assert.deepEqual(plain(packet),{op:'reward',token:'fdb-1',layerId:'layer-A',decision:'decision-A',mask:128,frames:6,seconds:result.elapsed,reward:.25,valid:true,frozen:false});
  f.ack();await settling;assert.equal(f.agent.capture(),null);
 });
 await check('eligibility elapsed clock includes real game time between observations, not invented executed frames',()=>{
  const f=fixture();f.decision();f.frames();const first=f.agent.capture();f.frames(128,6);f.decision('decision-B');f.frames();const second=f.agent.capture();
  assert.equal(first.frames,6);assert.equal(second.frames,6);assert.ok(Math.abs(first.elapsed-.1)<1e-12);assert.ok(Math.abs(second.elapsed-.2)<1e-12);
 });
 await check('no executed frames produce no reward packet',async()=>{
  const f=fixture();f.decision();assert.equal(f.agent.capture(),null);await f.agent.settle(null,1,false);assert.equal(f.calls.length,0);
 });
 await check('executed mask mismatch cannot earn positive credit',async()=>{
  const f=fixture();f.decision();f.frames(64);const p=f.agent.settle(f.agent.capture(),1,false);assert.equal(f.calls[0].valid,false);f.ack();await p;
 });
 await check('solo human intervention invalidates credit even when masks coincide',async()=>{
  const f=fixture();f.context.manualMask=128;const p=f.agent.settle(f.outcome(),1,false);assert.equal(f.calls[0].valid,false);f.ack();await p;
 });
 await check('co-op human P1 does not invalidate the independent agent P2 interval',async()=>{
  const f=fixture();f.context.gmodeMode='coop';f.context.manualMask=64;const p=f.agent.settle(f.outcome(),1,false);assert.equal(f.calls[0].valid,true);f.ack();await p;
 });
 await check('stale/released agent or interrupted observation invalidates outcome',async()=>{
  const f=fixture();f.context.agentIntervened=true;const p=f.agent.settle(f.outcome(),1,false);assert.equal(f.calls[0].valid,false);f.ack();await p;
  f.context.agentIntervened=false;const q=f.agent.settle(f.outcome('decision-B'),1,true);assert.equal(f.calls[1].valid,false);f.ack();await q;
 });
 await check('evaluation, human-teaching, off and external controllers create no automatic credit',()=>{
  for(const mode of ['eval','teach','off']){const f=fixture();f.nodes.learnMode.value=mode;f.decision();f.frames();assert.equal(f.agent.capture(),null);assert.equal(f.calls.length,0);}
  const f=fixture();f.nodes.learnerController.value='adaptive';f.decision();f.frames();assert.equal(f.agent.capture(),null);
 });
 await check('freeze suppresses new trace capture and marks already captured feedback frozen',async()=>{
  const f=fixture();const result=f.outcome();f.nodes.freeze.checked=true;f.decision('decision-B');f.frames();assert.equal(f.agent.capture(),null);
  const p=f.agent.settle(result,1,false);assert.equal(f.calls[0].frozen,true);f.ack();await p;
 });
 await check('boundary discards an old capture and is serialized after outstanding reward',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false);f.decision('decision-B');f.frames();f.agent.boundary();assert.equal(f.agent.capture(),null);
  assert.deepEqual(f.calls.map(c=>c.op),['reward','boundary']);const draining=f.agent.drain();f.ack(f.calls[0]);f.ack(f.calls[1]);await Promise.all([p,draining]);
 });
 await check('FDB state acknowledgement persists the same full topology and revision metadata',async()=>{
  const f=fixture(),state=f.state();const p=f.agent.settle(f.outcome(),1,false);f.ack(f.calls[0],{data:{fdbState:state,changed:1,revision:4,memoryBytes:4096}});await p;
  assert.deepEqual(JSON.parse(f.nodes.fdbJson.value),state);assert.deepEqual(f.context.requestedConfiguration.fdb,state);assert.deepEqual(f.counts(),{persisted:1,autosaved:1,views:1});
  assert.match(f.nodes.fdbStatus.textContent,/Wexo 1/);assert.match(f.nodes.fdbStatus.textContent,/4\.0 КиБ/);
 });
 await check('context drift prevents stale response from replacing a different ROM/model',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false);f.context.romHash='rom-B';f.ack(f.calls[0],{data:{fdbState:f.state(),changed:1,memoryBytes:4096}});await p;
  assert.equal(f.nodes.fdbJson.value,'');assert.deepEqual(f.context.requestedConfiguration,{});assert.deepEqual(f.counts(),{persisted:0,autosaved:0,views:0});
 });
 await check('error plus acknowledged data preserves changed weights and blocks further credit until boundary',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false);const state=f.state();f.ack(f.calls[0],{error:'write failed',data:{fdbState:state,changed:1,memoryBytes:4096}});await p;
  assert.deepEqual(JSON.parse(f.nodes.fdbJson.value),state);assert.equal(f.agent.error(),'write failed');assert.equal(f.calls[1].op,'boundary');
  f.decision('blocked');f.frames();assert.equal(f.agent.capture(),null);f.ack(f.calls[1]);f.decision('recovered');f.frames();assert.equal(f.agent.capture().id,'recovered');
 });
 await check('saveError cannot conceal the actual learned topology or durability error',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false);f.ack(f.calls[0],{saveError:'disk full',data:{fdbState:f.state(),changed:1,memoryBytes:4096}});await p;
  assert.equal(JSON.parse(f.nodes.fdbJson.value).edges[0].weight,2);assert.equal(f.agent.error(),'disk full');assert.match(f.statuses.at(-1).message,/Layer Set/);f.ack(f.calls[1]);
 });
 await check('out-of-window result clears native credit before accepting the already-produced next decision',async()=>{
  const f=fixture();f.decision();f.frames(128,121);const result=f.agent.capture();await f.agent.settle(result,1,false);
  assert.equal(f.calls[0].op,'boundary');f.decision('already-produced-B');f.frames();assert.equal(f.agent.capture(),null);
  f.ack();f.decision('after-boundary-C');f.frames();assert.equal(f.agent.capture().id,'after-boundary-C');
 });
 await check('bounded queue fails closed, recovery waits for capacity and drain includes recovery acknowledgement',async()=>{
  const f=fixture();for(let i=0;i<9;i++)f.agent.settle(f.outcome('decision-'+i),1,false);
  assert.equal(f.calls.length,8);assert.match(f.agent.error(),/очередь/);assert.equal(f.timers.size,8);
  f.decision('must-not-train');f.frames();assert.equal(f.agent.capture(),null);
  const draining=f.agent.drain();let done=false;draining.then(()=>{done=true;});f.ack(f.calls[0]);assert.equal(f.calls.length,9);assert.equal(f.calls[8].op,'boundary');assert.equal(f.timers.size,8);
  for(let i=1;i<8;i++)f.ack(f.calls[i]);await Promise.resolve();assert.equal(done,false);f.ack(f.calls[8]);await draining;assert.equal(f.timers.size,0);
  f.decision('recovered');f.frames();assert.equal(f.agent.capture().id,'recovered');
 });
 await check('timed-out reward loses no topology ack ordering and requires a confirmed boundary',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false),old=f.calls[0];const timeout=[...f.timers.values()][0];timeout();await p;
  assert.match(f.agent.error(),/не подтверждено/);assert.equal(f.calls[1].op,'boundary');f.decision('blocked');f.frames();assert.equal(f.agent.capture(),null);
  f.ack(old,{data:{fdbState:f.state(),changed:1,memoryBytes:4096}});assert.equal(f.nodes.fdbJson.value,'');
  f.ack(f.calls[1],{data:{fdbState:f.state(),changed:0,memoryBytes:4096}});assert.equal(JSON.parse(f.nodes.fdbJson.value).edges.length,1);
  f.decision('recovered');f.frames();assert.equal(f.agent.capture().id,'recovered');
 });
 await check('failed recovery boundary does not spin or re-enable unsafe credit; explicit boundary retries',async()=>{
  const f=fixture();const p=f.agent.settle(f.outcome(),1,false);f.ack(f.calls[0],{error:'native error'});await p;f.ack(f.calls[1],{error:'boundary error'});
  assert.equal(f.calls.length,2);f.decision('blocked');f.frames();assert.equal(f.agent.capture(),null);await f.agent.drain();
  f.agent.boundary();assert.equal(f.calls.length,3);f.ack(f.calls[2]);f.decision('recovered');f.frames();assert.equal(f.agent.capture().id,'recovered');
 });
 await check('missing bridge is a no-op and no empty outcome is invented',async()=>{
  const f=fixture();delete f.context.FlyBridge;await f.agent.settle(f.outcome(),1,false);await f.agent.drain();assert.equal(f.calls.length,0);
 });
 console.log('PASS: '+checks+' production FDB observation/credit protocol checks; these tests do not claim neural or gameplay improvement');
})().catch(error=>{console.error(error);process.exitCode=1;});
