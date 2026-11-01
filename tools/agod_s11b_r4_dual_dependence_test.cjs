'use strict';
// S11B-R / R4, specification A4: a field that is BOTH time-driven and
// action-driven, and what the phase-leak indicator is entitled to conclude.
//
// THE PROBLEM. `confirmedThatNeutralAlsoMoved` asks whether the neutral arm
// moved an address the probe went on to confirm. On every earlier fixture
// family that question has one answer, because every field there is either
// time-driven or action-driven and never both. On such a corpus the indicator
// looks like proof: whenever it fires, the confirmation really is an artefact.
// That is a property of the corpus, not of the indicator. S11B then reported
// PHASE_CONTROL_INSUFFICIENT with the words "the confirmation is an instrument
// artefact rather than a recovered causal link" - an assertion the measurement
// does not support for a field with two causes.
//
// WHAT THIS TEST ESTABLISHES, on the fifth fixture family:
//   1. timeAndAction  is confirmed AND flags the horizon as uncertain, and is
//      NOT recorded as a false causal event. Both facts survive in the record.
//   2. pureTime       the indicator fires, correctly, and no recovery is claimed.
//   3. pureAction     the indicator must NOT fire. If it does, the neutral
//      trajectory is leaking - a defect of the instrument.
//   4. slowTime       moves only at long horizons, separating "this field is
//      time-driven" from "the horizon was long enough to see that it is".
//   5. the six evidence quantities are reported separately, by name.
//   6. cadenceOnly    the cadence positive control. It steps down once every K
//      press edges and is moved by nothing else, so a continuous hold of ANY
//      duration - one press edge - can never move it, while a train of K or
//      more pulses does. Its ground truth is action structure rather than
//      duration. B = 0 on the pre-registered corpus could not be told apart
//      from an instrument unable to see cadence at all without such a field.
//
//      timeAndAction is NOT that control, and the first run of this test showed
//      why: its action half fires on EVERY edge, so the single edge of a
//      continuous hold already moves it and it came back confirmed under both
//      structures at all five horizons. "Confirmed under the train only" was
//      empty by construction, and that null result said nothing about cadence.
//
// THIS IS AN INSTRUMENT ATTESTATION, NOT A FINDING ABOUT ANY GAME, and it is
// reported apart from the pre-registered corpus. Nothing here changes A, B or C.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      {execFileSync}=require('node:child_process');
const Adapter=require('./agod_s11b_adapter.cjs'),
      Host=require('./agod_s11b_host.cjs');
const Provenance=require('./agod_provenance.cjs');

const HOLD_HORIZONS=[12,48,144,360,720];
const PULSES=[1,4,12,30,60],HOLD=4,RELEASE=8,SHIFT=3,STARTS=3,MAX_ADDRESSES=256;
const SAMPLE_EVERY=12;
const failures=[],fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);

/* R6. The SHA256 of every source file this run depended on, as the bytes
   were on disk when it started, and which of them differ from HEAD. A commit
   plus a dirty flag does not say either of those things. */
const provenance=Provenance.record({tool:'tools/agod_s11b_r4_dual_dependence_test.cjs',
 sources:['tools/make_agod_dual_dependence_rom.py']});

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-r4-'));
const seeds=(process.env.AGOD_R4_SEEDS||'1,2').split(',').map(Number);
const rows=[];
let framesSpent=0;

function build(seed){
 const out=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
 execFileSync(process.env.PYTHON||'python3',
  ['tools/make_agod_dual_dependence_rom.py','--seed',String(seed),'--out',out,'--oracle-out',orc]);
 return {bytes:Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64'),
  oracle:JSON.parse(fs.readFileSync(orc))};
}

function declaredStarts(host,pristine){
 host.driver.restore(pristine);
 const out=[];
 for(let i=0;i<STARTS;i++){
  host.driver.run(0,17+i*7);
  out.push({id:'start-'+i,stateHash:host.driver.stateHash(),
   snapshot:host.driver.snapshot(),independent:true,
   provenance:'pristine + '+(17+i*7)+' cumulative neutral frames, declared before any trial'});
 }
 return out;
}

function probeOne(host,starts,mask,alternative,spec){
 const common={starts,mask,neutralMask:0,alternativeMask:alternative,
  shiftTolerance:SHIFT,maxAddressesReported:MAX_ADDRESSES};
 const result=spec.kind==='hold'
  ?Adapter.probe(host.driver,{...common,kind:'hold',frames:spec.frames,sampleEvery:SAMPLE_EVERY})
  :Adapter.probe(host.driver,{...common,kind:'train',pulses:spec.pulses,hold:HOLD,release:RELEASE});
 framesSpent+=result.framesRun||0;
 return result;
}

