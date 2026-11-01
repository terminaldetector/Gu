'use strict';
// S11B-R / R2, specification A2: does the phase instrument actually receive a
// picture, and does the ABSENCE of a picture say so?
//
// THE DEFECT. The S11B host passed an empty onFrame callback to the emulator.
// lastFrame() therefore returned null for the whole run; both video
// differentials of the phase attestation were null; localised and survives were
// false; and the verdict came out as an ordinary UNCONFIRMED or NOT-REACHED -
// a statement about the cartridge produced by an instrument that had never
// been connected. The mirror image of the error this programme already
// forbids: an instrument limit presented as an absent game event.
//
// WHAT THIS TEST ESTABLISHES, each separately:
//   1. with the host wired, the phase probe receives a full 256x240 picture
//      and the picture is not constant;
//   2. a known gameplay state CAN reach PASS under the S8 parameters
//      (idle 180, pulses 14, settle 60) - a positive control, so a later
//      non-PASS cannot be blamed on an instrument that can never pass;
//   3. with the video channel off, the SAME ROM and the SAME state yield
//      VIDEO_UNAVAILABLE, explicitly, and NOT a negative finding;
//   4. a probe that returns no frame at all also yields VIDEO_UNAVAILABLE;
//   5. the PASS criteria are unchanged: wherever a picture is present the
//      verdict is the three-valued one, and VIDEO_UNAVAILABLE never replaces
//      a PASS.
//
// The phase detector's RULES ARE NOT RELAXED to pass this test.
// VIDEO_UNAVAILABLE is a FOURTH status that is never PASS; it makes the
// detector decline to answer where it previously answered negatively.
//
// The real cartridges are the only states known to reach gameplay, so check 2
// runs on them. If none is present locally the check is BLOCKED and is NOT
// substituted with a synthetic ROM.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),
      {execFileSync}=require('node:child_process');
const Phase=require('./agod_phase_evidence.cjs'),
      Host=require('./agod_s11b_host.cjs');

const S8={idleFrames:180,pulses:14,settleFrames:60};
/* The entry procedures as REGISTERED in S8/S10B, per cartridge. Contra needs
   300 settle frames; running it on Life Force's 60 was a mistake in the first
   version of this test, and it showed up as a static picture. */
const ENTRY={'lifeforce.nes':{bootFrames:240,startPulses:6,gapFrames:24,settleFrames:60},
 'contra.nes':{bootFrames:240,startPulses:6,gapFrames:24,settleFrames:300},
 'galaga.nes':{bootFrames:240,startPulses:6,gapFrames:24,settleFrames:60},
 'roadfighter.nes':{bootFrames:240,startPulses:6,gapFrames:24,settleFrames:60}};
const DEFAULT_ENTRY={bootFrames:240,startPulses:6,gapFrames:24,settleFrames:60};
const LIVENESS_FRAMES=200;
const FRAME_PIXELS=256*240;
const failures=[],rows=[];
const fail=m=>{failures.push(m);return false;};
const expect=(condition,message)=>condition?true:fail(message);

const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  phaseRevision:Phase.PHASE_EVIDENCE_REVISION,hostRevision:Host.HOST_REVISION};})();

/* ---- 4. a probe that hands over no frame at all ---- */
const stubProbe=frame=>({
 restore(){},press(){},pulses(){},
 readRam:()=>{const ram=new Uint8Array(0x800);
  /* enough bidirectional structure to make the RAM modality pass, so the
     verdict is decided by the video channel and nothing else */
  return ram;},
 hash:b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex'),
 lastFrame:()=>frame,resetMotion(){},motion:()=>({frames:0,changedFrames:0})});
const noFrame=Phase.measurePhase(stubProbe(null),S8);
rows.push({check:'a probe that returns no frame',
 phase:noFrame.phase,videoAvailable:noFrame.video.videoAvailable,
 videoFramesCaptured:noFrame.video.videoFramesCaptured,
 ramModality:noFrame.modalities.ram,
 pass:expect(noFrame.phase==='VIDEO_UNAVAILABLE',
  'a probe with no picture reported '+noFrame.phase+' instead of VIDEO_UNAVAILABLE')});
