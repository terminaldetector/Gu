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
       (3) its gain rate is modulated by another field - something in the game
           makes the same action worth more or less, which is what distinguishes
           a quantity the game cares about from a counter that merely rises.

   Two further factors are measured and reported but deliberately NOT part of
   the rule, so that their value can be judged rather than assumed:
     - whether advancing it changes which actions have effects;
     - whether advancing it reaches states neutral play never reaches.

   Honest caveat, stated here rather than in a footnote: the three rule factors
   were chosen knowing the two controlled families this is measured on. They
   must be re-measured on a corpus written by someone else before the rule is
   worth anything. Not wired into any production screen. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);
const SCHEMA_VERSION=1,PROPOSER_REVISION='agod-positive-s4-1';
const RULE=Object.freeze(['monotoneNotTimeDriven','survivesResourceReversal','gainRateModulated']);
const RECORDED_ONLY=Object.freeze(['changesAvailableActions','reachesStatesNeutralPlayDoesNot']);
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

 /* (3) Is the same action worth more in a different game state? */
 driver.restore(pristine);
 const beforeBase=read(candidate);pulse(candidateMask,1);
 const baseStep=read(candidate)-beforeBase;
 driver.restore(pristine);
 pulse(resourceMask,2,settle);                 /* a different state, still playable */
 const beforeAdvanced=read(candidate);pulse(candidateMask,1);
 const advancedStep=read(candidate)-beforeAdvanced;
 const gainRateModulated=baseStep>0&&advancedStep>0&&advancedStep!==baseStep;

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

 driver.restore(pristine);
 const neutralHashes=new Set();
 for(let i=0;i<8;i++){driver.run(0,hold+release);neutralHashes.add(driver.stateHash());}
 driver.restore(pristine);
 const advancedHashes=[];
 for(let i=0;i<8;i++){pulse(candidateMask,1);advancedHashes.push(driver.stateHash());}
 const reachesStatesNeutralPlayDoesNot=advancedHashes.some(hash=>!neutralHashes.has(hash));

 return frozen({
  monotoneNotTimeDriven,survivesResourceReversal,gainRateModulated,
  changesAvailableActions,reachesStatesNeutralPlayDoesNot,
  detail:frozen({baseStep,advancedStep,floorCandidate,reversalMask,reversalCandidate,
   actionsBefore,actionsAfter})});
}

function proposePositive(driver,options){
 if(!Ram)throw new Error('agod-ram is required to decode a candidate');
 const factors=evaluateFactors(driver,options);
 const held=RULE.filter(name=>factors[name]),missing=RULE.filter(name=>!factors[name]);
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
   'and its gain rate is modulated by another field',
  notAReward:'a ProvisionalGoal carries no value and can never be claimed through the broker; '+
   'confirming game semantics needs an independent oracle (11.2)'});
}

const api={SCHEMA_VERSION,PROPOSER_REVISION,RULE,RECORDED_ONLY,evaluateFactors,proposePositive};
root.FlyAgodPositive=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
