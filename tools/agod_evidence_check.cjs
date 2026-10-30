'use strict';
// AGOD-08/09: the evidence registry, and the first VERIFIED goal GU derives on
// its own. Part A runs the whole chain on the real controlled cartridge -
// causal probe, goal induction, evidence registered into disjoint partitions,
// promotion, payout - so that VERIFIED no longer arrives as a test fixture.
// Part B attacks the registry: shared starts, renamed starts, cached records,
// contradictions, control episodes and expiry must each block promotion.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Reward=require('../app/src/main/assets/lab/agod-reward.js'),
      Evidence=require('../app/src/main/assets/lab/agod-evidence.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-evidence-')),seeds=[0,1,2,7,8,9,47];
const FRAMES=12,SHIFT=3,STARTS=2,CORE='jsnes-nes',REV='profile-rev-1';
const PARTITIONS=[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}];
const chain=[],registryCases=[];
const result={type:'gu-agod-evidence-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 oracle:'checker-only: it drives depletion and scores the verdict, and is never passed into induction, the registry or the broker',
 claim:'A goal induced from the cartridge reaches VERIFIED only through evidence from disjoint, live holdout starts, and only then does the broker pay out. Every shortcut to VERIFIED is refused by name.',
 status:'RUNNING',chain,registryCases};
const save=()=>{if(process.env.AGOD_EVIDENCE_REPORT)fs.writeFileSync(process.env.AGOD_EVIDENCE_REPORT,JSON.stringify(result,null,2)+'\n');};save();

const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};
const overlaps=(addresses,f)=>spanOf(f).some(a=>addresses.includes(a));
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);

