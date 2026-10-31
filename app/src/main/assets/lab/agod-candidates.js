/* AGOD S9: a candidate inventory, observed grouping, and a pre-registered
   ranking over evidence quality.

   WHY THIS EXISTS. The pipeline committed to the first decreasing field it
   typed - first by mask traversal order, then by address within the mask - and
   never revisited that choice. On seven synthetic cartridges with exactly one
   resource that was adequate. On a real cartridge it is arbitrary: Life Force
   yielded 922, 927 or 939 depending only on how many spans reached typing, and
   those three are adjacent BCD digits of one quantity.

   WHAT THIS DOES NOT CLAIM. Ranking cannot conjure a goal that is not there.
   No candidate other than the first has passed independent verification yet, so
   this module is an instrument for asking whether better-founded candidates
   exist, not a mechanism for producing a VERIFIED result.

   THREE RULES THIS MODULE IS BUILT AROUND:
     1. Adjacency and a shared encoding do NOT group two fields. Grouping needs
        observed joint dynamics: total agreement on an INFORMATIVE movement
        pattern - one that contains both a moved and a not-moved transition, so
        that agreeing on it could have failed - or an observed digit carry.
        Two fields that both move on every transition agree trivially and are
        not grouped on that basis.
     2. The ranking weights are declared in RANKING_SPEC and frozen. They were
        committed before any HOLDOUT seed or real cartridge was run through
        ranked selection, and they are not functions of any result.
     3. A downstream read is not proof of usefulness, and the absence of an
        observed downstream effect is not proof that nothing consumes the field.
        Criterion 5 is therefore weighted below the four that can be established
        from inside the emulator.

   No oracle is read. No address is taken from any external source. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);
const Consumers=root.FlyAgodConsumers||(require_?require_('./agod-consumers.js'):null);

const SCHEMA_VERSION=1,CANDIDATES_REVISION='agod-candidates-s9-1';
const frozen=Object.freeze.bind(Object);

/* ---------------------------------------------------------------------------
   PRE-REGISTERED RANKING SPEC

   Weights are small integers and the criteria are ordered by how firmly each
   can be established from inside an emulator, which is the only principle
   used to set them. They are not tuned, and nothing below is a function of any
   measured outcome.
   --------------------------------------------------------------------------- */
const RANKING_SPEC=frozen({
 specRevision:'s9-ranking-1',
 declaredBefore:'committed in the commit that introduces this module, before any HOLDOUT seed or real cartridge was evaluated under ranked selection',
 totalWeight:19,
 criteria:frozen([
  frozen({id:'causality',weight:5,
   question:'was this address shown to change because of the action, against a frame-matched neutral control?',
   measured:'the fraction of independent starts where the causal probe confirmed this address for its mask',
   whyThisWeight:'a field that is not causally attributed cannot carry evidence about an action at all, so this is the prerequisite for every other criterion'}),
  frozen({id:'crossStartReproducibility',weight:4,
   question:'does it move the same way from several independent starting states?',
   measured:'the fraction of independent starts where the field moved, and whether the per-start step agreed',
   whyThisWeight:'one trajectory is an anecdote; agreement across starts is the cheapest strong evidence available here'}),
  frozen({id:'informativeValues',weight:3,
   question:'does it reach values that can carry information - more than one distinct value, a non-zero value, and a floor it settles at?',
   measured:'distinct values observed, whether a non-zero value was reached, whether a floor was reached and held',
   whyThisWeight:'a field pinned at one value cannot be measured against anything; this is what defeated every Life Force candidate in S8'}),
  frozen({id:'separability',weight:3,
   question:'is it distinguishable from a timer, from RNG, and from plain input echo?',
   measured:'moved under the neutral control, how many different masks move it, whether its step is constant across starts',
   whyThisWeight:'these three confounds are the documented failure modes of this pipeline (101 false attributions without shift control, 55 false typings without a neutral run), so they are weighted equal to reachability'}),
  frozen({id:'observedFunctionalEffect',weight:2,
   question:'did substituting the value change what the machine did next?',
   measured:'the S4c downstream counterfactual, when a poke-capable driver and budget are available',
   whyThisWeight:'deliberately below the four above: a null here is uninformative (read-modify-write and reads without visible effect both produce it), so it may raise a candidate but must not be able to sink one'}),
  frozen({id:'phaseAndRestoreRobustness',weight:2,
   question:'does the behaviour survive a savestate restore, and does it still hold after a Start pulse?',
   measured:'identical series after restore, and whether it still moves after a Start pulse',
   whyThisWeight:'the game phase is itself an inference, so this guards against a candidate that exists only in one transient screen, but cannot outrank directly measurable evidence'})]),
 scoring:'each criterion yields a score in [0,1] from its own measurement, is multiplied by its weight, and the weighted sum is divided by totalWeight. No criterion can veto another.',
 tieBreak:frozen(['higher causality score','higher crossStartReproducibility score',
  'more distinct values observed','wider span','lower address']),
 selectionRuleWhenSeveralPass:'the highest-ranked candidate by this spec that passed, with ties broken by tieBreak. NEVER the one whose outcome looks best, and never re-ranked after seeing outcomes.',
 forbidden:frozen(['no address from an external source or a game document',
  'no oracle label as an input to scoring',
  'a downstream read is not proof of usefulness; its absence is not proof of no consumer',
  'HOLDOUT must not be used to tune weights or to re-pick candidates after a failure'])});

