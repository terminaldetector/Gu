/* Experimental AGOD goal induction (TZ v2.0, AGOD-06/07/09, E4).
   Consumes causal evidence from agod-causal.js and turns it into phase and
   polarity hypotheses - conservatively. Nothing here reads an oracle, and
   nothing here emits a reward: reward is the broker's job (agod-reward.js).

   Deliberate asymmetry, and the core claim of this module: a NEGATIVE polarity
   can be evidenced from inside the emulator, a POSITIVE one cannot. Depleting a
   resource until normal play stops is observable. "A counter went up" is not
   value, and 1.3 forbids treating it as reward, so an accumulator never rises
   above a candidate here. Not wired into any production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=1,DETECTOR_REVISION='agod-goals-s3-2';
const PHASES=Object.freeze(['BOOT','MENU','PLAYING','PAUSED','DEATH','RESPAWN','TRANSITION','COMPLETE','UNKNOWN']);
const POLARITY=Object.freeze(['POSITIVE','NEGATIVE','NEUTRAL','UNKNOWN']);
const LIFECYCLE=Object.freeze(['CANDIDATE','TESTING','CALIBRATED','VERIFIED','CONTRADICTED','INVALIDATED','EXPIRED','UNKNOWN']);
const SIGNIFICANCE=Object.freeze(['PRIMARY','AUXILIARY','UNKNOWN']);
const frozen=Object.freeze.bind(Object);

function requireArray(value,label){if(!Array.isArray(value))throw new Error(label+' must be an array');return value;}
function requireInt(value,label){if(!Number.isInteger(value))throw new Error(label+' must be an integer');return value;}

/* A resource track is a series of observations of one address taken around a
   repeated action. The caller supplies values; this module does not drive the
   emulator. */
function analyseResource(track){
 const values=requireArray(track.values,'resource values').map(v=>requireInt(v,'resource value'));
 if(values.length<3)return {monotone:false,reason:'fewer than three samples'};
 let decreasing=true,increasing=true;
 for(let i=1;i<values.length;i++){
  if(values[i]>values[i-1])decreasing=false;
  if(values[i]<values[i-1])increasing=false;
 }
 const floor=Math.min(...values),reachedFloorAt=values.indexOf(floor);
 const settledAtFloor=values.slice(reachedFloorAt).every(v=>v===floor);
 return {monotone:decreasing||increasing,decreasing,increasing,floor,reachedFloorAt,settledAtFloor,
  samples:values.length};
}

/* Terminal evidence: effects that the causal engine confirmed while the
   resource was intact must stop being reproducible once it is exhausted.
   Losing previously confirmed effects is the observable part of "the game
   stopped being playable"; a single RAM flag is explicitly not enough (AGOD-06).

   Scope matters here. A cartridge keeps echoing the pressed button into RAM
   even when the player is dead, so "every confirmed effect disappeared" is the
   wrong bar - input plumbing never disappears. The caller therefore passes the
   addresses that represent play itself (taken from the causal engine, not from
   any oracle), and suppression is judged over exactly those. Separating input
   plumbing from game state in general is NOT solved here; the caller's scope is
   the honest boundary. */
function terminalEvidence(options){
 const before=new Set(requireArray(options.confirmedBeforeDepletion,'confirmedBeforeDepletion'));
 const after=new Set(requireArray(options.confirmedAfterDepletion,'confirmedAfterDepletion'));
 const scope=options.scope?new Set(requireArray(options.scope,'scope')):null;
 const judged=scope?[...before].filter(address=>scope.has(address)):[...before];
 const lost=judged.filter(address=>!after.has(address)).sort((a,b)=>a-b);
 const retained=judged.filter(address=>after.has(address)).sort((a,b)=>a-b);
 const suppressed=judged.length>0&&lost.length===judged.length;
 return {observedBefore:before.size,observedAfter:after.size,
  judgedEffects:judged.length,scoped:!!scope,
  lostEffects:lost,retainedEffects:retained,
  normalPlaySuppressed:suppressed,
  partialSuppression:lost.length>0&&!suppressed};
}

/* Distinguishing a menu from a death.
   Both suppress normal play. The separator used here is reversibility by the
   same action: a toggle restores play, an exhausted resource does not. */
