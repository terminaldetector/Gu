'use strict';
// S6: baselines under one budget, with discovery quality and algorithm quality
// as separate factors.
//
// Independent samples are TASKS and START STATES, not repetitions of identical
// dynamics: three families with genuinely different game logic, two cartridges
// each, two independent start states per cartridge. Every arm gets the same
// action space, the same observation space, the same number of environment
// steps and the same update budget, and is evaluated frozen from the same
// starts.
//
// The two factors are crossed on purpose:
//   reward source  discovered (through the pipeline and the broker) versus
//                  oracle (the closed label, an upper bound) versus
//                  provisional (an S4b hypothesis used as reward, which the
//                  contract forbids - measured to show what it would buy)
//   algorithm      vanilla DQN target versus Double DQN target
// so "the discovery was wrong" and "the learner was weak" cannot be confused.
//
// Legacy FDB is NOT run, and the report says so rather than substituting
// something and calling it FDB: the Java LIF backend takes a graph and layer
// inputs, not this four-action RAM-feature space, and the translation layer
// does not exist.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Positive=require('../app/src/main/assets/lab/agod-positive.js'),
      Reward=require('../app/src/main/assets/lab/agod-reward.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Dqn=require('../app/src/main/assets/lab/agod-dqn.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-baselines-'));
const SEEDS=[0,1],STARTS=2,HOLD=4,RELEASE=8,SETTLE=30;
const TRAIN_STEPS=300,EVAL_STEPS=60,AGENT_SEED=11;
const REV='profile-rev-1',CORE='jsnes-nes';
const FAMILIES=[
 {name:'survival',generator:'make_agod_test_rom.py',outcome:'lives',direction:-1},
 {name:'sacrifice',generator:'make_agod_sacrifice_rom.py',outcome:'treasure',direction:1},
 {name:'rate-trap',generator:'make_agod_rate_trap_rom.py',outcome:'steadyGain',direction:1}];
const ARMS=[
 {id:'no-op',kind:'fixed'},
 {id:'random',kind:'fixed'},
 {id:'safety-heuristic',kind:'fixed'},
 {id:'vanilla-dqn/discovered',kind:'learn',target:'vanilla',reward:'discovered'},
 {id:'double-dqn/discovered',kind:'learn',target:'double',reward:'discovered'},
 {id:'vanilla-dqn/oracle',kind:'learn',target:'vanilla',reward:'oracle'},
 {id:'double-dqn/oracle',kind:'learn',target:'double',reward:'oracle'},
 {id:'double-dqn/provisional',kind:'learn',target:'double',reward:'provisional'}];
const runs=[],tasks=[];
const result={type:'gu-agod-baselines-check',version:1,
 scope:'host emulator; 3 families x 2 cartridges x 2 independent start states = 12 (task, start) pairs',
 budget:'identical for every arm: same 4-action space, same 6 features, '+TRAIN_STEPS+' training steps, '+EVAL_STEPS+' frozen evaluation steps, same update budget',
 statistics:'counted over tasks and start states, not over repetitions of identical dynamics',
 legacyFdb:'not run: the Java LIF backend takes graph and layer inputs, not this action and observation space, and no translation layer exists. Reported as not run rather than substituted.',
 oracleUse:'the oracle is read only by the declared upper-bound arm and for scoring; objective discovery never sees it',
 status:'RUNNING',tasks,runs};
const save=()=>{if(process.env.AGOD_BASELINES_REPORT)fs.writeFileSync(process.env.AGOD_BASELINES_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};

function cartridge(generator,seed){
 const cart=path.join(directory,generator+'-'+seed+'.json'),orc=path.join(directory,generator+'-'+seed+'-o.json');
 execFileSync(process.env.PYTHON||'python3',['tools/'+generator,'--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart));
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {descriptor,driver,oraclePath:orc};
}
const decodeField=(memory,field)=>Ram.decode(memory,{address:field.address,width:field.width,
 endian:field.endian==='little'||field.endian==='big'?field.endian:'little',
 encoding:field.encodingDetermined===false?'binary':(field.encoding==='bcd'?'bcd':'binary')});

try{
 for(const family of FAMILIES){
  for(const seed of SEEDS){
   const {descriptor,driver,oraclePath}=cartridge(family.generator,seed);
   const boot=driver.snapshot();

   // ---- discovery, with no oracle anywhere near it ----
   const piped=Pipeline.run(driver,{romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV,
    contextKey:descriptor.sha256+'/'+CORE,nowMs:1761800000000});
   const discovered=piped.discovered;
   assert(discovered,family.name+'/'+seed+': discovery must report its findings');
   const costMask=discovered.resource.mask;
   const otherMasks=discovered.persistingByMask.map(entry=>entry.mask)
    .filter(mask=>mask!==costMask&&mask!==discovered.effect.mask);
   const masks=[0,discovered.effect.mask,costMask,otherMasks.length?otherMasks[0]:discovered.effect.mask];

   // A provisional hypothesis for the contract-violating arm.
   let provisional=null;
   for(const candidate of discovered.increasingFields){
    driver.restore(boot);
    const proposal=Positive.proposePositive(driver,{candidate,candidateMask:candidate.mask,
     resource:discovered.resource,resourceMask:costMask,
     modulators:[...discovered.increasingFields.map(f=>({field:f,mask:f.mask})),
      {field:discovered.resource,mask:costMask}],
     pristine:boot,neutralMoved:new Set(discovered.neutralMovedAddresses),
     hold:HOLD,release:RELEASE,settle:SETTLE});
    if(proposal.status==='PROVISIONAL_GOAL'){provisional=candidate;break;}
   }

   // Independent start states: different neutral advances, recorded by hash.
   driver.restore(boot);
   const starts=[];
   for(let i=0;i<STARTS;i++){driver.run(0,23+i*31);starts.push({id:'start-'+i,hash:driver.stateHash(),snapshot:driver.snapshot()});}
   assert.equal(new Set(starts.map(s=>s.hash)).size,STARTS,'start states must be distinct');

   // ---- only now the oracle, for the upper-bound arm and for scoring ----
   const oracle=JSON.parse(fs.readFileSync(oraclePath));
   const outcomeField=oracle.fields[family.outcome];
   const labelledField=oracle.positiveLabel.anyFieldDemonstrablyBeneficial
    ?oracle.fields[oracle.positiveLabel.field]:null;
   tasks.push({family:family.name,seed,romHash:descriptor.sha256,
    pipeline:piped.status,pipelineStage:piped.stage,
    verifiedRewardAvailable:piped.status==='VERIFIED',
    costMask,effectMask:discovered.effect.mask,masks,
    provisionalField:provisional?{address:provisional.address,mask:provisional.mask}:null,
    provisionalIsLabelledField:!!(provisional&&labelledField&&
     spanOf(provisional).some(a=>spanOf(labelledField).includes(a))),
    outcomeField:{name:family.outcome,address:outcomeField.address},
    startHashes:starts.map(s=>s.hash.slice(0,12))});save();

   const readResource=()=>decodeField(driver.readRam(),discovered.resource);
   const readOutcome=()=>decodeField(driver.readRam(),outcomeField);
   const readProvisional=()=>provisional?decodeField(driver.readRam(),provisional):0;
   const features=(resource,last,initial)=>{
    const state=new Float64Array(6);
    state[0]=initial>0?resource/initial:0;state[1]=resource<=0?1:0;
    if(last>=0)state[2+last]=1;return state;};

   for(const arm of ARMS){
    for(const start of starts){
     const broker=Reward.createBroker({profileRevision:REV,contextKey:descriptor.sha256+'/'+CORE});
     const agent=arm.kind==='learn'?Dqn.createAgent({inputs:6,hidden:24,actions:4,seed:AGENT_SEED,
      warmup:24,batchSize:32,syncEvery:40,gamma:0.95,lr:0.003,targetMode:arm.target}):null;
     let event=0,paid=0,unknown=0,stored=0;
     const episode=(steps,{epsilon,learn})=>{
      driver.restore(start.snapshot);
      const initial=Math.max(1,readResource());
      let resource=readResource(),last=-1,costChosen=0;
      const startOutcome=readOutcome();
      let heuristicTick=0;
      for(let step=0;step<steps;step++){
       let action;
       if(arm.id==='no-op')action=0;
       else if(arm.id==='random')action=step*7%4;
       else if(arm.id==='safety-heuristic'){
        /* Hand-written, no learning: never take the action discovery flagged as
           the cost, cycle over the rest. */
        const allowed=[0,1,3].filter(index=>masks[index]!==costMask);
        action=allowed[heuristicTick++%allowed.length];
       }
       else action=agent.act(features(resource,last,initial),epsilon).action;
       if(masks[action]===costMask)costChosen++;
       const before=features(resource,last,initial);
       const provisionalBefore=readProvisional(),outcomeBefore=readOutcome();
       driver.run(masks[action],HOLD);driver.run(0,RELEASE);
       const after=readResource(),delta=after-resource;
       const terminal=after<=0;
       const next=features(after,action,initial);
       if(arm.kind==='learn'&&learn){
        let reward=null;
        if(arm.reward==='discovered'){
         const claim=broker.claim({eventId:'e'+(event++),source:'verified-goal',profileRevision:REV,
          contextKey:descriptor.sha256+'/'+CORE,
          goal:piped.status==='VERIFIED'?piped.goal:{id:'none',lifecycle:'CANDIDATE',polarity:'UNKNOWN'},
          executedAction:{mask:masks[action],frames:HOLD+RELEASE,complete:true,manualOverride:false},
          requestedMask:masks[action],magnitude:Math.abs(delta),phase:'PLAYING',
          episode:{partition:'holdout'},ageMs:5});
         if(claim.status==='VERIFIED'){paid++;reward=claim.value;}else unknown++;
        }else if(arm.reward==='oracle'){
         reward=family.direction*(readOutcome()-outcomeBefore);
         if(reward===0)reward=null;      /* nothing observed, nothing stored */
        }else if(arm.reward==='provisional'){
         reward=readProvisional()-provisionalBefore;
         if(reward===0)reward=null;
        }
        if(reward!==null){agent.observe({state:before,action,reward,nextState:next,done:terminal});stored++;}
        agent.train();
       }
       resource=after;last=action;
       if(terminal){driver.restore(start.snapshot);resource=readResource();last=-1;}
      }
      return {costRate:costChosen/steps,outcomeGain:readOutcome()-startOutcome};
     };
     if(arm.kind==='learn')episode(TRAIN_STEPS,{epsilon:1,learn:true});
     const frozen=episode(EVAL_STEPS,{epsilon:0,learn:false});
     runs.push({family:family.name,seed,start:start.id,arm:arm.id,
      target:arm.target||null,rewardSource:arm.reward||null,
      frozenOutcomeGain:frozen.outcomeGain,frozenCostRate:frozen.costRate,
      updates:agent?agent.stats().updates:0,storedTransitions:stored,
      paidClaims:paid,unknownClaims:unknown});save();
    }
   }
  }
 }

 // ---- per task, rank the arms by that task's own outcome measure ----
 const key=r=>r.family+'/'+r.seed+'/'+r.start;
 const pairs=[...new Set(runs.map(key))];
 const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
 const ranksByArm={};
 for(const pair of pairs){
  const rows=runs.filter(r=>key(r)===pair);
  const sorted=[...rows].sort((a,b)=>b.frozenOutcomeGain-a.frozenOutcomeGain);
  sorted.forEach((row,index)=>{(ranksByArm[row.arm]=ranksByArm[row.arm]||[]).push(index+1);});
 }
 const perArm=ARMS.map(arm=>{
  const rows=runs.filter(r=>r.arm===arm.id);
  const byFamily={};
  for(const family of FAMILIES)
   byFamily[family.name]=mean(rows.filter(r=>r.family===family.name).map(r=>r.frozenOutcomeGain));
  return {arm:arm.id,target:arm.target||null,rewardSource:arm.reward||null,
   meanRank:mean(ranksByArm[arm.id]||[]),
   outcomeByFamily:byFamily,
   meanCostRate:mean(rows.map(r=>r.frozenCostRate)),
   meanUpdates:mean(rows.map(r=>r.updates)),
   meanStoredTransitions:mean(rows.map(r=>r.storedTransitions))};
 });
 const arm=id=>perArm.find(row=>row.arm===id);
 result.totals={independentPairs:pairs.length,tasks:tasks.length,arms:ARMS.length,
  perArm,
  tasksWithVerifiedReward:tasks.filter(t=>t.verifiedRewardAvailable).length,
  tasksWithoutVerifiedReward:tasks.filter(t=>!t.verifiedRewardAvailable).length,
  provisionalMatchedLabelledField:tasks.filter(t=>t.provisionalIsLabelledField).length,
  provisionalProposedAtAll:tasks.filter(t=>t.provisionalField).length,
  discoveryEffect:'compare the discovered arms with the oracle arms at the same target',
  algorithmEffect:'compare vanilla with double at the same reward source',
  legacyFdbRun:false};
 save();

 assert.equal(arm('double-dqn/discovered').meanStoredTransitions===0,false,
  'the discovered arm must learn on at least one task, or the comparison is empty');
 assert(arm('no-op').meanUpdates===0&&arm('random').meanUpdates===0,'fixed arms must not train');
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,tasks,runs}));
 console.log('PASS: '+pairs.length+' independent (task, start) pairs across 3 families under one budget. '+
  'Verified reward was available on '+result.totals.tasksWithVerifiedReward+' of '+tasks.length+' tasks. '+
  'Legacy FDB not run, and reported as not run.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
