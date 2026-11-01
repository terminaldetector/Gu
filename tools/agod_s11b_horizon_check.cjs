'use strict';
// S11B: at what temporal scale is a change actually tied to the action?
//
// Pre-registered in reports 26 (v1), 27 (v2) and 28 (v2.1). Horizons, pulses,
// shift tolerance, budget and the NEGATIVE criteria are as declared and are not
// adjusted after seeing results.
//
//   Series A  continuous hold, horizons [12,48,120,240,480]
//   Series B  pulse train, HOLD=4 RELEASE=8, pulses [1,4,12,30,60]
//             (horizons 12,48,144,360,720) WITH duration-matched continuous
//             controls at the same [12,48,144,360,720], so that
//             RECOVERED_BY_CADENCE means "structure, not merely more time".
//
// Thirteen declared outcomes, never merged under CAUSAL_RECOVERED. A limit of
// the instrument is never reported as the absence of a game event.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Adapter=require('./agod_s11b_adapter.cjs'),
      Phase=require('./agod_phase_evidence.cjs'),
      Host=require('./agod_s11b_host.cjs'),
      Provenance=require('./agod_provenance.cjs');

/* ---- pre-registered, not derived from any result ---- */
const SERIES_A_HORIZONS=[12,48,120,240,480];
const PULSES=[1,4,12,30,60],HOLD=4,RELEASE=8;
const PAIRED_CONTROLS=PULSES.map(p=>p*(HOLD+RELEASE));      /* 12,48,144,360,720 */
const SHIFT=3,STARTS=3,MAX_ADDRESSES=256,SAMPLE_EVERY=12;
const FRAME_BUDGET=4000000;
const PRIMARY_CANDIDATES=6,EXTRA_CANDIDATES=4;
const rows=[];
let framesSpent=0,snapshotsTaken=0,bytesRead=0,candidateEvaluations=0;
const started=Date.now();
/* R6 / specification 8. The final S11B report recorded commit a2aad98 with
   workingTreeDirty = true. Both true, and together they do not say which files
   differed or what was in them, so the result could not be reproduced against
   the published source. The run now records the SHA256 of every source file it
   depends on, as the bytes were on disk when it started, and names the ones
   that differ from HEAD. No evidence may outlive its own provenance. */
const provenance={...Provenance.record({
  tool:'tools/agod_s11b_horizon_check.cjs',
  sources:['tools/make_agod_test_rom.py','tools/make_agod_transition_rom.py',
   'tools/make_agod_sacrifice_rom.py','tools/make_agod_rate_trap_rom.py']}),
 causalRevision:Causal.DETECTOR_REVISION,adapterRevision:Adapter.ADAPTER_REVISION,
 phaseRevision:Phase.PHASE_EVIDENCE_REVISION,hostRevision:Host.HOST_REVISION};