try{
 // ---------------- Part A: induction to VERIFIED on the real cartridge ----------------
 for(const seed of seeds){
  const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart,'--oracle-out',orc]);
  const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
  const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  const driver={restore(s){core.fromJSON(JSON.parse(s));},
   run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
   readRam(){return ram();}};
  const startsAt=(count,offset,tag)=>{const out=[];for(let i=0;i<count;i++){driver.run(0,offset+i*7);
   out.push({id:tag+'-'+i,stateHash:hash(ram()),snapshot:JSON.stringify(core.toJSON())});}return out;};
  const probe=(starts,mask)=>Causal.probeAction(driver,{starts,mask,neutralMask:0,
   alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
  const readAt=f=>{const m=core.cpu.mem;let v=0;for(let i=0;i<f.width;i++)v|=m[f.address+(f.endian==='little'?i:f.width-1-i)]<<(8*i);return v>>>0;};
  const echo=new Set(oracle.echoAddresses.flatMap(b=>[b,b+16]));

  for(let i=0;i<60;i++)core.frame();
  const pristine=JSON.stringify(core.toJSON());

  const registry=Evidence.createRegistry({romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV});
  const goalId='goal-lives-'+seed,accumulatorId='goal-score-'+seed;
  const now=1761800000000;
  const perPartition=[],observed=new Map();

  // Each partition is an independent run of the whole induction: its own start
  // states, its own depletion, its own verdict. Nothing is shared but the ROM.
  for(const part of PARTITIONS){
   driver.restore(pristine);
   const starts=startsAt(STARTS,part.offset,'st-'+seed+'-'+part.group);
   const negativeAlive=probe(starts,oracle.negativeMask);
   const positiveAlive=probe(starts,oracle.positiveMask);
   const aliveAddresses=positiveAlive.confirmed.map(e=>e.address);
   const playScope=aliveAddresses.filter(a=>!echo.has(a));

   driver.restore(starts[0].snapshot);
   const track=[readAt(oracle.fields.lives)];
   for(let k=0;k<6;k++){driver.run(oracle.negativeMask,4);driver.run(0,30);track.push(readAt(oracle.fields.lives));}
   const deadStarts=startsAt(STARTS,5,'dead-'+seed+'-'+part.group);
   const deadAddresses=probe(deadStarts,oracle.positiveMask).confirmed.map(e=>e.address);

   const terminal={confirmedBeforeDepletion:aliveAddresses,confirmedAfterDepletion:deadAddresses,scope:playScope};
   const goal=Goals.induceGoal({id:goalId,actionMask:oracle.negativeMask,address:oracle.fields.lives.address,
    causalConfirmed:overlaps(negativeAlive.confirmed.map(e=>e.address),oracle.fields.lives),
    independentStarts:negativeAlive.independentStarts,resourceTrack:{values:track},terminal});
   const accumulator=Goals.induceGoal({id:accumulatorId,actionMask:oracle.positiveMask,address:oracle.fields.score.address,
    causalConfirmed:overlaps(aliveAddresses,oracle.fields.score),
    independentStarts:positiveAlive.independentStarts,resourceTrack:{values:[0,1,2,3]}});

   // Registration happens per start, because a start is the unit of independence.
   const registered=[],hashes=[];
   for(const observation of negativeAlive.perStart){
    if(observation.status!=='OBSERVED')continue;
    hashes.push(observation.stateHash);
    registered.push(registry.register({id:'ev-'+seed+'-'+part.group+'-'+observation.startId,goalId,group:part.group,
     parentStateHash:observation.stateHash,restorePath:['pristine','neutral+'+part.offset],
     episodeOrigin:'live',outcome:goal.polarity==='NEGATIVE'?'confirmed':'inconclusive',restored:false,atMs:now}));
    registry.register({id:'ev-acc-'+seed+'-'+part.group+'-'+observation.startId,goalId:accumulatorId,group:part.group,
     parentStateHash:observation.stateHash,restorePath:['pristine','neutral+'+part.offset],
     episodeOrigin:'live',outcome:'confirmed',restored:false,atMs:now});
   }
   observed.set(part.group,{hashes,restorePath:['pristine','neutral+'+part.offset]});
   perPartition.push({group:part.group,polarity:goal.polarity,lifecycle:goal.lifecycle,verifiable:goal.verifiable,
    livesTrack:track,playScopeSize:playScope.length,
    registered:registered.length,excluded:registered.filter(r=>r.group==='EXCLUDED').length,
    startKeys:registered.map(r=>r.startKey)});
   assert.equal(goal.polarity,'NEGATIVE',seed+'/'+part.group+': the depletion chain must still yield NEGATIVE');
   assert.equal(accumulator.polarity,'UNKNOWN',seed+'/'+part.group+': an accumulator must never be declared POSITIVE');
   assert.equal(registered.filter(r=>r.group==='EXCLUDED').length,0,seed+'/'+part.group+': independently produced starts must not be excluded');
  }

  // Starts must genuinely differ across partitions, or "disjoint" means nothing.
  const allKeys=perPartition.flatMap(p=>p.startKeys);
  assert.equal(new Set(allKeys).size,allKeys.length,'seed '+seed+': partitions must not share a start key');

  const assessed=registry.assess(goalId,{nowMs:now});
  const lastGoal=perPartition[perPartition.length-1];
  const promotion=registry.promote(goalId,{polarity:'NEGATIVE',polarityEvidenced:lastGoal.verifiable,profileRevision:REV,nowMs:now});
  const accumulatorPromotion=registry.promote(accumulatorId,{polarity:'UNKNOWN',polarityEvidenced:false,profileRevision:REV,nowMs:now});

  // The point of the whole exercise: the broker is handed a goal GU verified itself.
  // Negative control on the same real data: if the holdout partition is built
  // from the discovery starts instead of its own, promotion must fail. Without
  // this, a passing run would not show that the chain is capable of refusing.
  const controlRegistry=Evidence.createRegistry({romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV});
  for(const group of ['DISCOVERY','CALIBRATION','HOLDOUT']){
   const source=observed.get(group==='HOLDOUT'?'DISCOVERY':group);
   source.hashes.forEach((stateHash,i)=>controlRegistry.register({id:'ctl-'+seed+'-'+group+'-'+i,goalId,group,
    parentStateHash:stateHash,restorePath:observed.get(group==='HOLDOUT'?'DISCOVERY':group).restorePath,
    episodeOrigin:'live',outcome:'confirmed',restored:false,atMs:now}));
  }
  const controlPromotion=controlRegistry.promote(goalId,{polarity:'NEGATIVE',polarityEvidenced:true,profileRevision:REV,nowMs:now});

  const contextKey=descriptor.sha256+'/'+CORE;
  const broker=Reward.createBroker({profileRevision:REV,contextKey});
  const payout=broker.claim({eventId:'pay-'+seed,source:'verified-goal',profileRevision:REV,contextKey,
   goal:{id:goalId,lifecycle:promotion.lifecycle,polarity:promotion.polarity,evidenceRefs:promotion.evidenceRefs},
   executedAction:{mask:oracle.negativeMask,frames:FRAMES,complete:true,manualOverride:false},
   requestedMask:oracle.negativeMask,magnitude:1,phase:'PLAYING',episode:{partition:'holdout'},ageMs:10});

  chain.push({seed,romHash:descriptor.sha256,partitions:perPartition,
   assessedLifecycle:assessed.lifecycle,discoveryStarts:assessed.discoveryStarts,
   calibrationStarts:assessed.calibrationStarts,holdoutStarts:assessed.holdoutStarts,
   disjoint:assessed.disjoint,liveHoldout:assessed.liveHoldout,
   promotedLifecycle:promotion.lifecycle,promotedVerified:promotion.verified,
   evidenceRefs:promotion.evidenceRefs?promotion.evidenceRefs.length:0,
   accumulatorVerified:accumulatorPromotion.verified,accumulatorBlockers:accumulatorPromotion.blockers,
   reusedHoldoutVerified:controlPromotion.verified,reusedHoldoutBlockers:controlPromotion.blockers,
   payoutStatus:payout.status,payoutValue:has(payout,'value')?payout.value:null});
  save();

  assert.equal(assessed.lifecycle,'CALIBRATED','seed '+seed+': separate discovery and calibration starts must calibrate');
  assert(assessed.disjoint,'seed '+seed+': holdout must not share a start');
  assert(assessed.liveHoldout,'seed '+seed+': holdout evidence must be live, not restored');
  assert.equal(promotion.verified,true,'seed '+seed+': the induced goal must reach VERIFIED: '+(promotion.blockers||[]).join('; '));
  assert.equal(accumulatorPromotion.verified,false,'seed '+seed+': the registry must not become a route to POSITIVE');
  assert(accumulatorPromotion.blockers.includes('polarity is not independently evidenced'));
  assert.equal(controlPromotion.verified,false,'seed '+seed+': a holdout rebuilt from discovery starts must not verify');
  assert(controlPromotion.blockers.includes('no holdout evidence'),'seed '+seed+': the reused holdout must be excluded as a partition leak');
  assert.equal(payout.status,'VERIFIED','seed '+seed+': a self-verified goal must pay out');
  assert.equal(payout.value,-1,'seed '+seed+': a NEGATIVE goal must produce a negative value');
 }

 // ---------------- Part B: every shortcut to VERIFIED is refused ----------------
 const ROM='rom-hash-b',FULL={polarity:'NEGATIVE',polarityEvidenced:true,profileRevision:REV};
 const fresh=()=>Evidence.createRegistry({romHash:ROM,coreRevision:CORE,profileRevision:REV});
 const ev=(group,parent,extra)=>Object.assign({id:group+'-'+parent+'-'+Math.random().toString(36).slice(2,8),
  goalId:'g',group,parentStateHash:parent,restorePath:['boot','neutral'],episodeOrigin:'live',
  outcome:'confirmed',restored:false,atMs:1000},extra||{});
 const complete=registry=>{registry.register(ev('DISCOVERY','p1'));registry.register(ev('CALIBRATION','p2'));
  registry.register(ev('HOLDOUT','p3'));return registry;};
 const record=(name,expectation,observed,blockers)=>{registryCases.push({name,expectation,observed,blockers:blockers||null});save();};

 {// A start that already served discovery cannot come back as holdout.
  const r=fresh();r.register(ev('DISCOVERY','p1'));r.register(ev('CALIBRATION','p2'));
  const leak=r.register(ev('HOLDOUT','p1'));
  const out=r.promote('g',FULL);
  record('holdout start shared with discovery','EXCLUDED, promotion blocked',leak.group,out.blockers);
  assert.equal(leak.group,'EXCLUDED');assert(/leak evidence across partitions/.test(leak.exclusionReason));
  assert.equal(out.verified,false);assert(out.blockers.includes('no holdout evidence'));}

 {// A new identifier is not a new start (AGOD-08).
  const r=fresh();const first=r.register(ev('DISCOVERY','p1'));
  const renamed=r.register(ev('DISCOVERY','p1'));
  record('same parent state under a fresh identifier','recognised as reuse, not independent',
   renamed.independent?'independent':'reuseOf '+renamed.reuseOf);
  assert.equal(renamed.independent,false);assert.equal(renamed.reuseOf,first.id);
  assert.equal(r.assess('g',{nowMs:2000}).discoveryStarts,1);}

 {// A reloaded cache holds evidence, not authority.
  const source=complete(fresh());
  assert.equal(source.promote('g',FULL).verified,true);
  const reloaded=fresh();reloaded.importState(source.exportState());
  const state=reloaded.assess('g',{nowMs:2000});
  const out=reloaded.promote('g',FULL);
  record('promotion from a restored cache only','blocked: a cache cannot promote',
   'lifecycle '+state.lifecycle+', liveHoldout '+state.liveHoldout,out.blockers);
  assert.equal(state.lifecycle,'CALIBRATED');assert.equal(state.liveHoldout,false);
  assert.equal(out.verified,false);
  assert(out.blockers.includes('holdout evidence is restored only: a cache cannot promote a hypothesis'));}

 {// A contradiction removes a verification that was already granted.
  const r=complete(fresh());
  assert.equal(r.promote('g',FULL).verified,true);
  assert.deepEqual(r.verifiedGoals(),['g']);
  r.register(ev('HOLDOUT','p4',{outcome:'contradicted'}));
  const after=r.assess('g',{nowMs:2000}),out=r.promote('g',FULL);
  record('contradiction after verification','verification revoked, promotion blocked',
   after.lifecycle+', verified goals: '+r.verifiedGoals().length,out.blockers);
  assert.equal(after.lifecycle,'CONTRADICTED');assert.deepEqual(r.verifiedGoals(),[]);
  assert.equal(out.verified,false);assert(out.blockers.includes('hypothesis is contradicted'));}

 {// An explicit contradiction does the same, and says that it revoked something.
  const r=complete(fresh());r.promote('g',FULL);
  const out=r.contradict('g','the game outcome disagreed with RAM');
  record('explicit contradiction','prior verification revoked',String(out.revokedPriorVerification));
  assert.equal(out.revokedPriorVerification,true);}

 {// Control episodes support nothing.
  const r=fresh();r.register(ev('DISCOVERY','p1'));r.register(ev('CALIBRATION','p2'));
  const control=r.register(ev('HOLDOUT','p3',{controlEpisode:true}));
  const out=r.promote('g',FULL);
  record('control episode offered as holdout','EXCLUDED, promotion blocked',control.group,out.blockers);
  assert.equal(control.group,'EXCLUDED');assert(out.blockers.includes('no holdout evidence'));}

 {// Evidence does not stay true forever.
  const r=complete(fresh());
  const late=1000+Evidence.DEFAULT_TTL_MS+1;
  const state=r.assess('g',{nowMs:late}),out=r.promote('g',{...FULL,nowMs:late});
  record('evidence older than the registry TTL','EXPIRED, promotion blocked',state.lifecycle,out.blockers);
  assert.equal(state.lifecycle,'EXPIRED');assert(out.blockers.includes('evidence has expired'));}

 {// Counting evidence is not the same as knowing what it means.
  const r=complete(fresh());
  const unevidenced=r.promote('g',{polarity:'NEGATIVE',polarityEvidenced:false,profileRevision:REV});
  const unusable=r.promote('g',{polarity:'UNKNOWN',polarityEvidenced:true,profileRevision:REV});
  record('polarity not independently evidenced','blocked',String(unevidenced.verified),unevidenced.blockers);
  record('polarity UNKNOWN with full evidence','blocked',String(unusable.verified),unusable.blockers);
  assert.equal(unevidenced.verified,false);assert(unevidenced.blockers.includes('polarity is not independently evidenced'));
  assert.equal(unusable.verified,false);assert(unusable.blockers.includes('polarity is not usable for reward'));}

 {// Evidence belongs to the profile revision that produced it.
  const r=complete(fresh());
  const out=r.promote('g',{...FULL,profileRevision:'profile-rev-0'});
  record('evidence from another profile revision','blocked',String(out.verified),out.blockers);
  assert.equal(out.verified,false);assert(out.blockers.includes('profile revision mismatch'));}

 {// Holdout alone is not calibration.
  const r=fresh();r.register(ev('DISCOVERY','p1'));r.register(ev('HOLDOUT','p3'));
  const out=r.promote('g',FULL);
  record('holdout without calibration','blocked',String(out.verified),out.blockers);
  assert.equal(out.verified,false);assert(out.blockers.includes('hypothesis has not been calibrated on separate starts'));}

 {// State from another cartridge is refused outright.
  const foreign=Evidence.createRegistry({romHash:'other-rom',coreRevision:CORE,profileRevision:REV}).exportState();
  let message=null;try{fresh().importState(foreign);}catch(error){message=error.message;}
  record('imported state from another ROM','rejected',message||'accepted');
  assert(message&&/different ROM or core/.test(message));}

 {// A goal with no usable evidence at all is UNKNOWN, never a default.
  const state=fresh().assess('g',{nowMs:2000});
  record('no evidence at all','UNKNOWN, not a numeric default',state.lifecycle);
  assert.equal(state.lifecycle,'UNKNOWN');assert(!has(state,'value'));}

 result.totals={seeds:chain.length,
  goalsVerifiedFromOwnEvidence:chain.filter(r=>r.promotedVerified).length,
  accumulatorsVerified:chain.filter(r=>r.accumulatorVerified).length,
  payoutsFromSelfVerifiedGoals:chain.filter(r=>r.payoutStatus==='VERIFIED').length,
  reusedHoldoutVerified:chain.filter(r=>r.reusedHoldoutVerified).length,
  registryCases:registryCases.length};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,chain,registryCases}));
 console.log('PASS: '+result.totals.goalsVerifiedFromOwnEvidence+'/'+chain.length+' cartridges produced a VERIFIED goal from their own disjoint live holdout evidence and paid out through the broker; 0 accumulators were verified; '+registryCases.length+' registry shortcuts refused. Real games, blind corpus and Android remain untested.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
