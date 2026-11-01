'use strict';
// S11B-R / R7: the old instrument and the repaired one, side by side.
//
// The rule this file exists to keep: the historical numbers are not replaced.
// Report 29 stays as it was published, errors included. This tool reads the old
// report and a new one produced on the SAME corpus - same horizons, same
// candidates, same ROMs, same entry procedures - and prints both columns with
// the difference named. Where the two cannot be compared, it says so instead of
// guessing.
//
// What R7 asks for, each reported separately:
//   1. trusted horizons              per candidate, before and after
//   2. false confirmations of the time-driven decoys
//   3. pulse train vs the duration-matched continuous control
//   4. the PHASE_CONTROL_INSUFFICIENT count
//   5. A, B and C
//   6. the cost of observation
//
// A changed number here is NOT a new finding about any game. It is the
// difference between two instruments, and the only claim it supports is about
// the instruments.
//
// Usage: AGOD_S11B_OLD=<old.json> AGOD_S11B_NEW=<new.json> \
//        AGOD_R7_REPORT=<out.json> node tools/agod_s11b_r7_comparison.cjs
const fs=require('node:fs');
const Provenance=require('./agod_provenance.cjs');

const oldPath=process.env.AGOD_S11B_OLD
 ||'docs/reports/gu-agod-neural-revision-2026-10-29/logs/s11b_horizon_report.json';
const newPath=process.env.AGOD_S11B_NEW;
if(!newPath){console.error('set AGOD_S11B_NEW to the repaired run\'s report');process.exit(2);}
const before=JSON.parse(fs.readFileSync(oldPath));
const after=JSON.parse(fs.readFileSync(newPath));

const provenance=Provenance.record({tool:'tools/agod_s11b_r7_comparison.cjs'});
const key=row=>row.label;
const candidates=row=>(row.perCandidate||[]);
const indexOf=report=>{
 const map=new Map();
 for(const row of report.rows||[])
  for(const c of candidates(row))map.set(key(row)+' | '+c.address+' | mask '+c.mask,{row,c});
 return map;
};
const beforeIndex=indexOf(before),afterIndex=indexOf(after);
const everyKey=[...new Set([...beforeIndex.keys(),...afterIndex.keys()])].sort();

const outcomeOf=entry=>entry&&entry.c&&entry.c.outcome?entry.c.outcome.outcome:null;
const trustedOf=entry=>{
 if(!entry||!entry.c||!entry.c.trustworthyHorizons)return null;
 const t=entry.c.trustworthyHorizons;
 return {hold:t.hold||[],train:t.train||[],
  suspectHold:t.suspectHold||[],suspectTrain:t.suspectTrain||[]};
};
const confirmedFrames=(entry,series)=>{
 if(!entry||!entry.c||!entry.c[series])return null;
 return entry.c[series].filter(t=>t.confirmed).map(t=>t.frames);
};
const sameList=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

const perCandidate=everyKey.map(k=>{
 const b=beforeIndex.get(k),a=afterIndex.get(k);
 const bo=outcomeOf(b),ao=outcomeOf(a);
 const bt=trustedOf(b),at=trustedOf(a);
 /* NO_EVENT_IN_HORIZON was renamed, not re-decided. The rename is reported as
    a rename so it is not counted as a change of result. */
 const renamed=bo==='NO_EVENT_IN_HORIZON'&&ao==='NO_CHANGE_AT_SAMPLED_POINTS';
 return {candidate:k,
  presentBefore:!!b,presentAfter:!!a,
  comparable:!!b&&!!a,
  source:(a&&a.c.source)||(b&&b.c.source)||null,
  outcomeBefore:bo,outcomeAfter:ao,
  outcomeChanged:!!b&&!!a&&bo!==ao&&!renamed,
  outcomeOnlyRenamed:renamed,
  trustedHorizonsBefore:bt,trustedHorizonsAfter:at,
  trustedHorizonsChanged:!!bt&&!!at&&!(sameList(bt.hold,at.hold)&&sameList(bt.train,at.train)),
  confirmedHoldBefore:confirmedFrames(b,'seriesA'),confirmedHoldAfter:confirmedFrames(a,'seriesA'),
  confirmedTrainBefore:confirmedFrames(b,'seriesB'),confirmedTrainAfter:confirmedFrames(a,'seriesB'),
  confirmedPairedBefore:b&&b.c.pairedControls?b.c.pairedControls.filter(t=>t.confirmed).map(t=>t.frames):null,
  confirmedPairedAfter:a&&a.c.pairedControls?a.c.pairedControls.filter(t=>t.confirmed).map(t=>t.frames):null};
});

/* 2. the time-driven decoys, named by the oracle label in `source` */
const decoys=perCandidate.filter(e=>/time-driven/.test(e.source||''));
const falseConfirmations=list=>list.reduce((total,e)=>total
 +((e.confirmedHoldAfter||[]).length+(e.confirmedTrainAfter||[]).length),0);
const falseConfirmationsBefore=decoys.reduce((total,e)=>total
 +((e.confirmedHoldBefore||[]).length+(e.confirmedTrainBefore||[]).length),0);

/* 3. train versus the duration-matched continuous control */
const cadence=perCandidate.map(e=>{
 const pick=(train,paired)=>{
  if(!train||!paired)return null;
  const trainOnly=train.filter(f=>!paired.includes(f));
  return {confirmedUnderTrain:train,confirmedUnderPairedHold:paired,
   confirmedUnderTrainOnly:trainOnly};
 };
 return {candidate:e.candidate,
  before:pick(e.confirmedTrainBefore,e.confirmedPairedBefore),
  after:pick(e.confirmedTrainAfter,e.confirmedPairedAfter)};
}).filter(e=>e.before||e.after);

