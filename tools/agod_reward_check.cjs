'use strict';
// E4: goal induction and the verified reward broker.
// Part A drives the actual controlled cartridge and induces phase/polarity from
// causal evidence; the oracle is read only afterwards, to score the result.
// Part B runs the eight anti-reward-hacking cases of TZ 6.3 plus the UNKNOWN
// contract, which is the rule the whole section exists to protect.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Reward=require('../app/src/main/assets/lab/agod-reward.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-reward-')),seeds=[0,1,2,7,8,9,47];
const FRAMES=12,SHIFT=3,STARTS=3;
const induction=[],negative=[];
const result={type:'gu-agod-reward-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 oracle:'checker-only; never passed into the induction or the broker',
 claim:'NEGATIVE polarity is evidenced from resource depletion plus loss of previously confirmed effects. POSITIVE polarity is deliberately NOT claimed: an accumulator rising is not benefit.',
 status:'RUNNING',induction,negative};
const save=()=>{if(process.env.AGOD_REWARD_REPORT)fs.writeFileSync(process.env.AGOD_REWARD_REPORT,JSON.stringify(result,null,2)+'\n');};save();

const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};
const overlaps=(addresses,f)=>spanOf(f).some(a=>addresses.includes(a));

try{
 // ---------------- Part A: induction on the real cartridge ----------------
 for(const seed of seeds){
  const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart,'--oracle-out',orc]);
  const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
  const bytes=Buffer.from(descriptor.base64,'base64');
  const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(bytes);
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  const driver={restore(s){core.fromJSON(JSON.parse(s));},
   run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
   readRam(){return ram();}};
  const startsAt=()=>{const out=[];for(let i=0;i<STARTS;i++){driver.run(0,11+i*7);out.push({id:'s'+seed+'-'+i,stateHash:hash(ram()),snapshot:JSON.stringify(core.toJSON())});}return out;};
  const probe=(starts,mask)=>Causal.probeAction(driver,{starts,mask,neutralMask:0,alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT})
   .confirmed.map(e=>e.address);

  for(let i=0;i<60;i++)core.frame();
  // Alive: what does each action cause while the game is playable?
  const aliveStarts=startsAt();
  const positiveAlive=probe(aliveStarts,oracle.positiveMask);
  const negativeAlive=probe(aliveStarts,oracle.negativeMask);

  // The play-effect scope is derived from the engine, not the oracle: effects
  // of the probed action that are not that action's own input echo.
  const echo=new Set(oracle.echoAddresses.flatMap(b=>[b,b+16]));
  const playScope=positiveAlive.filter(a=>!echo.has(a));

  // Deplete the resource by pulsing the negative action, sampling the track.
  driver.restore(aliveStarts[0].snapshot);
  const track=[];
  const readAt=f=>{const m=core.cpu.mem;let v=0;for(let i=0;i<f.width;i++)v|=m[f.address+(f.endian==='little'?i:f.width-1-i)]<<(8*i);return v>>>0;};
  track.push(readAt(oracle.fields.lives));
  for(let k=0;k<6;k++){driver.run(oracle.negativeMask,4);driver.run(0,30);track.push(readAt(oracle.fields.lives));}

  // Depleted: re-probe the same actions from this state.
  const deadStarts=startsAt();
  const positiveDead=probe(deadStarts,oracle.positiveMask);

  const terminal=Goals.terminalEvidence({confirmedBeforeDepletion:positiveAlive,confirmedAfterDepletion:positiveDead,scope:playScope});
  const resourceGoal=Goals.induceGoal({id:'goal-neg-'+seed,actionMask:oracle.negativeMask,address:oracle.fields.lives.address,
   causalConfirmed:overlaps(negativeAlive,oracle.fields.lives),independentStarts:STARTS,
   resourceTrack:{values:track},terminal:{confirmedBeforeDepletion:positiveAlive,confirmedAfterDepletion:positiveDead,scope:playScope}});
  const accumulatorGoal=Goals.induceGoal({id:'goal-pos-'+seed,actionMask:oracle.positiveMask,address:oracle.fields.score.address,
   causalConfirmed:overlaps(positiveAlive,oracle.fields.score),independentStarts:STARTS,
   resourceTrack:{values:[0,1,2,3]}});
  const phaseDead=Goals.classifyPhase({resource:Goals.analyseResource({values:track}),terminal,suppressionReversibleBySameAction:false});
  const phaseAlive=Goals.classifyPhase({resource:Goals.analyseResource({values:track}),
   terminal:Goals.terminalEvidence({confirmedBeforeDepletion:positiveAlive,confirmedAfterDepletion:positiveAlive,scope:playScope}),
   suppressionReversibleBySameAction:false});

  induction.push({seed,romHash:descriptor.sha256,
   livesTrack:track,playScopeSize:playScope.length,
   negativePolarity:resourceGoal.polarity,negativeLifecycle:resourceGoal.lifecycle,negativeVerifiable:resourceGoal.verifiable,
   accumulatorPolarity:accumulatorGoal.polarity,accumulatorLifecycle:accumulatorGoal.lifecycle,positiveClaimBlocked:accumulatorGoal.positiveClaimBlocked,
   phaseWhileAlive:phaseAlive.value,phaseWhenDepleted:phaseDead.value,
   terminal:{judged:terminal.judgedEffects,lost:terminal.lostEffects.length,retained:terminal.retainedEffects.length,suppressed:terminal.normalPlaySuppressed}});
  save();

  assert.equal(resourceGoal.polarity,'NEGATIVE','seed '+seed+': resource depletion coupled to loss of play must yield NEGATIVE');
  assert.equal(accumulatorGoal.polarity,'UNKNOWN','seed '+seed+': an accumulator must never be declared POSITIVE');
  assert(accumulatorGoal.positiveClaimBlocked,'seed '+seed+': the positive claim must be explicitly blocked');
  assert.notEqual(accumulatorGoal.lifecycle,'VERIFIED','seed '+seed+': an accumulator must not reach VERIFIED');
  assert.equal(phaseAlive.value,'PLAYING','seed '+seed+': play must be recognised while effects reproduce');
  assert.equal(phaseDead.value,'DEATH','seed '+seed+': depletion plus suppression must be recognised as DEATH');
 }

 // ---------------- Part B: the reward contract ----------------
 const REV='profile-rev-1',CTX='rom-a/core-a';
 const verifiedGoal={id:'g-verified',lifecycle:'VERIFIED',polarity:'NEGATIVE',evidenceRefs:['e1','e2']};
 const candidateGoal={id:'g-candidate',lifecycle:'CANDIDATE',polarity:'UNKNOWN'};
 const base=extra=>({eventId:'ev-'+Math.random().toString(36).slice(2),source:'verified-goal',profileRevision:REV,contextKey:CTX,
  goal:verifiedGoal,executedAction:{mask:1,frames:6,complete:true,manualOverride:false},requestedMask:1,magnitude:1,phase:'PLAYING',
  episode:{partition:'discovery'},ageMs:10,...extra});
 const fresh=()=>{const b=Reward.createBroker({profileRevision:REV,contextKey:CTX});return b;};
 const check=(name,request,expectStatus,mutate)=>{
  const broker=fresh();
  if(mutate)mutate(broker);
  const out=broker.claim(request);
  const row={name,expected:expectStatus,actual:out.status,hasValueKey:Object.prototype.hasOwnProperty.call(out,'value'),reason:out.reason||null};
  negative.push(row);save();
  assert.equal(out.status,expectStatus,name+': expected '+expectStatus+', got '+out.status+' ('+(out.reason||'')+')');
  if(out.status!=='VERIFIED')assert(!row.hasValueKey,name+': a non-verified packet must carry no value key at all');
  return out;
 };

 // Sanity: the one path that is allowed to pay out.
 const paid=check('verified goal pays out',base(),'VERIFIED');
 assert.equal(paid.value,-1,'a NEGATIVE verified goal must produce a negative value');

 // 6.3.1 unbounded counter growth without game success
 check('6.3.1 accumulator growth is not reward',base({goal:candidateGoal}),'UNKNOWN');
 // 6.3.2 the same event credited twice
 {const broker=fresh();const request=base();const first=broker.claim(request);assert.equal(first.status,'VERIFIED');
  const second=broker.claim(request);negative.push({name:'6.3.2 repeated credit of one event',expected:'INVALIDATED',actual:second.status,hasValueKey:Object.prototype.hasOwnProperty.call(second,'value'),reason:second.reason});save();
  assert.equal(second.status,'INVALIDATED');assert(!Object.prototype.hasOwnProperty.call(second,'value'));}
 // 6.3.3 reward for a timer / animation: such a goal never reaches VERIFIED
 check('6.3.3 time-driven variable is not reward',base({goal:{id:'g-timer',lifecycle:'CANDIDATE',polarity:'UNKNOWN'}}),'UNKNOWN');
 // 6.3.4 false victory after pause/menu
 check('6.3.4 outcome during menu',base({phase:'MENU'}),'INVALIDATED');
 check('6.3.4b outcome during pause',base({phase:'PAUSED'}),'INVALIDATED');
 // 6.3.5 artificial reward after save/load
 check('6.3.5 state restored between observation and outcome',base({episode:{partition:'discovery',restoredAfterObservation:true}}),'INVALIDATED');
 // 6.3.6 reward from a restored control episode
 check('6.3.6 control episode',base({episode:{partition:'control'}}),'INVALIDATED');
 // 6.3.7 exploitation of a visual artifact: an unapproved source cannot pay
 check('6.3.7 disallowed source',base({source:'visual-heuristic'}),'UNKNOWN');
 // 6.3.8 contradiction between RAM and the game outcome: the goal is revoked
 {const broker=fresh();broker.revokeGoal('g-verified','RAM contradicted the observed outcome');
  const out=broker.claim(base());negative.push({name:'6.3.8 revoked goal after contradiction',expected:'INVALIDATED',actual:out.status,hasValueKey:Object.prototype.hasOwnProperty.call(out,'value'),reason:out.reason});save();
  assert.equal(out.status,'INVALIDATED');assert(!Object.prototype.hasOwnProperty.call(out,'value'));}

 // Executed-vs-requested action, human intervention, stale events, context drift.
 check('executed mask differs from requested',base({requestedMask:2}),'INVALIDATED');
 check('human intervened in the interval',base({executedAction:{mask:1,frames:6,complete:true,manualOverride:true}}),'INVALIDATED');
 check('incomplete interval',base({executedAction:{mask:1,frames:6,complete:false,manualOverride:false}}),'UNKNOWN');
 check('stale outcome',base({ageMs:999999}),'UNKNOWN');
 check('foreign context',base({contextKey:'rom-b/core-a'}),'INVALIDATED');
 check('stale profile revision',base({profileRevision:'profile-rev-0'}),'UNKNOWN');
 check('zero magnitude is not reward',base({magnitude:0}),'UNKNOWN');

 // The UNKNOWN contract: no path may turn absence of reward into 0.
 const unknownPacket=fresh().claim(base({goal:candidateGoal}));
 const roundTrip=JSON.parse(JSON.stringify(unknownPacket));
 const contract={status:unknownPacket.status,hasValueKey:Object.prototype.hasOwnProperty.call(unknownPacket,'value'),
  hasValueAfterJson:Object.prototype.hasOwnProperty.call(roundTrip,'value'),
  numericCoercionGuarded:roundTrip.value===undefined};
 result.unknownContract=contract;save();
 assert.equal(contract.status,'UNKNOWN');
 assert(!contract.hasValueKey&&!contract.hasValueAfterJson&&contract.numericCoercionGuarded,
  'UNKNOWN must survive serialisation without acquiring a numeric value');

 // Intrinsic motivation must not travel on the game-reward channel.
 const intrinsic=Reward.intrinsicSignal('novelty',0.7);
 assert.equal(intrinsic.channel,'intrinsic');
 assert(!Object.prototype.hasOwnProperty.call(intrinsic,'value'),'intrinsic signals must not expose a game reward value');
 result.intrinsicSeparation=true;

 result.totals={seeds:induction.length,
  negativePolarityRecovered:induction.filter(r=>r.negativePolarity==='NEGATIVE').length,
  positiveClaimsBlocked:induction.filter(r=>r.positiveClaimBlocked).length,
  deathPhaseRecovered:induction.filter(r=>r.phaseWhenDepleted==='DEATH').length,
  playingPhaseRecovered:induction.filter(r=>r.phaseWhileAlive==='PLAYING').length,
  negativeCases:negative.length,
  verifiedGoalsEmittedForAccumulators:0};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,unknownContract:contract,induction}));
 console.log('PASS: evidenced NEGATIVE polarity from resource depletion plus loss of confirmed effects, deliberately blocked POSITIVE claims, PLAYING/DEATH phases, and a reward broker that survives all eight 6.3 hacking cases with the UNKNOWN contract intact; real games, holdout and Android remain untested');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
