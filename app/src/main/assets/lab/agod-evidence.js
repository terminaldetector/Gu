/* Experimental AGOD evidence registry (TZ v2.0, AGOD-08/09, E4 continued).

   The registry exists to answer one question honestly: is this second piece of
   evidence actually independent of the first? A fresh identifier is explicitly
   not an answer (AGOD-08), so independence is derived from what the evidence was
   produced on - ROM and core identity, the parent save state, and the restore
   path that led there. Two records sharing a parent state are the same start
   wearing two names, and the registry says so.

   It also owns promotion. A hypothesis reaches VERIFIED only from disjoint
   holdout evidence plus an independently evidenced polarity, and never from
   cached records alone, because "кэш не вправе самостоятельно повышать гипотезу
   до VERIFIED". Not wired into any production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=1,REGISTRY_REVISION='agod-evidence-s5-2';
const GROUPS=Object.freeze(['DISCOVERY','CALIBRATION','HOLDOUT','EXCLUDED']);
const LIFECYCLE=Object.freeze(['CANDIDATE','TESTING','CALIBRATED','VERIFIED','CONTRADICTED','INVALIDATED','EXPIRED','UNKNOWN']);
const DEFAULT_TTL_MS=48*60*60*1000;
const frozen=Object.freeze.bind(Object);
/* An evidence record is an observation, so it has to be immutable all the way
   down. Freezing only the top level left `restorePath` writable, and because
   records() hands out the same objects, a push into that array mutated stored
   evidence. The S5 check caught it. */
function deepFrozen(value){
 if(Array.isArray(value))return frozen(value.map(deepFrozen));
 if(value&&typeof value==='object'){
  for(const key of Object.keys(value))value[key]=deepFrozen(value[key]);
  return frozen(value);
 }
 return value;
}
const text=(value,label)=>{if(typeof value!=='string'||!value)throw new Error(label+' must be a non-empty string');return value;};

/* Cheap, dependency-free digest. Identity here only has to be stable and
   collision-resistant enough to tell two starts apart; it is not a security
   boundary and is never presented as one. */
function digest(parts){
 const input=parts.join('\u0000');
 let h1=0x811c9dc5,h2=0x01000193;
 for(let i=0;i<input.length;i++){
  const code=input.charCodeAt(i);
  h1=(h1^code)*0x01000193>>>0;
  h2=(h2+code*31+(i&255))>>>0;
  h2=(h2<<7|h2>>>25)>>>0;
 }
 return ('00000000'+h1.toString(16)).slice(-8)+('00000000'+h2.toString(16)).slice(-8);
}