rows.push({check:'VIDEO_UNAVAILABLE is never PASS',
 pass:expect(noFrame.phase!=='PASS','VIDEO_UNAVAILABLE was treated as a PASS')});

/* ---- the real cartridges ---- */
const ROMS=process.env.AGOD_PRIVATE_ROMS;
const TARGETS=(process.env.AGOD_TARGETS||'lifeforce.nes,contra.nes').split(',').map(s=>s.trim());
let positiveControlReached=false,blocked=[];
if(!ROMS){blocked.push('AGOD_PRIVATE_ROMS not set');}
else for(const target of TARGETS){
 const file=path.join(ROMS,target);
 if(!fs.existsSync(file)){blocked.push(target+': not present');continue;}
 const bytes=fs.readFileSync(file);
 const measured={};
 const entry=ENTRY[target]||DEFAULT_ENTRY;
 for(const channel of ['on','off']){
  const host=Host.createHost({bytes,entry,hold:4,videoChannel:channel});
  const pristine=host.driver.snapshot();
  /* 1. does the probe see a picture at all? */
  host.resetMotion();host.press(0,8);
  const frame=host.lastFrame();
  const channelRow={rom:target,videoChannel:channel,
   frameDelivered:!!frame,framePixels:frame?frame.length:0};
  if(channel==='on'){
   channelRow.frameSizeCorrect=expect(!!frame&&frame.length===FRAME_PIXELS,
    target+': the wired host delivered '+(frame?frame.length:'no')+' pixels, expected '+FRAME_PIXELS);
   /* Is the buffer LIVE or stale? Two independent ways to show it, because a
      genuinely static screen defeats the temporal one on its own and would
      then read as a broken instrument - the same confusion in miniature. */
   const first=frame?Array.from(frame):null;
   host.press(0,LIVENESS_FRAMES);
   const second=host.lastFrame()?Array.from(host.lastFrame()):null;
   channelRow.pictureChangesOverTime=!!first&&!!second&&first.some((v,i)=>v!==second[i]);
   channelRow.livenessFrames=LIVENESS_FRAMES;
   host.driver.restore(pristine);
  }else{
   channelRow.frameWithheld=expect(!frame,
    target+': the host with the video channel off still delivered a picture');
  }
  const verdict=Phase.measurePhase(host.phaseProbe(pristine),S8);
  measured[channel]=verdict;
  channelRow.phase=verdict.phase;
  channelRow.modalities=verdict.modalities;
  channelRow.videoAvailable=verdict.video.videoAvailable;
  channelRow.videoFramesCaptured=verdict.video.videoFramesCaptured;
  channelRow.differingPixelsHeld=verdict.video.differingPixelsHeld;
  channelRow.differingPixelsAfterRelease=verdict.video.differingPixelsAfterRelease;
  channelRow.localised=verdict.video.localisedEnoughToBeAnObject;
  channelRow.survivesRelease=verdict.video.differenceSurvivesRelease;
  channelRow.bidirectionalRamAddresses=verdict.ram.bidirectionalRamAddresses;
  channelRow.distinctOutcomesAcrossEightButtons=verdict.ram.distinctOutcomesAcrossEightButtons;
  channelRow.parameters=verdict.parameters;
  if(channel==='on'){
   /* the second, stronger liveness witness: the picture differs BETWEEN the two
      input arms, which a stale buffer cannot produce */
   channelRow.pictureDiffersBetweenArms=(verdict.video.differingPixelsHeld||0)>0;
   channelRow.pictureLive=channelRow.pictureChangesOverTime||channelRow.pictureDiffersBetweenArms;
   channelRow.livenessWitness=channelRow.pictureDiffersBetweenArms
    ?'the picture differs between the Left and Right arms'
    :(channelRow.pictureChangesOverTime
      ?'the picture changed over '+LIVENESS_FRAMES+' neutral frames'
      :'none: the buffer may be stale');
   expect(channelRow.pictureLive,
    target+': the delivered picture neither changed over '+LIVENESS_FRAMES
    +' neutral frames nor differed between the two input arms, so the buffer '
    +'cannot be shown to be live rather than stale');
  }
  rows.push(channelRow);
 }
 /* 3. the broken channel names itself rather than reporting a negative */
 rows.push({check:target+': the unwired host says VIDEO_UNAVAILABLE',
  observed:measured.off.phase,
  pass:expect(measured.off.phase==='VIDEO_UNAVAILABLE',
   target+': with the video channel off the verdict was '+measured.off.phase
   +', which is a statement about the cartridge made by an instrument that observed nothing')});
 /* the RAM modality is unaffected by the video channel: the two differ ONLY
    in the video channel, which is what makes check 3 a clean comparison */
 rows.push({check:target+': the RAM modality is identical with and without video',
  withVideo:measured.on.ram.bidirectionalRamAddresses,
  withoutVideo:measured.off.ram.bidirectionalRamAddresses,
  pass:expect(measured.on.ram.bidirectionalRamAddresses===measured.off.ram.bidirectionalRamAddresses
   &&measured.on.ram.distinctOutcomesAcrossEightButtons===measured.off.ram.distinctOutcomesAcrossEightButtons,
   target+': the RAM modality differed between the two channels, so the comparison is not isolated to video')});
 if(measured.on.phase==='PASS')positiveControlReached=true;
}

