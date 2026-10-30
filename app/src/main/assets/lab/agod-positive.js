/* Automatic POSITIVE hypotheses (Sol decision 1, the main task).

   E4 established that POSITIVE polarity cannot be proven from inside the
   emulator, and blocked it outright. Sol's decision keeps that conclusion and
   changes what to do about it: do not demand hand labelling of every ROM, and
   do not promote a guess to a reward either. Generate POSITIVE *hypotheses*
   automatically from several independent signs, and measure how often they are
   right, wrong, and withheld.

   So nothing here ever returns VERIFIED, and nothing here carries a `value`
   key. The output is a ProvisionalGoal - a causally confirmed event with
   presumed usefulness and no right to the status of game reward.

   THE RULE IS FIXED HERE, BEFORE MEASUREMENT, and is not a tuned quorum:

     a field is proposed as provisionally positive if and only if
       (1) it rises under one action by a constant step and does not move
           under neutral play, and
       (2) its value survives an action that restores the depleted resource -
           the game itself treats the result as worth keeping, and
       (3) EITHER a named, action-driven field modulates its gain rate, shown by
           changing that field and running a frame-matched neutral control,
           OR driving it far enough unlocks an action that did nothing before.

   Requirement (3) was a single term in S4 - "the rate differs in another game
   state" - and Sol's review was right that this established context dependence
   and never said which field was responsible. The old term is still computed,
   as `contextDependentRate`, so what it was worth can be measured rather than
   argued about.

   Three factors are measured and reported but deliberately NOT part of the
   rule, so their value can be judged rather than assumed: the superseded
   context term, whether advancing the field changes which actions have effects,
   and whether advancing it reaches states neutral play never reaches.

   Two caveats, here rather than in a footnote. The rule factors were chosen
   knowing the controlled families this is measured on, so they must be
   re-measured on a corpus written by someone else. And requirement (3) cannot
   separate a quantity worth pursuing from a useless one that happens to be
   rate-modulated and persisted: the rate-trap family contains exactly such a
   counterexample, deliberately, and it stays a false positive. That boundary is
   a property of what RAM can show, not of this code.

   Not wired into any production screen. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);
const SCHEMA_VERSION=1,PROPOSER_REVISION='agod-positive-s4b-2';
/* The rule after Sol's review of S4. The third requirement is now a
   disjunction, and the first disjunct demands a NAMED modulating field rather
   than "the rate differs in some other context". Both disjuncts say the same
   thing in different ways: the game treats this quantity as mattering, either
   by changing what an action is worth or by changing which actions exist. */
const RULE=Object.freeze(['monotoneNotTimeDriven','survivesResourceReversal',
 'causallyModulatedByAttributedField|unlocksNewMode']);
const RECORDED_ONLY=Object.freeze(['contextDependentRate','changesAvailableActions',
 'reachesStatesNeutralPlayDoesNot']);
const frozen=Object.freeze.bind(Object);

const readField=(memory,field)=>Ram.decode(memory,{address:field.address,width:field.width,
 endian:field.endian==='n/a'?'little':field.endian,
 encoding:field.encodingDetermined?field.encoding:'binary'});