const report={type:'gu-agod-s11b-horizon-check',version:1,
 preregistration:['26_S11B_PREREGISTRATION_RU.md (v1)','27_S11B_PREREGISTRATION_V2_RU.md (v2)','28_S11B_PROTOCOL_V21_RU.md (v2.1)'],
 seriesA:{kind:'continuous hold',horizons:SERIES_A_HORIZONS,sampleEveryFrames:SAMPLE_EVERY},
 seriesB:{kind:'pulse train',hold:HOLD,release:RELEASE,pulses:PULSES,
  horizons:PAIRED_CONTROLS,pairedContinuousControls:PAIRED_CONTROLS},
 shiftTolerance:SHIFT,startsPerTrial:STARTS,maxAddressesReported:MAX_ADDRESSES,
 frameBudget:FRAME_BUDGET,
 outcomes:['OBSERVABLE_AT_BASELINE','DURATION_EXPLAINS_NOT_CADENCE','PHASE_CONTROL_INSUFFICIENT','RECOVERED_BY_DURATION','RECOVERED_BY_CADENCE','CADENCE_UNDECIDABLE',
  'TIME_EXPLAINED','NOT_REPRODUCIBLE_ACROSS_STARTS','TRANSIENT_WITHIN_WINDOW',
  'FINAL_STATE_UNCHANGED','NO_CHANGE_AT_SAMPLED_POINTS','ADDRESS_COVERAGE_UNKNOWN',
  'ADAPTER_DIVERGENCE_UNRESOLVED','NOT_OBSERVED','NOT_COMPARABLE','BUDGET_EXCEEDED'],
 outcomeAddedDuringS11B:{name:'PHASE_CONTROL_INSUFFICIENT',
  reason:'the first synthetic run showed the declared shiftTolerance of 3 does not scale with the horizon: known time-driven fields (timer, frameCounter) are rejected at 12 frames and falsely CONFIRMED from 48 frames upward, so a confirmation at a long horizon is not interpretable as causal. Awarding RECOVERED_BY_DURATION there would present an instrument artefact as a recovered causal link - the mirror image of presenting an instrument limit as an absent event.',
  declaredRule:'where a control field known to be time-driven is confirmed at a horizon, that horizon is marked PHASE_CONTROL_INSUFFICIENT and no recovery is claimed from it',
  shiftToleranceUnchanged:'the pre-registered value 3 is NOT altered; a horizon-scaled tolerance is a separately declared comparison',
  meaningOfTheFlag:'a state of the instrument at a horizon, not a verdict about a candidate. R4 / A4: a field that is both time-driven and action-driven moves in the neutral arm while being correctly confirmed, so the flag withholds a recovery claim without asserting the confirmation is false. The fifth fixture family and agod_s11b_r4_dual_dependence_test.cjs keep that distinction measurable.',
  horizonLevelNotAddressLevel:'confirmedThatNeutralAlsoMoved counts addresses across the whole probe, so the flag describes the HORIZON. Whether one particular address was itself moved by the neutral arm is a separate quantity and is reported separately.'},
 rules:['a limit of the observing instrument is never the absence of a game event',
  'an instrument artefact is never a recovered causal link',
  'the raw diff is recorded separately and never promoted to causal evidence',
  'RECOVERED_BY_CADENCE requires a duration-matched continuous control',
  'more observed RAM changes is not success'],
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_S11B_REPORT)
 fs.writeFileSync(process.env.AGOD_S11B_REPORT,JSON.stringify(report,null,2)+'\n');};write();

/* R2 / A2. The host now comes from agod_s11b_host.cjs, which both this
   experiment and agod_s11b_r2_phase_channel_test.cjs drive. The host built
   here previously passed an EMPTY onFrame callback, so lastFrame() stayed null
   for the whole run and the phase attestation could only ever report a
   non-PASS: an instrument that had never been wired, reporting a finding about
   the cartridge. The correct wiring already existed in
   agod_real_game_check.cjs; keeping two copies is what let the broken one
   decide results, so there is now one. */
function machine(bytes,entry){
 /* R6. The budget is passed to the host, which meters every run, so an arm
    that would cross the ceiling fails by name. Checking only between
    candidates let one candidate overrun the budget by a whole series of arms.
    The remaining budget is what is granted, so the ceiling is global across
    every cartridge in the run and not per cartridge. */
 return Host.createHost({bytes,entry,hold:HOLD,
  frameBudget:Math.max(1,FRAME_BUDGET-framesSpent),
  onFrames(count){framesSpent+=count;},
  onSnapshot(count){snapshotsTaken++;bytesRead+=count;}});
}

/* The same pre-declared start states for every horizon and mask. */
function declaredStarts(host,pristine){
 const {driver}=host;
 driver.restore(pristine);
 const out=[];
 for(let i=0;i<STARTS;i++){
  driver.run(0,17+i*7);
  out.push({id:'start-'+i,stateHash:driver.stateHash(),
   snapshot:driver.snapshot(),independent:true,
   provenance:'pristine + '+(17+i*7)+' cumulative neutral frames, declared before any trial'});
 }
 return out;
}

/* One trial: either series. Returns coverage and horizon-movement verdicts for
   the target address, each kept apart. */
