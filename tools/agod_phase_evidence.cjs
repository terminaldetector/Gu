'use strict';
// ONE phase test, shared by every real-ROM tool.
//
// Why this file exists: two tools measured "is the cartridge in gameplay" with
// two different instruments. The eligibility gate had the corrected version
// (two modalities, three-valued status); agod_real_game_check.cjs still carried
// an earlier one that decided the phase from a Left-vs-Right RAM divergence and
// reported a saturated sprite-slot count. Keeping two copies meant the weaker
// one silently decided results. There is now one implementation and both tools
// require it.
//
// WHAT IS MEASURED, and what each measurement cannot do:
//
//  1. RAM bidirectionality. A byte that moves one way while Right is held and
//     the other way while Left is held, against a frame-matched neutral
//     control. These are ADDRESSES, not confirmed coordinates: three of them
//     may be three bytes of one quantity, and a menu cursor produces the same
//     signature. Alone it decides nothing.
//  2. Distinct outcomes across ALL EIGHT single-button masks (A, B, Select,
//     Start, Up, Down, Left, Right), each from the same snapshot for the same
//     number of frames. The earlier version substituted the neutral mask for
//     Select and so never pressed one of the eight buttons; neutral is now
//     measured separately, as the control it is.
//  3. A video difference BETWEEN the two arms, not against a reference frame.
//     Comparing a frame to a reference counted every scrolling background
//     pixel (22162 of 61440 on one cartridge), so an object of a few dozen
//     pixels could not move the statistic and that version of the test was
//     blind. Both arms run the SAME number of frames from the SAME snapshot,
//     so an identical background cancels and what remains is what the player
//     moved. This test does NOT establish a direction: the differing pixels of
//     the two arms occupy the same set, so their mean x is one number, not two.
//  4. Whether that difference is still there after the button is released.
//
// Idle picture motion is recorded as context and promotes NOTHING: an attract
// screen moves as much as play does.
//
// Nothing here is passed to the discovery pipeline. No address found here
// reaches AGOD, so none of it can act as a hint.
const PHASE_EVIDENCE_REVISION='agod-phase-evidence-1';
const FRAME_WIDTH=256;
const BUTTON_MASKS=[1,2,4,8,16,32,64,128];   /* A B Select Start Up Down Left Right */
const LEFT=64,RIGHT=128,NEUTRAL=0;
const SATURATION_PIXELS=20000;               /* above this the test cannot resolve an object */

function differingPixels(a,b){
 if(!a||!b)return null;
 let count=0,sumX=0,leftHalf=0,rightHalf=0;
 const n=Math.min(a.length,b.length);
 for(let i=0;i<n;i++){
  if(a[i]===b[i])continue;
  const x=i%FRAME_WIDTH;
  count++;sumX+=x;
  if(x>=FRAME_WIDTH/2)rightHalf++;else leftHalf++;
 }
 return {count,meanX:count?sumX/count:null,leftHalf,rightHalf};
}

/* probe: {restore(), pulses(mask,n), press(mask,frames), readRam(), lastFrame(),
           hash(bytes), resetMotion(), motion()} */