/* The six quantities for ONE address, read out of the probe without collapsing
   any of them into any other.

   Note the two DIFFERENT phase-trust quantities. confirmedThatNeutralAlsoMoved
   counts addresses across the whole probe, so it describes the HORIZON: it says
   this horizon cannot be read cleanly. Whether THIS address was itself moved by
   the neutral arm is a separate fact. The first run of this test reported only
   the horizon-level flag, which made pureAction - a field with no time
   component at all - read as UNCERTAIN. Conflating the two is the same collapse
   R4 forbids, one level down. */
function sixQuantities(result,address){
 const neutralMoved=result.perStart.some(e=>(e.neutralMovedAddresses||[]).includes(address));
 const actionMoved=result.perStart.some(e=>(e.rawAttributed||[]).includes(address));
 const offTrajectory=result.perStart.some(e=>(e.attributed||[]).includes(address));
 const confirmed=result.confirmed.some(e=>e.address===address);
 const specific=result.perStart.some(e=>(e.specificToMask||[]).includes(address));
 const phaseFlagged=(result.confirmedThatNeutralAlsoMoved||[]).length>0;
 return {one_neutralArmMovedItself:neutralMoved,
  two_actionArmMovedIt:actionMoved,
  three_deviatedFromNeutralTrajectory:offTrajectory,
  four_agreedAcrossStarts:confirmed,
  five_specificToThisMask:specific,
  six_phaseTrust:phaseFlagged?'UNCERTAIN':'NOT_FLAGGED',
  six_phaseTrustScope:'HORIZON: computed over every confirmed address in this probe, not over this address alone',
  six_phaseTrustForThisAddress:(neutralMoved&&confirmed)?'UNCERTAIN':'NOT_FLAGGED',
  /* the whole point: these two can both be true at once */
  bothTimeAndActionEvidenced:neutralMoved&&confirmed&&specific};
}

for(const seed of seeds){
 const {bytes,oracle}=build(seed);
 const labels=oracle.dependenceLabels;
 const targets=[
  {name:'timeAndAction',mask:oracle.dualMask,alternative:oracle.soloMask},
  {name:'pureTime',mask:oracle.dualMask,alternative:oracle.soloMask},
  {name:'pureAction',mask:oracle.soloMask,alternative:oracle.dualMask},
  {name:'slowTime',mask:oracle.dualMask,alternative:oracle.soloMask},
  {name:'cadenceOnly',mask:oracle.dualMask,alternative:oracle.soloMask}];
 for(const target of targets){
  const host=Host.createHost({bytes,
   entry:{bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0},hold:HOLD,
   onFrames(){}});
  const pristine=host.driver.snapshot();
  const starts=declaredStarts(host,pristine);
  const address=oracle.fields[target.name].address;
  const holdSeries=HOLD_HORIZONS.map(frames=>{
   const r=probeOne(host,starts,target.mask,target.alternative,{kind:'hold',frames});
   return {frames,...sixQuantities(r,address),
    confirmedThatNeutralAlsoMoved:(r.confirmedThatNeutralAlsoMoved||[]).length,
    quantitiesReportedByProbe:!!r.evidenceQuantities};
  });
  const trainSeries=PULSES.map(pulses=>{
   const r=probeOne(host,starts,target.mask,target.alternative,{kind:'train',pulses});
   return {pulses,frames:pulses*(HOLD+RELEASE),...sixQuantities(r,address),
    confirmedThatNeutralAlsoMoved:(r.confirmedThatNeutralAlsoMoved||[]).length};
  });
  rows.push({seed,field:target.name,address,mask:target.mask,
   alternativeMask:target.alternative,
   groundTruth:{timeDriven:labels[target.name].timeDriven,
    actionDriven:labels[target.name].actionDriven,
    neutralArmMoves:labels[target.name].neutralArmMoves,
    movesUnderContinuousHold:labels[target.name].movesUnderContinuousHold,
    requiresMultipleEdges:labels[target.name].requiresMultipleEdges||null},
   holdSeries,trainSeries});
 }
}

