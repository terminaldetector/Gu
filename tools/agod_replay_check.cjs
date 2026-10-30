'use strict';
// S2: the replay correction Sol required, and the experiment that shows why it
// was required.
//
// Part A is the contract: UNKNOWN carries no value and is never trainable,
// KNOWN_ZERO is a measured zero and is, credit stops at episode edges, restore
// boundaries, evidenced rewards and the horizon, and a contradicted event takes
// its credit back.
//
// Part B is the point. A sparse chain where the decision that matters happens
// twelve steps before the only confirmed outcome. The E5 scheme - drop every
// UNKNOWN transition - keeps the TD target safe and makes that decision
// unlearnable, because the steps that connect it to the outcome are the ones
// thrown away. Both schemes are run on identical episodes with identical seeds
// and the same learner code; only the replay differs.
const assert=require('node:assert/strict'),fs=require('node:fs');
const Replay=require('../app/src/main/assets/lab/agod-replay.js'),
      Dqn=require('../app/src/main/assets/lab/agod-dqn.js');

const CORRIDOR=12,GAMMA=0.95,EPISODES=300,EVAL=60,AGENT_SEEDS=[11,29,37,53,71,97,113,131];
const EXPENSIVE=2,EXPENSIVE_COST=1,CHEAP_COST=0.1;
const contract=[],learning=[];
const result={type:'gu-agod-replay-check',version:1,
 scope:'synthetic sparse-reward chain, no emulator; the learner is the committed E5 agent, unchanged',
 claim:'Dropping UNKNOWN transitions protects the TD target and destroys delayed credit. Labelling certainty and crediting earlier steps from a later confirmed event restores it without ever turning UNKNOWN into a reward of zero.',
 status:'RUNNING',contract,learning};
