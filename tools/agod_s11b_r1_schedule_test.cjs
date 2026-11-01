'use strict';
// S11B-R / R1: is the pulse-train window actually the window we declare?
//
// WHY. The first S11B adapter applied a negative phase shift to the release of
// EVERY pulse. A 60-pulse train at delta=-3 therefore ran 60*(4+5)=540 frames
// where the declared window is H+delta=717 - short by 177 frames, and with a
// different train structure besides. Arithmetic alone caught it afterwards;
// nothing in the experiment would have. This test is the missing instrument.
//
// WHAT IS CHECKED, for pulses in {1,4,12,30,60} x delta in {-3..3} (35 windows):
//   1. the ACTUAL number of emulated frames, counted at the emulator, equals
//      the declared window H+delta;
//   2. the number of press edges equals the number of pulses - a shift must
//      never add, remove or merge a press;
//   3. the full button-state sequence, frame by frame, equals the declared
//      schedule: (hold, release) x (P-1), then (hold, release+delta) for a
//      negative shift, or (hold, release) x P then a neutral tail for a
//      positive one.
// The window geometry lives in neutralWindows, so neutralWindows is what the
// test drives; a test that only called trainArm would not exercise the shift.
//
// Frames are counted by a recorder wrapped around a REAL jsnes driver running a
// synthetic ROM, not by re-deriving the adapter's own arithmetic.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      {execFileSync}=require('node:child_process');
const Adapter=require('./agod_s11b_adapter.cjs'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const PULSES=[1,4,12,30,60],DELTAS=[-3,-2,-1,0,1,2,3];
const HOLD=4,RELEASE=8,SHIFT=3,ACTION_MASK=8;
const failures=[],windows=[];

/* ---- a real emulator, with every frame's button state recorded ---- */
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-r1-'));
const romFile=path.join(directory,'rom.json');
execFileSync(process.env.PYTHON||'python3',
 ['tools/make_agod_test_rom.py','--seed','0','--out',romFile,
  '--oracle-out',path.join(directory,'oracle.json')]);
const bytes=Buffer.from(JSON.parse(fs.readFileSync(romFile)).base64,'base64');

const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
core.loadROM(bytes);
let frameLog=[];                 /* one entry per EMULATED frame: the mask held */
let segments=[];                 /* frameLog split at each restore() */
const press=(mask,count)=>{
 for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
 for(let i=0;i<count;i++){core.frame();frameLog.push(mask);}
};
press(0,60);
const driver={
 restore(s){segments.push(frameLog);frameLog=[];core.fromJSON(JSON.parse(s));},
 run:(mask,count)=>press(mask,count),
 readRam:()=>core.cpu.mem.slice(0,0x800),
 snapshot(){return JSON.stringify(core.toJSON());}};
const pristine=driver.snapshot();

/* ---- the declared schedule, written out independently of the adapter ---- */
function declaredSchedule(pulses,delta){
 const out=[];
 for(let p=0;p<pulses;p++){
  const last=p===pulses-1;
  out.push({mask:ACTION_MASK,frames:HOLD});
  out.push({mask:0,frames:(last&&delta<0)?RELEASE+delta:RELEASE});
 }
 if(delta>0)out.push({mask:0,frames:delta});
 return out.filter(run=>run.frames>0);
}
const expand=runs=>runs.flatMap(r=>new Array(r.frames).fill(r.mask));
const compress=flat=>{
 const out=[];
 for(const mask of flat){
  const tail=out[out.length-1];
  if(tail&&tail.mask===mask)tail.frames++;else out.push({mask,frames:1});
 }
 return out;
};
const pressEdges=flat=>{
 let edges=0,previous=0;
 for(const mask of flat){if(mask!==0&&previous===0)edges++;previous=mask;}
 return edges;
};
const check=(label,actual,expected)=>{
 const ok=JSON.stringify(actual)===JSON.stringify(expected);
 if(!ok)failures.push(label+': expected '+JSON.stringify(expected)
  +' but observed '+JSON.stringify(actual));
 return ok;
};

/* ---- the 35 windows ---- */
for(const pulses of PULSES){
 const horizon=pulses*(HOLD+RELEASE);
 /* neutralMask is ACTION_MASK here ON PURPOSE: in production the neutral arm
    holds mask 0, where a press edge is unobservable. The mask does not affect
    the geometry, so driving the same code path with a visible mask is what
    makes requirement 2 testable at all. Requirement 1 is additionally
    re-checked below with the production mask of 0. */
 const plan={kind:'train',neutralMask:ACTION_MASK,pulses,hold:HOLD,release:RELEASE,
  shiftTolerance:SHIFT,frames:horizon,maxRamBytes:2048,maxAddressesReported:256};
 segments=[];frameLog=[];
 const produced=Adapter.neutralWindows(driver,{id:'r1',snapshot:pristine},plan);
 segments.push(frameLog);                       /* the final window's frames */
 const observed=segments.slice(1);              /* segment 0 is pre-restore */
 check('pulses='+pulses+' window count',observed.length,DELTAS.length);
 check('pulses='+pulses+' adapter window count',produced.length,DELTAS.length);
 DELTAS.forEach((delta,i)=>{
  const flat=observed[i]||[],expected=expand(declaredSchedule(pulses,delta));
  const row={pulses,delta,declaredWindowFrames:horizon+delta,
   observedFrames:flat.length,
   observedPressEdges:pressEdges(flat),declaredPressEdges:pulses,
   observedSequence:compress(flat),declaredSequence:compress(expected),
   sequenceComparedFrameByFrame:true,
   adapterReportedFrames:produced[i]?produced[i].frames:null,
   adapterReportedPressEdges:produced[i]?produced[i].pressEdges:null};
  const label='pulses='+pulses+' delta='+delta;
  row.frameCountExact=check(label+' emulated frame count',flat.length,horizon+delta);
  row.pressEdgesExact=check(label+' press edges',pressEdges(flat),pulses);
  /* Compared FRAME BY FRAME, not as run-lengths. A positive shift is issued as
     a separate run() call of mask 0 after the last release, so a run-length
     comparison would report a difference where the button state is identical
     on every frame. The per-frame sequence is the strict form of the check and
     has no such ambiguity. */
  row.sequenceExact=check(label+' button-state sequence, frame by frame',
   flat,expected);
  row.adapterAgreesWithEmulator=check(label+' adapter frames vs emulator',
   produced[i]?produced[i].frames:null,flat.length);
  row.pass=row.frameCountExact&&row.pressEdgesExact&&row.sequenceExact
   &&row.adapterAgreesWithEmulator;
  windows.push(row);
 });
 /* requirement 1 again, with the mask production actually uses */
 segments=[];frameLog=[];
 const neutral=Adapter.neutralWindows(driver,{id:'r1n',snapshot:pristine},
  {...plan,neutralMask:0});
 segments.push(frameLog);
 const neutralObserved=segments.slice(1);
 DELTAS.forEach((delta,i)=>{
  check('pulses='+pulses+' delta='+delta+' frame count with the production neutral mask 0',
   (neutralObserved[i]||[]).length,horizon+delta);
  check('pulses='+pulses+' delta='+delta+' adapter frames with the production neutral mask 0',
   neutral[i]?neutral[i].frames:null,horizon+delta);
 });
}

/* ---- the action arm itself: no shift, no tail ---- */
for(const pulses of PULSES){
 segments=[];frameLog=[];
 const arm=Adapter.trainArm(driver,{id:'r1a',snapshot:pristine},ACTION_MASK,
  pulses,HOLD,RELEASE);
 segments.push(frameLog);
 const flat=segments[1]||[];
 check('action arm pulses='+pulses+' frames',flat.length,pulses*(HOLD+RELEASE));
 check('action arm pulses='+pulses+' press edges',pressEdges(flat),pulses);
 check('action arm pulses='+pulses+' adapter frames',arm.frames,flat.length);
}

/* ---- a shift the release cannot absorb must FAIL, not be rounded ---- */
let clampRejected=false,clampDetail=null;
try{
 Adapter.trainArm(driver,{id:'r1c',snapshot:pristine},ACTION_MASK,3,HOLD,2,0,-3);
 failures.push('a shift of -3 against a release of 2 was accepted: the window '
  +'would have been silently shortened and a press merged into the tail');
}catch(problem){clampRejected=/SHIFT_EXCEEDS_RELEASE/.test(problem.message);
 clampDetail=problem.message;
 if(!clampRejected)failures.push('an impossible shift failed for the wrong reason: '+problem.message);}

/* ---- the regression this test exists for ---- */
const sixtyMinusThree=windows.find(w=>w.pulses===60&&w.delta===-3);
const oldDefectWouldGive=60*(HOLD+RELEASE-3);          /* 540 */
const report={type:'gu-agod-s11b-r1-schedule-test',version:1,
 item:'R1 - temporal geometry of the pulse train',
 adapterRevision:Adapter.ADAPTER_REVISION,
 parameters:{pulses:PULSES,deltas:DELTAS,hold:HOLD,release:RELEASE,
  shiftTolerance:SHIFT,actionMask:ACTION_MASK,
  shiftToleranceUnchanged:'the pre-registered value 3 is not altered by this test'},
 instrument:'frames counted at a real jsnes emulator running a synthetic ROM, '
  +'not re-derived from the adapter arithmetic',
 checks:['actual emulated frame count per window',
  'press-edge count per window',
  'frame-by-frame button-state sequence per window, compared frame by frame '
  +'rather than as run-lengths, because a positive shift is issued as a '
  +'separate call of the same button state',
  'the adapter report agrees with the emulator',
  'the same frame count with the production neutral mask of 0',
  'an unshifted action arm',
  'a shift larger than the release is refused rather than clamped'],
 regression:{defect:'a negative shift was applied to the release of every pulse',
  worstCase:'pulses=60 delta=-3',
  defectWouldRun:oldDefectWouldGive,declaredWindow:60*(HOLD+RELEASE)-3,
  observedNow:sixtyMinusThree?sixtyMinusThree.observedFrames:null,
  closed:!!(sixtyMinusThree&&sixtyMinusThree.observedFrames===60*(HOLD+RELEASE)-3)},
 impossibleShiftRefused:clampRejected,impossibleShiftError:clampDetail,
 windows,
 totals:{windowsChecked:windows.length,
  windowsPassing:windows.filter(w=>w.pass).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.AGOD_R1_REPORT)
 fs.writeFileSync(process.env.AGOD_R1_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,
 totals:report.totals,regression:report.regression,
 impossibleShiftRefused:report.impossibleShiftRefused},null,1));
if(failures.length){for(const f of failures.slice(0,20))console.error(' FAIL '+f);
 process.exitCode=1;}
