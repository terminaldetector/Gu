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
const Candidates=root.FlyAgodCandidates||(require_?require_('./agod-candidates.js'):null);
const Consumers=root.FlyAgodConsumers||(require_?require_('./agod-consumers.js'):null);

const SCHEMA_VERSION=1,PIPELINE_REVISION='agod-pipeline-s9-4';
const DEFAULTS=Object.freeze({masks:[1,2,4,8,16,32,64,128],frames:12,shiftTolerance:3,
 starts:2,typeEvents:60,hold:4,release:8,depletePulses:6,depleteSettle:30,
 partitions:[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}],
 /* S9. 'first' is FIRST-V1 and stays the default, so every earlier result is
    reproduced unchanged; 'ranked' is RANKED-V2. The budget is declared here and
    not raised per cartridge. */
 resourceSelection:'first',inventoryStarts:3,inventoryPulses:8,maxCandidates:6,
 /* criterion 5 of the ranking spec: a counterfactual per candidate, bounded */
 consumerProbeSteps:16,consumerFrameBudget:4000});
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
 /* What the pipeline discovered is reported even when it refuses. Otherwise a
    caller that needs the resource has to ask the oracle for it, which is how
    the first version of the POSITIVE proposer acquired an oracle dependency. */
 let discovered=null;
 const refuse=(stage,reason,detail)=>{
  refusals.push({stage,reason,...(detail||{})});
  return frozen({schemaVersion:SCHEMA_VERSION,pipelineRevision:PIPELINE_REVISION,
   status:'REFUSED',stage,reason,goal:null,actions:null,
   discovered:discovered?frozen(discovered):null,trace,refusals});
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
 discovered={
  resource:frozen({...decreasing.field,mask:decreasing.mask}),
  effect:frozen({...increasing.field,mask:increasing.mask}),
  /* Every increasing field the typing stage committed to, with its action, so a
     caller can enumerate candidates without the oracle. */
  increasingFields:[...typedByMask.entries()].flatMap(([mask,fields])=>
   fields.filter(field=>field.direction==='increasing').map(field=>frozen({...field,mask}))),
  persistingByMask:[...persistent.entries()].map(([mask,addresses])=>frozen({mask,addresses:addresses.slice(0,64)})),
  neutralMovedAddresses:[...neutralMoved].sort((a,b)=>a-b)};

 const decodeField=field=>Ram.decode(driver.readRam(),{address:field.address,width:field.width,
  endian:field.endian==='n/a'?'little':field.endian,
  encoding:field.encodingDetermined?field.encoding:'binary'});

 /* ------------------------------------------------------------------------
    2b, 3 and 4 for ONE resource candidate.

    This body is unchanged from the single-candidate version; it was extracted
    into a function so the SAME code evaluates the first-typed candidate (the
    FIRST-V1 strategy, still the default) and each ranked candidate in turn
    (RANKED-V2). It returns a descriptor rather than a pipeline result, so the
    caller decides whether a refusal ends the run or is recorded and the next
    candidate tried.

    The note tag is added only in ranked mode. In FIRST-V1 the trace is
    byte-for-byte what it was, so every committed result stays comparable.
    ------------------------------------------------------------------------ */
 const evaluateResource=decreasing=>{
  const noteFor=(stage,detail)=>note(stage,
   config.resourceSelection==='ranked'?{candidate:decreasing.field.address,...detail}:detail);
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
   noteFor('reverse',{mask,resource,floorResource,watched:playGains.length,retained,lostGainAddresses:lost});
   if(retained)break;   /* the strongest case found */
  }
  noteFor('judge',{coupledGains:coupledGains.length,playGainsWatched:playGains.length,floorReversible,gainRetainedAcrossReversal,reversalMask});

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
   noteFor('induce',{partition:part.group,polarity:induced.polarity,lifecycle:induced.lifecycle,
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
    return {outcome:'REFUSED',stage:'judge',
     reason:'terminal resource depletion was observed but is not evidenced as a cost to the game',
     detail:{fact:judgement.fact,classification:judgement.classification,blockers:judgement.blockers,
      coupledGains:judgement.coupledGains,floorReversible,gainRetainedAcrossReversal}};
   return {outcome:'REFUSED',stage:'induce',
    reason:'the resource did not produce an evidenced NEGATIVE polarity',
    detail:{polarity:induced?induced.polarity:null,rationale:induced?induced.rationale:null,
     resourceTrack:induced&&induced.resourceTrack?induced.resourceTrack:null}};
  }

  /* 4. Promotion is the registry's call, not the pipeline's. */
  const promotion=registry.promote(goalId,{polarity:induced.polarity,
   polarityEvidenced:induced.verifiable,profileRevision:config.profileRevision,nowMs:config.nowMs});
  noteFor('promote',{verified:promotion.verified,lifecycle:promotion.lifecycle,blockers:promotion.blockers});
  if(!promotion.verified)
   return {outcome:'REFUSED',stage:'promote',reason:'the registry refused to verify the goal',
    detail:{blockers:promotion.blockers}};

  const goal=frozen({id:goalId,lifecycle:promotion.lifecycle,polarity:promotion.polarity,
   evidenceRefs:promotion.evidenceRefs});
  return {outcome:'VERIFIED',stage:'complete',result:frozen({schemaVersion:SCHEMA_VERSION,pipelineRevision:PIPELINE_REVISION,
   status:'VERIFIED',stage:'complete',reason:null,
   goal,
   resource:frozen({...decreasing.field,mask:decreasing.mask}),
   discovered:frozen(discovered),
   judgement:induced.lossJudgement,
   depletionFact:induced.depletionFact,
   actions:frozen({neutral:0,effect:increasing.mask,cost:decreasing.mask}),
   readResource,
   broker:Reward.createBroker({profileRevision:config.profileRevision,contextKey:config.contextKey}),
   registry,trace,refusals})};
 };

 /* ---------------- resource selection ----------------
    FIRST-V1, the default, is exactly what it was: the first decreasing field
    the typing stage committed to, in mask-traversal order and then by address.
    It is kept so the two strategies can be compared on one code path. */
 if(config.resourceSelection!=='ranked'){
  const outcome=evaluateResource(decreasing);
  if(outcome.outcome==='REFUSED')return refuse(outcome.stage,outcome.reason,outcome.detail);
  return outcome.result;
 }

 /* RANKED-V2 (S9). Inventory every decreasing candidate, group by observed
    joint dynamics, rank by the pre-registered spec, evaluate the top groups
    inside the declared budget, keep every outcome, and then take the winner by
    the rule declared before any of this was run.

    ONE THING VARIES. `increasing` is still the first-typed field: how the
    positive play effect is chosen is deliberately NOT touched in this pass, so
    a difference between V1 and V2 can only come from resource selection. */
 if(!Candidates)return refuse('wiring','ranked resource selection needs agod-candidates.js');
 const decreasingCandidates=[...typedByMask.entries()].flatMap(([mask,fields])=>
  fields.filter(field=>field.direction==='decreasing').map(field=>({mask,field})));
 driver.restore(pristine);
 const inventoryStarts=startsFrom(config.inventoryStarts,23,'inv');
 const causalByMask=new Map();
 for(const mask of new Set(decreasingCandidates.map(entry=>entry.mask))){
  const outcome=probe(inventoryStarts,mask);
  causalByMask.set(mask,{
   confirmed:new Map((outcome.confirmed||[]).map(record=>[record.address,record])),
   contradicted:new Map((outcome.contradicted||[]).map(record=>[record.address,record])),
   usableStarts:outcome.usableStarts||inventoryStarts.length});
 }
 const inventoryProbe={
  restore(snapshot){driver.restore(snapshot);},
  drive(mask,pulses){for(let i=0;i<pulses;i++){driver.run(mask,config.hold);driver.run(0,config.release);}},
  read:decodeField,
  ram(){return driver.readRam();},
  snapshot(){return driver.snapshot();},
  startSnapshots:inventoryStarts,
  neutralMoved,
  /* how many actions move this byte at all: the input-echo signature */
  masksMoving(address){let count=0;
   for(const [,addresses] of persistent)if(addresses.indexOf(address)>=0)count++;
   return count;},
  pristine};
 /* Criterion 5 of the pre-registered spec is a counterfactual: poke the field
    to a second value it actually reaches and see whether the machine then does
    something different. It needs driver.poke, which only the NES driver has;
    where it is missing the record says NOT-SUPPORTED rather than NOT-TESTED,
    because "we cannot ask" and "we asked and saw nothing" are different claims
    and conflating them is the error S4c had to be rewritten to remove. */
 const probeConsumer=(field,mask)=>{
  if(!Consumers)return {status:'NOT-SUPPORTED',hasConsumer:null,
   reason:'agod-consumers.js is not wired in, so criterion 5 cannot be measured',
   caution:'this is an inability to test, not an absence of a consumer'};
  if(typeof driver.poke!=='function')return {status:'NOT-SUPPORTED',hasConsumer:null,
   reason:'this driver exposes no poke(address,value), so a counterfactual on a field cannot be performed on this platform',
   caution:'this is an inability to test, not an absence of a consumer'};
  try{
   driver.restore(pristine);
   return Consumers.downstreamConsumer(driver,{field,pristine,fieldMask:mask,
    hold:config.hold,release:config.release,masks:config.masks,
    steps:config.consumerProbeSteps,frameBudget:config.consumerFrameBudget});
  }catch(problem){
   return {status:'ERROR',hasConsumer:null,reason:problem.message,
    caution:'an error in the probe is not an absence of a consumer'};
  }
 };
 const records=[];
 for(const entry of decreasingCandidates){
  const causal=causalByMask.get(entry.mask);
  const span=[];
  for(let k=0;k<entry.field.width;k++)span.push(entry.field.address+k);
  /* the weakest byte of the span decides: a span is only as attributed as its
     least attributed byte */
  const confirmedStarts=Math.min(...span.map(address=>{
   const hit=causal.confirmed.get(address);
   if(hit)return hit.starts;
   const partial=causal.contradicted.get(address);
   return partial?partial.starts:0;}));
  const downstream=probeConsumer(entry.field,entry.mask);
  driver.restore(pristine);
  records.push(Candidates.observe(inventoryProbe,{field:entry.field,mask:entry.mask,
   pulses:config.inventoryPulses,starts:inventoryStarts,
   confirmedStarts,independentStarts:causal.usableStarts,downstream}));
 }
 const grouped=Candidates.groupRecords(records);
 const ranking=Candidates.rankGroups(grouped,{maxCandidates:config.maxCandidates});
 note('inventory',{candidatesTyped:records.length,groups:grouped.groups.length,
  groupingLinks:grouped.links.length,
  ranked:ranking.ordered.map(entry=>({rank:entry.rank,address:entry.address,
   mask:entry.mask,groupSize:entry.groupSize,score:entry.score.total}))});
 discovered.rankedSelection={specRevision:ranking.specRevision,
  candidatesTyped:records.length,candidatesFound:ranking.candidatesFound,
  maxCandidates:ranking.maxCandidates,budgetNote:ranking.budgetNote,
  grouping:{rule:grouped.groupingRule,links:grouped.links,
   groups:grouped.groups.map(group=>({addresses:group.addresses,size:group.size,
    representative:group.representative.field.address,rule:group.representativeRule}))},
  ranked:ranking.ordered.map(entry=>({rank:entry.rank,address:entry.address,mask:entry.mask,
   groupAddresses:entry.groupAddresses,score:entry.score,record:entry.record}))};
 /* The array is created before any candidate runs, because the first VERIFIED
    freezes `discovered` and a later property assignment would throw. */
 discovered.rankedAttempts=[];
 const attempts=[];
 for(const entry of ranking.withinBudget){
  const representative=entry.group.representative;
  const field=(typedByMask.get(representative.field.mask)||[])
   .find(candidate=>candidate.address===representative.field.address
    &&candidate.width===representative.field.width
    &&candidate.direction==='decreasing');
  if(!field){
   const skipped={rank:entry.rank,address:representative.field.address,
    mask:representative.field.mask,score:entry.score.total,outcome:'SKIPPED',
    stage:null,reason:'the typed field backing this group could not be recovered',detail:null};
   attempts.push(skipped);discovered.rankedAttempts.push(skipped);continue;
  }
  driver.restore(pristine);
  /* A candidate that cannot be evaluated is a refusal for THAT candidate, not
     the end of the run. Evaluating more than one candidate reached a path the
     single-candidate strategy never did: a BCD-typed field whose bytes stop
     being valid BCD somewhere along the depletion track decodes to null, and
     agod-goals then throws "resource value must be an integer".

     The value is NOT coerced. Substituting 0 for an unreadable resource is the
     UNKNOWN-becomes-zero shortcut this project forbids, and it would invent a
     depletion that was never observed. The candidate is recorded as ERRORED
     with the message and the next candidate is tried.

     V1 is deliberately left to propagate such an error, so its behaviour is
     unchanged and a crash there stays visible rather than being absorbed. */
  let outcome;
  try{outcome=evaluateResource({mask:representative.field.mask,field});}
  catch(problem){
   outcome={outcome:'ERRORED',stage:'evaluate',reason:problem.message,
    detail:{candidateUnevaluable:true,
     note:'this candidate could not be evaluated; its value was not coerced and no depletion was inferred'}};
  }
  const attempt={rank:entry.rank,address:field.address,mask:representative.field.mask,
   score:entry.score.total,outcome:outcome.outcome,stage:outcome.stage||null,
   reason:outcome.reason||null,detail:outcome.detail||null};
  attempts.push({...attempt,result:outcome.outcome==='VERIFIED'?outcome.result:null});
  discovered.rankedAttempts.push(attempt);
 }
 for(const attempt of attempts)
  if(attempt.outcome==='REFUSED'||attempt.outcome==='ERRORED')
   refusals.push({stage:attempt.stage,candidate:attempt.address,
    outcome:attempt.outcome,reason:attempt.reason,...(attempt.detail||{})});
 const passed=attempts.filter(attempt=>attempt.outcome==='VERIFIED');
 if(!passed.length)
  return refuse('ranked-selection',
   'every candidate inside the declared budget refused',
   {candidatesEvaluated:attempts.length,candidatesFound:ranking.candidatesFound,
    candidatesRefused:attempts.filter(a=>a.outcome==='REFUSED').length,
    candidatesErrored:attempts.filter(a=>a.outcome==='ERRORED').length,
    candidatesSkipped:attempts.filter(a=>a.outcome==='SKIPPED').length,
    perCandidate:attempts.map(attempt=>({rank:attempt.rank,address:attempt.address,
     outcome:attempt.outcome,stage:attempt.stage,reason:attempt.reason}))});
 /* `attempts` is in ranking order, so passed[0] IS what the pre-registered
    rule selects. Nothing is re-ordered after the outcomes are known. */
 const chosen=passed[0];
 note('select',{chosenAddress:chosen.address,chosenRank:chosen.rank,
  candidatesThatPassed:passed.length,
  passedAddresses:passed.map(attempt=>attempt.address),
  rule:Candidates.RANKING_SPEC.selectionRuleWhenSeveralPass});
 return chosen.result;
}

const api={SCHEMA_VERSION,PIPELINE_REVISION,DEFAULTS,run};
root.FlyAgodPipeline=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