const clamp01=value=>value<0?0:(value>1?1:value);
const ratio=(part,whole)=>whole>0?clamp01(part/whole):0;

/* ---------------------------------------------------------------------------
   S9A: INVENTORY

   observe() gathers, for one typed field, everything the ranking is allowed to
   use. It takes a probe rather than a driver so that the frame cost is the
   caller's to budget, and it never looks at an oracle.

   probe: {
     restore(snapshot), drive(mask, pulses), read(field), ram(),
     snapshot(), startSnapshots: [{id, snapshot}], neutralMoved: Set,
     masksMoving(address) -> number, poke? , pristine
   }
   --------------------------------------------------------------------------- */
function observe(probe,options){
 const field=options.field,mask=options.mask;
 const pulses=Number.isInteger(options.pulses)?options.pulses:8;
 const starts=options.starts||probe.startSnapshots||[];
 const confirmedStarts=options.confirmedStarts||0;
 const independentStarts=options.independentStarts||starts.length;

 /* dynamics from each independent start */
 const perStart=[];
 for(const start of starts){
  probe.restore(start.snapshot);
  const series=[probe.read(field)];
  const movedOnTransition=[];
  for(let pulse=0;pulse<pulses;pulse++){
   const before=probe.read(field);
   probe.drive(mask,1);
   const after=probe.read(field);
   series.push(after);
   movedOnTransition.push(after!==before);
  }
  const steps=[];
  for(let i=1;i<series.length;i++)if(series[i]!==series[i-1])steps.push(series[i]-series[i-1]);
  perStart.push(frozen({startId:start.id,series:frozen(series),
   movedOnTransition:frozen(movedOnTransition),
   moved:steps.length>0,
   distinctSteps:new Set(steps).size,
   step:new Set(steps).size===1?steps[0]:null}));
 }
 const movedStarts=perStart.filter(entry=>entry.moved).length;
 const stepsSeen=new Set(perStart.filter(entry=>entry.step!==null).map(entry=>entry.step));
 const stepAgreesAcrossStarts=stepsSeen.size===1&&movedStarts===perStart.length;

 /* reachability: distinct values, a non-zero value, and a floor that holds */
 const values=new Set();
 for(const entry of perStart)for(const value of entry.series)values.add(value);
 let floorValue=null,floorHeld=false;
 if(starts.length){
  probe.restore(starts[0].snapshot);
  let last=probe.read(field),stable=0;
  for(let pulse=0;pulse<pulses*3;pulse++){
   probe.drive(mask,1);
   const now=probe.read(field);
   if(now===last){stable++;if(stable>=4){floorValue=now;floorHeld=true;break;}}
   else stable=0;
   last=now;
  }
  if(floorValue===null)floorValue=last;
 }

 /* restore reproducibility: the same drive from a mid-drive snapshot twice */
 let restoreReproducible=null;
 if(starts.length){
  probe.restore(starts[0].snapshot);
  probe.drive(mask,Math.max(1,Math.floor(pulses/2)));
  const mid=probe.snapshot();
  const runFromMid=()=>{probe.restore(mid);const out=[];
   for(let pulse=0;pulse<pulses;pulse++){probe.drive(mask,1);out.push(probe.read(field));}
   return out.join(',');};
  restoreReproducible=runFromMid()===runFromMid();
 }

 /* phase dependence: does it still move after a Start pulse?
    Start is mask 8. A field that only exists on one screen fails here. */
 let movesAfterStartPulse=null;
 if(starts.length){
  probe.restore(starts[0].snapshot);
  probe.drive(8,1);
  const before=probe.read(field);
  probe.drive(mask,pulses);
  movesAfterStartPulse=probe.read(field)!==before;
 }

 /* separability from timers, RNG and input echo */
 const span=[];for(let k=0;k<field.width;k++)span.push(field.address+k);
 const movedUnderNeutral=span.some(address=>probe.neutralMoved&&probe.neutralMoved.has(address));
 const masksMoving=probe.masksMoving?Math.max(...span.map(address=>probe.masksMoving(address))):null;

 return frozen({
  field:frozen({address:field.address,width:field.width,encoding:field.encoding,
   encodingDetermined:field.encodingDetermined,endian:field.endian,step:field.step,
   direction:field.direction,mask}),
  detectorRevision:Ram?Ram.DETECTOR_REVISION:null,
  signedness:'NOT DECLARED: unsigned and two-complement steps coincide modulo the width, so the detector refuses signedness',
  causality:frozen({confirmedStarts,independentStarts,
   confirmedFraction:ratio(confirmedStarts,independentStarts)}),
  dynamics:frozen({perStart:frozen(perStart),startsObserved:perStart.length,
   startsWhereItMoved:movedStarts,stepAgreesAcrossStarts,
   stepsSeen:frozen([...stepsSeen].sort((a,b)=>a-b))}),
  reachability:frozen({distinctValues:values.size,
   values:frozen([...values].sort((a,b)=>a-b).slice(0,16)),
   reachedNonZero:[...values].some(value=>value!==0),
   floorValue,floorHeld}),
  restore:frozen({seriesIdenticalAfterRestore:restoreReproducible}),
  phase:frozen({movesAfterStartPulse,
   resetTested:false,
   resetNote:'a hardware reset is not exposed by this driver interface, so reset dependence is NOT TESTED rather than ruled out'}),
  separability:frozen({movedUnderNeutralControl:movedUnderNeutral,
   masksThatMoveThisSpan:masksMoving,
   constantStepAcrossStarts:stepAgreesAcrossStarts}),
  downstream:frozen(options.downstream||{status:'NOT-TESTED',
   reason:'no poke-capable driver or no frame budget for a counterfactual on this candidate',
   caution:'NOT-TESTED is not evidence of no consumer'})});
}