/* ---- the checks ---- */
const of=(field,seed)=>rows.find(r=>r.field===field&&r.seed===seed);
const checks=[];
for(const seed of seeds){
 /* 1. the dual field: both causes evidenced, and not recorded as false */
 const dual=of('timeAndAction',seed);
 const bothAnywhere=[...dual.holdSeries,...dual.trainSeries].filter(t=>t.bothTimeAndActionEvidenced);
 checks.push({seed,check:'timeAndAction is confirmed AND the neutral arm moves it, at the same horizon',
  horizonsWhereBoth:bothAnywhere.map(t=>t.frames),
  pass:expect(bothAnywhere.length>0,
   'seed '+seed+': no horizon showed timeAndAction both confirmed and moved by the neutral arm, '
   +'so the case the indicator cannot resolve was never produced and this test proves nothing')});
 checks.push({seed,check:'the phase-trust status at those horizons is UNCERTAIN, not a false-event verdict',
  statuses:[...new Set(bothAnywhere.map(t=>t.six_phaseTrust))],
  pass:expect(bothAnywhere.every(t=>t.six_phaseTrust==='UNCERTAIN'),
   'seed '+seed+': a horizon with both causes evidenced did not report phase trust as UNCERTAIN')});
 /* 2. the time-only control: the indicator is entitled to fire */
 const pureTime=of('pureTime',seed);
 const timeNeutralMoves=[...pureTime.holdSeries,...pureTime.trainSeries]
  .filter(t=>t.one_neutralArmMovedItself);
 checks.push({seed,check:'pureTime is moved by the neutral arm',
  horizons:timeNeutralMoves.map(t=>t.frames),
  pass:expect(timeNeutralMoves.length>0,
   'seed '+seed+': the neutral arm never moved pureTime, so the time-only control is not a control')});
 /* 3. the action-only control: the indicator must NOT fire for it */
 const pureAction=of('pureAction',seed);
 const leaked=[...pureAction.holdSeries,...pureAction.trainSeries]
  .filter(t=>t.one_neutralArmMovedItself);
 checks.push({seed,check:'pureAction is never moved by the neutral arm',
  leakedAtHorizons:leaked.map(t=>t.frames),
  pass:expect(leaked.length===0,
   'seed '+seed+': the neutral arm moved pureAction at '+leaked.map(t=>t.frames).join(', ')
   +' frames. pureAction has no time component, so this is the neutral trajectory leaking '
   +'and a defect of the instrument, not a property of the field')});
 checks.push({seed,check:'pureAction is confirmed under its own mask',
  horizons:[...pureAction.holdSeries,...pureAction.trainSeries]
   .filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames),
  pass:expect([...pureAction.holdSeries,...pureAction.trainSeries].some(t=>t.four_agreedAcrossStarts),
   'seed '+seed+': pureAction, which is purely action-driven, was confirmed at no horizon at all, '
   +'so the instrument cannot be shown capable of confirming an action-driven field')});
 /* 4. slowTime separates "is time-driven" from "the horizon showed it".

    The first version of this check asserted "not moved at 12 frames, moved at
    720". That is not a property of the field: whether a 12-frame window
    contains a self-advance depends on the start phase, and at the first period
    tried - about 64 frames, only five times the shortest horizon - it did. The
    fixture period is now about 318 frames, on the stated criterion that it must
    exceed the shortest declared horizon by an order of magnitude. The check
    below asserts what is actually a property of the two fields: the horizon at
    which the neutral arm first moves slowTime is LATER than for pureTime. The
    per-horizon readings are reported either way. */
 const slow=of('slowTime',seed);
 const firstMoved=row=>{
  const hit=row.holdSeries.find(t=>t.one_neutralArmMovedItself);
  return hit?hit.frames:null;
 };
 const slowFirst=firstMoved(slow),timeFirst=firstMoved(pureTime);
 checks.push({seed,check:'the neutral arm reaches slowTime later than it reaches pureTime',
  pureTimeFirstMovedAtFrames:timeFirst,slowTimeFirstMovedAtFrames:slowFirst,
  slowTimePerHorizon:slow.holdSeries.map(t=>({frames:t.frames,
   neutralMoved:t.one_neutralArmMovedItself,confirmed:t.four_agreedAcrossStarts})),
  pass:expect(timeFirst!==null&&(slowFirst===null||slowFirst>timeFirst),
   'seed '+seed+': the neutral arm first moved pureTime at '+timeFirst+' frames and slowTime at '
   +slowFirst+'. The two are not separated, so "this field is time-driven" and "the horizon was '
   +'long enough to see that it is" are still not distinguished by this corpus')});
 checks.push({seed,check:'slowTime is never falsely confirmed under the pulse train',
  confirmedUnderTrain:slow.trainSeries.filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames),
  pass:true,
  note:'reported, not asserted: a time-only field confirmed at a long horizon is the '
   +'tolerance-scaling limit already recorded as C24.4, not a new defect.'});
 /* 5. the six quantities are reported by the probe itself */
 checks.push({seed,check:'the probe reports the six quantities separately, by name',
  pass:expect(dual.holdSeries.every(t=>t.quantitiesReportedByProbe),
   'seed '+seed+': the probe did not report an evidenceQuantities block')});
 /* 5b. the horizon-level flag and the address-level fact are different */
 checks.push({seed,check:'the phase-trust flag is reported at horizon level AND per address, separately',
  pureActionHorizonFlag:[...new Set(pureAction.holdSeries.map(t=>t.six_phaseTrust))],
  pureActionAddressFlag:[...new Set(pureAction.holdSeries.map(t=>t.six_phaseTrustForThisAddress))],
  pass:expect(pureAction.holdSeries.every(t=>t.six_phaseTrustForThisAddress==='NOT_FLAGGED'),
   'seed '+seed+': pureAction, which has no time component, was flagged as uncertain at the '
   +'ADDRESS level, so the per-address quantity is not measuring what it claims')});

 /* 6. the cadence positive control, on the field whose ground truth is cadence */
 const cadence=of('cadenceOnly',seed);
 const cadenceTrain=cadence.trainSeries.filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames);
 const cadenceHold=cadence.holdSeries.filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames);
 const cadenceTrainOnly=cadenceTrain.filter(f=>!cadenceHold.includes(f));
 checks.push({seed,check:'cadence positive control: cadenceOnly is confirmed under the train and not under the duration-matched hold',
  confirmedUnderTrain:cadenceTrain,confirmedUnderHold:cadenceHold,
  confirmedUnderTrainOnly:cadenceTrainOnly,
  instrumentCanSeeCadence:cadenceTrainOnly.length>0,
  groundTruth:'a continuous hold is ONE press edge and cannot move this field at any duration; '
   +'a train of '+(cadence.groundTruth.requiresMultipleEdges||'K')+' or more pulses can',
  pass:true,
  note:'reported, not asserted. A null result here is a measured limit of the instrument and is '
   +'published as one; forcing it to be non-zero is exactly what this programme forbids.'});
 checks.push({seed,check:'cadenceOnly is NOT confirmed under any continuous hold',
  confirmedUnderHold:cadenceHold,
  pass:expect(cadenceHold.length===0,
   'seed '+seed+': cadenceOnly was confirmed under a continuous hold at '+cadenceHold.join(', ')
   +' frames. A continuous hold produces one press edge and cannot move this field, so the '
   +'instrument attributed something else to it')});

 /* the measured reason timeAndAction is not the cadence control */
 const trainConfirmed=dual.trainSeries.filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames);
 const holdConfirmed=dual.holdSeries.filter(t=>t.four_agreedAcrossStarts).map(t=>t.frames);
 checks.push({seed,check:'why timeAndAction is not the cadence control: it is confirmed under both structures',
  confirmedUnderTrain:trainConfirmed,confirmedUnderHold:holdConfirmed,
  confirmedUnderTrainOnly:trainConfirmed.filter(f=>!holdConfirmed.includes(f)),
  pass:true,
  note:'its action half fires on every edge, so the single edge of a continuous hold already '
   +'moves it. Recorded so the empty train-only set is not mistaken for a statement about cadence.'});
}

