'use strict';
// Bounded AGOD on a private real-game ROM, in two declared arms.
//
// NO ROM BYTES ENTER ANY ARTEFACT. The path comes from the environment, and the
// report carries the SHA-256, the header fields, the core identity, the frame
// and control parameters and the initial state hash, as the handoff requires.
//
// Two arms, both declared:
//   pure-boot        the machine is taken to a post-boot state and nothing is
//                    pressed before discovery. This is the honest baseline: a
//                    real cartridge sits on a title or attract screen there.
//   start-preamble   a generic "press Start a few times" is applied first. This
//                    IS an intervention and is labelled as one. It is not a RAM
//                    hint and it picks no reward, but it is a human prior about
//                    how cartridges begin.
//
// A RAM delta after Start does not demonstrate gameplay, so each arm records
// phase EVIDENCE instead: how much the picture moves without input, whether two
// different input sequences from one state diverge, whether a change survives
// the button being released, and how much of the sprite page is active. The
// phase estimate is derived from those and is reported as an estimate.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS; this checker never looks inside the repository');process.exit(2);}
const TARGET=process.env.AGOD_TARGET_ROM||'galaga.nes';
const HOLD=4,RELEASE=8,BOOT_FRAMES=240,REV='profile-rev-1';
const arms=[];
const provenance=(()=>{
 let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  pipelineRevision:Pipeline.PIPELINE_REVISION,causalRevision:Causal.DETECTOR_REVISION,
  ramRevision:Ram.DETECTOR_REVISION};
})();
const result={type:'gu-agod-real-game-check',version:1,
 corpusClass:'private user-supplied real-game ROM, local evaluation only; no ROM bytes in this artefact',
 oracle:'none exists for a real cartridge: discovery here is unlabelled by construction, and no judgement is recorded as a label',
 provenance,status:'RUNNING',arms};
const save=()=>{if(process.env.AGOD_REAL_GAME_REPORT)fs.writeFileSync(process.env.AGOD_REAL_GAME_REPORT,JSON.stringify(result,null,2)+'\n');};save();

const file=path.join(ROMS,TARGET);
if(!fs.existsSync(file)){console.error('not found: '+TARGET);process.exit(2);}
const bytes=fs.readFileSync(file);
const romSha=crypto.createHash('sha256').update(bytes).digest('hex');
const nes20=(bytes[7]&0x0C)===0x08;
result.rom={name:TARGET,sha256:romSha,fileBytes:bytes.length,
 format:nes20?'NES 2.0':'iNES',
 mapper:((bytes[7]&0xF0)|(bytes[6]>>4))|(nes20?((bytes[8]&0x0F)<<8):0),
 submapper:nes20?(bytes[8]>>4):0,
 prgRomBytes:bytes[4]*16384,chrRomBytes:bytes[5]*8192,
 timingHeader:nes20?['NTSC','PAL','multi','Dendy'][bytes[12]&3]:'unspecified'};
result.coreIdentity='jsnes (bundled in assets/lab/jsnes.min.js)';
result.frameParameters={hold:HOLD,release:RELEASE,bootFrames:BOOT_FRAMES};
save();

function machine(){
 let frameCount=0,changedFrames=0,previous=null;
 const core=new jsnes.NES({onFrame(buffer){
   frameCount++;
   if(previous){let diff=0;for(let i=0;i<buffer.length;i+=499)if(buffer[i]!==previous[i])diff++;if(diff)changedFrames++;}
   previous=buffer.slice();
  },onAudioSample(){}});
 core.loadROM(bytes);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {core,driver,motion(){return {frames:frameCount,changedFrames};},
  resetMotion(){frameCount=0;changedFrames=0;previous=null;}};
}

