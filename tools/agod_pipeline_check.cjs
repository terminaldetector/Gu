'use strict';
// E6 + E7: the integrated pipeline, and the first run on cartridges it was
// never developed against.
//
// HELD-OUT RULE, fixed before the first run of this file and not changed
// afterwards: the seven consecutive cartridge seeds 200..206. Nothing in this
// repository had been generated from them, no stage was tuned on them, and no
// parameter is per-cartridge. Whatever they produce is reported, including a
// refusal. TZ 18 forbids changing the oracle after seeing results, and the
// same applies to the seed list.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Dqn=require('../app/src/main/assets/lab/agod-dqn.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-pipeline-'));
const DEVELOPMENT_SEEDS=[0,1,2,7,8,9,47];
const HELDOUT_SEEDS=[200,201,202,203,204,205,206];
const AGENT_SEEDS=[11,29,37],TRAIN_STEPS=400,EVAL_STEPS=60;
const REV='profile-rev-1',CORE='jsnes-nes',HOLD=4,RELEASE=8;
const pipelineRuns=[],agentRuns=[];
const result={type:'gu-agod-pipeline-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 heldOutRule:'seeds 200..206, seven consecutive integers fixed before the first run of this check; never used to develop or tune any stage',
 oracle:'checker-only: read after the pipeline has committed its answer',
 claim:'The integrated pipeline either returns a VERIFIED goal or names the stage that refused. On cartridges it was never developed against it does the same thing it does on the development set, and an agent trained on its reward avoids the cost it found.',
 status:'RUNNING',pipelineRuns,agentRuns};
const save=()=>{if(process.env.AGOD_PIPELINE_REPORT)fs.writeFileSync(process.env.AGOD_PIPELINE_REPORT,JSON.stringify(result,null,2)+'\n');};save();

function cartridge(seed){
 const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
 execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {descriptor,oracle,driver};
}

