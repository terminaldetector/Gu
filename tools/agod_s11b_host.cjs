'use strict';
// The S11B experimental host: one emulator, one driver, one phase probe.
//
// WHY THIS FILE EXISTS (R2 / A2). agod_s11b_horizon_check.cjs built its own
// host with an EMPTY onFrame callback, so lastFrame() stayed null for the whole
// run, both video differentials of the phase attestation came back null, and
// the attestation could only ever report a non-PASS. An instrument that was
// never wired was reporting a finding about the cartridge. The same wiring
// already existed, correct, in agod_real_game_check.cjs. Two copies meant the
// broken one silently decided results, which is exactly the failure the shared
// phase module was created to end - so the host is shared too, and the test
// that checks the video channel drives the same code the experiment drives.
//
// videoChannel:'off' reproduces the defect ON PURPOSE, so a test can show what
// the broken host reports and that it is now named VIDEO_UNAVAILABLE rather
// than passed off as an ordinary negative.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const crypto=require('node:crypto');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const HOST_REVISION='agod-s11b-host-1';

/* options:
     bytes          the ROM image (never written anywhere)
     entry          {bootFrames,startPulses,gapFrames,settleFrames}
     hold           frames per press of the entry procedure and of a pulse
     videoChannel   'on' (default) or 'off' to reproduce the empty-callback defect
     onFrames(n)    called with the frame count of every run, for budget metering
     onSnapshot(n)  called with the byte count of every RAM read
     ramBytes       how many bytes of CPU RAM count as the observed state
*/
function createHost(options){
 const opts=options||{};
 const ramBytes=Number.isInteger(opts.ramBytes)?opts.ramBytes:0x800;
 const hold=Number.isInteger(opts.hold)?opts.hold:4;
 const videoOn=opts.videoChannel!=='off';
 const entry=opts.entry||{bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0};
 let lastFrame=null,motionFrames=0,changedFrames=0,previous=null;
 const core=new jsnes.NES({onFrame(buffer){
   if(!videoOn)return;                     /* the defect, reproduced deliberately */
   motionFrames++;
   if(previous){let diff=0;
    for(let i=0;i<buffer.length;i+=499)if(buffer[i]!==previous[i])diff++;
    if(diff)changedFrames++;}
   previous=buffer.slice();lastFrame=buffer;
  },onAudioSample(){}});
 core.loadROM(opts.bytes);

 const press=(mask,count)=>{
  for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<count;i++)core.frame();
  if(opts.onFrames)opts.onFrames(count);
 };
 const ram=()=>{if(opts.onSnapshot)opts.onSnapshot(ramBytes);
  return core.cpu.mem.slice(0,ramBytes);};

 press(0,entry.bootFrames);
 for(let i=0;i<(entry.startPulses||0);i++){press(8,hold);press(0,entry.gapFrames||0);}
 if(entry.settleFrames)press(0,entry.settleFrames);

 const hash=bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
 const driver={
  restore(s){core.fromJSON(JSON.parse(s));},
  run:(mask,count)=>press(mask,count),
  readRam:ram,
  snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return hash(core.cpu.mem.slice(0,ramBytes));}};

 return {HOST_REVISION,core,driver,press,
  videoChannel:videoOn?'on':'off',
  lastFrame(){return lastFrame;},
  motion(){return {frames:motionFrames,changedFrames};},
  resetMotion(){motionFrames=0;changedFrames=0;previous=null;lastFrame=null;},
  /* The probe the shared phase module expects. Built here so the experiment and
     the test that attests the video channel drive the SAME wiring. */
  phaseProbe(snapshot){
   return {restore(){core.fromJSON(JSON.parse(snapshot));},
    press,
    pulses(mask,n){for(let i=0;i<n;i++){press(mask,hold);press(0,8);}},
    readRam:()=>core.cpu.mem.slice(0,ramBytes),
    hash,
    lastFrame(){return lastFrame;},
    resetMotion(){motionFrames=0;changedFrames=0;previous=null;lastFrame=null;},
    motion(){return {frames:motionFrames,changedFrames};}};}};
}

module.exports={HOST_REVISION,createHost};