/* Phase evidence. None of these is a label; together they are an estimate. */
function phaseEvidence(host,snapshot){
 const {driver}=host;
 const differing=(a,b)=>{let n=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])n++;return n;};
 const spritePage=()=>{const ram=driver.readRam();let active=0;
  for(let i=0x200;i<0x300;i+=4)if(ram[i]<0xEF)active++;return active;};

 driver.restore(snapshot);host.resetMotion();
 driver.run(0,120);
 const idle=host.motion();
 const afterIdle=driver.readRam(),idleSprites=spritePage();

 /* Do two DIFFERENT input sequences from one state lead to different states?
    In attract mode they do not; in play they generally do. */
 driver.restore(snapshot);
 for(let i=0;i<10;i++){driver.run(64,HOLD);driver.run(0,RELEASE);}   /* left */
 const left=driver.readRam();
 driver.restore(snapshot);
 for(let i=0;i<10;i++){driver.run(128,HOLD);driver.run(0,RELEASE);}  /* right */
 const right=driver.readRam();
 const inputDivergence=differing(left,right);

 /* Does a change survive the button being released? */
 driver.restore(snapshot);
 driver.run(8,HOLD*4);                                              /* Start held */
 const held=driver.readRam();
 driver.run(0,90);
 const settled=driver.readRam();
 driver.restore(snapshot);
 driver.run(0,HOLD*4+90);
 const neutralSame=driver.readRam();
 const persistent=differing(settled,neutralSame),transient=differing(held,neutralSame);

 const motionWithoutInput=idle.frames?idle.changedFrames/idle.frames:0;
 const estimate=inputDivergence>8
  ?'INTERACTIVE'
  :(motionWithoutInput>0.2?'ANIMATED-NON-INTERACTIVE':'STATIC-OR-UNRESPONSIVE');
 return {motionWithoutInput:Number(motionWithoutInput.toFixed(3)),
  framesSampled:idle.frames,
  inputDivergenceBytes:inputDivergence,
  persistentBytesAfterRelease:persistent,transientBytesWhileHeld:transient,
  activeSpriteSlots:idleSprites,
  phaseEstimate:estimate,
  caveat:'an estimate from four measurements, not a label: RAM divergence alone does not establish gameplay'};
}

try{
 for(const arm of [{id:'pure-boot',preamble:null},
   {id:'start-preamble',preamble:'press Start 6 times, a declared human prior about how cartridges begin, not a RAM hint and not a reward choice'}]){
  const host=machine();const {driver}=host;
  driver.run(0,BOOT_FRAMES);
  if(arm.id==='start-preamble'){for(let i=0;i<6;i++){driver.run(8,HOLD);driver.run(0,24);}driver.run(0,120);}
  const snapshot=driver.snapshot();
  const initialStateHash=driver.stateHash();
  const evidence=phaseEvidence(host,snapshot);

  driver.restore(snapshot);
  const started=Date.now();
  let piped=null,failure=null;
  try{piped=Pipeline.run(driver,{romHash:romSha,coreRevision:'jsnes-private-corpus',profileRevision:REV,
   contextKey:romSha+'/jsnes',nowMs:1761800000000});}
  catch(error){failure=error.message;}
  const elapsed=Date.now()-started;

  const row={arm:arm.id,declaredIntervention:arm.preamble,
   initialStateHash:initialStateHash.slice(0,32),
   phaseEvidence:evidence,
   pipeline:failure?{status:'ERROR',reason:failure}:{
    status:piped.status,stage:piped.stage,reason:piped.reason,
    discovered:piped.discovered?{
     resource:{address:piped.discovered.resource.address,width:piped.discovered.resource.width,
      step:piped.discovered.resource.step,mask:piped.discovered.resource.mask},
     increasingFieldCount:piped.discovered.increasingFields.length,
     neutralMovedAddressCount:piped.discovered.neutralMovedAddresses.length}:null,
    refusals:piped.refusals?piped.refusals.map(r=>({stage:r.stage,reason:r.reason})):null},
   elapsedMs:elapsed};
  arms.push(row);save();
 }

 const pure=arms.find(a=>a.arm==='pure-boot'),pre=arms.find(a=>a.arm==='start-preamble');
 result.totals={
  arms:arms.length,
  phaseEstimates:Object.fromEntries(arms.map(a=>[a.arm,a.phaseEvidence.phaseEstimate])),
  pipelineOutcomes:Object.fromEntries(arms.map(a=>[a.arm,a.pipeline.status+(a.pipeline.stage?'/'+a.pipeline.stage:'')])),
  verifiedGoalInEitherArm:arms.some(a=>a.pipeline.status==='VERIFIED'),
  preambleChangedThePhaseEstimate:pure&&pre?pure.phaseEvidence.phaseEstimate!==pre.phaseEvidence.phaseEstimate:null,
  note:'no oracle exists for this cartridge. Nothing here is scored against a label, and no judgement about game value is recorded.'};
 result.status='COMPLETE';save();
 console.log(JSON.stringify({type:result.type,status:result.status,rom:result.rom,
  provenance:result.provenance,totals:result.totals,arms},null,1));
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