function classifyPhase(signals){
 const resource=signals.resource||null,terminal=signals.terminal||null;
 const reversible=signals.suppressionReversibleBySameAction===true;
 const depleted=!!(resource&&resource.decreasing&&resource.settledAtFloor);
 if(!terminal||terminal.observedBefore===0)return {value:'UNKNOWN',reason:'no confirmed effects to test suppression against',evidence:{resource,terminal}};
 if(!terminal.normalPlaySuppressed)return {value:'PLAYING',reason:'previously confirmed action effects remain reproducible',evidence:{resource,terminal}};
 if(reversible)return {value:'MENU',reason:'play is suppressed but the same action restores it',evidence:{resource,terminal}};
 if(depleted)return {value:'DEATH',reason:'a monotonically decreasing resource settled at its floor and every confirmed effect stopped reproducing',evidence:{resource,terminal}};
 return {value:'UNKNOWN',reason:'play is suppressed but neither reversibility nor resource depletion explains it',evidence:{resource,terminal}};
}

/* Polarity induction.

   NEGATIVE is issued only when all of the following hold, each measured:
     - the action monotonically decreases the variable,
     - the variable settles at a floor,
     - at that floor every previously confirmed effect stops reproducing.
   That chain is what makes the change harmful in the game's own terms rather
   than merely downward.

   POSITIVE is never issued at VERIFIED. An accumulator that an action raises is
   reported as a CANDIDATE with polarity UNKNOWN and an explicit note, because
   nothing observed inside the emulator distinguishes "score" from "a counter
   that happens to rise". Calling it reward is exactly the shortcut 1.3 bans. */
/* TERMINAL_RESOURCE_DEPLETION is a fact. NEGATIVE_GAME_REWARD is a judgement
   about that fact, and the two were conflated (Sol mandatory check).

   The chain E4 requires - monotone decrease, a floor, and previously confirmed
   effects ceasing there - is equally true of a resource that must be SPENT to
   progress. On such a game the floor is completion rather than death, and
   calling the spend harmful is simply wrong. So the fact is reported as a fact,
   and the judgement needs evidence of its own.

   Two discriminators, both observable from inside the emulator:

     coupled gain      the same action also causes a persisting monotone
                       INCREASE somewhere. A cost that buys something is not
                       evidence of harm.
     reversible floor  another action restores the resource AND the gain
                       survives that reversal. Then the floor is not an ending
                       and going round again is useful.

   Either one blocks NEGATIVE_GAME_REWARD and leaves the loss provisional. */
function depletionFact(options){
 const resource=options.resource||null;
 const terminal=options.terminal||null;
 const present=!!(resource&&resource.decreasing&&resource.settledAtFloor&&
  terminal&&terminal.normalPlaySuppressed);
 return frozen({fact:present?'TERMINAL_RESOURCE_DEPLETION':'NONE',
  observed:frozen({decreasing:!!(resource&&resource.decreasing),
   settledAtFloor:!!(resource&&resource.settledAtFloor),
   normalPlaySuppressed:!!(terminal&&terminal.normalPlaySuppressed)}),
  note:'this is what was seen, not what it is worth'});
}

function judgeResourceLoss(options){
 const fact=options.fact&&options.fact.fact?options.fact.fact:depletionFact(options).fact;
 const coupledGains=requireArray(options.coupledGains||[],'coupledGains');
 const floorReversible=options.floorReversible===true;
 const gainRetainedAcrossReversal=options.gainRetainedAcrossReversal===true;
 const blockers=[];
 if(fact!=='TERMINAL_RESOURCE_DEPLETION')blockers.push('no terminal resource depletion was observed');
 if(coupledGains.length)
  blockers.push('the same action also raises '+coupledGains.length+' persisting field(s): a cost that buys something is not evidence of harm');
 if(floorReversible&&gainRetainedAcrossReversal)
  blockers.push('another action restores the resource and the gain survives it: the floor is not an ending');
 const judged=blockers.length===0;
 return frozen({fact,
  judgement:judged?'NEGATIVE_GAME_REWARD':'UNKNOWN',
  /* Named so it can never be read as a measured verdict of harmlessness. */
  classification:judged?'cost':(fact==='TERMINAL_RESOURCE_DEPLETION'?'PROVISIONAL_SACRIFICE':'NOT-APPLICABLE'),
  blockers,coupledGains:coupledGains.slice(0,16),
  floorReversible,gainRetainedAcrossReversal,
  reason:judged
   ?'the action depletes a resource to a floor, play stops there, and nothing observable is gained in exchange'
   :'the depletion is real but its cost to the game is not established; an external source of truth is required'});
}

