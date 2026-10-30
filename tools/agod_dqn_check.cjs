'use strict';
// E5: is this a learner, or a demonstration of one?
// Part A checks the learner itself with no emulator: hand-written gradients
// against finite differences, the Double target against the vanilla target it
// is not, determinism, and a checkpoint that continues the same run.
// Part B lets the whole internal chain produce the reward - causal attribution
// (E3), typing (E2), induction (E4), the registry (AGOD-08), the broker - and
// measures whether behaviour changes. Part C repeats Part B with a goal that
// never reached VERIFIED, so every claim is UNKNOWN, nothing is learnable, and
// the measured difference can be attributed to the reward and not the setup.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Dqn=require('../app/src/main/assets/lab/agod-dqn.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Reward=require('../app/src/main/assets/lab/agod-reward.js'),
      Evidence=require('../app/src/main/assets/lab/agod-evidence.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-dqn-')),seeds=[0,1,2,7,8,9,47];
const FRAMES=12,SHIFT=3,STARTS=2,TYPE_EVENTS=60,HOLD=4,RELEASE=8;
const TRAIN_STEPS=400,EVAL_STEPS=60,AGENT_SEEDS=[11,29,37,53,71,97],REV='profile-rev-1',CORE='jsnes-nes';
const learner=[],runs=[];
const result={type:'gu-agod-dqn-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 oracle:'checker-only: read after every run, never passed into attribution, typing, induction, the registry, the broker or the agent',
 claim:'A Double DQN with hand-checked gradients changes its behaviour when, and only when, the internal chain produces a VERIFIED reward. With an unverified goal every claim is UNKNOWN, no transition carries reward evidence, and no weight moves.',
 unknownHandling:'A transition whose reward claim is UNKNOWN is not stored at all. UNKNOWN is absence of evidence, not a reward of zero, so it never enters a TD target.',
 status:'RUNNING',learner,runs};
