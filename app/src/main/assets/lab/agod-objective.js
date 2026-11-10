/* AGOD objective profile and live verified reward (L1).

   THE GAP THIS CLOSES. Everything up to here ends with a VERIFIED goal sitting
   in a worker result, while the learner on the other side of the app still
   needs a human to type a RAM address and a scale. This module is the adapter
   between the two, and it is deliberately small:

     createProfile   turns a VERIFIED goal DTO into a GameObjectiveProfile that
                     is bound to the exact ROM, core, pad layout and detector it
                     was proved on. Nothing else can become a profile.
     matches         re-checks that binding every time a profile is reused, so a
                     profile proved on one cartridge cannot pay out on another.
     createLiveReward watches the LIVE game through that profile and is the only
                     place a number is produced for the learner - by the
                     existing broker's claim(), with the executed action, never
                     by arithmetic here.

   UNKNOWN IS NOT ZERO, end to end. observe() returns a packet. A VERIFIED packet
   has a `value` key. Under the explicit 'aggressive' policy a PROVISIONAL packet
   has one too, on its own channel (see createProfile). UNKNOWN and INVALIDATED
   packets have none, and the
   caller is expected to clear the learner's temporal link instead of sending a
   reward - which is exactly what fdb-feedback.js already does for
   evidenceKnown=false.

   ONE CREDIT PER EVENT, ACROSS RESTARTS. The broker forgets what it paid when
   the page reloads, so the adapter keeps a bounded ledger of paid event ids
   that can be exported with a checkpoint and imported again. An event id is
   derived from the session and the frame the interval ended on, not from a
   counter that restarts at zero.

   A PROFILE CAN BE WITHDRAWN. revoke() stops every later payout and says why.
   What was already learned keeps its provenance; it is not retroactively
   described as proof. */
(function(root){'use strict';
const PROFILE_SCHEMA=1,OBJECTIVE_REVISION='agod-objective-d2-2';
const LEDGER_LIMIT=4096;
const frozen=Object.freeze.bind(Object);

function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value===undefined?null:value);
}
function fnv(text){
 let a=0x811c9dc5,b=0x1b873593;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);
  a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^(c+i),0x85ebca6b)>>>0;}
 return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
}
/* the facts a profile is bound to; a change in any of them is a different game
   as far as a proof is concerned */
function identityOf(source){
 const s=source||{},spec=s.actionSpec||{};
 return {romSha256:s.romSha256||null,platform:s.platform||null,
  coreRevision:s.coreRevision||null,detectorRevision:s.detectorRevision||null,
  buttonCount:Number.isInteger(spec.buttonCount)?spec.buttonCount:null,
  padType:s.padType===undefined?null:s.padType,
  observedRamBytes:Number.isInteger(s.observedRamBytes)?s.observedRamBytes:null};
}
function identityProblems(identity){
 const problems=[];
 for(const key of ['romSha256','platform','coreRevision','detectorRevision'])
  if(typeof identity[key]!=='string'||!identity[key])problems.push('identity lacks '+key);
 if(identity.romSha256&&!/^[0-9a-f]{64}$/.test(identity.romSha256))
  problems.push('romSha256 is not a SHA-256');
 if(!Number.isInteger(identity.buttonCount))problems.push('identity lacks the pad button count');
 if(!Number.isInteger(identity.observedRamBytes))problems.push('identity lacks the observed RAM width');
 return problems;
}

