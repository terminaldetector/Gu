/* The live objective: the one AGOD profile the running game may be paid by.

   goal-discovery-ui.js hands a VERIFIED worker result here; lab.js asks here
   when the reward source is "agod". Everything that decides whether a number
   is produced lives in agod-objective.js - this file only holds the current
   profile, keeps it bound to the cartridge that is actually loaded, and stores
   it so the same cartridge does not have to be re-proved on every launch.

   A STORED PROFILE DOES NOT PAY UNTIL THIS BUILD HAS CONFIRMED ITS DETECTOR.
   The profile records which detector revision proved it. A profile restored
   from storage is RESTORED_UNCHECKED until a discovery run in this build has
   reported the same revision; if the revision differs the profile is dropped.

   Changing the cartridge drops the live objective at once. Nothing here ever
   touches the emulator: it reads the bytes lab.js already sampled. */
'use strict';
(()=>{
 const STORE='gu.agod.objective.v1.';
 const modules=()=>({Dto:window.FlyAgodGoalDto,Reward:window.FlyAgodReward,
  Evidence:window.FlyAgodEvidence,Ram:window.FlyAgodRam});
 let profile=null,reward=null,state='NONE',reason='',detectorSeen=null,capabilities=null;
 const listeners=new Set();
 const notify=()=>{for(const fn of listeners)try{fn(status());}catch(_){}
  try{if(typeof trainingView==='function')trainingView();}catch(_){}};
 const storage=()=>{try{return window.localStorage;}catch(_){return null;}};

 function identity(){
  const caps=capabilities||{};
  return {romSha256:typeof romHash==='string'?romHash:null,
   platform:typeof labPlatform==='string'?labPlatform:null,
   coreRevision:window.labCoreIdentity||null,
   detectorRevision:profile?profile.identity.detectorRevision:detectorSeen,
   actionSpec:caps.actionSpec||(profile?{buttonCount:profile.identity.buttonCount}:null),
   padType:caps.padType!==undefined?caps.padType:(profile?profile.identity.padType:null),
   observedRamBytes:Number.isInteger(caps.observedRamBytes)?caps.observedRamBytes
    :(profile?profile.identity.observedRamBytes:null)};
 }
 function status(){
  return {state,reason,goalId:profile?profile.goal.id:null,
   polarity:profile?profile.goal.polarity:null,
   resourceAddress:profile?profile.resource.address:null,
   identityKey:profile?profile.identityKey:null,
   counts:reward?reward.counts():null,revoked:reward?reward.revoked():null};
 }
 function persist(){
  const store=storage();if(!store||!profile)return;
  try{store.setItem(STORE+profile.identity.romSha256,JSON.stringify({profile,
   ledger:reward?reward.exportLedger():[]}));}catch(_){}
 }
 function arm(ledger){
  const live=window.FlyAgodObjective.createLiveReward(profile,modules(),
   {identity:identity(),sessionId:'app-'+(window.flyOriginId||'session'),ledger});
  if(live.status!=='READY'){reward=null;state='REFUSED';reason=live.reason;return false;}
  reward=live;state='VERIFIED';reason='';return true;
 }
 function clear(why){profile=null;reward=null;state='NONE';reason=why||'';notify();}

 /* a VERIFIED result from the discovery worker */
 function adopt(dto,started){
  if(!window.FlyAgodObjective)return status();
  capabilities=started&&started.capabilities||capabilities;
  detectorSeen=started&&started.pipelineRevision||detectorSeen;
  const made=window.FlyAgodObjective.createProfile(dto,
   {...identity(),detectorRevision:detectorSeen},modules());
  if(made.status!=='PROFILE'){
   /* a run that did not verify also settles a restored, unchecked profile */
   if(state==='RESTORED_UNCHECKED')clear('re-verification did not confirm the stored objective');
   else{state='UNKNOWN';reason=made.reason;notify();}
   return status();
  }
  profile=made;arm([]);persist();notify();
  return status();
 }
 /* the detector revision this build reports, from any discovery run */
 function detector(started){
  capabilities=started&&started.capabilities||capabilities;
  detectorSeen=started&&started.pipelineRevision||detectorSeen;
  if(state==='RESTORED_UNCHECKED'&&profile){
   if(profile.identity.detectorRevision!==detectorSeen)
    clear('the stored objective was proved by another detector revision');
   else if(window.FlyAgodObjective.matches(profile,identity()).ok){
    const store=storage();let ledger=[];
    try{ledger=JSON.parse(store.getItem(STORE+profile.identity.romSha256)).ledger||[];}catch(_){}
    arm(ledger);notify();
   }else clear('the stored objective does not match this game');
  }
 }
 /* a cartridge was loaded: forget the old objective, look for a stored one */
 function romLoaded(){
  profile=null;reward=null;capabilities=null;state='NONE';reason='';
  const store=storage();
  if(store&&typeof romHash==='string'){
   try{
    const saved=JSON.parse(store.getItem(STORE+romHash)||'null');
    if(saved&&saved.profile&&saved.profile.status==='PROFILE'
     &&saved.profile.identity.romSha256===romHash
     &&saved.profile.identity.platform===labPlatform
     &&saved.profile.identity.coreRevision===(window.labCoreIdentity||null)){
     profile=saved.profile;state='RESTORED_UNCHECKED';
     reason='stored objective; waiting for this build to confirm its detector';
    }
   }catch(_){}
  }
  notify();
 }
 const active=()=>state==='VERIFIED'&&!!reward&&!reward.revoked();
 /* the resource value from the bytes lab.js sampled; null when there is no objective */
 function read(memory){
  if(!active())return null;
  try{const value=reward.read(memory);return Number.isFinite(value)?value:null;}catch(_){return null;}
 }
 /* which addresses lab.js must include in its sparse reward sample */
 function addresses(){
  if(!profile||state!=='VERIFIED')return [];
  const out=[];for(let i=0;i<profile.resource.width;i++)out.push(profile.resource.address+i);
  return out;
 }
 /* one executed interval -> a packet. Only VERIFIED carries a value. */
 function settle(sample){
  if(!active())return {status:'UNKNOWN',reason:'no verified objective for this game'};
  if(!window.FlyAgodObjective.matches(profile,identity()).ok){
   clear('the game changed under the objective');
   return {status:'INVALIDATED',reason:'the game changed under the objective'};
  }
  const packet=reward.observe(sample);
  if(packet.status==='VERIFIED')persist();
  return packet;
 }
 function revoke(why){if(reward){reward.revoke(why);state='INVALIDATED';reason=String(why);persist();notify();}}

 window.agodObjective={adopt,detector,romLoaded,active,read,addresses,settle,revoke,
  status,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}};
 window.addEventListener('lab-rom-loaded',romLoaded);
})();