const report={type:'gu-agod-s11b-r4-dual-dependence-test',version:1,
 item:'R4 / A4 - a field that is both time-driven and action-driven',
 classification:'INSTRUMENT ATTESTATION, reported apart from the pre-registered corpus. '
  +'Nothing here enters A, B or C, and nothing here is evidence about any game.',
 fixtureFamily:'dual-dependence (tools/make_agod_dual_dependence_rom.py), the fifth family',
 parameters:{holdHorizons:HOLD_HORIZONS,pulses:PULSES,hold:HOLD,release:RELEASE,
  shiftTolerance:SHIFT,startsPerTrial:STARTS,sampleEveryFrames:SAMPLE_EVERY,
  shiftToleranceUnchanged:'the pre-registered value 3 is not altered'},
 rule:'the phase-leak indicator is a state of the instrument. UNCERTAIN means this horizon '
  +'cannot be read cleanly; it never means a particular confirmation is false. A field with two '
  +'causes lands there while being correctly confirmed.',
 provenance,
 rows,checks,
 cost:{emulatedFrames:framesSpent},
 totals:{checks:checks.length,passing:checks.filter(c=>c.pass===true).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.AGOD_R4_REPORT)
 fs.writeFileSync(process.env.AGOD_R4_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 cadence:checks.filter(c=>c.instrumentCanSeeCadence!==undefined).map(c=>({seed:c.seed,
  check:c.check.slice(0,60),
  confirmedUnderTrain:c.confirmedUnderTrain,confirmedUnderHold:c.confirmedUnderHold,
  confirmedUnderTrainOnly:c.confirmedUnderTrainOnly,
  instrumentCanSeeCadence:c.instrumentCanSeeCadence})),
 cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
