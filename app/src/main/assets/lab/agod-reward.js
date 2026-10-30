/* Experimental Verified Reward Broker (TZ v2.0, section 6, E4).

   The one rule everything here exists to enforce: absence of trustworthy reward
   is not zero reward. A packet with status UNKNOWN carries no `value` field at
   all, so no default, no serialisation round-trip and no arithmetic can quietly
   turn it into 0. Only a goal that reached VERIFIED through the registry can
   produce a numeric value. Not wired into any production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=1,BROKER_REVISION='agod-reward-e4-1';
const STATUS=Object.freeze(['UNKNOWN','OBSERVED','VERIFIED','INVALIDATED']);
const frozen=Object.freeze.bind(Object);
const isInt=Number.isInteger;

function unknown(reason,extra){
 /* No `value` key. Deliberate: a missing key cannot be coerced the way a 0 can. */
 return frozen({schemaVersion:SCHEMA_VERSION,brokerRevision:BROKER_REVISION,
  status:'UNKNOWN',reason,...(extra||{})});
}
function invalidated(reason,extra){
 return frozen({schemaVersion:SCHEMA_VERSION,brokerRevision:BROKER_REVISION,
  status:'INVALIDATED',reason,...(extra||{})});
}

function createBroker(options){
 const config=options||{};
 const allowedSources=new Set(config.allowedSources||['verified-goal']);
 const maxEventAgeMs=isInt(config.maxEventAgeMs)?config.maxEventAgeMs:2000;
 const profileRevision=config.profileRevision;
 if(typeof profileRevision!=='string'||!profileRevision)throw new Error('broker needs a profileRevision');
 const granted=new Set();          /* eventIds already paid: idempotency */
 const revokedGoals=new Set();     /* goals withdrawn after contradiction */
 const journal=[];
 let contextKey=config.contextKey||null;

 const record=entry=>{if(journal.length<512)journal.push(entry);return entry;};

 function revokeGoal(goalId,reason){
  revokedGoals.add(goalId);
  return record(frozen({kind:'revocation',goalId,reason}));
 }

 /* claim() is the only way a number can be produced. Every rejection path
    returns UNKNOWN or INVALIDATED, never a value. */
 function claim(request){
  const r=request||{};
  const eventId=typeof r.eventId==='string'&&r.eventId?r.eventId:null;
  if(!eventId)return record(unknown('missing eventId'));

  if(!allowedSources.has(r.source))
   return record(unknown('source is not allowed to produce reward',{eventId,source:r.source??null}));

  if(r.profileRevision!==profileRevision)
   return record(unknown('stale or foreign profile revision',{eventId,expected:profileRevision,received:r.profileRevision??null}));

  if(contextKey!==null&&r.contextKey!==contextKey)
   return record(invalidated('context drift: a different ROM, core or configuration',{eventId}));

  const goal=r.goal||null;
  if(!goal||typeof goal.id!=='string')return record(unknown('no goal attached',{eventId}));
  if(revokedGoals.has(goal.id))
   return record(invalidated('goal was revoked after a contradiction',{eventId,goalId:goal.id}));
  if(goal.lifecycle!=='VERIFIED')
   return record(unknown('goal is not VERIFIED',{eventId,goalId:goal.id,lifecycle:goal.lifecycle??null}));
  if(goal.polarity!=='POSITIVE'&&goal.polarity!=='NEGATIVE')
   return record(unknown('verified goal has no usable polarity',{eventId,goalId:goal.id,polarity:goal.polarity??null}));

  /* Credit belongs to what the game actually executed, not to what was asked
     for (NN-03). A mask mismatch is a hard invalidation, not a silent zero. */
  const executed=r.executedAction||null;
  if(!executed||!isInt(executed.mask)||!isInt(executed.frames)||executed.frames<1)
   return record(unknown('no executed action interval',{eventId,goalId:goal.id}));
  if(isInt(r.requestedMask)&&r.requestedMask!==executed.mask)
   return record(invalidated('executed mask differs from the requested mask',{eventId,goalId:goal.id,requested:r.requestedMask,executed:executed.mask}));
  if(executed.manualOverride===true)
   return record(invalidated('a human intervened during the interval',{eventId,goalId:goal.id}));
  if(executed.complete!==true)
   return record(unknown('the action interval was not completed',{eventId,goalId:goal.id}));

  /* Episode provenance: a restored control episode must never pay out, and a
     restore makes any earlier in-flight event stale. */
  if(r.episode&&r.episode.partition==='control')
   return record(invalidated('control episodes do not produce reward',{eventId,goalId:goal.id}));
  if(r.episode&&r.episode.restoredAfterObservation===true)
   return record(invalidated('state was restored between observation and outcome',{eventId,goalId:goal.id}));

  /* Phase gate: a transition seen while play is suppressed is not an outcome. */
  if(r.phase==='MENU'||r.phase==='PAUSED')
   return record(invalidated('outcome observed while play was suppressed',{eventId,goalId:goal.id,phase:r.phase}));

  if(isInt(r.ageMs)&&r.ageMs>maxEventAgeMs)
   return record(unknown('outcome is older than the accepted window',{eventId,goalId:goal.id,ageMs:r.ageMs}));

  if(granted.has(eventId))
   return record(invalidated('this event was already credited',{eventId,goalId:goal.id}));

  const magnitude=r.magnitude;
  if(!Number.isFinite(magnitude)||magnitude===0)
   return record(unknown('no finite non-zero magnitude was observed',{eventId,goalId:goal.id}));

  granted.add(eventId);
  const value=goal.polarity==='NEGATIVE'?-Math.abs(magnitude):Math.abs(magnitude);
  return record(frozen({schemaVersion:SCHEMA_VERSION,brokerRevision:BROKER_REVISION,
   status:'VERIFIED',value,eventId,goalId:goal.id,source:r.source,
   polarity:goal.polarity,profileRevision,
   executedAction:frozen({mask:executed.mask,frames:executed.frames}),
   evidenceRefs:Array.isArray(goal.evidenceRefs)?goal.evidenceRefs.slice(0,32):[]}));
 }

 return frozen({claim,revokeGoal,
  setContext(key){contextKey=key;},
  grantedCount(){return granted.size;},
  journal(){return journal.slice();}});
}

/* Internal exploration signals must never travel on the game-reward channel
   (6.2). They are returned under a different key so they cannot be summed with
   a game reward by accident. */
function intrinsicSignal(name,value){
 if(typeof name!=='string'||!name)throw new Error('intrinsic signal needs a name');
 if(!Number.isFinite(value))throw new Error('intrinsic signal must be finite');
 return frozen({schemaVersion:SCHEMA_VERSION,channel:'intrinsic',name,intrinsicValue:value,
  note:'exploration signal, not game reward; never add this to a verified reward value'});
}

const api={SCHEMA_VERSION,BROKER_REVISION,STATUS,createBroker,intrinsicSignal};
root.FlyAgodReward=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