try{
 for(const group of [{name:'development',seeds:DEVELOPMENT_SEEDS,agent:false},
                     {name:'held-out',seeds:HELDOUT_SEEDS,agent:true}]){
  for(const seed of group.seeds){
   const {descriptor,oracle,driver}=cartridge(seed);
   // The pipeline's last act is depleting the resource, so it leaves the
   // machine dead. The agent arm must start from the booted state instead.
   const boot=driver.snapshot();
   const outcome=Pipeline.run(driver,{romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV,
    contextKey:descriptor.sha256+'/'+CORE,nowMs:1761800000000});
   // Only now is the oracle opened.
   const verified=outcome.status==='VERIFIED';
   const row={group:group.name,seed,romHash:descriptor.sha256,
    status:outcome.status,stage:outcome.stage,reason:outcome.reason,
    oracle:{negativeMask:oracle.negativeMask,positiveMask:oracle.positiveMask,
     lives:oracle.fields.lives,score:{address:oracle.fields.score.address,width:oracle.fields.score.width,
      format:oracle.fields.score.format,endian:oracle.fields.score.endian}},
    found:verified?{costMask:outcome.actions.cost,effectMask:outcome.actions.effect,
     resource:{address:outcome.resource.address,width:outcome.resource.width,
      encoding:outcome.resource.encoding,step:outcome.resource.step}}:null,
    costMaskCorrect:verified&&outcome.actions.cost===oracle.negativeMask,
    resourceIsLives:verified&&outcome.resource.address===oracle.fields.lives.address,
    // Informational, not a correctness criterion: the pipeline looks for any
    // persisting increasing effect to use as a play-effect scope, and the level
    // counter serves that purpose as well as the score does.
    effectMaskIsScoreButton:verified&&outcome.actions.effect===oracle.positiveMask,
    refusals:outcome.refusals,traceStages:outcome.trace.length};
   pipelineRuns.push(row);save();

   if(!verified||!group.agent)continue;

   // The agent arm: the only reward it can ever receive is the one this
   // pipeline verified, through this pipeline's broker.
   for(const agentSeed of AGENT_SEEDS){
    const agent=Dqn.createAgent({inputs:5,hidden:24,actions:3,seed:agentSeed,
     warmup:48,batchSize:32,syncEvery:40,gamma:0.95,lr:0.003});
    const masks=[0,outcome.actions.effect,outcome.actions.cost];
    driver.restore(boot);
    const pristine=driver.snapshot();
    const initial=outcome.readResource(driver.readRam());
    assert(initial>0,'seed '+seed+': the agent must start from a live state, resource read '+initial);
    const features=(value,last)=>{const state=new Float64Array(5);
     state[0]=initial>0?value/initial:0;state[1]=value<=0?1:0;
     if(last>=0)state[2+last]=1;return state;};
    let event=0,paid=0,unknown=0;
    const arm=(steps,{epsilonFrom,epsilonTo,learn})=>{
     driver.restore(pristine);
     let value=outcome.readResource(driver.readRam()),last=-1,cost=0,lost=0;
     const counts=[0,0,0];
     for(let step=0;step<steps;step++){
      const epsilon=epsilonFrom+(epsilonTo-epsilonFrom)*(steps<2?1:step/(steps-1));
      const state=features(value,last);
      const {action}=agent.act(state,epsilon);
      counts[action]++;if(action===2)cost++;
      driver.run(masks[action],HOLD);driver.run(0,RELEASE);
      const after=outcome.readResource(driver.readRam()),delta=after-value;
      if(delta<0)lost+=-delta;
      const claim=outcome.broker.claim({eventId:'ev-'+seed+'-'+agentSeed+'-'+(event++),
       source:'verified-goal',profileRevision:REV,contextKey:descriptor.sha256+'/'+CORE,
       goal:outcome.goal,executedAction:{mask:masks[action],frames:HOLD+RELEASE,complete:true,manualOverride:false},
       requestedMask:masks[action],magnitude:Math.abs(delta),phase:'PLAYING',
       episode:{partition:'holdout'},ageMs:5});
      const terminal=after<=0;
      if(claim.status==='VERIFIED'){paid++;if(learn)agent.observe({state,action,reward:claim.value,
       nextState:features(after,action),done:terminal});}
      else unknown++;   /* UNKNOWN is stored nowhere: it is not a reward of zero. */
      if(learn)agent.train();
      value=after;last=action;
      if(terminal){driver.restore(pristine);value=outcome.readResource(driver.readRam());last=-1;}
     }
     return {costRate:cost/steps,lost,counts};
    };
    arm(TRAIN_STEPS,{epsilonFrom:1,epsilonTo:0.05,learn:true});
    const frozen=arm(EVAL_STEPS,{epsilonFrom:0,epsilonTo:0,learn:false});
    const q=agent.qValues(features(initial,-1));
    assert(paid>0,'seed '+seed+'/'+agentSeed+': a run with no payout teaches nothing, and its cost rate means nothing');
    agentRuns.push({seed,agentSeed,initialResource:initial,frozenCostRate:frozen.costRate,frozenLost:frozen.lost,
     frozenActionCounts:frozen.counts,updates:agent.stats().updates,paidClaims:paid,unknownClaims:unknown,
     qAtFullResource:q,costActionHasLowestQ:q[2]===Math.min(...q)});save();
   }
  }
 }

 const group=name=>pipelineRuns.filter(row=>row.group===name);
 const summarise=name=>{const rows=group(name);return {
  cartridges:rows.length,verified:rows.filter(r=>r.status==='VERIFIED').length,
  costMaskCorrect:rows.filter(r=>r.costMaskCorrect).length,
  resourceIsLives:rows.filter(r=>r.resourceIsLives).length,
  effectMaskIsScoreButton:rows.filter(r=>r.effectMaskIsScoreButton).length,
  refusedStages:rows.filter(r=>r.status!=='VERIFIED').map(r=>r.stage+': '+r.reason)};};
 const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
 result.totals={development:summarise('development'),heldOut:summarise('held-out'),
  agent:{runs:agentRuns.length,agentSeeds:AGENT_SEEDS.length,
   paidClaims:agentRuns.reduce((sum,r)=>sum+r.paidClaims,0),
   frozenCostRate:mean(agentRuns.map(r=>r.frozenCostRate)),
   frozenLivesLost:mean(agentRuns.map(r=>r.frozenLost)),
   runsWhereCostActionHasLowestQ:agentRuns.filter(r=>r.costActionHasLowestQ).length,
   runsWithoutWeightUpdates:agentRuns.filter(r=>r.updates===0).length}};
 save();

 const dev=result.totals.development,held=result.totals.heldOut;
 assert.equal(dev.verified,dev.cartridges,'the refactored pipeline must still verify every development cartridge');
 assert.equal(dev.costMaskCorrect,dev.cartridges,'development: the cost action must still be the right one');
 assert.equal(held.verified,held.cartridges,'held-out cartridges must be handled without tuning: '+held.refusedStages.join('; '));
 assert.equal(held.costMaskCorrect,held.cartridges,'held-out: the cost action must be the right one');
 assert.equal(held.resourceIsLives,held.cartridges,'held-out: the depleting resource must be the lives field');
 assert.equal(result.totals.agent.frozenCostRate,0,'held-out: a trained agent must not choose the cost action');
 assert.equal(result.totals.agent.frozenLivesLost,0,'held-out: a trained agent must lose no lives under frozen evaluation');
 assert.equal(result.totals.agent.runsWithoutWeightUpdates,0,'every held-out agent run must have trained');

 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,pipelineRuns,agentRuns}));
 console.log('PASS: the integrated pipeline verified '+held.verified+'/'+held.cartridges+
  ' held-out cartridges (seeds 200..206, never used in development) with the right cost action and resource, and agents trained only on its reward chose the cost action at rate '+
  result.totals.agent.frozenCostRate.toFixed(3)+' with Q(cost) lowest in '+result.totals.agent.runsWhereCostActionHasLowestQ+'/'+agentRuns.length+
  ' runs. Same generator family; real games, Android and an independent oracle remain untested.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