function createProfile(dto,identitySource,modules){
 const refuse=(reason,detail)=>frozen({status:'REFUSED',reason,...(detail||{})});
 const Dto=modules&&modules.Dto;
 if(!dto||dto.status!=='VERIFIED')
  return refuse('only a VERIFIED goal can become an objective profile',
   {dtoStatus:dto?dto.status:null});
 if(Dto&&typeof Dto.validate==='function'){
  const verdict=Dto.validate(dto,{});
  if(!verdict.valid)return refuse('the goal record did not validate',{problems:verdict.problems});
 }
 if(!dto.goal||dto.goal.lifecycle!=='VERIFIED'
  ||(dto.goal.polarity!=='NEGATIVE'&&dto.goal.polarity!=='POSITIVE'))
  return refuse('the goal has no verified polarity');
 if(!dto.resource||!Number.isInteger(dto.resource.address))
  return refuse('the goal names no resource address');
 const identity=identityOf(identitySource);
 const problems=identityProblems(identity);
 if(problems.length)return refuse('the profile cannot be bound to a game',{problems});
 if(dto.resource.address+dto.resource.width>identity.observedRamBytes)
  return refuse('the resource lies outside the observed RAM of this platform');
 const identityKey=fnv(canonical(identity));
 /* PROGRESS FIELDS (D2, the aggressive tier). A resource goal alone teaches an
    agent not to lose; nothing in it says what to do instead, and no level is
    passed by standing still. The pipeline already measures the one behavioural
    fact that separates a quantity the game VALUES from a counter that merely
    grows: what the game takes away when the resource is restored from its
    floor. A field that an action raises, and that the reversal arm destroys,
    is a gain the game itself ties to survival. Position bytes, level counters
    and input echoes are raised by actions too, but survive the reversal, and
    are not taken.

    This is evidence of what the game couples to the resource, NOT a verified
    positive polarity - so it travels as its own PROVISIONAL channel, at a
    fraction of a verified loss, and only when the caller asks for it. */
 const lost=new Set();
 for(const entry of dto.trace||[])
  if(entry.stage==='reverse'&&Array.isArray(entry.lostGainAddresses))
   for(const address of entry.lostGainAddresses)lost.add(address);
 const progress=[],seen=new Set();
 for(const field of (dto.discovered&&dto.discovered.increasingFields)||[]){
  if(!Number.isInteger(field.address)||!lost.has(field.address)||seen.has(field.address))continue;
  if(field.address===dto.resource.address)continue;
  if(field.address+(field.width||1)>identity.observedRamBytes)continue;
  seen.add(field.address);
  progress.push(frozen({address:field.address,width:field.width||1,endian:field.endian,
   encoding:field.encoding,encodingDetermined:field.encodingDetermined===true,
   mask:Number.isInteger(field.mask)?field.mask:null,
   basis:'raised by an action and destroyed by the reversal arm'}));
 }
 return frozen({status:'PROFILE',profileSchema:PROFILE_SCHEMA,
  objectiveRevision:OBJECTIVE_REVISION,
  identity:frozen(identity),identityKey,
  profileRevision:dto.brokerSpec&&dto.brokerSpec.profileRevision||null,
  goal:frozen({id:dto.goal.id,polarity:dto.goal.polarity,lifecycle:dto.goal.lifecycle}),
  resource:frozen({address:dto.resource.address,width:dto.resource.width,
   endian:dto.resource.endian,encoding:dto.resource.encoding,
   encodingDetermined:dto.resource.encodingDetermined===true}),
  actions:dto.actions?frozen({...dto.actions}):null,
  progress:frozen(progress),
  /* the goal record travels with the profile, so the mechanism can be rebuilt
     and so the evidence a payout cites is the evidence that was verified */
  dto});
}

function matches(profile,identitySource){
 if(!profile||profile.status!=='PROFILE')return frozen({ok:false,problems:['not a profile']});
 const now=identityOf(identitySource),problems=[];
 for(const key of Object.keys(profile.identity))
  if(profile.identity[key]!==now[key])
   problems.push(key+' was '+JSON.stringify(profile.identity[key])+' and is '
    +JSON.stringify(now[key]));
 return frozen({ok:problems.length===0,problems});
}

