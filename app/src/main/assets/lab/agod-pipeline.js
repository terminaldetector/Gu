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

const SCHEMA_VERSION=1,PIPELINE_REVISION='agod-pipeline-s10-5';
const DEFAULTS=Object.freeze({masks:[1,2,4,8,16,32,64,128],frames:12,shiftTolerance:3,
 starts:2,typeEvents:60,hold:4,release:8,depletePulses:6,depleteSettle:30,
 partitions:[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}],
 /* S9. 'first' is FIRST-V1 and stays the default, so every earlier result is
    reproduced unchanged; 'ranked' is RANKED-V2. The budget is declared here and
    not raised per cartridge. */
 resourceSelection:'first',inventoryStarts:3,inventoryPulses:8,maxCandidates:6,
 /* criterion 5 of the ranking spec: a counterfactual per candidate, bounded */
 consumerProbeSteps:16,consumerFrameBudget:4000,
 /* ONE budget over the whole ranked search (inventory, criterion 5 on the
    shortlist, and every candidate evaluation), so cost scales with the budget
    and not with how many fields happened to type. */
 searchFrameBudget:600000,
 /* S10A: diagnostics only. Off by default, changes no decision when on. */
 auditPolarity:false});
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

 /* M3 (S10B protocol fix). The budget has to cover EVERYTHING the ranked
    search runs. The previous meter wrapped only the inventory and the consumer
    probes, while evaluateResource called the raw driver and spent frames the
    counter never saw. The driver itself is replaced here, so every stage -
    partition probes, depletion pulses, reversal probes and the confirmation
    phase - is counted in one place and cannot opt out.

    Exceeding it throws a NAMED condition, so a mid-candidate overrun is a
    recognised outcome rather than an unknown error. */
 let framesSpent=0;
 if(config.resourceSelection==='ranked'){
  const raw=driver;
  driver={...raw,
   run(mask,count){
    framesSpent+=count;
    if(framesSpent>config.searchFrameBudget)
     throw new Error('FRAME_BUDGET_EXCEEDED: the ranked search spent '+framesSpent
      +' frames, over the declared budget of '+config.searchFrameBudget);
    return raw.run(mask,count);
   }};
 }
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
 /* P1 (S10 protocol fix). The partition set and whether to promote are
    parameters now. FIRST-V1 passes neither and therefore behaves exactly as
    before: all three partitions, promotion attempted. RANKED-V2 selects on
    DISCOVERY and CALIBRATION only and then lets HOLDOUT check the choice it has
    already fixed, so HOLDOUT is no longer part of choosing. */
 const evaluateResource=(decreasing,phase)=>{
  const settings=phase||{};
  const partitions=settings.partitions||config.partitions;
  const promoteAfter=settings.promote===undefined?true:settings.promote===true;
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
  /* M4 (S10B protocol fix). Every partition's verdict is kept. The previous
     version overwrote `induced` each pass, so the decision rested on whichever
     partition happened to run last: DISCOVERY=UNKNOWN with CALIBRATION=NEGATIVE
     would pass on the strength of the second alone. Agreement across the
     partitions is the whole point of running more than one. */
  let induced=null;
  const perPartition=[];
  for(const part of partitions){
   driver.restore(pristine);
   const partStarts=startsFrom(config.starts,part.offset,'part-'+part.group);
   const costProbe=probe(partStarts,decreasing.mask);
   const aliveEffects=probe(partStarts,increasing.mask).confirmed.map(entry=>entry.address);
   /* S10A diagnostics. The initial value at EVERY independent start, not just
      the one the track is taken from, so "it reads zero" can be told apart from
      "it reads zero on the start we happened to use". Read-only: the track and
      everything downstream are unchanged. */
   const initialByStart=[];
   if(config.auditPolarity)for(const start of partStarts){
    driver.restore(start.snapshot);
    const raw=driver.readRam();
    const value=readResource(raw);
    initialByStart.push({startId:start.id,value,
     decoded:Number.isInteger(value),
     bytes:Array.from({length:decreasing.field.width},(_,k)=>raw[decreasing.field.address+k])});
   }
   driver.restore(partStarts[0].snapshot);
   const track=[readResource(driver.readRam())];
   /* Every sample with its decode state, so a null is visible as a decode
      failure rather than vanishing into a track of numbers. */
   const samples=config.auditPolarity
    ?[{pulse:0,value:track[0],decoded:Number.isInteger(track[0]),
       bytes:Array.from({length:decreasing.field.width},(_,k)=>driver.readRam()[decreasing.field.address+k])}]
    :null;
   for(let pulse=0;pulse<config.depletePulses;pulse++){
    driver.run(decreasing.mask,config.hold);driver.run(0,config.depleteSettle);
    const value=readResource(driver.readRam());
    track.push(value);
    if(samples){const raw=driver.readRam();
     samples.push({pulse:pulse+1,value,decoded:Number.isInteger(value),
      bytes:Array.from({length:decreasing.field.width},(_,k)=>raw[decreasing.field.address+k])});}
   }
   const deadEffects=probe(startsFrom(config.starts,5,'dead-'+part.group),increasing.mask).confirmed.map(entry=>entry.address);
   induced=Goals.induceGoal({id:goalId,actionMask:decreasing.mask,address:decreasing.field.address,
    causalConfirmed:costProbe.confirmed.some(entry=>entry.address===decreasing.field.address),
    independentStarts:costProbe.independentStarts,resourceTrack:{values:track},
    terminal:{confirmedBeforeDepletion:aliveEffects,confirmedAfterDepletion:deadEffects,scope:playScope},
    ...judgementInputs});
   noteFor('induce',{partition:part.group,polarity:induced.polarity,lifecycle:induced.lifecycle,
    verifiable:induced.verifiable,resourceTrack:track});
   /* S10A: the whole evidence chain for THIS partition, and which term of the
      NEGATIVE conjunction was false. Nothing here feeds any decision; it is a
      separate note so that removing it changes no result. */
   if(config.auditPolarity){
    const resourceAnalysis=induced.resource;
    const terminal=induced.terminal;
    const judgement=induced.lossJudgement;
    const terms=[
     {term:'causalConfirmed',
      holds:induced.causalConfirmed===true,
      observation:'the causal probe confirmed this exact address for its mask on every usable start of this partition',
      value:costProbe.confirmed.some(entry=>entry.address===decreasing.field.address),
      detail:{confirmedAddresses:costProbe.confirmed.map(e=>e.address).slice(0,24),
       contradictedAddresses:(costProbe.contradicted||[]).map(e=>e.address).slice(0,24),
       usableStarts:costProbe.independentStarts}},
     {term:'resource.decreasing',
      holds:!!(resourceAnalysis&&resourceAnalysis.decreasing),
      observation:'no sample along the track rose above its predecessor',
      value:resourceAnalysis?resourceAnalysis.decreasing:null,
      detail:resourceAnalysis?{monotone:resourceAnalysis.monotone,samples:resourceAnalysis.samples,
       reason:resourceAnalysis.reason||null}:null},
     {term:'resource.settledAtFloor',
      holds:!!(resourceAnalysis&&resourceAnalysis.settledAtFloor),
      observation:'the minimum was reached and every later sample equals it',
      value:resourceAnalysis?resourceAnalysis.settledAtFloor:null,
      detail:resourceAnalysis?{floor:resourceAnalysis.floor,
       reachedFloorAt:resourceAnalysis.reachedFloorAt,
       pulsesRun:config.depletePulses,
       floorReachedWithinBudget:resourceAnalysis.reachedFloorAt<config.depletePulses}:null},
     {term:'terminal.normalPlaySuppressed',
      holds:!!(terminal&&terminal.normalPlaySuppressed),
      observation:'every previously confirmed effect inside the play scope stopped being confirmed after depletion',
      value:terminal?terminal.normalPlaySuppressed:null,
      detail:terminal?{judgedEffects:terminal.judgedEffects,
       observedBefore:terminal.observedBefore,observedAfter:terminal.observedAfter,
       lostEffects:terminal.lostEffects,retainedEffects:terminal.retainedEffects,
       partialSuppression:terminal.partialSuppression,
       scopeSize:playScope.length,
       vacuousBecauseNothingWasConfirmed:terminal.judgedEffects===0}:null},
     {term:'!judgementBlocks',
      holds:!(judgement&&judgement.judgement!=='NEGATIVE_GAME_REWARD'),
      observation:'INTERPRETATION, not observation: whether the observed depletion counts as a cost to the game',
      value:judgement?judgement.judgement:null,
      detail:judgement?{classification:judgement.classification,blockers:judgement.blockers,
       coupledGainCount:judgement.coupledGains.length,
       floorReversible:judgement.floorReversible,
       gainRetainedAcrossReversal:judgement.gainRetainedAcrossReversal}:null}];
    /* M1 (S10B protocol fix). floorNotReachedInsideBudget could not support the
       claim I made from it. With a track of 0,0,0,0,0,0,0 the floor-reached test
       is satisfied vacuously - the minimum "arrives" at sample 0 and every later
       sample equals it - so a resource that never depleted counted as one whose
       floor was comfortably inside budget, and I read that as "six pulses are
       enough". It does not say that. Four outcomes are now distinguished, and
       only INSUFFICIENT_COVERAGE is the one a larger budget could change. */
    const depletionCoverage=(()=>{
     const values=samples?samples.map(entry=>entry.value):track;
     const decodable=values.every(value=>Number.isInteger(value));
     if(!decodable)return {status:'UNDECODABLE',
      reason:'at least one sample could not be decoded, so the track cannot be classified'};
     const first=values[0],min=Math.min(...values),max=Math.max(...values);
     let fell=false,rose=false;
     for(let i=1;i<values.length;i++){
      if(values[i]<values[i-1])fell=true;
      if(values[i]>values[i-1])rose=true;
     }
     const constant=min===max;
     if(constant)return {status:'ALREADY_AT_MINIMUM',first,min,max,
      reason:'the value never changed across the whole track, so no depletion could be observed and the floor test is satisfied vacuously',
      aLargerBudgetCouldChangeThis:false};
     if(!fell)return {status:'NO_DEPLETION_OBSERVED',first,min,max,rose,
      reason:'the value moved but never downward, so this is not a depletion at all',
      aLargerBudgetCouldChangeThis:false};
     const lastIndexOfMin=values.lastIndexOf(min),firstIndexOfMin=values.indexOf(min);
     const settled=values.slice(firstIndexOfMin).every(value=>value===min);
     const arrivedOnLastSample=firstIndexOfMin===values.length-1;
     if(settled&&!arrivedOnLastSample)
      return {status:'OBSERVED_DEPLETION',first,min,max,
       reachedFloorAt:firstIndexOfMin,heldForSamples:values.length-firstIndexOfMin,
       reason:'a decrease was observed, the minimum was reached before the last sample and every later sample equals it',
       aLargerBudgetCouldChangeThis:false};
     return {status:'INSUFFICIENT_COVERAGE',first,min,max,
      reachedFloorAt:firstIndexOfMin,lastIndexOfMin,settled,arrivedOnLastSample,
      reason:arrivedOnLastSample
       ?'the minimum arrived only on the final sample, so whether it is a floor is unknown at this budget'
       :'the value fell but never settled, so no floor was demonstrated at this budget',
      aLargerBudgetCouldChangeThis:true};
    })();
    note('polarity-audit',{candidate:decreasing.field.address,mask:decreasing.mask,
     depletionCoverage,
     partition:part.group,
     field:{address:decreasing.field.address,width:decreasing.field.width,
      encoding:decreasing.field.encoding,encodingDetermined:decreasing.field.encodingDetermined,
      endian:decreasing.field.endian,step:decreasing.field.step},
     initialByStart,samples,
     decodeFailures:samples?samples.filter(entry=>!entry.decoded).length:null,
     polarity:induced.polarity,rationale:induced.rationale,
     depletionFact:induced.depletionFact,
     firstFalseTerm:(terms.find(entry=>!entry.holds)||{term:null}).term,
     falseTerms:terms.filter(entry=>!entry.holds).map(entry=>entry.term),
     terms,
     coverage:{pulsesRun:config.depletePulses,
      pulseBudgetDeclaredIn:'config.depletePulses, unchanged from S9',
      startsPerPartition:config.starts,
      framesSpentSoFar:config.resourceSelection==='ranked'?searchFrames.spent():null},
     factVersusInterpretation:{
      observation:['causalConfirmed','resource.decreasing','resource.settledAtFloor','terminal.normalPlaySuppressed'],
      interpretation:['!judgementBlocks'],
      note:'the first four are statements about what the emulator did; the fifth is a judgement about what the depletion is worth, and NEGATIVE_GAME_REWARD is that judgement, not a measurement'}});
   }
   perPartition.push({group:part.group,polarity:induced.polarity,
    lifecycle:induced.lifecycle,verifiable:induced.verifiable,
    rationale:induced.rationale,depletionFact:induced.depletionFact});
   for(const observation of costProbe.perStart){
    if(observation.status!=='OBSERVED')continue;
    registry.register({id:'ev-'+part.group+'-'+observation.startId,goalId,group:part.group,
     parentStateHash:observation.stateHash,restorePath:['pristine','neutral+'+part.offset],
     episodeOrigin:'live',outcome:induced.polarity==='NEGATIVE'?'confirmed':'inconclusive',
     restored:false,atMs:config.nowMs||0});
   }
  }
  /* M4: the conjunction across partitions, not the last one standing. */
  const disagreeing=perPartition.filter(entry=>entry.polarity!=='NEGATIVE');
  if(perPartition.length>1&&disagreeing.length&&disagreeing.length<perPartition.length)
   return {outcome:'REFUSED',stage:'induce',
    reason:'the partitions disagree about polarity, so no single verdict is evidenced',
    detail:{perPartition,
     agreeingPartitions:perPartition.filter(entry=>entry.polarity==='NEGATIVE').map(entry=>entry.group),
     disagreeingPartitions:disagreeing.map(entry=>entry.group),
     note:'a NEGATIVE on one partition and an UNKNOWN on another is not evidence of a cost; the earlier version decided on whichever partition ran last'}};
  if(!induced||induced.polarity!=='NEGATIVE'||disagreeing.length){
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

  /* 4. Promotion is the registry's call, not the pipeline's.

     In the selection phase there is no promotion to attempt: the registry
     requires holdout evidence (AGOD-08) and holdout is deliberately not run
     yet, so asking would produce the blocker "no holdout evidence" and that
     would be an artefact of the protocol rather than a fact about the
     candidate. The phase returns INDUCED instead. */
  if(!promoteAfter)
   return {outcome:'INDUCED',stage:'induce',
    detail:{polarity:induced.polarity,lifecycle:induced.lifecycle,
     polarityEvidenced:induced.verifiable,
     partitionsUsed:partitions.map(part=>part.group),
     perPartition,
     allPartitionsAgreed:perPartition.every(entry=>entry.polarity==='NEGATIVE'),
     note:'selected on these partitions only, and every one of them agreed; holdout has not been consulted'}};
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
 /* The meter now lives in the driver itself (see the top of run()); this is
    just the read side of it. */
 const searchFrames={driver,spent(){return framesSpent;},
  exhausted(){return framesSpent>=config.searchFrameBudget;}};
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
  if(searchFrames.spent()>=config.searchFrameBudget)
   return {status:'NOT-MEASURED',hasConsumer:null,
    reason:'the shared frame budget for the ranked search was already spent ('
     +searchFrames.spent()+' of '+config.searchFrameBudget+' frames)',
    caution:'this is an exhausted budget, not an absence of a consumer'};
  try{
   driver.restore(pristine);
   const before=searchFrames.spent();
   const outcome=Consumers.downstreamConsumer(driver,{field,pristine,fieldMask:mask,
    hold:config.hold,release:config.release,masks:config.masks,
    steps:config.consumerProbeSteps,frameBudget:config.consumerFrameBudget});
   return {...outcome,framesSpent:searchFrames.spent()-before};
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
  /* criterion 5 is NOT measured here: see the shortlist below */
  records.push(Candidates.observe(inventoryProbe,{field:entry.field,mask:entry.mask,
   pulses:config.inventoryPulses,starts:inventoryStarts,
   confirmedStarts,independentStarts:causal.usableStarts,
   downstream:{status:'NOT-MEASURED-YET',hasConsumer:null,
    reason:'criterion 5 is measured only on the shortlist, so the search cost stays bounded',
    caution:'this is a deferred measurement, not an absence of a consumer'}}));
 }
 /* PASS 1: rank on the five criteria that cost nothing beyond the inventory,
    and take the shortlist the budget allows. */
 const groupedFirst=Candidates.groupRecords(records);
 const provisional=Candidates.rankGroups(groupedFirst,{maxCandidates:config.maxCandidates});
 /* PASS 2: measure criterion 5 only on the shortlisted groups' representatives,
    then rank again with it. Measuring it on every typed candidate first is what
    made the search cost scale with the inventory instead of with the budget. */
 const shortlist=new Set(provisional.withinBudget.map(entry=>entry.group.representative.field.address));
 const measured=records.map(record=>{
  if(!shortlist.has(record.field.address))return record;
  const downstream=probeConsumer({address:record.field.address,width:record.field.width,
   encoding:record.field.encoding,encodingDetermined:record.field.encodingDetermined,
   endian:record.field.endian},record.field.mask);
  driver.restore(pristine);
  return Candidates.withDownstream(record,downstream);
 });
 const grouped=Candidates.groupRecords(measured);
 const ranking=Candidates.rankGroups(grouped,{maxCandidates:config.maxCandidates});
 note('shortlist',{shortlisted:shortlist.size,ofGroups:provisional.candidatesFound,
  framesSpentBeforeCriterion5:searchFrames.spent(),
  rankingChangedByCriterion5:provisional.ordered.map(e=>e.address).join(',')
   !==ranking.ordered.map(e=>e.address).join(','),
  provisionalOrder:provisional.ordered.map(e=>({rank:e.rank,address:e.address,score:e.score.total})),
  finalOrder:ranking.ordered.map(e=>({rank:e.rank,address:e.address,score:e.score.total}))});
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
 /* P1 (S10 protocol fix). SELECTION PHASE: DISCOVERY and CALIBRATION only.
    Holdout is not consulted while the choice is still being made, so it cannot
    become "the first candidate that happened to pass holdout". */
 const selectionPartitions=config.partitions.filter(part=>part.group!=='HOLDOUT');
 const holdoutPartitions=config.partitions.filter(part=>part.group==='HOLDOUT');
 if(!selectionPartitions.length)
  return refuse('wiring','ranked selection needs at least one non-holdout partition');
 /* P5 (S10 protocol fix). A candidate the pipeline cannot read is unevaluable
    and is recorded as such. An error it does not recognise is a defect in this
    code and must stop the experiment rather than be filed as a refusal: a bug
    that reads as "the candidate refused" is a result that looks like evidence. */
 const KNOWN_UNEVALUABLE=[/^resource value must be an integer$/];
 const BUDGET_EXCEEDED=/^FRAME_BUDGET_EXCEEDED:/;
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
    stage:null,reason:'the typed field backing this group could not be recovered',
    detail:{notAnError:true},framesSpent:searchFrames.spent()};
   attempts.push(skipped);discovered.rankedAttempts.push(skipped);continue;
  }
  if(searchFrames.exhausted()){
   const stopped={rank:entry.rank,address:field.address,mask:representative.field.mask,
    score:entry.score.total,outcome:'SKIPPED',stage:null,
    reason:'the shared frame budget for the ranked search was spent before this candidate',
    detail:{notAnError:true,framesSpent:searchFrames.spent(),budget:config.searchFrameBudget},
    framesSpent:searchFrames.spent()};
   attempts.push(stopped);discovered.rankedAttempts.push(stopped);continue;
  }
  driver.restore(pristine);
  const before=searchFrames.spent();
  let outcome;
  try{outcome=evaluateResource({mask:representative.field.mask,field},
   {partitions:selectionPartitions,promote:false});}
  catch(problem){
   if(BUDGET_EXCEEDED.test(problem.message)){
    /* M3: an overrun inside a candidate. Named, not an error and not a refusal
       by the candidate: the experiment ran out of its declared frames. */
    outcome={outcome:'BUDGET_EXCEEDED',stage:'budget',reason:problem.message,
     detail:{framesSpent:framesSpent,budget:config.searchFrameBudget,
      note:'the candidate was not judged; the declared frame budget ended mid-evaluation'}};
    const attempt={rank:entry.rank,address:field.address,mask:representative.field.mask,
     score:entry.score.total,outcome:outcome.outcome,stage:outcome.stage,
     reason:outcome.reason,detail:outcome.detail,framesSpent:framesSpent-before};
    attempts.push({...attempt,field,representative});
    discovered.rankedAttempts.push(attempt);
    break;
   }
   const known=KNOWN_UNEVALUABLE.some(pattern=>pattern.test(problem.message));
   if(!known){
    /* Not swallowed. An unrecognised failure aborts the run. */
    problem.message='ranked selection aborted on an unrecognised error while evaluating '
     +'candidate at address '+field.address+': '+problem.message
     +' (this is a defect in the pipeline, not a refusal by the candidate)';
    throw problem;
   }
   outcome={outcome:'UNEVALUABLE',stage:'decode',reason:problem.message,
    detail:{knownUnevaluable:true,
     note:'the value could not be decoded along the track; it was NOT coerced, so no depletion was inferred'}};
  }
  const attempt={rank:entry.rank,address:field.address,mask:representative.field.mask,
   score:entry.score.total,outcome:outcome.outcome,stage:outcome.stage||null,
   reason:outcome.reason||null,detail:outcome.detail||null,
   framesSpent:searchFrames.spent()-before};
  attempts.push({...attempt,field,representative});
  discovered.rankedAttempts.push(attempt);
 }
 for(const attempt of attempts)
  if(attempt.outcome==='REFUSED'||attempt.outcome==='UNEVALUABLE')
   refusals.push({stage:attempt.stage,candidate:attempt.address,
    outcome:attempt.outcome,reason:attempt.reason,...(attempt.detail||{})});
 const induced_=attempts.filter(attempt=>attempt.outcome==='INDUCED'
  &&attempt.detail&&attempt.detail.polarityEvidenced===true);
 const selectionSummary={
  partitionsUsedForSelection:selectionPartitions.map(part=>part.group),
  holdoutWithheldDuringSelection:true,
  candidatesEvaluated:attempts.length,
  candidatesInduced:induced_.length,
  candidatesRefused:attempts.filter(a=>a.outcome==='REFUSED').length,
  candidatesUnevaluable:attempts.filter(a=>a.outcome==='UNEVALUABLE').length,
  candidatesSkipped:attempts.filter(a=>a.outcome==='SKIPPED').length,
  framesSpent:searchFrames.spent(),frameBudget:config.searchFrameBudget,
  perCandidate:attempts.map(a=>({rank:a.rank,address:a.address,outcome:a.outcome,
   stage:a.stage,reason:a.reason,framesSpent:a.framesSpent}))};
 discovered.rankedSelectionPhase=selectionSummary;
 if(!induced_.length)
  return refuse('ranked-selection',
   'no candidate inside the declared budget was induced as NEGATIVE on the selection partitions',
   selectionSummary);
 /* The choice is fixed HERE, by the pre-registered rule, on selection-partition
    evidence alone. attempts is in ranking order, so the first induced candidate
    IS what the rule selects; nothing is re-ordered once outcomes are known. */
 const chosen=induced_[0];
 note('select',{chosenAddress:chosen.address,chosenRank:chosen.rank,
  candidatesInduced:induced_.length,
  inducedAddresses:induced_.map(attempt=>attempt.address),
  partitions:selectionPartitions.map(part=>part.group),
  rule:Candidates.RANKING_SPEC.selectionRuleWhenSeveralPass});
 /* CONFIRMATION PHASE: only now does holdout see anything, and only the one
    candidate already chosen. Its verdict is an independent check, not a filter
    that selection could have shopped through. */
 if(!holdoutPartitions.length)
  return refuse('ranked-holdout','no HOLDOUT partition is configured, so the fixed choice cannot be checked independently',
   {...selectionSummary,chosenAddress:chosen.address});
 driver.restore(pristine);
 /* The container is created BEFORE the call. A VERIFIED confirmation freezes
    `discovered` on its way out, and Object.freeze is shallow, so a property
    added to `discovered` afterwards throws while a property written into an
    object that already hangs off it does not. This is the same trap that
    rankedAttempts was written to avoid, and it only surfaces on a cartridge
    where a candidate is actually selected - which is why the synthetic control
    caught it and the real cartridges, where nothing is induced, would not. */
 const confirmationRecord={chosenAddress:chosen.address,chosenRank:chosen.rank,
  partitionsUsed:config.partitions.map(part=>part.group),
  outcome:null,stage:null,reason:null,detail:null,framesSpent:null};
 discovered.rankedConfirmation=confirmationRecord;
 /* The confirmation phase spends frames from the same budget, so it can run out
    too. Found by the budget ladder: at one budget the overrun landed inside the
    candidate loop and was named, while at a larger one it landed in
    confirmation and escaped as an unhandled error. Both are the same condition
    and both are now named. */
 let confirmation;
 try{confirmation=evaluateResource({mask:chosen.mask,field:chosen.field},
  {partitions:config.partitions,promote:true});}
 catch(problem){
  if(!BUDGET_EXCEEDED.test(problem.message))throw problem;
  confirmation={outcome:'BUDGET_EXCEEDED',stage:'budget',reason:problem.message,
   detail:{framesSpent,budget:config.searchFrameBudget,
    note:'the selected candidate was not checked against holdout: the declared frame budget ended during confirmation'}};
 }
 confirmationRecord.outcome=confirmation.outcome;
 confirmationRecord.stage=confirmation.stage||null;
 confirmationRecord.reason=confirmation.reason||null;
 confirmationRecord.detail=confirmation.detail||null;
 confirmationRecord.framesSpent=searchFrames.spent();
 note('confirm',{address:chosen.address,outcome:confirmation.outcome,stage:confirmation.stage||null});
 /* A budget that ended during confirmation is NOT a holdout failure, and must
    not be reported as one: the check never ran. The top-level reason said
    "did not survive the independent holdout check" for both until the budget
    ladder made the difference visible. */
 if(confirmation.outcome==='BUDGET_EXCEEDED')
  return refuse('ranked-budget',
   'the declared frame budget ended during confirmation, so the selected candidate was never checked against holdout',
   {...selectionSummary,chosenAddress:chosen.address,chosenRank:chosen.rank,
    framesSpent,budget:config.searchFrameBudget,
    holdoutWasNotConsulted:true,
    note:'this is an exhausted budget, not a verdict about the candidate'});
 if(confirmation.outcome!=='VERIFIED')
  return refuse('ranked-holdout',
   'the candidate selected on DISCOVERY and CALIBRATION did not survive the independent holdout check',
   {...selectionSummary,chosenAddress:chosen.address,chosenRank:chosen.rank,
    holdoutStage:confirmation.stage||null,holdoutReason:confirmation.reason||null,
    holdoutDetail:confirmation.detail||null});
 return confirmation.result;
}

const api={SCHEMA_VERSION,PIPELINE_REVISION,DEFAULTS,run};
root.FlyAgodPipeline=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
