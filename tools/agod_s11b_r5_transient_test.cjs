'use strict';
// S11B-R / R5, specification A5: the difference between "no event" and
// "no event the instrument could see".
//
// THE PROBLEM. The classifier returned NO_EVENT_IN_HORIZON, which claims the
// horizon contained no event. The probe samples every 12 frames, so a change
// that appears and disappears entirely between two adjacent snapshots is
// invisible to it. The label was corrected to NO_CHANGE_AT_SAMPLED_POINTS - but
// a corrected label is a wording change until something proves the two cases
// are really distinct and that the instrument really confuses them.
//
// So this test uses a fixture whose transient is known to fire, and asks four
// separate questions:
//   1. did the event actually happen during the window?  (the witness field)
//   2. what did the probe see at its sampled points?     (nothing)
//   3. what does the probe therefore report?             (NO_CHANGE_AT_SAMPLED_POINTS,
//                                                         with cannotExcludeBetweenSamples)
//   4. does a DENSER grid catch it?                      (if yes, the limit is the
//                                                         sampling density, and the
//                                                         event was never absent)
//
// And the control that makes the point sharp: a byte that genuinely never
// moves. It yields the SAME label at the 12-frame grid. The label cannot tell
// the two apart, which is precisely why it must not claim the stronger thing;
// only the denser grid separates them, and that separation is measured here.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      {execFileSync}=require('node:child_process');
const Adapter=require('./agod_s11b_adapter.cjs'),
      Host=require('./agod_s11b_host.cjs');
const Provenance=require('./agod_provenance.cjs');

const HOLD=4,RELEASE=8,SHIFT=3,STARTS=3,MAX_ADDRESSES=256;
const COARSE=12,FINE=1;             /* the declared grid, and a denser one */
const HORIZON_FRAMES=144,PULSES=12;
const failures=[],fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);

/* R6. The SHA256 of every source file this run depended on, as the bytes
   were on disk when it started, and which of them differ from HEAD. A commit
   plus a dirty flag does not say either of those things. */
const provenance=Provenance.record({tool:'tools/agod_s11b_r5_transient_test.cjs',
 sources:['tools/make_agod_dual_dependence_rom.py']});

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-r5-'));
const seeds=(process.env.AGOD_R5_SEEDS||'1,2').split(',').map(Number);
const rows=[],checks=[];
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
   snapshot:host.driver.snapshot(),independent:true});
 }
 return out;
}

