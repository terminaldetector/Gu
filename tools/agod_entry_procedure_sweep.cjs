'use strict';
// Does ANY simple entry procedure reach gameplay on this cartridge?
//
// Two procedures failing is not an answer; it is two attempts. This sweeps a
// declared grid of generic procedures - how many times Start is pulsed, and how
// long the machine is left to settle afterwards - and measures the phase after
// each one with the SAME shared instrument the other tools use.
//
// Nothing in the grid encodes knowledge of any particular game: no RAM address,
// no menu layout, no sequence taken from a manual. Life Force is included as a
// POSITIVE CONTROL, because a sweep that finds gameplay nowhere is
// indistinguishable from a broken sweep.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js'),
      Phase=require('./agod_phase_evidence.cjs');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS; this tool never looks inside the repository');process.exit(2);}
const TARGETS=(process.env.AGOD_TARGETS||'lifeforce.nes,contra.nes,galaga.nes').split(',').map(s=>s.trim());
const HOLD=4,BOOT=240,GAP=24;   /* GAP: frames between Start presses, a third parameter of the procedure */
const START_PULSES=[0,1,2,3,6,12];
const SETTLE=[60,300];
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  core:'jsnes (assets/lab/jsnes.min.js)',phaseEvidenceRevision:Phase.PHASE_EVIDENCE_REVISION};})();
const report={type:'gu-agod-entry-procedure-sweep',version:1,
 question:'does any of a declared grid of generic entry procedures reach a gameplay phase on this cartridge?',
 grid:{bootFrames:BOOT,startPulses:START_PULSES,holdFrames:HOLD,gapFramesBetweenPresses:GAP,settleFrames:SETTLE,
  note:'generic only: Start pulses and settling time. No address, menu layout or game-specific sequence is used.'},
 positiveControl:'lifeforce.nes, where one procedure is already known to reach gameplay; a sweep finding nothing anywhere would be indistinguishable from a broken sweep',
 corpusClass:'private user-supplied real-game ROMs, local evaluation only; no ROM bytes in this artefact',
 provenance,status:'RUNNING',rows};
const save=()=>{if(process.env.AGOD_ENTRY_SWEEP_REPORT)
 fs.writeFileSync(process.env.AGOD_ENTRY_SWEEP_REPORT,JSON.stringify(report,null,2)+'\n');};save();

for(const target of TARGETS){
 const file=path.join(ROMS,target);
 if(!fs.existsSync(file)){rows.push({rom:target,status:'BLOCKED: not present'});save();continue;}
 const bytes=fs.readFileSync(file);
 const sha=crypto.createHash('sha256').update(bytes).digest('hex');
 for(const startPulses of START_PULSES)for(const settle of SETTLE){
  let frames=0,changed=0,previous=null,lastFrame=null;
  const core=new jsnes.NES({onFrame(b){frames++;
    if(previous){let d=0;for(let i=0;i<b.length;i+=499)if(b[i]!==previous[i])d++;if(d)changed++;}
    previous=b.slice();lastFrame=b;},onAudioSample(){}});
  core.loadROM(bytes);
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const press=(mask,n)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
   for(let i=0;i<n;i++)core.frame();};
  const pulses=(mask,n)=>{for(let i=0;i<n;i++){press(mask,HOLD);press(0,8);}};
  press(0,BOOT);
  for(let i=0;i<startPulses;i++){press(8,HOLD);press(0,GAP);}
  press(0,settle);
  const snapshot=JSON.stringify(core.toJSON());
  const probe={
   restore(){core.fromJSON(JSON.parse(snapshot));},
   press,pulses,readRam:ram,
   hash(b){return crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');},
   lastFrame(){return lastFrame;},
   resetMotion(){frames=0;changed=0;previous=null;},
   motion(){return {frames,changedFrames:changed};}};
  const started=Date.now();
  const phase=Phase.measurePhase(probe,{idleFrames:180,pulses:14,settleFrames:60});
  rows.push({rom:target,sha256:sha.slice(0,16),
   procedure:{bootFrames:BOOT,startPulses,holdFrames:HOLD,gapFramesBetweenPresses:GAP,settleFrames:settle},
   phase:phase.phase,modalities:phase.modalities,
   idleMotion:phase.idle.pictureMotionWithoutInput,
   bidirectionalRamAddresses:phase.ram.bidirectionalRamAddresses,
   distinctOutcomesAcrossEightButtons:phase.ram.distinctOutcomesAcrossEightButtons,
   differingPixelsHeld:phase.video.differingPixelsHeld,
   localisedEnoughToBeAnObject:phase.video.localisedEnoughToBeAnObject,
   differenceSurvivesRelease:phase.video.differenceSurvivesRelease,
   elapsedMs:Date.now()-started});
  save();
 }
}

const measured=rows.filter(r=>r.phase);
const perRom={};
for(const r of measured){
 const e=perRom[r.rom]||(perRom[r.rom]={procedures:0,pass:0,unconfirmed:0,notReached:0,
  videoUnavailable:0,bestDistinctOutcomes:0,passingProcedures:[]});
 e.procedures++;
 if(r.phase==='PASS'){e.pass++;e.passingProcedures.push(r.procedure);}
 else if(r.phase==='UNCONFIRMED')e.unconfirmed++;
 /* R2. VIDEO_UNAVAILABLE is a failure of the observing instrument. Counting it
    under notReached would read as "this procedure did not reach gameplay",
    which is a claim about the cartridge that the measurement does not support. */
 else if(r.phase==='VIDEO_UNAVAILABLE')e.videoUnavailable++;
 else e.notReached++;
 if(r.distinctOutcomesAcrossEightButtons>e.bestDistinctOutcomes)
  e.bestDistinctOutcomes=r.distinctOutcomesAcrossEightButtons;
}
report.totals={proceduresPerRom:START_PULSES.length*SETTLE.length,perRom,
 positiveControlReachedGameplay:!!(perRom['lifeforce.nes']&&perRom['lifeforce.nes'].pass>0),
 note:'a cartridge where no procedure reaches gameplay is recorded as GAMEPLAY_NOT_REACHED under this grid. That is an absence of evidence across a bounded set of generic procedures, not proof that the cartridge cannot be played, and the cause remains unknown without an independent emulator reference.'};
report.status='COMPLETE';save();
console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals},null,1));