/* ---------------------------------------------------------------------------
   S9A: GROUPING FROM OBSERVED JOINT DYNAMICS

   Two records join a group only on observed evidence:
     co-movement  they moved on exactly the same transitions, in every start
                  that was observed, and there was more than one transition;
     carry        on some transition one record wrapped (its value moved against
                  its own direction by more than half its modulus) while the
                  other stepped by exactly +/-1.

   Adjacency, a shared encoding and a shared mask are recorded but never group
   anything on their own: 922/927/939 being adjacent BCD bytes under the same
   button is a hypothesis, and this is where it has to be earned.
   --------------------------------------------------------------------------- */
function modulusOf(record){
 return record.field.encoding==='bcd'?Math.pow(100,record.field.width):Math.pow(256,record.field.width);
}
/* Co-movement is only evidence when the shared pattern could have disagreed.
   Two fields that both move on EVERY transition agree trivially: that is the
   normal state of any two fields driven by the same button, and the first
   version of this rule grouped almost everything because of it - including an
   input-echo byte with a clean resource. Agreement is therefore required to be
   total AND the pattern is required to contain both a moved and a not-moved
   transition, so that agreeing on it says something. */
function coMovement(a,b){
 const byStart=new Map();
 for(const entry of b.dynamics.perStart)byStart.set(entry.startId,entry);
 let shared=0,transitions=0,moved=0,still=0;
 for(const entry of a.dynamics.perStart){
  const other=byStart.get(entry.startId);
  if(!other)continue;
  const n=Math.min(entry.movedOnTransition.length,other.movedOnTransition.length);
  for(let i=0;i<n;i++){
   transitions++;
   if(entry.movedOnTransition[i])moved++;else still++;
   if(entry.movedOnTransition[i]===other.movedOnTransition[i])shared++;
  }
 }
 const informative=moved>0&&still>0;
 return {transitions,movedTransitions:moved,stillTransitions:still,informative,
  agreementTotal:transitions>1&&shared===transitions,
  identical:transitions>1&&shared===transitions&&informative,
  whyNot:transitions<=1?'fewer than two comparable transitions'
   :(shared!==transitions?'the two patterns disagree somewhere'
    :(!informative?'the shared pattern is all-moved or all-still, so agreeing on it is not evidence':null))};
}
function carryBetween(a,b){
 const byStart=new Map();
 for(const entry of b.dynamics.perStart)byStart.set(entry.startId,entry);
 const halfA=modulusOf(a)/2;
 for(const entry of a.dynamics.perStart){
  const other=byStart.get(entry.startId);
  if(!other)continue;
  const n=Math.min(entry.series.length,other.series.length);
  for(let i=1;i<n;i++){
   const deltaA=entry.series[i]-entry.series[i-1];
   const deltaB=other.series[i]-other.series[i-1];
   const wrapped=Math.abs(deltaA)>halfA;
   if(wrapped&&Math.abs(deltaB)===1)return {observed:true,atTransition:i,startId:entry.startId,deltaA,deltaB};
  }
 }
 return {observed:false};
}
function groupRecords(records){
 const parent=records.map((_,index)=>index);
 const find=i=>{while(parent[i]!==i)i=parent[i]=parent[parent[i]];return i;};
 const union=(i,j)=>{const a=find(i),b=find(j);if(a!==b)parent[a]=b;};
 const links=[];
 for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
  const a=records[i],b=records[j];
  const co=coMovement(a,b),carry=carryBetween(a,b);
  const adjacentOrOverlapping=
   a.field.address+a.field.width>=b.field.address&&b.field.address+b.field.width>=a.field.address;
  const reason=carry.observed?'observed digit carry':(co.identical?'identical movement on every observed transition':null);
  if(reason){
   union(i,j);
   links.push(frozen({a:a.field.address,b:b.field.address,reason,
    transitionsCompared:co.transitions,movedTransitions:co.movedTransitions,
    stillTransitions:co.stillTransitions,carry:frozen(carry),
    adjacentOrOverlapping}));
  }else{
   links.push(frozen({a:a.field.address,b:b.field.address,
    reason:null,groupedAnyway:false,transitionsCompared:co.transitions,
    movedTransitions:co.movedTransitions,stillTransitions:co.stillTransitions,
    agreementWasTotal:co.agreementTotal,patternInformative:co.informative,
    whyNotGrouped:co.whyNot,adjacentOrOverlapping,
    note:adjacentOrOverlapping
     ?'adjacent and/or sharing an encoding, but joint dynamics did not support grouping, so they stay separate'
     :'joint dynamics did not support grouping'}));
  }
 }
 const buckets=new Map();
 for(let i=0;i<records.length;i++){
  const key=find(i);
  if(!buckets.has(key))buckets.set(key,[]);
  buckets.get(key).push(records[i]);
 }
 /* P2 (S10 protocol fix). Grouping is a TRANSITIVE CLOSURE over proven links:
    if A-B and B-C are each established by joint dynamics, A and C end up in one
    group even though A-C was never shown directly. That is declared, not
    accidental - a chain of observed co-movement is the evidence - but it means
    a group can contain a pair with no direct link, so each group records the
    proven links it was built from and which of its pairs are indirect. Nothing
    is grouped without at least one proven link on the path. */
 const linkKey=(a,b)=>Math.min(a,b)+'-'+Math.max(a,b);
 const proven=new Set(links.filter(link=>link.reason).map(link=>linkKey(link.a,link.b)));
 const groups=[...buckets.values()].map(members=>{
  /* Representative: the BEST-EVIDENCED member by the pre-registered spec, then
     the widest span, then the most distinct values, then the lowest address.

     The first version used width and address alone, and the unit check caught
     what that costs: when an input-echo byte is grouped with a clean resource,
     a lowest-address rule makes the echo the representative and the group is
     then ranked on the worse evidence of the two. Grouping must never be able
     to demote the evidence it grouped. */
  const sorted=members.slice().sort((x,y)=>
   (scoreRecord(y).total-scoreRecord(x).total)||
   (y.field.width-x.field.width)||
   (y.reachability.distinctValues-x.reachability.distinctValues)||
   (x.field.address-y.field.address));
  const addresses=members.map(member=>member.field.address);
  const directPairs=[],indirectPairs=[];
  for(let i=0;i<addresses.length;i++)for(let j=i+1;j<addresses.length;j++)
   (proven.has(linkKey(addresses[i],addresses[j]))?directPairs:indirectPairs)
    .push([addresses[i],addresses[j]]);
  return frozen({representative:sorted[0],members:frozen(sorted),
   size:members.length,
   addresses:frozen(addresses.slice().sort((a,b)=>a-b)),
   provenLinkPairs:frozen(directPairs),
   transitiveOnlyPairs:frozen(indirectPairs),
   builtByTransitiveClosure:indirectPairs.length>0,
   closureNote:indirectPairs.length
    ?'this group contains pair(s) joined only through a chain of proven links, never directly; declared behaviour, recorded so it can be audited'
    :'every pair in this group is directly proven',
   representativeRule:'highest score by the pre-registered spec, then widest span, then most distinct values, then lowest address'});
 });
 groups.sort((a,b)=>a.representative.field.address-b.representative.field.address);
 return frozen({groups:frozen(groups),links:frozen(links),
  groupingRule:'total agreement on an INFORMATIVE movement pattern (one containing both a moved and a not-moved transition), or an observed digit carry. Adjacency and a shared encoding never group on their own, and agreeing on an all-moved pattern is not evidence.'});
}

