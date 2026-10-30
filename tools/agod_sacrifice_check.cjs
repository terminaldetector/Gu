'use strict';
// S3: a fact is not a judgement.
//
// The sacrifice family (tools/make_agod_sacrifice_rom.py) presents the exact
// chain E4 reads as harm - monotone decrease, a floor, confirmed effects ceasing
// there - on an action that is REQUIRED for progress. Three questions, in order:
//
//   1. Does the old rule mislabel it? (it should, or the family is not adversarial)
//   2. Does the split refuse to label it, naming which discriminator refused?
//   3. Does the split still label the survival family, so it is not just "refuse
//      everything"?
//
// And then the part that decides whether any of this matters: what the mislabel
// costs in behaviour, measured as treasure collected by an agent trained on it.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Dqn=require('../app/src/main/assets/lab/agod-dqn.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-sacrifice-'));
const SEEDS=[0,1,2,3,4,5,6];
const FRAMES=12,SHIFT=3,STARTS=2,HOLD=4,RELEASE=8,SETTLE=30;
const REV='profile-rev-1',CORE='jsnes-nes';
const BEHAVIOUR_SEEDS=[11,29,37],TRAIN_STEPS=400,EVAL=60;
const families=[],behaviour=[];
const result={type:'gu-agod-sacrifice-check',version:1,
 scope:'host emulator; two independent controlled families - survival (make_agod_test_rom.py) and sacrifice (make_agod_sacrifice_rom.py)',
 oracle:'checker-only, read after every verdict; the sacrifice oracle carries closed judgement labels that no stage sees',
 claim:'Terminal resource depletion is a fact. Treating it as harm is a judgement that needs its own evidence, and on a cartridge where the resource must be spent to progress the old rule gets it wrong.',
 status:'RUNNING',families,behaviour};
const save=()=>{if(process.env.AGOD_SACRIFICE_REPORT)fs.writeFileSync(process.env.AGOD_SACRIFICE_REPORT,JSON.stringify(result,null,2)+'\n');};save();