function trial(host,starts,candidate,spec){
 if(framesSpent>=FRAME_BUDGET)return {budgetExceeded:true};
 candidateEvaluations++;
 const alternative=candidate.mask===1?2:1;
 const common={starts,mask:candidate.mask,neutralMask:0,alternativeMask:alternative,
  shiftTolerance:SHIFT,maxAddressesReported:MAX_ADDRESSES};
 const result=spec.kind==='hold'
  ?Adapter.probe(host.driver,{...common,kind:'hold',frames:spec.frames,sampleEvery:SAMPLE_EVERY})
  :Adapter.probe(host.driver,{...common,kind:'train',pulses:spec.pulses,hold:HOLD,release:RELEASE});
 const coverage=Adapter.addressCoverage(result,candidate.address);
 const movement=Adapter.horizonMovement(result,candidate.address);
 /* reproducibility across the declared starts, separately from confirmation */
 const perStartHasIt=result.perStart.map(e=>(e.attributed||[]).includes(candidate.address));
 return {kind:spec.kind,frames:spec.kind==='hold'?spec.frames:spec.pulses*(HOLD+RELEASE),
  pulses:spec.kind==='train'?spec.pulses:null,
  coverage,movement,
  confirmed:coverage.attributedMembership,
  reproducibleAcrossStarts:perStartHasIt.length>0&&perStartHasIt.every(Boolean),
  onSomeStart:perStartHasIt.some(Boolean),
  usableStarts:result.usableStarts,excludedStarts:result.excludedStarts,
  reportTruncated:result.anyReportTruncated,
  rawDiffMembership:coverage.rawDiffMembership,
  /* oracle-free instrument indicator: confirmed addresses that the neutral arm
     moved by itself. Greater than zero means the phase control did not cover
     the drift at this horizon, so a confirmation here is suspect. */
  confirmedThatNeutralAlsoMoved:(result.confirmedThatNeutralAlsoMoved||[]).length,
  phaseControlSuspect:(result.confirmedThatNeutralAlsoMoved||[]).length>0,
  neutralMovedCount:result.perStart.reduce((t,e)=>Math.max(t,e.neutralMovedCount||0),0),
  framesRun:result.framesRun};
}

/* The outcome for one candidate, from its two series. Every branch is one of
   the thirteen declared outcomes; none is merged into another. */