const tallyOf=report=>{
 const out={};
 for(const row of report.rows||[])for(const c of candidates(row)){
  const name=c.outcome?c.outcome.outcome:'MISSING';
  out[name]=(out[name]||0)+1;
 }
 return out;
};
const beforeTally=tallyOf(before),afterTally=tallyOf(after);
const headlineOf=(report,tally)=>({
 A_missedForWantOfHorizon:tally.RECOVERED_BY_DURATION||0,
 B_missedForWrongActionStructure:tally.RECOVERED_BY_CADENCE||0,
 C_remainingUncertainty:(report.totals&&report.totals.headline
  &&report.totals.headline.C_remainingUncertainty)||null,
 instrumentArtefacts_PHASE_CONTROL_INSUFFICIENT:tally.PHASE_CONTROL_INSUFFICIENT||0,
 observableAtBaseline:tally.OBSERVABLE_AT_BASELINE||0,
 durationExplainsNotCadence:tally.DURATION_EXPLAINS_NOT_CADENCE||0});

const costOf=report=>report.totals&&report.totals.cost?report.totals.cost:null;
const changed=perCandidate.filter(e=>e.outcomeChanged);
const renamedOnly=perCandidate.filter(e=>e.outcomeOnlyRenamed);
const report={type:'gu-agod-s11b-r7-comparison',version:1,
 item:'R7 - the old instrument and the repaired one, side by side',
 rule:'the historical numbers are NOT replaced. Report 29 stands as published, errors included. '
  +'A changed number here is the difference between two instruments and supports no claim about '
  +'any game.',
 sources:{before:oldPath,after:newPath,
  beforeProvenance:before.provenance||null,afterProvenance:after.provenance||null,
  beforeStatus:before.status,afterStatus:after.status},
 corpusIdentity:{
  candidatesBefore:beforeIndex.size,candidatesAfter:afterIndex.size,
  comparable:perCandidate.filter(e=>e.comparable).length,
  onlyBefore:perCandidate.filter(e=>e.presentBefore&&!e.presentAfter).map(e=>e.candidate),
  onlyAfter:perCandidate.filter(e=>!e.presentBefore&&e.presentAfter).map(e=>e.candidate),
  note:'a candidate present on one side only is NOT compared. The corpus must be the same corpus '
   +'for the comparison to mean anything, and where it is not, that is reported rather than '
   +'papered over.'},
 one_trustedHorizons:perCandidate.map(e=>({candidate:e.candidate,
  before:e.trustedHorizonsBefore,after:e.trustedHorizonsAfter,
  changed:e.trustedHorizonsChanged})),
 two_falseConfirmationsOfTimeDecoys:{
  decoysCompared:decoys.length,
  confirmationsBefore:falseConfirmationsBefore,
  confirmationsAfter:falseConfirmations(decoys),
  perDecoy:decoys.map(e=>({candidate:e.candidate,
   confirmedHoldBefore:e.confirmedHoldBefore,confirmedHoldAfter:e.confirmedHoldAfter,
   confirmedTrainBefore:e.confirmedTrainBefore,confirmedTrainAfter:e.confirmedTrainAfter})),
  note:'a confirmation of a field the oracle labels time-driven and not action-driven is a FALSE '
   +'confirmation. The count is of confirmations, not of candidates.'},
 three_trainVersusPairedContinuous:cadence,
 four_phaseControlInsufficient:{
  before:beforeTally.PHASE_CONTROL_INSUFFICIENT||0,
  after:afterTally.PHASE_CONTROL_INSUFFICIENT||0},
 five_headline:{before:headlineOf(before,beforeTally),after:headlineOf(after,afterTally),
  outcomeTallyBefore:beforeTally,outcomeTallyAfter:afterTally,
  note:'A and B count candidates whose causal observability was recovered. Neither is a target. '
   +'A null result is published as a null result.'},
 six_cost:{before:costOf(before),after:costOf(after)},
 outcomeChanges:changed.map(e=>({candidate:e.candidate,source:e.source,
  before:e.outcomeBefore,after:e.outcomeAfter})),
 outcomesOnlyRenamed:renamedOnly.map(e=>({candidate:e.candidate,
  before:e.outcomeBefore,after:e.outcomeAfter,
  note:'NO_EVENT_IN_HORIZON became NO_CHANGE_AT_SAMPLED_POINTS. The verdict was not re-decided: '
   +'the label stopped claiming the horizon was empty. Counted as a rename, not a change.'})),
 perCandidate,
 provenance,
 status:'COMPLETE'};
if(process.env.AGOD_R7_REPORT)
 fs.writeFileSync(process.env.AGOD_R7_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,
 corpusIdentity:report.corpusIdentity,
 two_falseConfirmationsOfTimeDecoys:{
  decoysCompared:report.two_falseConfirmationsOfTimeDecoys.decoysCompared,
  confirmationsBefore:report.two_falseConfirmationsOfTimeDecoys.confirmationsBefore,
  confirmationsAfter:report.two_falseConfirmationsOfTimeDecoys.confirmationsAfter},
 four_phaseControlInsufficient:report.four_phaseControlInsufficient,
 five_headline:{before:report.five_headline.before,after:report.five_headline.after},
 six_cost:report.six_cost,
 outcomeChanges:report.outcomeChanges,
 outcomesOnlyRenamed:report.outcomesOnlyRenamed.length},null,1));
