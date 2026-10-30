/* Replay with reward-certainty labels and deferred credit assignment
   (Sol mandatory correction to E5).

   E5 protected the TD target by throwing UNKNOWN transitions away. That is
   correct about the target and wrong about learning: it also throws away every
   action whose consequence is confirmed later, so nothing with a delay can ever
   be learned. The fix is not to store a zero - it is to store the step together
   with how much is actually known about its reward, and to let a later
   trustworthy event pay the earlier steps back.

   Four labels, and the difference between the first three is the whole point:

     VERIFIED_REWARD  the broker paid out; `value` is observed.
     KNOWN_ZERO       absence of reward was *evidenced* over a complete
                      interval; `value` is 0 because 0 was measured.
     UNKNOWN          nothing is known. There is no `value` key at all, and the
                      step is never trainable.
     CREDITED         an UNKNOWN step that a later confirmed event paid back.
                      It carries the event it came from, the discount, and the
                      assumption that makes it possible - in words, on the
                      record - because crediting a step necessarily assumes
                      something about the rewards in between. Naming that
                      assumption is the honest version of what substituting a
                      zero would have hidden.

   So UNKNOWN never becomes 0: it either stays untrainable or becomes CREDITED,
   which is a different label carrying its own provenance. Not wired into any
   production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=1,STORE_REVISION='agod-replay-s2-1';
const VERIFIED='VERIFIED_REWARD',KNOWN_ZERO='KNOWN_ZERO',UNKNOWN='UNKNOWN',CREDITED='CREDITED';
const STATUSES=Object.freeze([VERIFIED,KNOWN_ZERO,UNKNOWN,CREDITED]);
const EVIDENCED=Object.freeze([VERIFIED,KNOWN_ZERO]);
const TRAINABLE=Object.freeze([VERIFIED,KNOWN_ZERO,CREDITED]);
const ASSUMPTION='rewards between this step and the credited event were not observed; this target treats them as absent, which is an assumption recorded here rather than a measured zero';
const frozen=Object.freeze.bind(Object);
const text=(value,label)=>{if(typeof value!=='string'||!value)throw new Error(label+' must be a non-empty string');return value;};

function createStore(options){
 const config=options||{};
 const capacity=Number.isInteger(config.capacity)?config.capacity:20000;
 const gamma=typeof config.gamma==='number'?config.gamma:0.95;
 const creditHorizon=Number.isInteger(config.creditHorizon)?config.creditHorizon:64;
 const episodes=new Map();   /* episodeId -> {provenance, steps:[], order} */
 const order=[];             /* episode ids, oldest first, for whole-episode eviction */
 let serial=0,stored=0;
 const stats={appended:0,evicted:0,evictedEpisodes:0,credited:0,revoked:0,
  byStatus:{VERIFIED_REWARD:0,KNOWN_ZERO:0,UNKNOWN:0,CREDITED:0},
  creditEvents:0,creditStoppedAtEvidenced:0,creditStoppedAtBoundary:0,creditStoppedAtHorizon:0};

 function beginEpisode(input){
  const id=text(input&&input.id,'episode id');
  if(episodes.has(id))throw new Error('episode already open: '+id);
  const provenance=frozen({
   romHash:text(input.provenance&&input.provenance.romHash,'provenance.romHash'),
   coreRevision:text(input.provenance&&input.provenance.coreRevision,'provenance.coreRevision'),
   startId:input.provenance.startId===undefined?null:input.provenance.startId,
   restorePath:Array.isArray(input.provenance.restorePath)?input.provenance.restorePath.slice(0,16):[],
   partition:input.provenance.partition===undefined?null:input.provenance.partition,
   openedAt:serial++});
  episodes.set(id,{id,provenance,steps:[],boundaries:new Set()});
  order.push(id);
  evict();
  return frozen({episodeId:id,provenance});
 }

 /* Eviction removes whole episodes. Half an episode is a sequence whose credit
    assignment would silently stop working, which is worse than storing less. */
 function evict(){
  while(stored>capacity&&order.length>1){
   const oldest=order.shift(),episode=episodes.get(oldest);
   if(!episode)continue;
   stored-=episode.steps.length;stats.evicted+=episode.steps.length;stats.evictedEpisodes++;
   for(const step of episode.steps)stats.byStatus[step.status]--;
   episodes.delete(oldest);
  }
 }

 /* A save/load between two steps breaks the causal chain, so credit must not
    cross it (6.3.5 in the TZ is the same rule for a single payout). */
 function markBoundary(episodeId,reason){
  const episode=episodes.get(text(episodeId,'episodeId'));
  if(!episode)throw new Error('unknown episode: '+episodeId);
  episode.boundaries.add(episode.steps.length);
  return frozen({episodeId,atIndex:episode.steps.length,reason:reason||'state restored'});
 }

 function append(input){
  const episode=episodes.get(text(input&&input.episodeId,'episodeId'));
  if(!episode)throw new Error('unknown episode: '+input.episodeId);
  const status=input.status;
  if(!STATUSES.includes(status)||status===CREDITED)
   throw new Error('append takes '+VERIFIED+', '+KNOWN_ZERO+' or '+UNKNOWN+'; CREDITED is produced by settle');
  if(EVIDENCED.includes(status)&&!Number.isFinite(input.value))
   throw new Error(status+' requires an observed numeric value');
  if(status===UNKNOWN&&input.value!==undefined)
   throw new Error('an UNKNOWN step must not carry a value');
  const step={schemaVersion:SCHEMA_VERSION,storeRevision:STORE_REVISION,
   index:episode.steps.length,episodeId:episode.id,
   state:input.state,action:input.action,nextState:input.nextState,
   terminal:input.terminal===true,status,
   provenance:episode.provenance,
   reason:input.reason===undefined?null:input.reason,
   credit:null};
  if(EVIDENCED.includes(status))step.value=input.value;
  /* UNKNOWN deliberately has no `value` key: a missing key cannot be coerced
     the way a 0 can, and JSON round-trips keep it missing. */
  episode.steps.push(step);stored++;stats.appended++;stats.byStatus[status]++;
  evict();
  return frozen({...step});
 }

 /* Deferred credit assignment. A trustworthy event at `index` pays back the
    UNKNOWN steps before it, inside one episode, without crossing a restore
    boundary or an already evidenced reward, up to the horizon. */
 function settle(input){
  const episode=episodes.get(text(input&&input.episodeId,'episodeId'));
  if(!episode)throw new Error('unknown episode: '+input.episodeId);
  const index=input.index;
  if(!Number.isInteger(index)||index<0||index>=episode.steps.length)
   throw new Error('settle needs an index inside the episode');
  const event=episode.steps[index];
  if(!EVIDENCED.includes(event.status))
   throw new Error('only an evidenced step can credit earlier ones, this one is '+event.status);
  const kind=input.kind==='intermediate'?'intermediate':'terminal';
  if(!Number.isFinite(event.value))throw new Error('the crediting event has no numeric value');
  const credited=[];
  let stop=null;
  for(let i=index-1;i>=0;i--){
   if(index-i>creditHorizon){stop='horizon';stats.creditStoppedAtHorizon++;break;}
   if(episode.boundaries.has(i+1)){stop='restore-boundary';stats.creditStoppedAtBoundary++;break;}
   const step=episode.steps[i];
   if(EVIDENCED.includes(step.status)){stop='evidenced-reward';stats.creditStoppedAtEvidenced++;break;}
   if(step.status===CREDITED){
    /* Already paid by a nearer event; a nearer event is the tighter claim. */
    if(step.credit&&step.credit.fromIndex>=index)continue;
   }
   const steps=index-i,discount=Math.pow(gamma,steps);
   if(step.status===UNKNOWN)stats.byStatus[UNKNOWN]--,stats.byStatus[CREDITED]++;
   step.status=CREDITED;
   step.value=event.value*discount;
   step.credit=frozen({fromIndex:index,fromStatus:event.status,kind,steps,discount,
    gamma,eventValue:event.value,assumption:ASSUMPTION});
   credited.push(i);
  }
  stats.credited+=credited.length;stats.creditEvents++;
  return frozen({episodeId:episode.id,eventIndex:index,kind,credited:credited.length,
   indices:credited.slice(0,64),stoppedBecause:stop,horizon:creditHorizon});
 }

 /* A contradicted event must take its credit back with it. */
 function revoke(input){
  const episode=episodes.get(text(input&&input.episodeId,'episodeId'));
  if(!episode)throw new Error('unknown episode: '+input.episodeId);
  const index=input.index;let reverted=0;
  for(const step of episode.steps){
   if(step.status!==CREDITED||!step.credit||step.credit.fromIndex!==index)continue;
   step.status=UNKNOWN;delete step.value;step.credit=null;
   step.reason=text(input.reason||'the crediting event was contradicted','reason');
   stats.byStatus[CREDITED]--;stats.byStatus[UNKNOWN]++;reverted++;
  }
  stats.revoked+=reverted;
  return frozen({episodeId:episode.id,eventIndex:index,reverted});
 }

 const all=()=>[...episodes.values()].flatMap(episode=>episode.steps);
 return frozen({
  STATUSES,TRAINABLE,beginEpisode,append,settle,revoke,markBoundary,
  /* The only set a learner may see. UNKNOWN is absent by construction, which is
     what "block training on unproven reward labels" has to mean in code. */
  trainable(){return all().filter(step=>TRAINABLE.includes(step.status)).map(step=>frozen({...step}));},
  untrainable(){return all().filter(step=>!TRAINABLE.includes(step.status)).map(step=>frozen({...step}));},
  episode(id){const episode=episodes.get(id);return episode?episode.steps.map(step=>frozen({...step})):null;},
  size(){return stored;},
  episodeCount(){return episodes.size;},
  stats(){return {...stats,byStatus:{...stats.byStatus},stored,episodes:episodes.size,capacity,gamma,creditHorizon};}});
}

const api={SCHEMA_VERSION,STORE_REVISION,STATUSES,TRAINABLE,EVIDENCED,ASSUMPTION,
 VERIFIED_REWARD:VERIFIED,KNOWN_ZERO,UNKNOWN,CREDITED,createStore};
root.FlyAgodReplay=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