function classify(candidate,seriesA,seriesB,pairedControls,gatePassed,isKnownTimeDriven,trustworthy){
 /* A known time-driven control that the probe CONFIRMS is proof the phase
    control failed at that horizon, not proof of a causal link. */
 if(isKnownTimeDriven){
  const confirmedHold=seriesA.filter(t=>t.confirmed).map(t=>t.frames);
  const confirmedTrain=seriesB.filter(t=>t.confirmed).map(t=>t.frames);
  if(confirmedHold.length||confirmedTrain.length)
   return {outcome:'PHASE_CONTROL_INSUFFICIENT',
    confirmedHoldFrames:confirmedHold,confirmedTrainFrames:confirmedTrain,
    /* Reached only for a field the ORACLE labels time-driven and NOT
       action-driven, so here the stronger reading is earned: there is no
       action component for the confirmation to be about. A field labelled
       with both causes is kept out of this branch by the caller. */
    why:'this field is a KNOWN time-driven control with no action component, and the probe confirmed it, so the neutral trajectory failed to cover the drift at those horizons. No recovery is claimed from any horizon in this list.',
    appliesOnlyToSingleCauseControls:true};
  return {outcome:'TIME_EXPLAINED',
   why:'a known time-driven control, correctly rejected at every horizon: the phase control held here'};
 }
 /* Only horizons the instrument check did not flag may support a recovery. */
 const okHold=seriesA.filter(t=>!t.phaseControlSuspect);
 const okTrain=seriesB.filter(t=>!t.phaseControlSuspect);
 const shortHold=okHold.find(t=>t.frames===12);
 const longHold=[...okHold].reverse().find(t=>t.confirmed);
 const anyHoldConfirmed=okHold.some(t=>t.confirmed);
 const anyTrainConfirmed=okTrain.some(t=>t.confirmed);
 const confirmedOnlyWhereSuspect=
  (seriesA.some(t=>t.confirmed)||seriesB.some(t=>t.confirmed))&&!anyHoldConfirmed&&!anyTrainConfirmed;
 if(confirmedOnlyWhereSuspect)
  return {outcome:'PHASE_CONTROL_INSUFFICIENT',
   suspectHoldFrames:trustworthy?trustworthy.suspectHold:null,
   suspectTrainFrames:trustworthy?trustworthy.suspectTrain:null,
   /* R4 / A4. This used to end "the confirmation is an instrument artefact
      rather than a recovered causal link". That asserts more than the
      measurement supports. A field can be time-driven AND action-driven at
      once - the fifth fixture family is built to contain one, and
      agod_s11b_r4_dual_dependence_test.cjs confirms timeAndAction at every
      horizon while the neutral arm also moves it. The flag withholds a
      recovery claim; it does not assert falsity. */
   why:'this candidate was confirmed ONLY at horizons where the probe also confirmed addresses the neutral arm moved by itself, so the phase control did not cover the drift there and the horizon cannot be read cleanly. No recovery is claimed from such a horizon. This is NOT a verdict that the confirmation is false: a field that is both time-driven and action-driven lands here while being correctly confirmed.',
   whatWouldSettleIt:'a horizon at which no confirmed address is also moved by the neutral arm, or an independent channel that attributes the change to the action without relying on the neutral trajectory'};
 const notes=[];
 /* DEFECT FOUND BY READING THE RESULT. The fallback below used to return
    RECOVERED_BY_DURATION whenever a candidate was confirmed under both the
    train and the duration-matched hold. That swept up candidates that were
    ALREADY confirmed at the 12-frame baseline, and reported them as recovered
    by duration when nothing had been recovered at all: it inflated A to 6 on
    the synthetic corpus where the truth is 0. A baseline confirmation is now
    its own outcome and contributes to neither A nor B. */
 const baseline=seriesA.find(t=>t.frames===12)||seriesB.find(t=>t.frames===12);
 if(baseline&&baseline.confirmed&&!baseline.phaseControlSuspect)
  return {outcome:'OBSERVABLE_AT_BASELINE',atFrames:12,
   why:'already confirmed at the 12-frame baseline, so neither a longer horizon nor a different action structure recovered anything'};
 /* A: duration - confirmed at a long horizon, not at the short one, same regime */
 if(anyHoldConfirmed&&shortHold&&!shortHold.confirmed)
  return {outcome:'RECOVERED_BY_DURATION',
   atFrames:longHold?longHold.frames:null,
   why:'confirmed under continuous hold at a longer horizon and not at 12 frames, within the same regime'};
 /* B: cadence - needs a duration-matched continuous control that does NOT confirm */
 if(anyTrainConfirmed){
  const confirmedTrain=seriesB.find(t=>t.confirmed);
  const matched=pairedControls.find(c=>c.frames===confirmedTrain.frames);
  if(!matched)
   return {outcome:'CADENCE_UNDECIDABLE',atFrames:confirmedTrain.frames,
    why:'confirmed under the pulse train, but no duration-matched continuous control exists at that duration, so structure and duration cannot be separated'};
  if(!gatePassed)
   return {outcome:'ADAPTER_DIVERGENCE_UNRESOLVED',atFrames:confirmedTrain.frames,
    why:'the adapter and the standard detector diverged, so a cadence claim would compare two instruments'};
  if(!matched.confirmed)
   return {outcome:'RECOVERED_BY_CADENCE',atFrames:confirmedTrain.frames,
    why:'confirmed under the pulse train and NOT under continuous hold of the same duration'};
  return {outcome:'DURATION_EXPLAINS_NOT_CADENCE',atFrames:confirmedTrain.frames,
   why:'confirmed under both the train and the duration-matched hold of the same length, so the duration accounts for it and the action structure adds nothing. This is NOT a recovery: it does not enter A or B.'};
 }
 /* C: the remaining uncertainty, each cause named */
 const all=[...seriesA,...seriesB,...pairedControls];
 if(all.every(t=>t.phaseControlSuspect))
  return {outcome:'PHASE_CONTROL_INSUFFICIENT',
   why:'every horizon tried was flagged by the instrument check, so nothing here is interpretable'};
 if(all.some(t=>t.budgetExceeded))return {outcome:'BUDGET_EXCEEDED',why:'the declared frame budget ended before this candidate was fully evaluated'};
 if(all.some(t=>t.onSomeStart&&!t.reproducibleAcrossStarts))
  return {outcome:'NOT_REPRODUCIBLE_ACROSS_STARTS',
   why:'attributed on some declared starts and not on others'};
 if(all.some(t=>t.movement&&t.movement.outcome==='TRANSIENT_WITHIN_WINDOW'))
  return {outcome:'TRANSIENT_WITHIN_WINDOW',
   why:'an intermediate sample moved and the endpoint did not'};
 if(all.some(t=>t.coverage&&t.coverage.status==='ADDRESS_COVERAGE_UNKNOWN'))
  return {outcome:'ADDRESS_COVERAGE_UNKNOWN',
   why:'the probe report was truncated and membership in the full set is not established: a limit of the instrument, not the absence of an event'};
 const sampled=all.every(t=>!t.movement||t.movement.sampledThroughout);
 if(all.some(t=>t.rawDiffMembership))
  return {outcome:'TIME_EXPLAINED',
   why:'the address differed in the raw diff but never survived the neutral trajectory, so the change is not separable from the neutral course of the game'};
 /* R5 / A5. This returned NO_EVENT_IN_HORIZON, which claims the horizon
    contained no event. The samples are 12 frames apart, so a change that
    appears and disappears entirely between two adjacent snapshots is invisible
    to them: the strongest honest claim is about the sampled points. The
    adapter's own label was corrected first; this, the outcome the experiment
    actually publishes, had been left behind. */
 return {outcome:sampled?'NO_CHANGE_AT_SAMPLED_POINTS':'FINAL_STATE_UNCHANGED',
  samplingIntervalFrames:SAMPLE_EVERY,
  cannotExcludeBetweenSamples:true,
  why:sampled?'no intermediate or final sample moved across any declared horizon. A transient entirely between two adjacent snapshots, '+SAMPLE_EVERY+' frames apart, is NOT excluded: this is a limit of the sampling density and not the absence of a game event'
   :'endpoints matched and intermediate samples do not cover the horizon'};
}