/* Each factor is one experiment, run on the live machine. */
function evaluateFactors(driver,options){
 const candidate=options.candidate,candidateMask=options.candidateMask;
 const resource=options.resource,resourceMask=options.resourceMask;
 const hold=options.hold===undefined?4:options.hold;
 const release=options.release===undefined?8:options.release;
 const settle=options.settle===undefined?30:options.settle;
 const pristine=options.pristine;
 const neutralMoved=options.neutralMoved||new Set();
 const masks=options.masks||[1,2,4,8,16,32,64,128];
 const read=field=>readField(driver.readRam(),field);
 const pulse=(mask,times,gap)=>{for(let i=0;i<(times||1);i++){driver.run(mask,hold);driver.run(0,gap===undefined?release:gap);}};
 const span=field=>{const out=[];for(let i=0;i<field.width;i++)out.push(field.address+i);return out;};

 /* (1) Rises by a constant step under its action, still under neutral play. */
 const monotoneNotTimeDriven=candidate.direction==='increasing'&&
  Number.isFinite(candidate.step)&&candidate.step>0&&
  span(candidate).every(address=>!neutralMoved.has(address));

 /* (2) Does the game keep it when it restores the resource? */
 driver.restore(pristine);
 pulse(candidateMask,3);                       /* accumulate something to lose */
 pulse(resourceMask,8,settle);                 /* drive the resource to its floor */
 const floor=driver.snapshot();
 const floorResource=read(resource),floorCandidate=read(candidate);
 let survivesResourceReversal=false,reversalMask=null,reversalCandidate=null;
 for(const mask of masks){
  if(mask===resourceMask)continue;
  driver.restore(floor);
  pulse(mask,1);
  const restored=read(resource),kept=read(candidate);
  if(restored>floorResource){
   reversalMask=mask;reversalCandidate=kept;
   if(kept>=floorCandidate&&floorCandidate>0){survivesResourceReversal=true;break;}
  }
 }

 /* (3a) SUPERSEDED, kept only to measure what it was worth: does the rate
        differ after the resource action has been applied? This establishes
        context dependence and says nothing about which field is responsible,
        which is the defect Sol's review of S4 identified. */
 const stepAfter=(prepare)=>{driver.restore(pristine);if(prepare)prepare();
  const before=read(candidate);pulse(candidateMask,1);return read(candidate)-before;};
 const baseStep=stepAfter(null);
 const advancedStep=stepAfter(()=>pulse(resourceMask,2,settle));
 const contextDependentRate=baseStep>0&&advancedStep>0&&advancedStep!==baseStep;

 /* (3b) Which field modulates the rate? For each candidate modulator the state
        is reached by that modulator's own action, and the same number of frames
        of neutral play is run as a control. A rate that moves in the control as
        well is time-driven, not modulated by the field. */
 const modulators=(options.modulators||[]).filter(entry=>
  entry&&Number.isFinite(entry.mask)&&entry.field&&entry.field.address!==candidate.address);
 const attributedModulators=[];
 const modulatorTrials=[];
 for(const entry of modulators){
  const pulses=entry.pulses===undefined?2:entry.pulses;
  const gap=entry.settle===undefined?settle:entry.settle;
  const modulated=stepAfter(()=>pulse(entry.mask,pulses,gap));
  const control=stepAfter(()=>driver.run(0,pulses*(hold+gap)));
  const attributed=baseStep>0&&modulated>0&&modulated!==baseStep&&control===baseStep;
  modulatorTrials.push({mask:entry.mask,address:entry.field.address,baseStep,modulated,control,attributed});
  if(attributed)attributedModulators.push({mask:entry.mask,address:entry.field.address,
   baseStep,modulatedStep:modulated});
 }
 const causallyModulatedByAttributedField=attributedModulators.length>0;

 /* Recorded only: which actions still do something, before and after. */
 const effectiveMasks=()=>{
  const before=driver.snapshot(),out=[];
  for(const mask of masks){
   driver.restore(before);
   const ram=driver.readRam();pulse(mask,1);
   const after=driver.readRam();
   let changed=false;
   for(let a=0;a<after.length;a++)if(after[a]!==ram[a]&&!neutralMoved.has(a)){changed=true;break;}
   if(changed)out.push(mask);
  }
  driver.restore(before);return out;
 };
 driver.restore(pristine);
 const actionsBefore=effectiveMasks();
 driver.restore(pristine);pulse(candidateMask,6);
 const actionsAfter=effectiveMasks();
 const changesAvailableActions=actionsBefore.join(',')!==actionsAfter.join(',');

 /* (3c) Does driving this quantity far enough unlock something? A threshold the
        cartridge itself defines shows up as an action that did nothing starting
        to work. The frame-matched control rules out anything that would have
        happened anyway. */
 const unlockPulses=options.unlockPulses===undefined?16:options.unlockPulses;
 driver.restore(pristine);pulse(candidateMask,unlockPulses);
 const actionsAfterDriving=effectiveMasks();
 driver.restore(pristine);driver.run(0,unlockPulses*(hold+release));
 const actionsAfterWaiting=effectiveMasks();
 const gained=actionsAfterDriving.filter(mask=>!actionsBefore.includes(mask));
 const unlocksNewMode=gained.length>0&&
  actionsAfterWaiting.join(',')===actionsBefore.join(',');

 driver.restore(pristine);
 const neutralHashes=new Set();
 for(let i=0;i<8;i++){driver.run(0,hold+release);neutralHashes.add(driver.stateHash());}
 driver.restore(pristine);
 const advancedHashes=[];
 for(let i=0;i<8;i++){pulse(candidateMask,1);advancedHashes.push(driver.stateHash());}
 const reachesStatesNeutralPlayDoesNot=advancedHashes.some(hash=>!neutralHashes.has(hash));

 return frozen({
  monotoneNotTimeDriven,survivesResourceReversal,
  causallyModulatedByAttributedField,unlocksNewMode,
  contextDependentRate,changesAvailableActions,reachesStatesNeutralPlayDoesNot,
  detail:frozen({baseStep,advancedStep,floorCandidate,reversalMask,reversalCandidate,
   actionsBefore,actionsAfter,actionsAfterDriving,actionsAfterWaiting,unlockedMasks:gained,
   attributedModulators,modulatorTrials})});
}

function proposePositive(driver,options){
 if(!Ram)throw new Error('agod-ram is required to decode a candidate');
 const factors=evaluateFactors(driver,options);
 /* The third requirement is a disjunction, so the rule is evaluated term by
    term rather than by counting true factors. */
 const satisfied=term=>term.split('|').some(name=>!!factors[name]);
 const held=RULE.filter(satisfied),missing=RULE.filter(term=>!satisfied(term));
 const proposed=missing.length===0;
 const base={schemaVersion:SCHEMA_VERSION,proposerRevision:PROPOSER_REVISION,
  /* Never VERIFIED, never a `value`: this is a hypothesis, not a reward. */
  channel:'provisional',
  field:frozen({address:options.candidate.address,width:options.candidate.width,
   endian:options.candidate.endian,encoding:options.candidate.encoding,step:options.candidate.step}),
  actionMask:options.candidateMask,
  rule:RULE.slice(),recordedOnly:RECORDED_ONLY.slice(),
  factors,factorsHeld:held,factorsMissing:missing};
 if(!proposed)
  return frozen({...base,status:'ABSTAIN',
   reason:'withheld: '+missing.join(', ')+' did not hold, and the rule is not a vote'});
 return frozen({...base,status:'PROVISIONAL_GOAL',lifecycle:'CANDIDATE',polarity:'UNKNOWN',
  significance:'PROVISIONAL',
  reason:'rises by a constant step under one action, survives the action that restores the resource, '+
   'and either a named field modulates its gain rate or driving it unlocks an action that did nothing before',
  evidence:frozen({modulators:factors.detail.attributedModulators,
   unlockedMasks:factors.detail.unlockedMasks}),
  notAReward:'a ProvisionalGoal carries no value and can never be claimed through the broker; '+
   'confirming game semantics needs an independent oracle (11.2)'});
}

const api={SCHEMA_VERSION,PROPOSER_REVISION,RULE,RECORDED_ONLY,evaluateFactors,proposePositive};
root.FlyAgodPositive=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