function createRegistry(options){
 const config=options||{};
 const romHash=text(config.romHash,'romHash');
 const coreRevision=text(config.coreRevision,'coreRevision');
 const profileRevision=text(config.profileRevision,'profileRevision');
 /* Optional so the AGOD-08 call path and its published numbers are unchanged.
    When supplied it becomes part of the validity context and is enforced. */
 const detectorRevision=typeof config.detectorRevision==='string'&&config.detectorRevision?config.detectorRevision:null;
 const ttlMs=Number.isInteger(config.ttlMs)?config.ttlMs:DEFAULT_TTL_MS;
 /* Three different things that were one thing before (Sol decision 5):
      an evidence record   - an immutable observation with its provenance;
      a verification       - valid or not, for reasons that have nothing to do
                             with elapsed time;
      a cache horizon      - after which a verification must be revalidated,
                             which is not the same as being wrong.
    `cacheTtlMs` only forces revalidation. Nothing here lets time alone revoke
    a verification, and nothing here lets a changed core or detector survive
    one. */
 const cacheTtlMs=Number.isInteger(config.cacheTtlMs)?config.cacheTtlMs:DEFAULT_TTL_MS;
 const records=[];                 /* every registered item, including excluded */
 const partition=new Map();        /* startKey -> group: the split is global, not per hypothesis */
 const goalStart=new Map();        /* goalId + startKey -> recordId: reuse of a start by one goal */
 const contradictions=new Map();   /* goalId -> reason */
 const verified=new Map();         /* goalId -> verification record */
 const revocations=new Map();      /* goalId -> why a verification was revoked */
 const pairKey=(goalId,startKey)=>goalId+'\u0000'+startKey;

 /* A start is identified by what produced it, not by its name. */
 function startKeyOf(item){
  return digest([romHash,coreRevision,
   text(item.parentStateHash,'parentStateHash'),
   (item.restorePath||[]).join('>')]);
 }

 function register(item){
  const record={
   schemaVersion:SCHEMA_VERSION,
   id:text(item.id,'evidence id'),
   goalId:text(item.goalId,'goalId'),
   requestedGroup:item.group,
   group:item.group,
   romHash,coreRevision,profileRevision,
   parentStateHash:text(item.parentStateHash,'parentStateHash'),
   restorePath:Array.isArray(item.restorePath)?item.restorePath.slice(0,16):[],
   episodeOrigin:item.episodeOrigin===undefined?null:item.episodeOrigin,
   controlEpisode:item.controlEpisode===true,
   outcome:item.outcome,
   restored:item.restored===true,     /* loaded from persistence, not observed live */
   atMs:Number.isInteger(item.atMs)?item.atMs:0,
   independent:true,reuseOf:null,exclusionReason:null
  };
  if(!GROUPS.includes(record.group))throw new Error('unknown evidence group: '+record.group);
  if(record.group==='EXCLUDED')record.exclusionReason='registered as excluded by the caller';
  if(!['confirmed','contradicted','inconclusive'].includes(record.outcome))
   throw new Error('outcome must be confirmed, contradicted or inconclusive');

  const key=startKeyOf(record);
  record.startKey=key;

  /* Control episodes can never serve as holdout evidence (6.2/AGOD-08). */
  if(record.controlEpisode&&record.group!=='EXCLUDED'){
   record.group='EXCLUDED';record.independent=false;
   record.exclusionReason='control episodes cannot support a hypothesis';
  }

  /* The partition of a start is a property of the data, not of the hypothesis:
     once a start has served as DISCOVERY it can never be holdout, for any goal.
     Reuse, by contrast, is per hypothesis - one start supporting two different
     goals inside its own partition is legitimate and stays independent. */
  const assigned=partition.get(key);
  if(record.group!=='EXCLUDED'){
   if(assigned===undefined)partition.set(key,record.group);
   else if(assigned!==record.group){
    record.group='EXCLUDED';record.independent=false;
    record.exclusionReason='this start is already in the '+assigned+' partition: using it as '+record.requestedGroup+' would leak evidence across partitions';
   }
  }
  const prior=goalStart.get(pairKey(record.goalId,key));
  if(prior!==undefined&&record.group!=='EXCLUDED'){
   record.independent=false;record.reuseOf=prior;
   record.exclusionReason='same start as '+prior+' (identical ROM, core, parent state and restore path): not a second independent confirmation';
  }else if(record.group!=='EXCLUDED'){
   goalStart.set(pairKey(record.goalId,key),record.id);
  }

  if(record.outcome==='contradicted'&&record.group!=='EXCLUDED'){
   const reason='contradicted by evidence '+record.id;
   contradictions.set(record.goalId,reason);
   if(verified.has(record.goalId)){
    verified.delete(record.goalId); /* revoke */
    revocations.set(record.goalId,{by:'contradiction',reasons:[reason]});
   }
  }
  deepFrozen(record);
  records.push(record);
  return record;
 }

 const live=goalId=>records.filter(r=>r.goalId===goalId&&r.group!=='EXCLUDED');
 const expired=(r,nowMs)=>ttlMs>0&&Number.isInteger(nowMs)&&r.atMs>0&&nowMs-r.atMs>ttlMs;

 /* Independent confirmations are counted per distinct start, inside the groups
    that are allowed to support a claim. */
 function independentConfirmations(goalId,group,nowMs){
  const seen=new Set();
  for(const r of live(goalId)){
   if(r.group!==group||r.outcome!=='confirmed'||expired(r,nowMs))continue;
   seen.add(r.startKey);
  }
  return seen;
 }

 function assess(goalId,context){
  const ctx=context||{};
  const nowMs=ctx.nowMs;
  const all=live(goalId);
  if(contradictions.has(goalId))
   return frozen({goalId,lifecycle:'CONTRADICTED',reason:contradictions.get(goalId),
    discoveryStarts:0,holdoutStarts:0,disjoint:false});
  if(!all.length)
   return frozen({goalId,lifecycle:'UNKNOWN',reason:'no usable evidence',discoveryStarts:0,holdoutStarts:0,disjoint:false});
  if(all.every(r=>expired(r,nowMs)))
   return frozen({goalId,lifecycle:'EXPIRED',reason:'all evidence is older than the registry TTL',discoveryStarts:0,holdoutStarts:0,disjoint:false});

  const discovery=independentConfirmations(goalId,'DISCOVERY',nowMs);
  const calibration=independentConfirmations(goalId,'CALIBRATION',nowMs);
  const holdout=independentConfirmations(goalId,'HOLDOUT',nowMs);
  const overlap=[...holdout].filter(key=>discovery.has(key)||calibration.has(key));
  const disjoint=holdout.size>0&&overlap.length===0;
  /* Promotion requires at least one holdout record that was actually observed
     in this session: restored records alone cannot promote (AGOD-09). */
  const liveHoldout=all.some(r=>r.group==='HOLDOUT'&&r.outcome==='confirmed'&&!r.restored&&!expired(r,nowMs));

  let lifecycle='CANDIDATE',reason='a single start is not a confirmation';
  if(discovery.size>=1&&calibration.size>=1){lifecycle='CALIBRATED';reason='confirmed on separate discovery and calibration starts';}
  else if(discovery.size>=2){lifecycle='TESTING';reason='reproduced on more than one discovery start, no calibration yet';}
  else if(discovery.size===1){lifecycle='CANDIDATE';reason='a single start is not a confirmation';}

  return frozen({goalId,lifecycle,reason,
   discoveryStarts:discovery.size,calibrationStarts:calibration.size,holdoutStarts:holdout.size,
   disjoint,overlappingStarts:overlap.length,liveHoldout});
 }

 /* The only path to VERIFIED. It takes the polarity verdict from outside
    (agod-goals), because a registry counts evidence and must not invent
    meaning; and it refuses whenever any requirement is unmet, naming it. */
 function promote(goalId,requirements){
  const req=requirements||{};
  const state=assess(goalId,req);
  const blockers=[];
  /* A contradicted or expired hypothesis is refused on that ground alone: the
     assessment short-circuits there, so counting its evidence would report
     absences that are artefacts of the short-circuit rather than facts. */
  if(state.lifecycle==='CONTRADICTED'||state.lifecycle==='EXPIRED')
   return frozen({goalId,lifecycle:state.lifecycle,verified:false,evidence:state,
    blockers:[state.lifecycle==='CONTRADICTED'?'hypothesis is contradicted':'evidence has expired']});
  if(req.polarityEvidenced!==true)blockers.push('polarity is not independently evidenced');
  if(!['POSITIVE','NEGATIVE'].includes(req.polarity))blockers.push('polarity is not usable for reward');
  /* Only one of these can be true at a time, and saying all three would be a
     false report: with no holdout at all there is nothing to share or restore. */
  if(state.holdoutStarts<1)blockers.push('no holdout evidence');
  else if(!state.disjoint)blockers.push('holdout evidence shares a start with discovery or calibration');
  else if(!state.liveHoldout)blockers.push('holdout evidence is restored only: a cache cannot promote a hypothesis');
  if(state.lifecycle!=='CALIBRATED')blockers.push('hypothesis has not been calibrated on separate starts');
  if(req.profileRevision!==profileRevision)blockers.push('profile revision mismatch');

  if(blockers.length)
   return frozen({goalId,lifecycle:state.lifecycle,verified:false,blockers,evidence:state});
  const record=frozen({goalId,lifecycle:'VERIFIED',verified:true,blockers:[],
   polarity:req.polarity,romHash,coreRevision,profileRevision,
   /* What this verification was issued against. Checked, not assumed, by
      verificationStatus(). */
   validityContext:frozen({romHash,coreRevision,detectorRevision,profileRevision}),
   issuedAtMs:Number.isInteger(req.nowMs)?req.nowMs:null,
   discoveryStarts:state.discoveryStarts,calibrationStarts:state.calibrationStarts,
   holdoutStarts:state.holdoutStarts,evidence:state,
   evidenceRefs:live(goalId).filter(r=>r.outcome==='confirmed').map(r=>r.id).slice(0,32)});
  verified.set(goalId,record);
  return record;
 }

 /* Is a verification still good, and if not, why? Time is the one reason that
    does NOT make it wrong: a stale verification needs revalidating, an
    incompatible one is revoked outright. */
 function verificationStatus(goalId,context){
  const ctx=context||{};
  const record=verified.get(goalId);
  const reasons=[];
  if(contradictions.has(goalId))
   return frozen({goalId,state:'REVOKED',requiresRevalidation:false,
    reasons:[contradictions.get(goalId)],revokedBy:'contradiction',verification:null});
  if(!record){
   /* A revoked verification stays revoked, with its cause. Degrading to NONE
      would lose the one fact a caller most needs. */
   const revoked=revocations.get(goalId);
   if(revoked)
    return frozen({goalId,state:'REVOKED',requiresRevalidation:false,
     reasons:revoked.reasons.slice(),revokedBy:revoked.by,verification:null});
   return frozen({goalId,state:'NONE',requiresRevalidation:false,
    reasons:['no verification has been granted'],verification:null});
  }
  const against=record.validityContext;
  if(ctx.romHash!==undefined&&ctx.romHash!==against.romHash)
   reasons.push('verified against another ROM: '+against.romHash+' != '+ctx.romHash);
  if(ctx.coreRevision!==undefined&&ctx.coreRevision!==against.coreRevision)
   reasons.push('core revision changed: verified against '+against.coreRevision+', now '+ctx.coreRevision);
  if(ctx.detectorRevision!==undefined&&against.detectorRevision!==null&&
     ctx.detectorRevision!==against.detectorRevision)
   reasons.push('detector revision changed: verified against '+against.detectorRevision+', now '+ctx.detectorRevision);
  if(ctx.profileRevision!==undefined&&ctx.profileRevision!==against.profileRevision)
   reasons.push('profile revision changed: verified against '+against.profileRevision+', now '+ctx.profileRevision);
  if(reasons.length){
   /* Revoked regardless of how recently it was issued. */
   verified.delete(goalId);
   revocations.set(goalId,{by:'incompatible-context',reasons:reasons.slice()});
   return frozen({goalId,state:'REVOKED',requiresRevalidation:false,reasons,
    revokedBy:'incompatible-context',verification:record});
  }
  const ageMs=Number.isInteger(ctx.nowMs)&&Number.isInteger(record.issuedAtMs)
   ?ctx.nowMs-record.issuedAtMs:null;
  if(cacheTtlMs>0&&ageMs!==null&&ageMs>cacheTtlMs)
   return frozen({goalId,state:'STALE',requiresRevalidation:true,
    reasons:['older than the cache horizon of '+cacheTtlMs+' ms (age '+ageMs+' ms): revalidate, '+
     'which is not the same as being wrong'],
    ageMs,cacheTtlMs,verification:record});
  return frozen({goalId,state:'VALID',requiresRevalidation:false,reasons:[],ageMs,cacheTtlMs,verification:record});
 }

 /* Revalidation moves the cache horizon only. It cannot repair a revoked
    verification, and it cannot invent one. */
 function revalidate(goalId,context){
  const ctx=context||{};
  const status=verificationStatus(goalId,ctx);
  if(status.state!=='STALE')
   return frozen({goalId,revalidated:false,state:status.state,
    reason:status.state==='VALID'?'nothing to revalidate':'a '+status.state+' verification cannot be revalidated'});
  const refreshed=frozen({...status.verification,
   issuedAtMs:Number.isInteger(ctx.nowMs)?ctx.nowMs:status.verification.issuedAtMs,
   revalidations:(status.verification.revalidations||0)+1});
  verified.set(goalId,refreshed);
  return frozen({goalId,revalidated:true,state:'VALID',revalidations:refreshed.revalidations});
 }

 function contradict(goalId,reason){
  contradictions.set(text(goalId,'goalId'),text(reason,'reason'));
  const revoked=verified.delete(goalId);
  if(revoked)revocations.set(goalId,{by:'contradiction',reasons:[reason]});
  return frozen({goalId,lifecycle:'CONTRADICTED',reason,revokedPriorVerification:revoked});
 }

 /* Persistence round-trips evidence, never verdicts: a reloaded registry must
    re-derive lifecycle from records, and its restored records cannot promote. */
 function exportState(){
  return frozen({schemaVersion:SCHEMA_VERSION,registryRevision:REGISTRY_REVISION,
   romHash,coreRevision,profileRevision,ttlMs,
   records:records.map(r=>deepFrozen({...r,restorePath:r.restorePath.slice(),restored:true})),
   contradictions:[...contradictions.entries()].map(([goalId,reason])=>frozen({goalId,reason}))});
 }
 function importState(state){
  if(!state||state.schemaVersion!==SCHEMA_VERSION)throw new Error('unsupported registry state');
  if(state.romHash!==romHash||state.coreRevision!==coreRevision)throw new Error('registry state belongs to a different ROM or core');
  for(const r of state.records||[]){
   records.push(deepFrozen({...r,restorePath:Array.isArray(r.restorePath)?r.restorePath.slice():[],restored:true}));
   if(r.group!=='EXCLUDED'){
    if(!partition.has(r.startKey))partition.set(r.startKey,r.group);
    const pair=pairKey(r.goalId,r.startKey);
    if(!goalStart.has(pair))goalStart.set(pair,r.id);
   }
  }
  for(const c of state.contradictions||[])contradictions.set(c.goalId,c.reason);
  return frozen({imported:(state.records||[]).length,restoredOnly:true});
 }

 return frozen({register,assess,promote,contradict,exportState,importState,
  verificationStatus,revalidate,
  validityContext(){return frozen({romHash,coreRevision,detectorRevision,profileRevision,cacheTtlMs});},
  revocationLedger(){return [...revocations.entries()].map(([goalId,entry])=>frozen({goalId,by:entry.by,reasons:entry.reasons.slice()}));},
  groups(){return GROUPS.slice();},
  size(){return records.length;},
  records(){return records.slice();},
  verifiedGoals(){return [...verified.keys()];}});
}

const api={SCHEMA_VERSION,REGISTRY_REVISION,GROUPS,LIFECYCLE,DEFAULT_TTL_MS,createRegistry};
root.FlyAgodEvidence=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