function evaluate(label,extra,bytes,entry,candidatesFrom,gatePassed,attestPhase){
 const host=machine(bytes,entry);
 const pristine=host.driver.snapshot();
 const starts=declaredStarts(host,pristine);
 let phase=null;
 if(attestPhase){
  /* R2 / A2. The S8 parameters, so this attestation is the same measurement the
     rest of the programme reports and not a cheaper variant of it. */
  const p=Phase.measurePhase(host.phaseProbe(pristine),
   {idleFrames:180,pulses:14,settleFrames:60});
  phase={status:p.phase,modalities:p.modalities,parameters:p.parameters,
   video:{videoAvailable:p.video.videoAvailable,
    videoFramesCaptured:p.video.videoFramesCaptured,
    differingPixelsHeld:p.video.differingPixelsHeld,
    differingPixelsAfterRelease:p.video.differingPixelsAfterRelease,
    localisedEnoughToBeAnObject:p.video.localisedEnoughToBeAnObject,
    differenceSurvivesRelease:p.video.differenceSurvivesRelease},
   ram:{bidirectionalRamAddresses:p.ram.bidirectionalRamAddresses,
    distinctOutcomesAcrossEightButtons:p.ram.distinctOutcomesAcrossEightButtons},
   idlePictureMotionWithoutInput:p.idle.pictureMotionWithoutInput,
   comparabilityCounts:p.phase==='PASS',
   instrumentFailureNotAFinding:p.phase==='VIDEO_UNAVAILABLE'};
 }
 const candidates=candidatesFrom.slice(0,PRIMARY_CANDIDATES+EXTRA_CANDIDATES);
 /* Which candidates are KNOWN time-driven controls. Used only as a checker,
    after the trials, to decide whether the instrument can be trusted at a
    given horizon. */
 /* A control counts as purely time-driven only when the oracle labels it
    time-driven and does NOT label it action-driven. R4: a field with both
    causes must not be routed into the single-cause branch, which is entitled
    to a stronger reading than a dual-dependence field allows. */
 const controlAddresses=new Set(candidates
  .filter(c=>/time-driven/.test(c.source||'')&&!/action-driven/.test(c.source||''))
  .map(c=>c.address));
 const dualAddresses=new Set(candidates
  .filter(c=>/time-driven/.test(c.source||'')&&/action-driven/.test(c.source||''))
  .map(c=>c.address));
 const perCandidate=[];
 for(const candidate of candidates){
  if(framesSpent>=FRAME_BUDGET){
   perCandidate.push({...candidate,outcome:{outcome:'BUDGET_EXCEEDED',
    why:'the declared frame budget ended before this candidate was evaluated'}});
   continue;
  }
  host.driver.restore(pristine);
  const seriesA=SERIES_A_HORIZONS.map(frames=>trial(host,starts,candidate,{kind:'hold',frames}));
  const seriesB=PULSES.map(pulses=>trial(host,starts,candidate,{kind:'train',pulses}));
  const paired=PAIRED_CONTROLS.map(frames=>trial(host,starts,candidate,{kind:'hold',frames}));
  /* Which horizons may be trusted for THIS candidate, oracle-free: those where
     no confirmed address is one the neutral arm moved by itself. */
  const trustworthy={
   hold:seriesA.filter(t=>t&&!t.phaseControlSuspect).map(t=>t.frames),
   train:seriesB.filter(t=>t&&!t.phaseControlSuspect).map(t=>t.frames),
   suspectHold:seriesA.filter(t=>t&&t.phaseControlSuspect).map(t=>t.frames),
   suspectTrain:seriesB.filter(t=>t&&t.phaseControlSuspect).map(t=>t.frames)};
  const outcome=classify(candidate,seriesA,seriesB,paired,gatePassed,
   controlAddresses.has(candidate.address),trustworthy);
  if(dualAddresses.has(candidate.address))
   outcome.dualDependenceControl='this candidate is labelled BOTH time-driven and action-driven. '
    +'A phase-trust flag on it is uncertainty of the instrument at that horizon and never a false '
    +'causal event.';
  perCandidate.push({address:candidate.address,mask:candidate.mask,
   source:candidate.source,
   seriesA:seriesA.map(t=>({frames:t.frames,confirmed:t.confirmed,
    coverage:t.coverage?t.coverage.status:null,movement:t.movement?t.movement.outcome:null,
    reproducible:t.reproducibleAcrossStarts,truncated:t.reportTruncated,
    rawDiff:t.rawDiffMembership})),
   seriesB:seriesB.map(t=>({pulses:t.pulses,frames:t.frames,confirmed:t.confirmed,
    coverage:t.coverage?t.coverage.status:null,movement:t.movement?t.movement.outcome:null,
    reproducible:t.reproducibleAcrossStarts,truncated:t.reportTruncated,
    rawDiff:t.rawDiffMembership})),
   pairedControls:paired.map(t=>({frames:t.frames,confirmed:t.confirmed,
    coverage:t.coverage?t.coverage.status:null,suspect:t.phaseControlSuspect})),
   trustworthyHorizons:trustworthy,
   outcome});
  write();
 }
 const row={label,...extra,
  phaseAttestation:phase,
  startStateLevels:{SINGLE_SAVESTATE_REPLAY:false,MULTIPLE_SAVED_STATES:true,
   INDEPENDENT_HISTORIES:false,PHASE_ATTESTED:!!(phase&&phase.status==='PASS'),
   note:'the declared starts are distinct saved states from one pristine snapshot: multiple saved states, NOT independent histories. An identical state hash would not be an independent history either.'},
  candidatesEvaluated:perCandidate.length,perCandidate};
 rows.push(row);write();
 return row;
}