/* ---------------------------------------------------------------------------
   S9B: RANKING
   --------------------------------------------------------------------------- */
function scoreRecord(record){
 const c1=record.causality.confirmedFraction;
 const c2=(ratio(record.dynamics.startsWhereItMoved,record.dynamics.startsObserved)*0.7)
  +(record.dynamics.stepAgreesAcrossStarts?0.3:0);
 const distinct=record.reachability.distinctValues;
 const c3=clamp01((distinct>1?0.4:0)+(record.reachability.reachedNonZero?0.3:0)
  +(record.reachability.floorHeld?0.3:0));
 const masks=record.separability.masksThatMoveThisSpan;
 const c4=clamp01((record.separability.movedUnderNeutralControl?0:0.4)
  +(masks===null?0:(masks<=1?0.3:(masks<=2?0.15:0)))
  +(record.separability.constantStepAcrossStarts?0.3:0));
 const consumed=record.downstream&&record.downstream.hasConsumer===true;
 const c5=consumed?1:0;   /* a null or NOT-TESTED scores 0 and sinks nothing: weight 2 of 19 */
 const c6=clamp01((record.restore.seriesIdenticalAfterRestore?0.6:0)
  +(record.phase.movesAfterStartPulse?0.4:0));
 const parts=[['causality',c1],['crossStartReproducibility',c2],['informativeValues',c3],
  ['separability',c4],['observedFunctionalEffect',c5],['phaseAndRestoreRobustness',c6]];
 const weights=new Map(RANKING_SPEC.criteria.map(entry=>[entry.id,entry.weight]));
 let weighted=0;
 const breakdown={};
 for(const [id,value] of parts){
  const rounded=Math.round(value*1000)/1000;
  breakdown[id]=frozen({score:rounded,weight:weights.get(id),contribution:Math.round(rounded*weights.get(id)*1000)/1000});
  weighted+=rounded*weights.get(id);
 }
 return frozen({total:Math.round(weighted/RANKING_SPEC.totalWeight*1000)/1000,
  weightedSum:Math.round(weighted*1000)/1000,breakdown:frozen(breakdown)});
}

