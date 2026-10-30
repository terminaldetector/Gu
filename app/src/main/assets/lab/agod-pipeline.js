/* Experimental AGOD pipeline (TZ v2.0, E6).

   The stages already existed separately: causal attribution (agod-causal),
   typing (agod-ram), induction (agod-goals), the evidence registry
   (agod-evidence) and the broker (agod-reward). Until now the wiring between
   them lived inside a check script, which meant the integration itself was
   never a thing that could be run, refused or evaluated.

   This is that wiring, with one rule: every stage can refuse, and a refusal is
   named and returned rather than smoothed over. The pipeline returns a VERIFIED
   goal or it returns why it did not, and it never returns something in between.
   It reads no oracle and takes no per-game configuration.

   The driver is the only platform-specific part:
     restore(snapshot), run(mask, frames), readRam(), snapshot(), stateHash()
   Not wired into any production screen. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Causal=root.FlyAgodCausal||(require_?require_('./agod-causal.js'):null);
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);
const Goals=root.FlyAgodGoals||(require_?require_('./agod-goals.js'):null);
const Evidence=root.FlyAgodEvidence||(require_?require_('./agod-evidence.js'):null);
const Reward=root.FlyAgodReward||(require_?require_('./agod-reward.js'):null);

const SCHEMA_VERSION=1,PIPELINE_REVISION='agod-pipeline-s3-2';
const DEFAULTS=Object.freeze({masks:[1,2,4,8,16,32,64,128],frames:12,shiftTolerance:3,
 starts:2,typeEvents:60,hold:4,release:8,depletePulses:6,depleteSettle:30,
 partitions:[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}]});
const frozen=Object.freeze.bind(Object);

function movedBetween(samples){
 const moved=new Set();
 for(let i=1;i<samples.length;i++)
  for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])moved.add(a);
 return moved;
}

function run(driver,options){
 const config={...DEFAULTS,...(options||{})};
 const trace=[],refusals=[];
 const refuse=(stage,reason,detail)=>{
  refusals.push({stage,reason,...(detail||{})});
  return frozen({schemaVersion:SCHEMA_VERSION,pipelineRevision:PIPELINE_REVISION,
   status:'REFUSED',stage,reason,goal:null,actions:null,trace,refusals});
 };
 const note=(stage,detail)=>{trace.push({stage,...detail});};

 for(const [name,module] of [['agod-causal',Causal],['agod-ram',Ram],['agod-goals',Goals],['agod-evidence',Evidence],['agod-reward',Reward]])
  if(!module)return refuse('wiring','a required stage module is missing: '+name);
 if(!driver||['restore','run','readRam','snapshot','stateHash'].some(key=>typeof driver[key]!=='function'))
  return refuse('wiring','driver must provide restore, run, readRam, snapshot and stateHash');

 const pristine=driver.snapshot();
 const startsFrom=(count,offset,tag)=>{
  const out=[];
  for(let i=0;i<count;i++){driver.run(0,offset+i*7);out.push({id:tag+'-'+i,stateHash:driver.stateHash(),snapshot:driver.snapshot()});}
  return out;
 };
 const probe=(starts,mask)=>Causal.probeAction(driver,{starts,mask,neutralMask:0,
  alternativeMask:mask===1?2:1,frames:config.frames,shiftTolerance:config.shiftTolerance});
 const play=(mask,events)=>{
  const samples=[];
  for(let e=0;e<events;e++){driver.run(mask,config.hold);driver.run(0,config.release);samples.push(driver.readRam());}
  return samples;
 };

 /* 1. Which actions cause anything at all. */
 driver.restore(pristine);
 const starts=startsFrom(config.starts,17,'probe');
 const attributed=new Map();
 for(const mask of config.masks){
  const outcome=probe(starts,mask);
  if(outcome.causalStatus==='INCONCLUSIVE'){note('attribute',{mask,status:'INCONCLUSIVE'});continue;}
  attributed.set(mask,outcome.confirmed.map(entry=>entry.address));
 }
 if(![...attributed.values()].some(list=>list.length))
  return refuse('attribute','no action was shown to cause any RAM change');

 /* 2. What persists after release is game state; what reverts is input
       plumbing. Time-driven bytes are excluded by a neutral run of the same
       length and cadence, which no phase shift can defeat. */
 driver.restore(pristine);
 const neutralMoved=movedBetween(play(0,config.typeEvents));
 const persistent=new Map();
 const typedByMask=new Map();
 let decreasing=null,increasing=null;
 for(const [mask,shortAttributed] of attributed){
  if(!shortAttributed.length)continue;
  driver.restore(pristine);
  const samples=play(mask,config.typeEvents);
  const addresses=[...movedBetween(samples)].filter(address=>!neutralMoved.has(address)).sort((a,b)=>a-b);
  persistent.set(mask,addresses);
  for(const span of Ram.spansOf(addresses)){
   const outcome=Ram.identifyField({samples,addresses:span});
   note('type',{mask,span:[span[0],span[span.length-1]],status:outcome.status,
    field:outcome.field?{address:outcome.field.address,width:outcome.field.width,
     endian:outcome.field.endian,encoding:outcome.field.encoding,step:outcome.field.step,
     direction:outcome.field.direction}:null});
   if(outcome.status!=='IDENTIFIED')continue;
   if(!typedByMask.has(mask))typedByMask.set(mask,[]);
   typedByMask.get(mask).push(outcome.field);
   if(outcome.field.direction==='decreasing'&&!decreasing)decreasing={mask,field:outcome.field};
   if(outcome.field.direction==='increasing'&&!increasing)increasing={mask,field:outcome.field};
  }
 }
 if(!decreasing)return refuse('type','no action-driven resource decreases, so no cost can be evidenced');
 if(!increasing)return refuse('type','no persisting action-driven effect is available as a play-effect scope');

 /* 2b. Is the loss a cost, or is it the price of something?
       A depletion coupled to a persisting gain under the SAME action, or a floor
       that another action undoes while the gain survives, is a sacrifice rather
       than a cost. Both are decided by observation here, not by assumption. */
 const coupledGains=(typedByMask.get(decreasing.mask)||[])
  .filter(field=>field.direction==='increasing')
  .map(field=>frozen({address:field.address,width:field.width,step:field.step}));

 const readField=field=>Ram.decode(driver.readRam(),{address:field.address,width:field.width,
  endian:field.endian==='n/a'?'little':field.endian,
  encoding:field.encodingDetermined?field.encoding:'binary'});

 /* Drive the resource to its floor once, keep that state, and try every other
    action from it. */
 driver.restore(pristine);
 for(let pulse=0;pulse<config.depletePulses+2;pulse++){
  driver.run(decreasing.mask,config.hold);driver.run(0,config.depleteSettle);
 }
 const floor=driver.snapshot();
 const floorResource=readField(decreasing.field);
 /* "The gain survives the reversal" has to mean everything the suppressed play
    had accumulated, not one arbitrary field. Watching a single increasing field
    is fragile: on the survival family a reset restores the resource and zeroes
    the score while leaving the level counter standing, so watching the level
    alone would read a death as a sacrifice. Measured, not assumed - this is
    what the first run of the S3 check caught. */
 const playGains=[...typedByMask.entries()]
  .filter(([mask])=>mask!==decreasing.mask)
  .flatMap(([,fields])=>fields.filter(field=>field.direction==='increasing'));
 const floorGains=playGains.map(field=>readField(field));
 let floorReversible=false,gainRetainedAcrossReversal=false,reversalMask=null;
 for(const mask of config.masks){
  if(mask===decreasing.mask)continue;
  driver.restore(floor);
  driver.run(mask,config.hold);driver.run(0,config.release);
  const resource=readField(decreasing.field);
  if(resource<=floorResource)continue;
  const after=playGains.map(field=>readField(field));
  const retained=playGains.length>0&&after.every((value,index)=>value>=floorGains[index]);
  const lost=playGains.filter((field,index)=>after[index]<floorGains[index]).map(field=>field.address);
  floorReversible=true;reversalMask=mask;
  if(retained)gainRetainedAcrossReversal=true;
  note('reverse',{mask,resource,floorResource,watched:playGains.length,retained,lostGainAddresses:lost});
  if(retained)break;   /* the strongest case found */
 }
 note('judge',{coupledGains:coupledGains.length,playGainsWatched:playGains.length,floorReversible,gainRetainedAcrossReversal,reversalMask});

 /* 3. Induce and register, once per partition, each partition an independent
       run of the same procedure. */
 const registry=Evidence.createRegistry({romHash:config.romHash,coreRevision:config.coreRevision,
  profileRevision:config.profileRevision,ttlMs:config.ttlMs});
 const goalId=config.goalId||('goal-resource-'+decreasing.mask+'-'+decreasing.field.address);
 const readResource=memory=>Ram.decode(memory,{address:decreasing.field.address,width:decreasing.field.width,
  endian:decreasing.field.endian==='n/a'?'little':decreasing.field.endian,
  encoding:decreasing.field.encodingDetermined?decreasing.field.encoding:'binary'});
 const judgementInputs={coupledGains,floorReversible,gainRetainedAcrossReversal};
 const playScope=persistent.get(increasing.mask)||[];
 let induced=null;
 for(const part of config.partitions){
  driver.restore(pristine);
  const partStarts=startsFrom(config.starts,part.offset,'part-'+part.group);
  const costProbe=probe(partStarts,decreasing.mask);
  const aliveEffects=probe(partStarts,increasing.mask).confirmed.map(entry=>entry.address);
  driver.restore(partStarts[0].snapshot);
  const track=[readResource(driver.readRam())];
  for(let pulse=0;pulse<config.depletePulses;pulse++){
   driver.run(decreasing.mask,config.hold);driver.run(0,config.depleteSettle);
   track.push(readResource(driver.readRam()));
  }
  const deadEffects=probe(startsFrom(config.starts,5,'dead-'+part.group),increasing.mask).confirmed.map(entry=>entry.address);
  induced=Goals.induceGoal({id:goalId,actionMask:decreasing.mask,address:decreasing.field.address,
   causalConfirmed:costProbe.confirmed.some(entry=>entry.address===decreasing.field.address),
   independentStarts:costProbe.independentStarts,resourceTrack:{values:track},
   terminal:{confirmedBeforeDepletion:aliveEffects,confirmedAfterDepletion:deadEffects,scope:playScope},
   ...judgementInputs});
  note('induce',{partition:part.group,polarity:induced.polarity,lifecycle:induced.lifecycle,
   verifiable:induced.verifiable,resourceTrack:track});
  for(const observation of costProbe.perStart){
   if(observation.status!=='OBSERVED')continue;
   registry.register({id:'ev-'+part.group+'-'+observation.startId,goalId,group:part.group,
    parentStateHash:observation.stateHash,restorePath:['pristine','neutral+'+part.offset],
    episodeOrigin:'live',outcome:induced.polarity==='NEGATIVE'?'confirmed':'inconclusive',
    restored:false,atMs:config.nowMs||0});
  }
 }
 if(!induced||induced.polarity!=='NEGATIVE'){
  const judgement=induced?induced.lossJudgement:null;
  if(judgement&&judgement.fact==='TERMINAL_RESOURCE_DEPLETION'&&judgement.judgement!=='NEGATIVE_GAME_REWARD')
   /* The fact is reported; only the verdict is withheld, and the reason says
      which discriminator withheld it. */
   return refuse('judge','terminal resource depletion was observed but is not evidenced as a cost to the game',
    {fact:judgement.fact,classification:judgement.classification,blockers:judgement.blockers,
     coupledGains:judgement.coupledGains,floorReversible,gainRetainedAcrossReversal});
  return refuse('induce','the resource did not produce an evidenced NEGATIVE polarity',
   {polarity:induced?induced.polarity:null,rationale:induced?induced.rationale:null});
 }

 /* 4. Promotion is the registry's call, not the pipeline's. */
 const promotion=registry.promote(goalId,{polarity:induced.polarity,
  polarityEvidenced:induced.verifiable,profileRevision:config.profileRevision,nowMs:config.nowMs});
 note('promote',{verified:promotion.verified,lifecycle:promotion.lifecycle,blockers:promotion.blockers});
 if(!promotion.verified)
  return refuse('promote','the registry refused to verify the goal',{blockers:promotion.blockers});

 const goal=frozen({id:goalId,lifecycle:promotion.lifecycle,polarity:promotion.polarity,
  evidenceRefs:promotion.evidenceRefs});
 return frozen({schemaVersion:SCHEMA_VERSION,pipelineRevision:PIPELINE_REVISION,
  status:'VERIFIED',stage:'complete',reason:null,
  goal,
  resource:frozen({...decreasing.field,mask:decreasing.mask}),
  judgement:induced.lossJudgement,
  depletionFact:induced.depletionFact,
  actions:frozen({neutral:0,effect:increasing.mask,cost:decreasing.mask}),
  readResource,
  broker:Reward.createBroker({profileRevision:config.profileRevision,contextKey:config.contextKey}),
  registry,trace,refusals});
}

const api={SCHEMA_VERSION,PIPELINE_REVISION,DEFAULTS,run};
root.FlyAgodPipeline=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