try{
 /* the T2 gate decides whether RECOVERED_BY_CADENCE may be used at all */
 let gatePassed=false,gateSource=null;
 const gatePath=process.env.AGOD_T2_GATE;
 if(gatePath&&fs.existsSync(gatePath)){
  const gate=JSON.parse(fs.readFileSync(gatePath));
  gatePassed=gate.totals&&gate.totals.gatePassed===true;
  gateSource={file:path.basename(gatePath),status:gate.status,
   trials:gate.totals?gate.totals.trials:null,equivalent:gate.totals?gate.totals.equivalent:null};
 }
 report.t2Gate=gateSource?{...gateSource,passed:gatePassed}
  :{passed:false,note:'no T2 report supplied: RECOVERED_BY_CADENCE is withheld'};
 write();

 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s11b-'));
 const build=(generator,seed,extraArgs)=>{
  const tag=path.basename(generator)+'-'+seed+'-'+(extraArgs||[]).join('');
  const out=path.join(directory,'rom-'+tag+'.json'),orc=path.join(directory,'oracle-'+tag+'.json');
  execFileSync(process.env.PYTHON||'python3',
   [generator,'--seed',String(seed),'--out',out,'--oracle-out',orc,...(extraArgs||[])]);
  return {bytes:Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64'),
   oracle:JSON.parse(fs.readFileSync(orc))};
 };
 const bootOnly={bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0};
 const fieldAsCandidate=(oracle,name,mask,source)=>({address:oracle.fields[name].address,
  mask,source:source||name});

 /* --- the required synthetic mechanisms, each with its driving mask --- */
 const plan=[];
 for(const seed of (process.env.AGOD_S11B_SEEDS||'0').split(',').map(Number)){
  const {bytes,oracle}=build('tools/make_agod_test_rom.py',seed);
  plan.push({label:'test seed '+seed+' (lives: a repeatedly decreasing resource)',
   extra:{corpus:'synthetic',family:'test',seed},bytes,entry:bootOnly,
   candidates:[fieldAsCandidate(oracle,'lives',oracle.negativeMask,'lives'),
    fieldAsCandidate(oracle,'timer',oracle.negativeMask,'timer (time-driven)'),
    fieldAsCandidate(oracle,'frameCounter',oracle.negativeMask,'frameCounter (time-driven)')]});
 }
 for(const arm of [1,4]){
  const {bytes,oracle}=build('tools/make_agod_transition_rom.py',1,['--arm-presses',String(arm)]);
  plan.push({label:'single-transition arm='+arm,
   extra:{corpus:'synthetic',family:'single-transition',armPresses:arm},bytes,entry:bootOnly,
   candidates:[fieldAsCandidate(oracle,'singleUnit',oracle.spendMask,'singleUnit'),
    fieldAsCandidate(oracle,'oneShotSwitch',oracle.latchMask,'oneShotSwitch'),
    fieldAsCandidate(oracle,'firstThenLater',oracle.latchMask,'firstThenLater'),
    fieldAsCandidate(oracle,'frameCounter',oracle.latchMask,'frameCounter (time-driven)')]});
 }
 for(const seed of (process.env.AGOD_S11B_SACRIFICE||'3').split(',').map(Number)){
  const {bytes,oracle}=build('tools/make_agod_sacrifice_rom.py',seed);
  plan.push({label:'sacrifice seed '+seed,
   extra:{corpus:'synthetic',family:'sacrifice',seed},bytes,entry:bootOnly,
   candidates:[fieldAsCandidate(oracle,'charges',oracle.spendMask,'charges'),
    fieldAsCandidate(oracle,'treasure',oracle.actMask,'treasure')]});
 }
 for(const seed of (process.env.AGOD_S11B_TRAP||'5').split(',').map(Number)){
  const {bytes,oracle}=build('tools/make_agod_rate_trap_rom.py',seed);
  plan.push({label:'rate-trap seed '+seed,
   extra:{corpus:'synthetic',family:'rate-trap',seed},bytes,entry:bootOnly,
   candidates:[fieldAsCandidate(oracle,'fuel',oracle.spendMask,'fuel'),
    fieldAsCandidate(oracle,'steadyGain',oracle.collectMask,'steadyGain'),
    fieldAsCandidate(oracle,'fickleDecoy',oracle.fiddleMask,'fickleDecoy')]});
 }
 for(const item of plan)
  evaluate(item.label,item.extra,item.bytes,item.entry,item.candidates,gatePassed,false);

 /* --- the real cartridges: the S10B/S11A candidates, unchanged --- */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 if(ROMS){
  const real=[
   {rom:'lifeforce',pulses:1,settle:60,candidates:[{address:1629,mask:8},{address:927,mask:2}]},
   {rom:'lifeforce',pulses:6,settle:60,candidates:[{address:114,mask:16},{address:927,mask:2}]},
   {rom:'contra',pulses:6,settle:300,candidates:[{address:266,mask:8},{address:480,mask:2}]}];
  for(const spec of real){
   const file=path.join(ROMS,spec.rom+'.nes');
   if(!fs.existsSync(file)){rows.push({label:spec.rom,status:'BLOCKED: not present'});write();continue;}
   evaluate(spec.rom+' '+spec.pulses+'/'+spec.settle,
    {corpus:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
     entryProcedure:{bootFrames:240,startPulses:spec.pulses,gapFramesBetweenPresses:24,settleFrames:spec.settle},
     candidateSource:'the S10B / S11A candidates, unchanged'},
    fs.readFileSync(file),
    {bootFrames:240,startPulses:spec.pulses,gapFrames:24,settleFrames:spec.settle},
    spec.candidates.map(c=>({...c,source:'S10B/S11A'})),gatePassed,true);
  }
 }else report.privateCorpus='AGOD_PRIVATE_ROMS not set: the real half was not run';

 /* --- A / B / C --- */
 const everyCandidate=rows.flatMap(r=>(r.perCandidate||[]).map(c=>({row:r,c})));
 const tally={};
 for(const {c} of everyCandidate){
  const key=c.outcome?c.outcome.outcome:'MISSING';
  tally[key]=(tally[key]||0)+1;
 }
 const byCorpus={};
 for(const {row,c} of everyCandidate){
  const k=row.corpus==='synthetic'?'synthetic':'real';
  byCorpus[k]=byCorpus[k]||{};
  const key=c.outcome?c.outcome.outcome:'MISSING';
  byCorpus[k][key]=(byCorpus[k][key]||0)+1;
 }
 const countOf=(set,keys)=>keys.reduce((t,k)=>t+(set[k]||0),0);
 report.totals={
  candidates:everyCandidate.length,outcomes:tally,outcomesByCorpus:byCorpus,
  headline:{
   A_missedForWantOfHorizon:tally.RECOVERED_BY_DURATION||0,
   B_missedForWrongActionStructure:tally.RECOVERED_BY_CADENCE||0,
   instrumentArtefacts_PHASE_CONTROL_INSUFFICIENT:tally.PHASE_CONTROL_INSUFFICIENT||0,
   observableAtBaseline_neitherAnorB:tally.OBSERVABLE_AT_BASELINE||0,
   durationExplainsNotCadence_neitherAnorB:tally.DURATION_EXPLAINS_NOT_CADENCE||0,
   C_remainingUncertainty:countOf(tally,['PHASE_CONTROL_INSUFFICIENT','CADENCE_UNDECIDABLE','TIME_EXPLAINED',
    'NOT_REPRODUCIBLE_ACROSS_STARTS','TRANSIENT_WITHIN_WINDOW','FINAL_STATE_UNCHANGED',
    'NO_CHANGE_AT_SAMPLED_POINTS','ADDRESS_COVERAGE_UNKNOWN','ADAPTER_DIVERGENCE_UNRESOLVED',
    'NOT_OBSERVED','NOT_COMPARABLE','BUDGET_EXCEEDED'])},
  cost:{emulatedFrames:framesSpent,frameBudget:FRAME_BUDGET,
   budgetExhausted:framesSpent>=FRAME_BUDGET,
   ramSnapshots:snapshotsTaken,ramBytesRead:bytesRead,
   cpuWallClockMs:Date.now()-started,candidateEvaluations},
  t2Gate:report.t2Gate,
  note:'more observed RAM changes is not success. A and B count candidates whose causal observability was recovered; C names every remaining cause separately, and none of its members is evidence that a game resource is useless'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,
  totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
