'use strict';
// Did replacing the phase detector change any answer? Measured, not asserted.
//
// This tool re-implements the DISCARDED statistic - and nothing else from the
// old detector - alongside the shared module's verdict, on the same two arms of
// the same cartridge, so the claim "the old instrument did not discriminate"
// can be checked rather than believed.
//
// The discarded statistic was:
//   inputDivergenceBytes  bytes differing between a Left-pulse run and a
//                         Right-pulse run from one snapshot, with NO neutral
//                         control and NO sign requirement. The old detector
//                         called the phase INTERACTIVE whenever this exceeded 8.
//   activeSpriteSlots     sprite slots whose Y byte is below 0xEF.
//
// Neither is reinstated as an instrument. They are computed here only to show
// what they reported where the shared module now reports something else.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js'),
      Phase=require('./agod_phase_evidence.cjs');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS; this tool never looks inside the repository');process.exit(2);}
const TARGETS=(process.env.AGOD_TARGETS||'lifeforce.nes,contra.nes,galaga.nes').split(',').map(s=>s.trim());
const HOLD=4,RELEASE=8,BOOT=240;
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  core:'jsnes (assets/lab/jsnes.min.js)',phaseEvidenceRevision:Phase.PHASE_EVIDENCE_REVISION};})();
const report={type:'gu-agod-phase-detector-regression',version:1,
 question:'on the same arms of the same cartridges, does the replaced detector give a different answer from the discarded one?',
 discardedStatistic:'inputDivergenceBytes: bytes differing between a Left-pulse run and a Right-pulse run, no neutral control, no sign requirement; the old rule was INTERACTIVE when it exceeded 8',
 corpusClass:'private user-supplied real-game ROMs, local evaluation only; no ROM bytes in this artefact',
 provenance,status:'RUNNING',rows};
const save=()=>{if(process.env.AGOD_PHASE_REGRESSION_REPORT)
 fs.writeFileSync(process.env.AGOD_PHASE_REGRESSION_REPORT,JSON.stringify(report,null,2)+'\n');};save();

for(const target of TARGETS){
 const file=path.join(ROMS,target);
 if(!fs.existsSync(file)){rows.push({rom:target,status:'BLOCKED: not present'});save();continue;}
 const bytes=fs.readFileSync(file);
 const sha=crypto.createHash('sha256').update(bytes).digest('hex');
 for(const arm of ['pure-boot','start-preamble']){
  let frames=0,changed=0,previous=null,lastFrame=null;
  const core=new jsnes.NES({onFrame(b){frames++;
    if(previous){let d=0;for(let i=0;i<b.length;i+=499)if(b[i]!==previous[i])d++;if(d)changed++;}
    previous=b.slice();lastFrame=b;},onAudioSample(){}});
  core.loadROM(bytes);
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const press=(mask,n)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
   for(let i=0;i<n;i++)core.frame();};
  const pulses=(mask,n)=>{for(let i=0;i<n;i++){press(mask,HOLD);press(0,RELEASE);}};
  press(0,BOOT);
  if(arm==='start-preamble'){for(let i=0;i<6;i++){press(8,HOLD);press(0,24);}press(0,120);}
  const snapshot=JSON.stringify(core.toJSON());

  /* the DISCARDED statistic, on exactly the arm the old detector saw */
  core.fromJSON(JSON.parse(snapshot));
  for(let i=0;i<10;i++){press(64,HOLD);press(0,RELEASE);}
  const left=ram();
  core.fromJSON(JSON.parse(snapshot));
  for(let i=0;i<10;i++){press(128,HOLD);press(0,RELEASE);}
  const right=ram();
  let divergence=0;for(let i=0;i<left.length;i++)if(left[i]!==right[i])divergence++;
  core.fromJSON(JSON.parse(snapshot));
  press(0,120);
  const page=ram();let slots=0;for(let i=0x200;i<0x300;i+=4)if(page[i]<0xEF)slots++;
  const oldVerdict=divergence>8?'INTERACTIVE':'(not INTERACTIVE by the old rule)';

  /* the replacement, same arm, same snapshot */
  const probe={
   restore(){core.fromJSON(JSON.parse(snapshot));},
   press,pulses,readRam:ram,
   hash(b){return crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');},
   lastFrame(){return lastFrame;},
   resetMotion(){frames=0;changed=0;previous=null;},
   motion(){return {frames,changedFrames:changed};}};
  const phase=Phase.measurePhase(probe,{idleFrames:180,pulses:14,settleFrames:60});

  rows.push({rom:target,sha256:sha.slice(0,16),arm,
   discarded:{inputDivergenceBytes:divergence,activeSpriteSlots:slots,
    spriteSlotsAvailable:64,spriteStatisticSaturated:slots===64,
    verdictUnderOldRule:oldVerdict},
   replacement:{phase:phase.phase,modalities:phase.modalities,
    bidirectionalRamAddresses:phase.ram.bidirectionalRamAddresses,
    distinctOutcomesAcrossEightButtons:phase.ram.distinctOutcomesAcrossEightButtons,
    differingPixelsHeld:phase.video.differingPixelsHeld,
    localisedEnoughToBeAnObject:phase.video.localisedEnoughToBeAnObject,
    differenceSurvivesRelease:phase.video.differenceSurvivesRelease},
   answersDiffer:(oldVerdict==='INTERACTIVE')!==(phase.phase==='PASS')});
  save();
 }
}

const measured=rows.filter(r=>r.discarded);
report.totals={
 armsMeasured:measured.length,
 oldRuleSaidInteractive:measured.filter(r=>r.discarded.verdictUnderOldRule==='INTERACTIVE').length,
 replacementSaysPass:measured.filter(r=>r.replacement.phase==='PASS').length,
 armsWhereTheAnswerChanged:measured.filter(r=>r.answersDiffer).length,
 spriteStatisticSaturatedOnEveryArm:measured.length>0&&measured.every(r=>r.discarded.spriteStatisticSaturated),
 note:'the old rule is reported for comparison only; it is not an instrument here and no verdict in any other artefact is taken from it'};
report.status='COMPLETE';save();
console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals,rows},null,1));