function cartridge(generator,seed){
 const cart=path.join(directory,generator+'-'+seed+'.json'),orc=path.join(directory,generator+'-'+seed+'-oracle.json');
 execFileSync(process.env.PYTHON||'python3',['tools/'+generator,'--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {descriptor,oracle,driver,core};
}
const decode=(memory,field)=>Ram.decode(memory,{address:field.address,width:field.width,
 endian:field.endian==='little'||field.endian==='big'?field.endian:'little',encoding:'binary'});

try{
 for(const family of [
  {name:'survival',generator:'make_agod_test_rom.py',resource:'lives',costMask:o=>o.negativeMask,gain:'score'},
  {name:'sacrifice',generator:'make_agod_sacrifice_rom.py',resource:'charges',costMask:o=>o.spendMask,gain:'treasure'}]){
  for(const seed of SEEDS){
   const {descriptor,oracle,driver}=cartridge(family.generator,seed);
   const boot=driver.snapshot();

   // --- the old rule, called exactly as E4 called it: no judgement evidence ---
   const starts=[];
   for(let i=0;i<STARTS;i++){driver.run(0,17+i*13);starts.push({id:'s'+i,stateHash:driver.stateHash(),snapshot:driver.snapshot()});}
   const probe=mask=>Causal.probeAction(driver,{starts,mask,neutralMask:0,
    alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
   const costMask=family.costMask(oracle),gainMask=family.name==='survival'?oracle.positiveMask:oracle.actMask;
   const resourceField=oracle.fields[family.resource],gainField=oracle.fields[family.gain];
   // The play scope is derived exactly as the pipeline derives it: moved by the
   // action over a long horizon AND not moved by neutral play. Filtering only
   // by the neutral run keeps the input echo, which never stops, and that is
   // the E4 mistake this check must not repeat.
   const movedUnder=mask=>{driver.restore(boot);const seen=new Set();let previous=driver.readRam();
    for(let i=0;i<40;i++){driver.run(mask,HOLD);driver.run(0,RELEASE);const now=driver.readRam();
     for(let a=0;a<now.length;a++)if(now[a]!==previous[a])seen.add(a);previous=now;}return seen;};
   const neutralMoved=movedUnder(0),gainPersisting=movedUnder(gainMask);
   const persisting=a=>gainPersisting.has(a)&&!neutralMoved.has(a);
   driver.restore(boot);
   const aliveEffects=probe(gainMask).confirmed.map(entry=>entry.address).filter(persisting);
   const costEffects=probe(costMask).confirmed.map(entry=>entry.address);
   driver.restore(boot);
   const track=[decode(driver.readRam(),resourceField)];
   for(let pulse=0;pulse<6;pulse++){driver.run(costMask,HOLD);driver.run(0,SETTLE);track.push(decode(driver.readRam(),resourceField));}
   const deadStarts=[];
   for(let i=0;i<STARTS;i++){driver.run(0,5+i*7);deadStarts.push({id:'d'+i,stateHash:driver.stateHash(),snapshot:driver.snapshot()});}
   const deadEffects=Causal.probeAction(driver,{starts:deadStarts,mask:gainMask,neutralMask:0,
    alternativeMask:gainMask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT}).confirmed.map(e=>e.address).filter(persisting);
   const terminal={confirmedBeforeDepletion:aliveEffects,confirmedAfterDepletion:deadEffects,scope:aliveEffects};
   const oldRule=Goals.induceGoal({id:'old-'+family.name+'-'+seed,actionMask:costMask,address:resourceField.address,
    causalConfirmed:costEffects.some(a=>a===resourceField.address),independentStarts:STARTS,
    resourceTrack:{values:track},terminal});

   // --- the pipeline with the split ---
   driver.restore(boot);
   const piped=Pipeline.run(driver,{romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV,
    contextKey:descriptor.sha256+'/'+CORE,nowMs:1761800000000});
   const judge=piped.trace.filter(entry=>entry.stage==='judge').pop()||null;

   const row={family:family.name,seed,romHash:descriptor.sha256,
    resourceTrack:track,
    oldRule:{polarity:oldRule.polarity,verifiable:oldRule.verifiable,depletionFact:oldRule.depletionFact},
    pipeline:{status:piped.status,stage:piped.stage,reason:piped.reason},
    judgeTrace:judge,
    refusalBlockers:piped.status==='REFUSED'?(piped.refusals[piped.refusals.length-1].blockers||null):null,
    closedLabel:family.name==='sacrifice'?oracle.judgement.negativeGameReward:true};
   families.push(row);save();

   // The family is only adversarial if the old rule actually falls for it.
   assert.equal(oldRule.depletionFact,'TERMINAL_RESOURCE_DEPLETION',
    family.name+'/'+seed+': the depletion fact must be observable in both families');
   assert.equal(oldRule.polarity,'NEGATIVE',
    family.name+'/'+seed+': the old rule must read this chain as NEGATIVE, otherwise there is nothing to fix');
   if(family.name==='survival'){
    assert.equal(piped.status,'VERIFIED',
     'survival/'+seed+': the split must still verify a real cost, not refuse everything: '+piped.reason);
    assert.equal(piped.judgement.judgement,'NEGATIVE_GAME_REWARD');
    assert.equal(piped.actions.cost,oracle.negativeMask);
   }else{
    assert.equal(piped.status,'REFUSED','sacrifice/'+seed+': the split must refuse to call a required action harmful');
    assert.equal(piped.stage,'judge','sacrifice/'+seed+': the refusal must come from the judgement, not from an earlier stage');
    assert(row.refusalBlockers&&row.refusalBlockers.length,'the refusal must name which discriminator withheld the verdict');
   }
  }
 }

 // ---------------- What the mislabel costs in behaviour ----------------
 // An agent trained on the mislabelled NEGATIVE reward learns to avoid the very
 // action the game requires. Measured against a random policy and against a
 // spend-then-act reference on the same cartridge and the same budget.
 for(const seed of [0,1,2]){
  const {oracle,driver}=cartridge('make_agod_sacrifice_rom.py',seed);
  const boot=driver.snapshot();
  // Four actions, so the agent can run the cycle itself. Note what the optimum
  // actually is on this cartridge: spending the LAST charge closes the gate and
  // stops all earning, so the best play is partial sacrifice - spend down to one
  // charge, then farm at the higher rate. That gives a three-way ordering:
  // spend-nothing (+1 per act) < partial sacrifice (+3 per act), and
  // spend-everything earns nothing at all.
  const masks=[0,oracle.actMask,oracle.spendMask,oracle.restartMask];
  const charges=oracle.fields.charges,treasure=oracle.fields.treasure;
  const read=field=>decode(driver.readRam(),field);
  const features=(c,last)=>{const state=new Float64Array(6);
   state[0]=c/oracle.chargesStart;state[1]=c<=0?1:0;if(last>=0)state[2+last]=1;return state;};
  const episode=(agent,steps,{epsilon,learn,policy})=>{
   driver.restore(boot);
   let c=read(charges),last=-1,spends=0;
   const start=read(treasure);
   for(let step=0;step<steps;step++){
    let action;
    if(policy==='cycling')action=step%4;
    else if(policy==='partial-sacrifice')action=read(charges)>1?2:1;
    else if(policy==='spend-everything')action=read(charges)>0?2:1;
    else action=agent.act(features(c,last),epsilon).action;
    if(action===2)spends++;
    driver.run(masks[action],HOLD);driver.run(0,RELEASE);
    const after=read(charges),delta=after-c;
    if(agent&&learn&&delta<0)
     // The mislabelled reward: the pipeline would never emit this, which is the
     // point; it is injected here to measure what believing it would cost.
     agent.observe({state:features(c,last),action,reward:-Math.abs(delta),
      nextState:features(after,action),done:after<=0});
    if(agent&&learn)agent.train();
    c=after;last=action;
   }
   return {treasure:read(treasure)-start,spends};
  };
  for(const agentSeed of BEHAVIOUR_SEEDS){
   const agent=Dqn.createAgent({inputs:6,hidden:24,actions:4,seed:agentSeed,
    warmup:24,batchSize:32,syncEvery:40,gamma:0.95,lr:0.003});
   const rounds=Math.round(TRAIN_STEPS/EVAL);
   for(let i=0;i<rounds;i++)episode(agent,EVAL,{epsilon:1-0.95*i/rounds,learn:true});
   const trained=episode(agent,EVAL,{epsilon:0,learn:false});
   const cycling=episode(null,EVAL,{policy:'cycling'});
   const partial=episode(null,EVAL,{policy:'partial-sacrifice'});
   const everything=episode(null,EVAL,{policy:'spend-everything'});
   behaviour.push({seed,agentSeed,
    trainedOnMislabel:{treasure:trained.treasure,spends:trained.spends,updates:agent.stats().updates},
    cyclingPolicy:{treasure:cycling.treasure,spends:cycling.spends},
    partialSacrifice:{treasure:partial.treasure,spends:partial.spends},
    spendEverything:{treasure:everything.treasure,spends:everything.spends}});save();
   assert(agent.stats().updates>0,'the behaviour arm must have trained on something');
  }
 }

 const group=name=>families.filter(row=>row.family===name);
 const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
 result.totals={
  cartridgesPerFamily:SEEDS.length,
  survival:{oldRuleNegative:group('survival').filter(r=>r.oldRule.polarity==='NEGATIVE').length,
   pipelineVerified:group('survival').filter(r=>r.pipeline.status==='VERIFIED').length},
  sacrifice:{depletionFactObserved:group('sacrifice').filter(r=>r.oldRule.depletionFact==='TERMINAL_RESOURCE_DEPLETION').length,
   oldRuleMislabelledAsNegative:group('sacrifice').filter(r=>r.oldRule.polarity==='NEGATIVE').length,
   pipelineRefusedAtJudge:group('sacrifice').filter(r=>r.pipeline.status==='REFUSED'&&r.pipeline.stage==='judge').length,
   closedLabelSaysNegative:group('sacrifice').filter(r=>r.closedLabel===true).length},
  behaviour:{runs:behaviour.length,
   treasureTrainedOnMislabel:mean(behaviour.map(r=>r.trainedOnMislabel.treasure)),
   treasureCyclingPolicy:mean(behaviour.map(r=>r.cyclingPolicy.treasure)),
   treasurePartialSacrifice:mean(behaviour.map(r=>r.partialSacrifice.treasure)),
   treasureSpendEverything:mean(behaviour.map(r=>r.spendEverything.treasure)),
   spendsTrainedOnMislabel:mean(behaviour.map(r=>r.trainedOnMislabel.spends)),
   spendsPartialSacrifice:mean(behaviour.map(r=>r.partialSacrifice.spends)),
   costOfBelievingTheMislabel:mean(behaviour.map(r=>r.partialSacrifice.treasure-r.trainedOnMislabel.treasure))}};
 result.status='PASS';save();
 const t=result.totals;
 console.log(JSON.stringify({type:result.type,status:result.status,totals:t,families,behaviour}));
 console.log('PASS: the depletion fact is observable on '+t.sacrifice.depletionFactObserved+'/'+SEEDS.length+
  ' sacrifice cartridges and the old rule calls it NEGATIVE on '+t.sacrifice.oldRuleMislabelledAsNegative+'/'+SEEDS.length+
  ' of them, where the closed label says it is not a cost. The split refuses at the judge stage '+t.sacrifice.pipelineRefusedAtJudge+'/'+SEEDS.length+
  ' while still verifying a real cost on '+t.survival.pipelineVerified+'/'+SEEDS.length+
  ' survival cartridges. Believing the mislabel collects '+t.behaviour.treasureTrainedOnMislabel.toFixed(1)+
  ' treasure against '+t.behaviour.treasurePartialSacrifice.toFixed(1)+' for partial sacrifice, a shortfall of '+
  t.behaviour.costOfBelievingTheMislabel.toFixed(1)+'.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