for(const seed of seeds){
 const {bytes,oracle}=build(seed);
 const pulseAddress=oracle.fields.transientPulse.address;
 const witnessAddress=oracle.fields.transientWitness.address;
 /* the control: a byte in the same page that no writer site touches */
 const used=new Set();
 for(const f of Object.values(oracle.fields))
  for(let i=0;i<f.width;i++)used.add(f.address+i);
 let neverMoves=null;
 for(let a=0xC0;a<0x100;a++)if(!used.has(a)){neverMoves=a;break;}

 const host=Host.createHost({bytes,
  entry:{bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0},hold:HOLD,
  onFrames(n){framesSpent+=n;}});
 const pristine=host.driver.snapshot();
 const starts=declaredStarts(host,pristine);

 /* 1. did the event actually happen? Measured on the witness, outside the probe. */
 host.driver.restore(starts[0].snapshot);
 const witnessBefore=host.driver.readRam()[witnessAddress];
 let caughtAtCoarseBoundaries=0;
 for(let p=0;p<PULSES;p++){
  host.driver.run(oracle.dualMask,HOLD);host.driver.run(0,RELEASE);
  if(host.driver.readRam()[pulseAddress]!==0)caughtAtCoarseBoundaries++;
 }
 const witnessAfter=host.driver.readRam()[witnessAddress];
 const firings=(witnessAfter-witnessBefore+256)%256;

 /* 2-3. what the probe sees and reports, at the declared grid and at a dense one */
 const probeAt=sampleEvery=>{
  const r=Adapter.probe(host.driver,{kind:'hold',starts,mask:oracle.dualMask,
   neutralMask:0,alternativeMask:oracle.soloMask,frames:HORIZON_FRAMES,
   sampleEvery,shiftTolerance:SHIFT,maxAddressesReported:MAX_ADDRESSES});
  framesSpent+=r.framesRun||0;
  return r;
 };
 const coarse=probeAt(COARSE),fine=probeAt(FINE);
 const coarseMovement=Adapter.horizonMovement(coarse,pulseAddress);
 const fineMovement=Adapter.horizonMovement(fine,pulseAddress);
 const coarseControl=Adapter.horizonMovement(coarse,neverMoves);
 const fineControl=Adapter.horizonMovement(fine,neverMoves);

 rows.push({seed,
  transientAddress:pulseAddress,witnessAddress,controlAddress:neverMoves,
  groundTruth:oracle.dependenceLabels.transientPulse,
  eventReallyHappened:{witnessFiringsOverThisWindow:firings,
   pulsesRun:PULSES,
   caughtAtTheTwelveFrameBoundaries:caughtAtCoarseBoundaries,
   note:'the witness is a separate address outside the probe, so the event is proved rather than assumed'},
  atDeclaredGrid:{sampleEveryFrames:COARSE,
   transient:{outcome:coarseMovement.outcome,
    endpointMoved:coarseMovement.endpointMoved,
    intermediateMoved:coarseMovement.intermediateMoved,
    cannotExcludeBetweenSamples:coarseMovement.cannotExcludeBetweenSamples,
    note:coarseMovement.note},
   byteThatNeverMoves:{outcome:coarseControl.outcome}},
  atDenseGrid:{sampleEveryFrames:FINE,
   transient:{outcome:fineMovement.outcome,
    endpointMoved:fineMovement.endpointMoved,
    intermediateMoved:fineMovement.intermediateMoved},
   byteThatNeverMoves:{outcome:fineControl.outcome}}});

 /* ---- the checks ---- */
 checks.push({seed,check:'the transient really fired during the window',
  firings,
  pass:expect(firings>0,
   'seed '+seed+': the witness recorded no firing, so there is no known event for the '
   +'instrument to miss and this test proves nothing')});
 checks.push({seed,check:'the declared 12-frame grid never caught the transient',
  caughtAtTheTwelveFrameBoundaries:caughtAtCoarseBoundaries,
  pass:expect(caughtAtCoarseBoundaries===0,
   'seed '+seed+': the 12-frame boundaries caught the transient '+caughtAtCoarseBoundaries
   +' times, so it is not shorter than the sampling interval and the fixture is not the case needed')});
 checks.push({seed,check:'the probe reports NO_CHANGE_AT_SAMPLED_POINTS, not an absent event',
  outcome:coarseMovement.outcome,
  pass:expect(coarseMovement.outcome==='NO_CHANGE_AT_SAMPLED_POINTS'
   &&coarseMovement.cannotExcludeBetweenSamples===true,
   'seed '+seed+': the probe reported '+coarseMovement.outcome
   +' for a change it provably could not see, with cannotExcludeBetweenSamples='
   +coarseMovement.cannotExcludeBetweenSamples)});
 checks.push({seed,check:'a byte that genuinely never moves gets the SAME label at the declared grid',
  transient:coarseMovement.outcome,control:coarseControl.outcome,
  pass:expect(coarseMovement.outcome===coarseControl.outcome,
   'seed '+seed+': the two cases already differ at the declared grid, which would make the '
   +'label stronger than it is entitled to be')});
 checks.push({seed,check:'a denser grid separates them: it catches the transient and still not the control',
  transientAtDenseGrid:fineMovement.outcome,controlAtDenseGrid:fineControl.outcome,
  pass:expect(fineMovement.intermediateMoved===true&&fineControl.intermediateMoved===false,
   'seed '+seed+': a 1-frame grid saw the transient as '+fineMovement.outcome
   +' and the never-moving byte as '+fineControl.outcome
   +'. If the dense grid cannot separate them either, the claim that the 12-frame verdict is a '
   +'sampling limit is not established by this measurement')});
 checks.push({seed,check:'the label does not change with the grid in a way that reverses the verdict',
  pass:expect(fineControl.outcome==='NO_CHANGE_AT_SAMPLED_POINTS'
   ||fineControl.outcome==='FINAL_STATE_UNCHANGED',
   'seed '+seed+': the never-moving byte changed verdict at a denser grid to '
   +fineControl.outcome+', which it cannot legitimately do')});
}

const report={type:'gu-agod-s11b-r5-transient-test',version:1,
 item:'R5 / A5 - a transient between two adjacent snapshots',
 classification:'INSTRUMENT ATTESTATION, reported apart from the pre-registered corpus. '
  +'Nothing here enters A, B or C.',
 question:'is NO_CHANGE_AT_SAMPLED_POINTS a real distinction, or only a renaming of NO_EVENT_IN_HORIZON?',
 parameters:{horizonFrames:HORIZON_FRAMES,pulses:PULSES,hold:HOLD,release:RELEASE,
  declaredSamplingInterval:COARSE,denseSamplingInterval:FINE,
  shiftTolerance:SHIFT,startsPerTrial:STARTS,
  shiftToleranceUnchanged:'the pre-registered value 3 is not altered'},
 rule:'a limit of the observing instrument is never the absence of a game event. The declared '
  +'12-frame grid gives the same verdict for a real transient and for a byte that never moves, '
  +'so that verdict may not claim the horizon was empty. The denser grid is what separates them, '
  +'and it is reported as a diagnostic rather than adopted as the default: more samples cost '
  +'frames and more observed changes is not success.',
 provenance,rows,checks,
 cost:{emulatedFrames:framesSpent},
 totals:{checks:checks.length,passing:checks.filter(c=>c.pass===true).length,failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.AGOD_R5_REPORT)
 fs.writeFileSync(process.env.AGOD_R5_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 summary:rows.map(r=>({seed:r.seed,
  witnessFirings:r.eventReallyHappened.witnessFiringsOverThisWindow,
  caughtAt12Frames:r.eventReallyHappened.caughtAtTheTwelveFrameBoundaries,
  at12Frames:{transient:r.atDeclaredGrid.transient.outcome,
   neverMoves:r.atDeclaredGrid.byteThatNeverMoves.outcome},
  at1Frame:{transient:r.atDenseGrid.transient.outcome,
   neverMoves:r.atDenseGrid.byteThatNeverMoves.outcome}})),
 cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