function createLiveReward(profile,modules,options){
 const parts=modules||{},settings=options||{};
 const refuse=reason=>frozen({status:'REFUSED',reason,observe:null});
 if(!profile||profile.status!=='PROFILE')return refuse('a profile is required');
 if(!parts.Dto||!parts.Reward||!parts.Ram)return refuse('Dto, Reward and Ram modules are required');
 const bound=matches(profile,settings.identity);
 if(!bound.ok)return refuse('the profile does not match the running game: '+bound.problems.join('; '));
 const rebuilt=parts.Dto.rebuild(profile.dto,
  {Reward:parts.Reward,Evidence:parts.Evidence,Ram:parts.Ram},{});
 if(rebuilt.status!=='REBUILT'||!rebuilt.broker)
  return refuse('the reward mechanism could not be rebuilt: '+(rebuilt.reason||rebuilt.status));
 const broker=rebuilt.broker;
 const spec=parts.Dto.decodeSpecFor(profile.resource);
 const read=memory=>parts.Ram.decode(memory,spec);
 const sessionId=typeof settings.sessionId==='string'&&settings.sessionId?settings.sessionId:'session';
 const contextKey=profile.dto.brokerSpec&&profile.dto.brokerSpec.contextKey||undefined;
 /* the ledger: event ids already paid, restorable across a restart */
 const ledger=[],paid=new Set();
 for(const id of Array.isArray(settings.ledger)?settings.ledger:[])
  if(typeof id==='string'&&!paid.has(id)){paid.add(id);ledger.push(id);}
 const counts={VERIFIED:0,PROVISIONAL:0,UNKNOWN:0,INVALIDATED:0};
 /* 'strict': only a verified event pays - every result before this was produced
    that way. 'aggressive': a gain in a progress field also pays, as PROVISIONAL. */
 const policy=settings.policy==='aggressive'?'aggressive':'strict';
 const PROGRESS_UNIT=Number.isFinite(settings.progressUnit)?settings.progressUnit:0.25;
 const progressSpecs=(profile.progress||[]).map(field=>parts.Dto.decodeSpecFor(field));
 const readProgress=memory=>progressSpecs.map(spec=>{
  try{const value=parts.Ram.decode(memory,spec);return Number.isFinite(value)?value:null;}
  catch(error){return null;}});
 let revoked=null;
 const packet=(status,reason,extra)=>{counts[status]++;
  return frozen({status,reason,goalId:profile.goal.id,...(extra||{})});};

 function observe(sample){
  const s=sample||{};
  if(revoked)return packet('INVALIDATED','the objective was revoked: '+revoked);
  if(!Number.isInteger(s.endFrame))return packet('UNKNOWN','no end frame for the interval');
  /* either the two RAM images, or the two values already decoded from them
     through this same profile (lab.js samples reward bytes sparsely at the
     moment the retina is captured, so the images no longer exist) */
  let before,after;
  if(Number.isFinite(s.valueBefore)&&Number.isFinite(s.valueAfter)){
   before=s.valueBefore;after=s.valueAfter;
  }else{
   try{before=read(s.ramBefore);after=read(s.ramAfter);}
   catch(error){return packet('UNKNOWN','the resource could not be read');}
  }
  if(!Number.isFinite(before)||!Number.isFinite(after))
   return packet('UNKNOWN','the resource read was not a number');
  const delta=after-before;
  /* which direction is an event depends on the VERIFIED polarity: a loss for a
     NEGATIVE resource goal, a gain for a POSITIVE one. Movement the other way
     is not this goal's event and produces nothing. */
  const eventMagnitude=profile.goal.polarity==='NEGATIVE'?Math.max(0,-delta):Math.max(0,delta);
  /* No event is UNKNOWN, not zero. A "measured zero" for a completed interval
     in which the verified resource did not move was tried as an alternative
     and REVERTED: across 120, 160 and 200 training steps on three seeds it was
     not consistently better than paying losses only (it won one seed and lost
     another at each budget), so it bought nothing and widened the one rule
     this module exists to keep. */
  if(eventMagnitude===0){
   /* THE PROVISIONAL TIER. No verified event; did a progress field rise? The
      same conditions a verified claim must meet apply - the requested action
      ran, to completion, with no human in it, while play was not suppressed -
      and the same ledger makes it payable once. It is paid at PROGRESS_UNIT
      per unit, capped at one unit-step of four, so no amount of provisional
      gain outweighs one verified loss. */
   if(policy==='aggressive'&&progressSpecs.length){
    const executed=s.executed||{};
    const clean=executed.complete===true&&executed.manualOverride!==true
     &&Number.isInteger(executed.mask)&&Number.isInteger(executed.frames)&&executed.frames>0
     &&(!Number.isInteger(s.requestedMask)||s.requestedMask===executed.mask)
     &&(s.phase===undefined||s.phase==='PLAYING')
     &&!(s.episode&&(s.episode.partition==='control'||s.episode.restoredAfterObservation===true));
    const was=Array.isArray(s.progressBefore)?s.progressBefore:(s.ramBefore?readProgress(s.ramBefore):null);
    const now=Array.isArray(s.progressAfter)?s.progressAfter:(s.ramAfter?readProgress(s.ramAfter):null);
    if(clean&&was&&now){
     let gain=0;
     for(let i=0;i<progressSpecs.length;i++)
      if(Number.isFinite(was[i])&&Number.isFinite(now[i])&&now[i]>was[i])gain+=now[i]-was[i];
     if(gain>0){
      const eventId=sessionId+':'+profile.goal.id+':'+s.endFrame+':p';
      if(paid.has(eventId))
       return packet('INVALIDATED','this progress was already credited (ledger)',{eventId});
      paid.add(eventId);ledger.push(eventId);
      if(ledger.length>LEDGER_LIMIT)paid.delete(ledger.shift());
      return packet('PROVISIONAL','a field the game destroys on reversal rose',
       {eventId,channel:'provisional-progress',value:PROGRESS_UNIT*Math.min(4,gain),gain,
        notVerified:'this is a coupled gain, not a verified positive polarity'});
     }
    }
   }
   return packet('UNKNOWN','no verified event in this interval',{delta});
  }
  const eventId=sessionId+':'+profile.goal.id+':'+s.endFrame;
  if(paid.has(eventId))
   return packet('INVALIDATED','this event was already credited (ledger)',{eventId});
  const executed=s.executed||{};
  const claim=broker.claim({eventId,source:'verified-goal',
   profileRevision:profile.profileRevision,contextKey,
   goal:{id:profile.goal.id,lifecycle:profile.goal.lifecycle,
    polarity:profile.goal.polarity,evidenceRefs:profile.dto.goal.evidenceRefs},
   executedAction:{mask:executed.mask,frames:executed.frames,
    complete:executed.complete===true,manualOverride:executed.manualOverride===true},
   requestedMask:s.requestedMask,magnitude:eventMagnitude,
   phase:s.phase||'PLAYING',episode:s.episode,ageMs:s.ageMs});
  if(claim.status!=='VERIFIED')
   return packet(claim.status==='INVALIDATED'?'INVALIDATED':'UNKNOWN',claim.reason,{eventId});
  paid.add(eventId);ledger.push(eventId);
  if(ledger.length>LEDGER_LIMIT)paid.delete(ledger.shift());
  /* the ONLY place a value key appears */
  return packet('VERIFIED','verified '+profile.goal.polarity+' event',
   {eventId,value:claim.value,magnitude:eventMagnitude,
    executedAction:claim.executedAction,evidenceRefs:claim.evidenceRefs});
 }
 return frozen({status:'READY',observe,read,readProgress,policy,
  progressFields:(profile.progress||[]).length,
  revoke(reason){revoked=String(reason||'revoked');broker.revokeGoal(profile.goal.id,revoked);},
  revoked:()=>revoked,
  counts:()=>({...counts}),
  exportLedger:()=>ledger.slice(),
  goalId:profile.goal.id,polarity:profile.goal.polarity});
}

const api={PROFILE_SCHEMA,OBJECTIVE_REVISION,createProfile,matches,createLiveReward,
 identityOf,identityKeyOf:source=>fnv(canonical(identityOf(source)))};
root.FlyAgodObjective=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