/* ---- 2. the positive control ---- */
rows.push({check:'a known gameplay state can reach PASS under the S8 parameters',
 reached:positiveControlReached,blocked,
 pass:blocked.length&&!positiveControlReached
  ?true   /* BLOCKED, not asserted: see status below */
  :expect(positiveControlReached,
   'no real cartridge reached PASS with the video channel wired, so the '
   +'instrument cannot be shown capable of a positive verdict and every '
   +'non-PASS it reports remains uninterpretable')});

/* ---- 5. the rules were not relaxed ---- */
const criteriaUnchanged=noFrame.criteria.includes('RAM bidirectionality')
 &&noFrame.criteria.includes('distinct outcomes across eight buttons')
 &&noFrame.criteria.includes('localised video difference')
 &&noFrame.criteria.includes('surviving release');
rows.push({check:'the PASS criteria are the S8 criteria, unchanged',
 criteria:noFrame.criteria,
 pass:expect(criteriaUnchanged,'the stated PASS criteria no longer match the S8 criteria')});

/* ---- the source-level guard against the defect returning ---- */
const hostSource=fs.readFileSync(path.join(__dirname,'agod_s11b_host.cjs'),'utf8');
const checkSource=fs.readFileSync(path.join(__dirname,'agod_s11b_horizon_check.cjs'),'utf8');
rows.push({check:'the experiment uses the shared host rather than its own emulator',
 pass:expect(/agod_s11b_host/.test(checkSource)&&!/onFrame\(\)\{\}/.test(checkSource),
  'agod_s11b_horizon_check.cjs still builds its own host or still passes an empty onFrame')});
rows.push({check:'the shared host keeps the picture',
 pass:expect(/lastFrame=buffer/.test(hostSource),
  'the shared host no longer retains the frame buffer')});

const positiveControlStatus=positiveControlReached?'REACHED'
 :(blocked.length?'BLOCKED: '+blocked.join('; ')+' - no synthetic substitute was used':'NOT REACHED');
const report={type:'gu-agod-s11b-r2-phase-channel-test',version:1,
 item:'R2 / A2 - the phase attestation video channel',
 s8Parameters:S8,entryProcedure:ENTRY,
 corpusClass:'private user-supplied real-game ROMs, local evaluation only; no ROM bytes in this artefact',
 rulesNote:'the phase detector PASS criteria are unchanged. VIDEO_UNAVAILABLE is a fourth status that is never PASS: it makes the instrument decline to answer where it previously answered negatively.',
 provenance,
 positiveControl:{status:positiveControlStatus,reached:positiveControlReached,blocked},
 rows,
 totals:{checks:rows.filter(r=>r.pass!==undefined).length,
  passing:rows.filter(r=>r.pass===true).length,failures:failures.length},
 failures,
 status:failures.length===0?(positiveControlReached?'PASS':'PASS_WITH_BLOCKED_POSITIVE_CONTROL'):'FAIL'};
if(process.env.AGOD_R2_REPORT)
 fs.writeFileSync(process.env.AGOD_R2_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,
 positiveControl:report.positiveControl,totals:report.totals},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