function rankGroups(grouped,options){
 const limit=Number.isInteger(options&&options.maxCandidates)?options.maxCandidates:6;
 const scored=grouped.groups.map(group=>frozen({group,score:scoreRecord(group.representative)}));
 scored.sort((a,b)=>{
  if(b.score.total!==a.score.total)return b.score.total-a.score.total;
  const ab=a.score.breakdown,bb=b.score.breakdown;
  if(bb.causality.score!==ab.causality.score)return bb.causality.score-ab.causality.score;
  if(bb.crossStartReproducibility.score!==ab.crossStartReproducibility.score)
   return bb.crossStartReproducibility.score-ab.crossStartReproducibility.score;
  const ar=a.group.representative.reachability.distinctValues,br=b.group.representative.reachability.distinctValues;
  if(br!==ar)return br-ar;
  const aw=a.group.representative.field.width,bw=b.group.representative.field.width;
  if(bw!==aw)return bw-aw;
  return a.group.representative.field.address-b.group.representative.field.address;
 });
 return frozen({specRevision:RANKING_SPEC.specRevision,
  ordered:frozen(scored.map((entry,index)=>frozen({rank:index+1,
   address:entry.group.representative.field.address,
   mask:entry.group.representative.field.mask,
   groupSize:entry.group.size,groupAddresses:entry.group.addresses,
   score:entry.score,record:entry.group.representative}))),
  withinBudget:frozen(scored.slice(0,limit).map((entry,index)=>frozen({rank:index+1,group:entry.group,score:entry.score}))),
  candidatesFound:scored.length,maxCandidates:limit,
  budgetNote:scored.length>limit
   ?('ranking produced '+scored.length+' groups; the declared budget evaluates the top '+limit+'. The rest are recorded and not evaluated.')
   :'every group fits inside the declared candidate budget'});
}

/* Records are frozen, so attaching a late criterion-5 measurement returns a new
   record rather than mutating one. Used by the two-phase ranking, where the
   counterfactual is measured only on the shortlist. */
function withDownstream(record,downstream){
 return frozen({...record,downstream:frozen(downstream)});
}

const api={SCHEMA_VERSION,CANDIDATES_REVISION,RANKING_SPEC,
 observe,groupRecords,rankGroups,scoreRecord,coMovement,carryBetween,withDownstream};
root.FlyAgodCandidates=api;if(typeof module!=='undefined')module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