function measurePhase(probe,options){
 const opts=options||{};
 const idleFrames=Number.isInteger(opts.idleFrames)?opts.idleFrames:180;
 const probePulses=Number.isInteger(opts.pulses)?opts.pulses:14;
 const settleFrames=Number.isInteger(opts.settleFrames)?opts.settleFrames:60;
 const minDistinctOutcomes=Number.isInteger(opts.minDistinctOutcomes)?opts.minDistinctOutcomes:4;

 /* context only */
 probe.restore();probe.resetMotion();
 probe.press(NEUTRAL,idleFrames);
 const motion=probe.motion();
 const idleMotion=motion.frames?motion.changedFrames/motion.frames:0;

 const sampleRam=mask=>{probe.restore();probe.pulses(mask,probePulses);return probe.readRam();};
 const right=sampleRam(RIGHT),left=sampleRam(LEFT),neutral=sampleRam(NEUTRAL);

 const addresses=[];
 for(let i=0;i<neutral.length;i++){
  const dr=right[i]-neutral[i],dl=left[i]-neutral[i];
  if(dr!==0&&dl!==0&&Math.sign(dr)!==Math.sign(dl)&&Math.abs(dr)<64&&Math.abs(dl)<64)
   addresses.push({address:i,underRight:dr,underLeft:dl});
 }

 const outcomes=new Map();
 for(const mask of BUTTON_MASKS)outcomes.set(mask,probe.hash(sampleRam(mask)));
 const distinctOutcomes=new Set(outcomes.values()).size;
 const neutralHash=probe.hash(neutral);

 const frameAfter=(mask,settle)=>{
  probe.restore();probe.pulses(mask,probePulses);
  if(settle)probe.press(NEUTRAL,settle);
  const frame=probe.lastFrame();
  return frame?frame.slice():null;
 };
 const heldFrames={right:frameAfter(RIGHT,0),left:frameAfter(LEFT,0)};
 const releasedFrames={right:frameAfter(RIGHT,settleFrames),left:frameAfter(LEFT,settleFrames)};
 const held=differingPixels(heldFrames.right,heldFrames.left);
 const released=differingPixels(releasedFrames.right,releasedFrames.left);
 const localised=!!(held&&held.count>0&&held.count<SATURATION_PIXELS);
 const survives=!!(released&&released.count>0&&released.count<SATURATION_PIXELS);

 /* R2. The video channel can be ABSENT rather than negative: a host whose
    onFrame callback discards the buffer leaves lastFrame null, and then both
    differentials are null, localised and survives are false, and the verdict
    reads as an ordinary UNCONFIRMED or NOT-REACHED. That is an instrument
    failure reported as a measurement about the cartridge - the very thing this
    programme forbids - so the absence of a picture now has its own status.
    This does NOT relax the PASS criteria: VIDEO_UNAVAILABLE is never PASS, and
    with a picture present every verdict is exactly what it was before. */
 const videoFramesCaptured=[heldFrames.right,heldFrames.left,
  releasedFrames.right,releasedFrames.left].filter(f=>f&&f.length>0).length;
 const videoAvailable=videoFramesCaptured===4;

 const ramSide=addresses.length>0&&distinctOutcomes>=minDistinctOutcomes;
 const videoSide=videoAvailable&&localised&&survives;
 const phase=!videoAvailable?'VIDEO_UNAVAILABLE'
  :((ramSide&&videoSide)?'PASS':(ramSide?'UNCONFIRMED':'NOT-REACHED'));

 return {
  revision:PHASE_EVIDENCE_REVISION,
  parameters:{idleFrames,pulses:probePulses,settleFrames,minDistinctOutcomes,
   buttonMasks:BUTTON_MASKS.slice(),saturationPixels:SATURATION_PIXELS},
  idle:{framesSampled:motion.frames,
   pictureMotionWithoutInput:Number(idleMotion.toFixed(3)),
   note:'context only: an attract screen moves as much as play does, so this promotes nothing'},
  ram:{bidirectionalRamAddresses:addresses.length,
   addressSample:addresses.slice(0,4),
   distinctOutcomesAcrossEightButtons:distinctOutcomes,
   buttonsTested:BUTTON_MASKS.length,
   neutralControlDiffersFromSomeButton:[...outcomes.values()].some(h=>h!==neutralHash),
   note:'ADDRESSES responding bidirectionally, not confirmed coordinates; a menu cursor has the same signature'},
  video:{method:'differential between the Left and Right arms at equal frame counts from one snapshot, so an identical scrolling background cancels',
   differingPixelsHeld:held?held.count:null,
   meanXOfDifferingPixelsHeld:held&&held.meanX!==null?Number(held.meanX.toFixed(2)):null,
   massSplitAcrossHalvesHeld:held?{leftHalf:held.leftHalf,rightHalf:held.rightHalf,total:held.count}:null,
   differingPixelsAfterRelease:released?released.count:null,
   meanXOfDifferingPixelsAfterRelease:released&&released.meanX!==null?Number(released.meanX.toFixed(2)):null,
   localisedEnoughToBeAnObject:localised,
   differenceSurvivesRelease:survives,
   videoFramesCaptured,videoFramesExpected:4,videoAvailable,
   videoChannelNote:videoAvailable
    ?'the host delivered a picture for all four arms'
    :'the host delivered '+videoFramesCaptured+' of 4 pictures, so the video modality did not run. This is a failure of the observing instrument and is reported as VIDEO_UNAVAILABLE, never as a negative finding about the cartridge.',
   directionEstablished:false,
   directionNote:'the differing pixels of the two arms are one set, so this yields one mean x and cannot say which way an object moved',
   sensitivityNote:'a differing-pixel count near the whole screen means the test cannot resolve an object, and is reported as not localised rather than as an object'},
  criteria:'RAM bidirectionality AND >='+minDistinctOutcomes+' distinct outcomes across eight buttons AND a localised video difference AND that difference surviving release',
  modalities:{ram:ramSide,video:videoSide},
  phase,
  statusValues:['PASS','UNCONFIRMED','NOT-REACHED','VIDEO_UNAVAILABLE'],
  phaseNote:phase==='VIDEO_UNAVAILABLE'
   ?'the host did not deliver a picture, so the video modality could not run and NO phase verdict is offered. The RAM modality is reported above on its own and is not promoted: an instrument that did not observe is not a cartridge that did not respond.'
   :(phase==='PASS'
   ?'control of an object is corroborated across RAM and video; the phase remains an inference, not a certainty'
   :(phase==='UNCONFIRMED'
    ?'RAM responds bidirectionally but the video test did not corroborate it. This is UNCONFIRMED, not evidence that gameplay is absent: a menu cursor looks the same in RAM, and a scrolling background can defeat the video test.'
    :'neither modality indicates object control under this entry procedure; this is an absence of evidence under one procedure, not proof that the cartridge cannot be played'))
 };
}

module.exports={PHASE_EVIDENCE_REVISION,BUTTON_MASKS,FRAME_WIDTH,differingPixels,measurePhase};