const save=()=>{if(process.env.AGOD_DQN_REPORT)fs.writeFileSync(process.env.AGOD_DQN_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const note=(name,expectation,observed)=>{learner.push({name,expectation,observed});save();};

try{
 // ---------------- Part A: the learner, with no emulator in sight ----------------
 {// Every parameter's analytic derivative against a central finite difference.
  const rng=Dqn.createRng(7),net=Dqn.createNetwork({inputs:4,hidden:8,actions:3,rng});
  const batch=[{state:Float64Array.from([0.3,-0.2,0.8,1]),action:1,target:0.5},
               {state:Float64Array.from([-0.7,0.9,-0.1,1]),action:2,target:-1.2},
               {state:Float64Array.from([0.1,0.4,0.6,1]),action:0,target:0.3}];
  const analytic=Dqn.gradients(net,batch),base=Dqn.getParameters(net);
  let worst=0;const h=1e-6;
  for(let i=0;i<base.length;i++){
   const up=Float64Array.from(base);up[i]=base[i]+h;Dqn.setParameters(net,up);const a=Dqn.loss(net,batch);
   const down=Float64Array.from(base);down[i]=base[i]-h;Dqn.setParameters(net,down);const b=Dqn.loss(net,batch);
   Dqn.setParameters(net,base);
   worst=Math.max(worst,Math.abs((a-b)/(2*h)-analytic[i]));
  }
  note('analytic gradients vs central finite differences','max error < 1e-6 over every parameter,  '+base.length+' parameters','max error '+worst.toExponential(3));
  assert(worst<1e-6,'hand-written gradients must match finite differences, worst '+worst);
 }
 {// The Double target is not the vanilla target: shown, not asserted by name.
  const rng=Dqn.createRng(3);
  const online=Dqn.createNetwork({inputs:2,hidden:6,actions:3,rng}),targetNet=Dqn.createNetwork({inputs:2,hidden:6,actions:3,rng});
  const transition={state:Float64Array.from([0.2,1]),action:0,reward:-1,
   nextState:Float64Array.from([0.5,1]),done:false};
  const gamma=0.9;
  const double=Dqn.targetValue('double',online,targetNet,transition,gamma);
  const vanilla=Dqn.targetValue('vanilla',online,targetNet,transition,gamma);
  const next=Dqn.qValues(targetNet,transition.nextState);
  const selected=Dqn.argmax(Dqn.qValues(online,transition.nextState));
  note('Double DQN target differs from the vanilla target',
   'the online net selects the action, the target net values it, so a disagreement changes the target',
   'double '+double.toFixed(6)+' (online picked action '+selected+'), vanilla '+vanilla.toFixed(6)+' (target net picked '+Dqn.argmax(next)+')');
  assert.notEqual(double,vanilla,'on a disagreement the two targets must differ');
  assert(vanilla>=double-1e-12,'the vanilla target takes the maximum, so it can never be the smaller of the two');
  assert.equal(double,transition.reward+gamma*next[selected],'the Double target must value the online choice with the target net');
 }
 {// Same seed, same transitions, same weights. Different seed, different weights.
  const build=seed=>{
   const agent=Dqn.createAgent({inputs:3,hidden:8,actions:3,seed,warmup:8,batchSize:8,syncEvery:5});
   for(let i=0;i<40;i++)agent.observe({state:Float64Array.from([i%3/3,(i%5)/5,1]),action:i%3,reward:i%4===0?-1:0,
    nextState:Float64Array.from([(i+1)%3/3,((i+1)%5)/5,1]),done:i%7===0});
   for(let i=0;i<30;i++)agent.train();
   return agent;};
  const a=build(5),b=build(5),c=build(6);
  const same=Array.from(a.parameters()).every((value,i)=>value===b.parameters()[i]);
  const differs=Array.from(a.parameters()).some((value,i)=>value!==c.parameters()[i]);
  note('determinism','identical seed reproduces identical weights; a different seed does not','identical '+same+', differs across seeds '+differs);
  assert(same&&differs);
  assert(a.stats().updates>0&&a.stats().parameterMovement>0,'training must actually move weights');
 }
 {// A checkpoint continues the same run rather than restarting it.
  const make=()=>Dqn.createAgent({inputs:3,hidden:8,actions:3,seed:13,warmup:8,batchSize:8,syncEvery:5});
  const feed=(agent,from,to)=>{for(let i=from;i<to;i++){agent.observe({state:Float64Array.from([i%3/3,(i%7)/7,1]),action:i%3,
    reward:i%3===0?-1:0,nextState:Float64Array.from([(i+1)%3/3,((i+1)%7)/7,1]),done:false});agent.train();}};
  const straight=make();feed(straight,0,60);
  const halted=make();feed(halted,0,30);
  const checkpoint=JSON.parse(JSON.stringify(halted.checkpoint()));
  const resumed=make();resumed.restore(checkpoint);feed(resumed,30,60);
  const identical=Array.from(straight.parameters()).every((value,i)=>Math.abs(value-resumed.parameters()[i])<1e-12);
  note('checkpoint round-trip through JSON','a resumed run ends at the same weights as an uninterrupted one','identical '+identical);
  assert(identical,'a restored checkpoint must continue the same trajectory');
  let threw=null;try{Dqn.createAgent({inputs:4,hidden:8,actions:3,seed:13}).restore(checkpoint);}catch(error){threw=error.message;}
  note('checkpoint shape guard','a checkpoint from another shape is refused',threw||'accepted');
  assert(threw&&/shape/.test(threw));
 }

 // ---------------- Parts B and C: the chain drives the agent ----------------
 for(const seed of seeds){
  const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart,'--oracle-out',orc]);
  const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
  const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  const driver={restore(s){core.fromJSON(JSON.parse(s));},
   run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
   readRam(){return ram();}};
  const startsFrom=(count,offset,tag)=>{const out=[];for(let i=0;i<count;i++){driver.run(0,offset+i*7);
   out.push({id:tag+'-'+i,stateHash:hash(ram()),snapshot:JSON.stringify(core.toJSON())});}return out;};
  const probe=(starts,mask)=>Causal.probeAction(driver,{starts,mask,neutralMask:0,
   alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
  const play=(mask,events)=>{const samples=[];for(let e=0;e<events;e++){driver.run(mask,HOLD);driver.run(0,RELEASE);samples.push(ram());}return samples;};
  const movedIn=samples=>{const out=new Set();
   for(let i=1;i<samples.length;i++)for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])out.add(a);return out;};

  for(let i=0;i<60;i++)core.frame();
  const pristine=JSON.stringify(core.toJSON());

  // 1. Which button does what, and what type is the thing it moves?
  const starts=startsFrom(STARTS,17,'st-'+seed);
  const attributed=new Map();
  for(let bit=0;bit<8;bit++){const mask=1<<bit;attributed.set(mask,probe(starts,mask).confirmed.map(e=>e.address));}
  driver.restore(pristine);const neutralMoved=movedIn(play(0,TYPE_EVENTS));
  let decreasing=null,increasing=null;
  // An address that only moves while the button is held and reverts on release
  // is input plumbing, not game state. Persisting after release is what makes
  // an effect part of play, and that is decidable here without the oracle:
  // E4 had to be handed this scope from outside (limitation C3.3).
  const persistentByMask=new Map();
  for(const [mask,shortAttributed] of attributed){
   if(!shortAttributed.length)continue;
   driver.restore(pristine);const samples=play(mask,TYPE_EVENTS);
   const addresses=[...movedIn(samples)].filter(a=>!neutralMoved.has(a)).sort((a,b)=>a-b);
   persistentByMask.set(mask,addresses);
   for(const span of Ram.spansOf(addresses)){
    const outcome=Ram.identifyField({samples,addresses:span});
    if(outcome.status!=='IDENTIFIED')continue;
    if(outcome.field.direction==='decreasing'&&!decreasing)decreasing={mask,field:outcome.field};
    if(outcome.field.direction==='increasing'&&!increasing)increasing={mask,field:outcome.field};
   }
  }
  assert(decreasing,'seed '+seed+': a decreasing action-driven resource must be found without the oracle');
  assert(increasing,'seed '+seed+': an increasing action-driven counter is needed as the play-effect scope');

  // 2. Induce the goal and verify it through the registry, exactly as AGOD-08.
  const registry=Evidence.createRegistry({romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV});
  const goalId='goal-resource-'+seed,now=1761800000000;
  const readField=(memory,field)=>Ram.decode(memory,{address:field.address,width:field.width,
   endian:field.endian==='n/a'?'little':field.endian,encoding:field.encodingDetermined?field.encoding:'binary'});
  let induced=null;
  for(const part of [{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}]){
   driver.restore(pristine);
   const partStarts=startsFrom(STARTS,part.offset,'st-'+seed+'-'+part.group);
   const negativeProbe=probe(partStarts,decreasing.mask);
   const playScope=persistentByMask.get(increasing.mask)||[];
   const aliveEffects=probe(partStarts,increasing.mask).confirmed.map(e=>e.address);
   driver.restore(partStarts[0].snapshot);
   const track=[readField(ram(),decreasing.field)];
   for(let k=0;k<6;k++){driver.run(decreasing.mask,HOLD);driver.run(0,30);track.push(readField(ram(),decreasing.field));}
   const deadEffects=probe(startsFrom(STARTS,5,'dead-'+seed+'-'+part.group),increasing.mask).confirmed.map(e=>e.address);
   induced=Goals.induceGoal({id:goalId,actionMask:decreasing.mask,address:decreasing.field.address,
    causalConfirmed:negativeProbe.confirmed.some(e=>e.address===decreasing.field.address),
    independentStarts:negativeProbe.independentStarts,resourceTrack:{values:track},
    terminal:{confirmedBeforeDepletion:aliveEffects,confirmedAfterDepletion:deadEffects,scope:playScope}});
   for(const observation of negativeProbe.perStart){
    if(observation.status!=='OBSERVED')continue;
    registry.register({id:'ev-'+seed+'-'+part.group+'-'+observation.startId,goalId,group:part.group,
     parentStateHash:observation.stateHash,restorePath:['pristine','neutral+'+part.offset],
     episodeOrigin:'live',outcome:induced.polarity==='NEGATIVE'?'confirmed':'inconclusive',restored:false,atMs:now});
   }
  }
  const promotion=registry.promote(goalId,{polarity:induced.polarity,polarityEvidenced:induced.verifiable,profileRevision:REV,nowMs:now});
  assert(promotion.verified,'seed '+seed+': the agent must be given a goal the chain verified: '+(promotion.blockers||[]).join('; '));

  // 3. The environment: three actions, one of which is the verified cost.
  const actionMasks=[0,increasing?increasing.mask:0,decreasing.mask];
  const contextKey=descriptor.sha256+'/'+CORE;
  const initialLives=(()=>{driver.restore(pristine);return readField(ram(),decreasing.field);})();
  const features=(lives,lastAction)=>{
   const state=new Float64Array(5);
   state[0]=initialLives>0?lives/initialLives:0;state[1]=lives<=0?1:0;
   if(lastAction>=0)state[2+lastAction]=1;
   return state;};

  const episode=(options)=>{
   const agent=Dqn.createAgent({inputs:5,hidden:24,actions:3,seed:options.agentSeed,
    warmup:48,batchSize:32,syncEvery:40,gamma:0.95,lr:0.003});
   const goal=options.verified
    ?{id:goalId,lifecycle:promotion.lifecycle,polarity:promotion.polarity,evidenceRefs:promotion.evidenceRefs}
    :{id:goalId,lifecycle:'CANDIDATE',polarity:'UNKNOWN'};
   const broker=Reward.createBroker({profileRevision:REV,contextKey});
   let unknownClaims=0,paidClaims=0,event=0;
   const run=(steps,{epsilonFrom,epsilonTo,learn})=>{
    driver.restore(pristine);
    let lives=readField(ram(),decreasing.field),last=-1,chosenNegative=0,livesLost=0,resets=0;
    const actionCounts=[0,0,0];
    for(let step=0;step<steps;step++){
     const epsilon=epsilonFrom+(epsilonTo-epsilonFrom)*(steps<2?1:step/(steps-1));
     const state=features(lives,last);
     const {action}=agent.act(state,epsilon);
     actionCounts[action]++;if(action===2)chosenNegative++;
     driver.run(actionMasks[action],HOLD);driver.run(0,RELEASE);
     const after=readField(ram(),decreasing.field);
     const delta=after-lives;
     if(delta<0)livesLost+=-delta;
     const claim=broker.claim({eventId:'ev-'+seed+'-'+options.agentSeed+'-'+(event++),source:'verified-goal',
      profileRevision:REV,contextKey,goal,
      executedAction:{mask:actionMasks[action],frames:HOLD+RELEASE,complete:true,manualOverride:false},
      requestedMask:actionMasks[action],magnitude:Math.abs(delta),phase:'PLAYING',
      episode:{partition:'holdout'},ageMs:5});
     const terminal=after<=0;
     const nextState=features(after,action);
     if(claim.status==='VERIFIED'){
      paidClaims++;
      if(learn)agent.observe({state,action,reward:claim.value,nextState,done:terminal});
     }else{
      unknownClaims++;
      // Deliberately nothing is stored. UNKNOWN is not a reward of zero.
     }
     if(learn)agent.train();
     lives=after;last=action;
     if(terminal){driver.restore(pristine);lives=readField(ram(),decreasing.field);last=-1;resets++;}
    }
    return {negativeRate:chosenNegative/steps,livesLost,resets,actionCounts};
   };
   const training=run(TRAIN_STEPS,{epsilonFrom:1,epsilonTo:0.05,learn:true});
   const frozen=run(EVAL_STEPS,{epsilonFrom:0,epsilonTo:0,learn:false});
   /* A measured uniform reference, so the comparison does not rest on where an
      untrained argmax happens to land. */
   const random=run(EVAL_STEPS,{epsilonFrom:1,epsilonTo:1,learn:false});
   return {training,frozen,random,stats:agent.stats(),unknownClaims,paidClaims,
    qAtFullResource:agent.qValues(features(initialLives,-1))};
  };

  for(const agentSeed of AGENT_SEEDS){
   const trained=episode({agentSeed,verified:true});
   const control=episode({agentSeed,verified:false});
   const row={seed,romHash:descriptor.sha256,agentSeed,
    discovered:{negativeMask:decreasing.mask,resource:{address:decreasing.field.address,width:decreasing.field.width,step:decreasing.field.step},
     positiveMask:increasing?increasing.mask:null},
    oracleNegativeMask:oracle.negativeMask,negativeMaskCorrect:decreasing.mask===oracle.negativeMask,
    resourceIsLives:decreasing.field.address===oracle.fields.lives.address,
    randomPolicy:{negativeRate:trained.random.negativeRate,livesLost:trained.random.livesLost},
    trained:{negativeRateWhileTraining:trained.training.negativeRate,frozenNegativeRate:trained.frozen.negativeRate,
     frozenActionCounts:trained.frozen.actionCounts,
     frozenLivesLost:trained.frozen.livesLost,updates:trained.stats.updates,syncs:trained.stats.syncs,
     parameterMovement:trained.stats.parameterMovement,paidClaims:trained.paidClaims,unknownClaims:trained.unknownClaims,
     qAtFullResource:trained.qAtFullResource},
    control:{negativeRateWhileTraining:control.training.negativeRate,frozenNegativeRate:control.frozen.negativeRate,
     frozenActionCounts:control.frozen.actionCounts,
     frozenLivesLost:control.frozen.livesLost,updates:control.stats.updates,
     parameterMovement:control.stats.parameterMovement,paidClaims:control.paidClaims,unknownClaims:control.unknownClaims}};
   runs.push(row);save();

   assert(row.trained.updates>0,'seed '+seed+'/'+agentSeed+': the trained agent must perform weight updates');
   assert(row.trained.parameterMovement>0,'seed '+seed+'/'+agentSeed+': weights must move');
   assert.equal(row.control.updates,0,'seed '+seed+'/'+agentSeed+': with no verified goal there is nothing to learn from');
   assert.equal(row.control.parameterMovement,0,'seed '+seed+'/'+agentSeed+': the control must not move a single weight');
   assert.equal(row.control.paidClaims,0,'seed '+seed+'/'+agentSeed+': an unverified goal must never pay out');
   assert(row.control.unknownClaims>0,'seed '+seed+'/'+agentSeed+': the control must have produced UNKNOWN claims');
  }
 }

 const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
 const trainedFrozen=runs.map(r=>r.trained.frozenNegativeRate),controlFrozen=runs.map(r=>r.control.frozenNegativeRate);
 const trainedLost=runs.map(r=>r.trained.frozenLivesLost),controlLost=runs.map(r=>r.control.frozenLivesLost);
 result.totals={cartridges:seeds.length,agentSeeds:AGENT_SEEDS.length,runs:runs.length,
  negativeMaskFoundWithoutOracle:runs.filter(r=>r.negativeMaskCorrect).length,
  resourceIsLives:runs.filter(r=>r.resourceIsLives).length,
  frozenNegativeRateTrained:mean(trainedFrozen),frozenNegativeRateControl:mean(controlFrozen),
  frozenNegativeRateRandomPolicy:mean(runs.map(r=>r.randomPolicy.negativeRate)),
  frozenLivesLostRandomPolicy:mean(runs.map(r=>r.randomPolicy.livesLost)),
  /* The informative cases: the untrained policy did choose the penalised
     action and training moved it away. */
  runsWhereControlChoseNegativeAndTrainedDidNot:runs.filter(r=>r.control.frozenNegativeRate>0&&r.trained.frozenNegativeRate===0).length,
  runsWhereControlChoseNegative:runs.filter(r=>r.control.frozenNegativeRate>0).length,
  untrainedPolicyIsCartridgeIndependent:'the control never updates and the features are identical across cartridges, so its effective sample size is the number of agent seeds, not the number of runs',
  frozenLivesLostTrained:mean(trainedLost),frozenLivesLostControl:mean(controlLost),
  runsWhereTrainedAvoidsMore:runs.filter(r=>r.trained.frozenNegativeRate<r.control.frozenNegativeRate).length,
  runsWhereTrainedIsWorse:runs.filter(r=>r.trained.frozenNegativeRate>r.control.frozenNegativeRate).length,
  controlWeightUpdates:runs.reduce((sum,r)=>sum+r.control.updates,0),
  learnerChecks:learner.length};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,learner,runs}));
 console.log('PASS: gradients match finite differences, the Double target is not the vanilla one, checkpoints continue the same run; frozen penalised-action rate '+
  result.totals.frozenNegativeRateTrained.toFixed(3)+' trained vs '+result.totals.frozenNegativeRateControl.toFixed(3)+
  ' control, with 0 weight updates in the control. Real games, blind corpus and Android remain untested.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