const save=()=>{if(process.env.AGOD_REPLAY_REPORT)fs.writeFileSync(process.env.AGOD_REPLAY_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const note=(name,expectation,observed)=>{contract.push({name,expectation,observed});save();};
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const provenance={romHash:'rom-a',coreRevision:'core-a',startId:'boot',restorePath:['boot'],partition:'discovery'};

try{
 // ---------------- Part A: the certainty contract ----------------
 {const store=Replay.createStore({gamma:0.9,creditHorizon:4});
  store.beginEpisode({id:'e',provenance});
  for(let i=0;i<6;i++)store.append({episodeId:'e',state:[i],action:i%3,nextState:[i+1],status:Replay.UNKNOWN});
  const event=store.append({episodeId:'e',state:[6],action:2,nextState:[7],status:Replay.VERIFIED_REWARD,value:-1,terminal:true});
  const stepsBefore=store.episode('e');
  const roundTrip=JSON.parse(JSON.stringify(stepsBefore[0]));
  note('an UNKNOWN step','no value key, before or after JSON, and not trainable',
   'hasValue '+has(stepsBefore[0],'value')+', hasValueAfterJson '+has(roundTrip,'value')+', trainable '+store.trainable().length+' of '+store.size());
  assert(!has(stepsBefore[0],'value')&&!has(roundTrip,'value'),'UNKNOWN must never carry a value key');
  assert.equal(store.trainable().length,1,'only the evidenced step may be trainable before settling');
  assert.equal(store.untrainable().length,6);

  const settled=store.settle({episodeId:'e',index:event.index,kind:'terminal'});
  const credited=store.episode('e').filter(step=>step.status===Replay.CREDITED);
  note('credit horizon','the horizon stops the walk-back, it is not unlimited',
   'credited '+settled.credited+' of 6, stopped because '+settled.stoppedBecause);
  assert.equal(settled.credited,4,'the horizon of 4 must limit credit to four steps');
  assert.equal(settled.stoppedBecause,'horizon');
  const nearest=credited.find(step=>step.index===event.index-1);
  note('credited value','discounted by gamma^distance, with the assumption on the record',
   'nearest '+nearest.value.toFixed(4)+' (gamma^1), assumption recorded '+(nearest.credit.assumption.length>0));
  assert(Math.abs(nearest.value-(-1*0.9))<1e-12,'a step one before the event is discounted once');
  assert.equal(nearest.credit.fromIndex,event.index);
  assert(/assumption recorded here rather than a measured zero/.test(nearest.credit.assumption),
   'the assumption that makes credit possible must be stated, not hidden');
  assert.equal(store.trainable().length,5);

  const revoked=store.revoke({episodeId:'e',index:event.index,reason:'the event was contradicted'});
  note('a contradicted event','takes its credit back, steps return to UNKNOWN',
   'reverted '+revoked.reverted+', trainable now '+store.trainable().length);
  assert.equal(revoked.reverted,4);
  assert.equal(store.trainable().length,1);
  assert(store.episode('e').filter(s=>s.status===Replay.UNKNOWN).every(s=>!has(s,'value')),
   'a revoked step must lose its value key, not keep a stale number');}

 {const store=Replay.createStore({gamma:0.9,creditHorizon:64});
  store.beginEpisode({id:'a',provenance});store.beginEpisode({id:'b',provenance});
  store.append({episodeId:'a',state:[0],action:0,nextState:[1],status:Replay.UNKNOWN});
  store.append({episodeId:'b',state:[0],action:1,nextState:[1],status:Replay.UNKNOWN});
  const event=store.append({episodeId:'b',state:[1],action:1,nextState:[2],status:Replay.VERIFIED_REWARD,value:-1});
  store.settle({episodeId:'b',index:event.index,kind:'terminal'});
  note('episode isolation','credit never crosses into another episode',
   'episode a still '+store.episode('a')[0].status);
  assert.equal(store.episode('a')[0].status,Replay.UNKNOWN,'another episode must be untouched');}

 {const store=Replay.createStore({gamma:0.9,creditHorizon:64});
  store.beginEpisode({id:'r',provenance});
  store.append({episodeId:'r',state:[0],action:0,nextState:[1],status:Replay.UNKNOWN});
  store.markBoundary('r','state restored between observation and outcome');
  store.append({episodeId:'r',state:[1],action:0,nextState:[2],status:Replay.UNKNOWN});
  const event=store.append({episodeId:'r',state:[2],action:0,nextState:[3],status:Replay.VERIFIED_REWARD,value:-1});
  const settled=store.settle({episodeId:'r',index:event.index,kind:'terminal'});
  note('restore boundary','credit stops at a save/load, as a single payout does (6.3.5)',
   'credited '+settled.credited+', stopped because '+settled.stoppedBecause);
  assert.equal(settled.credited,1);
  assert.equal(settled.stoppedBecause,'restore-boundary');
  assert.equal(store.episode('r')[0].status,Replay.UNKNOWN,'the step before the restore must stay unknown');}

 {const store=Replay.createStore({gamma:0.9,creditHorizon:64});
  store.beginEpisode({id:'z',provenance});
  store.append({episodeId:'z',state:[0],action:0,nextState:[1],status:Replay.UNKNOWN});
  store.append({episodeId:'z',state:[1],action:0,nextState:[2],status:Replay.KNOWN_ZERO,value:0});
  store.append({episodeId:'z',state:[2],action:0,nextState:[3],status:Replay.UNKNOWN});
  const event=store.append({episodeId:'z',state:[3],action:0,nextState:[4],status:Replay.VERIFIED_REWARD,value:-1});
  const settled=store.settle({episodeId:'z',index:event.index,kind:'terminal'});
  const zero=store.episode('z')[1];
  note('a measured zero is not an unknown','KNOWN_ZERO is trainable and blocks the walk-back',
   'value '+zero.value+', status '+zero.status+', credited '+settled.credited+', stopped because '+settled.stoppedBecause);
  assert.equal(zero.value,0);
  assert.equal(settled.credited,1,'credit must stop at an evidenced reward rather than double count past it');
  assert.equal(settled.stoppedBecause,'evidenced-reward');
  let threw=null;try{store.append({episodeId:'z',state:[9],action:0,nextState:[9],status:Replay.UNKNOWN,value:0});}catch(error){threw=error.message;}
  note('refusing to smuggle a zero','an UNKNOWN step offered a value is rejected',threw||'accepted');
  assert(threw&&/must not carry a value/.test(threw));}

 {const store=Replay.createStore({capacity:6,gamma:0.9});
  for(const id of ['p','q','r']){store.beginEpisode({id,provenance});
   for(let i=0;i<4;i++)store.append({episodeId:id,state:[i],action:0,nextState:[i+1],status:Replay.UNKNOWN});}
  const lengths=['p','q','r'].map(id=>store.episode(id)?store.episode(id).length:null);
  note('eviction','whole episodes are dropped, never half a sequence',JSON.stringify(lengths));
  assert(lengths.every(length=>length===null||length===4),'a surviving episode must be intact');
  assert(lengths.includes(null),'the oldest episode must have been dropped');}

 // ---------------- Part B: can the delayed decision be learned? ----------------
 // One gate choice, then a corridor where actions do nothing and nothing is
 // observed, then one confirmed cost that depends only on the gate.
 const features=(step,gate)=>{
  const state=new Float64Array(5);
  state[0]=step===0?1:0;
  state[1]=step/(CORRIDOR+1);
  if(gate>=0)state[2+gate]=1;
  return state;
 };
 const run=(agentSeed,scheme)=>{
  const agent=Dqn.createAgent({inputs:5,hidden:24,actions:3,seed:agentSeed,
   warmup:48,batchSize:32,syncEvery:40,gamma:GAMMA,lr:0.003});
  const store=Replay.createStore({gamma:GAMMA,creditHorizon:64,capacity:40000});
  let fed=0;
  const seen=new Set();
  const feed=()=>{
   for(const step of store.trainable()){
    const key=step.episodeId+'#'+step.index+'#'+step.status+'#'+(step.credit?step.credit.fromIndex:'-');
    if(seen.has(key))continue;
    seen.add(key);fed++;
    agent.observe({state:step.state,action:step.action,reward:step.value,nextState:step.nextState,done:step.terminal});
   }
  };
  const episode=(index,{epsilon,learn})=>{
   const id='ep-'+scheme+'-'+agentSeed+'-'+index;
   store.beginEpisode({id,provenance});
   let gate=-1,chosenExpensive=false;
   for(let step=0;step<=CORRIDOR+1;step++){
    const state=features(step,gate);
    const {action}=agent.act(state,epsilon);
    if(step===0){gate=action;chosenExpensive=action===EXPENSIVE;}
    const next=features(step+1,gate);
    const terminal=step===CORRIDOR+1;
    if(terminal){
     // The only confirmed observation in the whole episode.
     const cost=chosenExpensive?EXPENSIVE_COST:CHEAP_COST;
     const event=store.append({episodeId:id,state,action,nextState:next,terminal:true,
      status:Replay.VERIFIED_REWARD,value:-cost});
     if(scheme==='deferred-credit')store.settle({episodeId:id,index:event.index,kind:'terminal'});
    }else{
     // Nothing is known about this step's reward. Under the E5 scheme it would
     // simply not exist; here it exists and stays untrainable until credited.
     store.append({episodeId:id,state,action,nextState:next,status:Replay.UNKNOWN});
    }
   }
   if(learn){feed();for(let i=0;i<CORRIDOR+2;i++)agent.train();}
   return chosenExpensive;
  };
  for(let i=0;i<EPISODES;i++){
   const epsilon=1-(1-0.05)*(i/(EPISODES-1));
   episode(i,{epsilon,learn:true});
  }
  let expensive=0;
  for(let i=0;i<EVAL;i++)if(episode(EPISODES+i,{epsilon:0,learn:false}))expensive++;
  const q=agent.qValues(features(0,-1));
  return {expensiveRate:expensive/EVAL,updates:agent.stats().updates,fedTransitions:fed,
   storeStats:store.stats(),qAtGate:Array.from(q),
   expensiveHasLowestQ:q[EXPENSIVE]===Math.min(...q)};
 };

 for(const agentSeed of AGENT_SEEDS){
  const dropped=run(agentSeed,'drop-unknown');
  const deferred=run(agentSeed,'deferred-credit');
  learning.push({agentSeed,
   dropUnknown:{expensiveRate:dropped.expensiveRate,updates:dropped.updates,fedTransitions:dropped.fedTransitions,
    trainableShare:dropped.storeStats.byStatus.VERIFIED_REWARD/dropped.storeStats.stored,
    unknownKept:dropped.storeStats.byStatus.UNKNOWN,credited:dropped.storeStats.credited,
    qAtGate:dropped.qAtGate,expensiveHasLowestQ:dropped.expensiveHasLowestQ},
   deferredCredit:{expensiveRate:deferred.expensiveRate,updates:deferred.updates,fedTransitions:deferred.fedTransitions,
    credited:deferred.storeStats.credited,unknownLeft:deferred.storeStats.byStatus.UNKNOWN,
    qAtGate:deferred.qAtGate,expensiveHasLowestQ:deferred.expensiveHasLowestQ}});
  save();
  assert.equal(dropped.storeStats.credited,0,'the drop-unknown arm must never credit');
  assert(deferred.storeStats.credited>0,'the deferred arm must credit earlier steps');
  assert(deferred.fedTransitions>dropped.fedTransitions,'crediting must make more steps trainable');
 }

 const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
 const droppedRates=learning.map(row=>row.dropUnknown.expensiveRate);
 const deferredRates=learning.map(row=>row.deferredCredit.expensiveRate);
 result.totals={agentSeeds:AGENT_SEEDS.length,corridor:CORRIDOR,gamma:GAMMA,episodes:EPISODES,
  contractChecks:contract.length,
  expensiveGateRateDropUnknown:mean(droppedRates),
  expensiveGateRateDeferredCredit:mean(deferredRates),
  seedsWhereDeferredAvoidsExpensive:learning.filter(r=>r.deferredCredit.expensiveRate<r.dropUnknown.expensiveRate).length,
  seedsWhereDeferredIsWorse:learning.filter(r=>r.deferredCredit.expensiveRate>r.dropUnknown.expensiveRate).length,
  seedsWhereExpensiveHasLowestQDeferred:learning.filter(r=>r.deferredCredit.expensiveHasLowestQ).length,
  seedsWhereExpensiveHasLowestQDropped:learning.filter(r=>r.dropUnknown.expensiveHasLowestQ).length,
  trainableStepsDropUnknown:mean(learning.map(r=>r.dropUnknown.fedTransitions)),
  trainableStepsDeferredCredit:mean(learning.map(r=>r.deferredCredit.fedTransitions)),
  effectiveSampleSize:'the comparison is paired on agent seed: 8 independent initialisations, each run under both schemes on identical episode structure'};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,contract,learning}));
 console.log('PASS: '+contract.length+' contract checks; with the decision '+CORRIDOR+' steps before the only confirmed outcome, the expensive gate is chosen at rate '+
  result.totals.expensiveGateRateDropUnknown.toFixed(3)+' when UNKNOWN transitions are dropped and '+
  result.totals.expensiveGateRateDeferredCredit.toFixed(3)+' with deferred credit, and the expensive action has the lowest Q at the gate in '+
  result.totals.seedsWhereExpensiveHasLowestQDeferred+'/'+AGENT_SEEDS.length+' seeds against '+
  result.totals.seedsWhereExpensiveHasLowestQDropped+'/'+AGENT_SEEDS.length+'. UNKNOWN never became a zero.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