function induceGoal(options){
 const id=typeof options.id==='string'&&options.id?options.id:null;
 if(!id)throw new Error('goal hypothesis needs an id');
 const mask=requireInt(options.actionMask,'actionMask');
 const address=requireInt(options.address,'address');
 const resource=options.resourceTrack?analyseResource(options.resourceTrack):null;
 const terminal=options.terminal?terminalEvidence(options.terminal):null;
 const causalConfirmed=options.causalConfirmed===true;
 const independentStarts=requireInt(options.independentStarts||0,'independentStarts');
 const alternatives=requireArray(options.alternatives||[],'alternatives');
 const evidenceRefs=requireArray(options.evidenceRefs||[],'evidenceRefs');

 let polarity='UNKNOWN',lifecycle='CANDIDATE',significance='UNKNOWN',rationale='insufficient evidence';
 const depletion=depletionFact({resource,terminal});
 /* The judgement is applied only when the caller supplies the evidence it needs.
    Without it the original E4 behaviour stands unchanged, so E4's published
    numbers remain reproducible; the pipeline supplies it. */
 const lossJudgement=options.coupledGains!==undefined||options.floorReversible!==undefined
  ?judgeResourceLoss({fact:depletion,coupledGains:options.coupledGains||[],
    floorReversible:options.floorReversible,gainRetainedAcrossReversal:options.gainRetainedAcrossReversal})
  :null;
 const judgementBlocks=!!(lossJudgement&&lossJudgement.judgement!=='NEGATIVE_GAME_REWARD');
 const negativeChain=!!(causalConfirmed&&resource&&resource.decreasing&&resource.settledAtFloor&&
   terminal&&terminal.normalPlaySuppressed)&&!judgementBlocks;
 if(negativeChain){
  polarity='NEGATIVE';significance='PRIMARY';
  lifecycle=independentStarts>=2?'CALIBRATED':'TESTING';
  rationale='an action-caused monotone decrease reached a floor and suppressed every previously confirmed effect';
 }else if(judgementBlocks&&depletion.fact==='TERMINAL_RESOURCE_DEPLETION'){
  /* The fact stands; only the verdict is withheld. */
  polarity='UNKNOWN';lifecycle='CANDIDATE';significance='UNKNOWN';
  rationale='terminal resource depletion was observed, but it is not evidenced as a cost: '+lossJudgement.blockers.join('; ');
 }else if(causalConfirmed&&resource&&resource.increasing&&!resource.decreasing){
  polarity='UNKNOWN';lifecycle='CANDIDATE';significance='UNKNOWN';
  rationale='an action raises this value, which is not evidence of benefit: an accumulator cannot be shown positive from inside the emulator';
 }else if(causalConfirmed){
  polarity='UNKNOWN';lifecycle='CANDIDATE';rationale='the action changes this address but no resource or terminal structure was observed';
 }
 /* VERIFIED is never reached here. Promotion to VERIFIED requires holdout
    evidence from the registry (AGOD-08/09), which this module does not own. */
 return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
  id,actionMask:mask,address,
  polarity,lifecycle,significance,
  rationale,
  horizon:options.horizon===undefined?'unknown':options.horizon,
  causalConfirmed,independentStarts,
  resource:resource?frozen(resource):null,
  terminal:terminal?frozen(terminal):null,
  alternatives:alternatives.slice(0,16),
  evidenceRefs:evidenceRefs.slice(0,32),
  confidence:null,calibrationStatus:'uncalibrated',
  depletionFact:depletion.fact,
  lossJudgement:lossJudgement,
  verifiable:negativeChain,
  positiveClaimBlocked:!!(resource&&resource.increasing&&!resource.decreasing)});
}

const api={SCHEMA_VERSION,DETECTOR_REVISION,depletionFact,judgeResourceLoss,PHASES,POLARITY,LIFECYCLE,SIGNIFICANCE,
 analyseResource,terminalEvidence,classifyPhase,induceGoal};
root.FlyAgodGoals=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
