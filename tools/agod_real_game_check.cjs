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
// phase EVIDENCE instead. That measurement is NOT made here: it comes from the
// shared module tools/agod_phase_evidence.cjs, so this checker and the
// eligibility gate cannot disagree about what "in gameplay" means.
//
// The estimator this file used to carry has been removed. It decided the phase
// from a Left-vs-Right RAM divergence alone - which a menu cursor also produces
// - and reported activeSpriteSlots, a count of sprite slots whose Y byte is
// below 0xEF, which saturates near 64 on almost any screen and so carried no
// information. Neither is reinstated in a weaker form here; the shared module
// is the only phase instrument.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js'),
      Phase=require('./agod_phase_evidence.cjs');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS; this checker never looks inside the repository');process.exit(2);}
const TARGET=process.env.AGOD_TARGET_ROM||'galaga.nes';
const HOLD=4,RELEASE=8,BOOT_FRAMES=240,REV='profile-rev-1';
/* The entry procedure is a PARAMETER, not a constant. The sweep in
   tools/agod_entry_procedure_sweep.cjs showed that a cartridge can read as
   NOT-REACHED purely because it was given too few frames to settle, so the
   procedure that is used has to be declared in the report and changeable
   without editing the tool. Defaults are the ones the published runs used. */
const num=(name,fallback)=>{const raw=process.env[name];if(raw===undefined||raw==='')return fallback;
 const value=Number(raw);if(!Number.isInteger(value)||value<0)throw new Error(name+' must be a non-negative integer, got: '+raw);return value;};
/* S9: which resource-selection strategy the pipeline uses. 'first' is FIRST-V1
   and stays the default, so every S8 result reproduces unchanged. */
const SELECTION=(()=>{const raw=process.env.AGOD_RESOURCE_SELECTION||'first';
 if(raw!=='first'&&raw!=='ranked')throw new Error("AGOD_RESOURCE_SELECTION must be 'first' or 'ranked', got: "+raw);
 return raw;})();
const PREAMBLE_PULSES=num('AGOD_PREAMBLE_PULSES',6),PREAMBLE_SETTLE=num('AGOD_PREAMBLE_SETTLE',120),
/* The gap between Start presses is the third parameter of an entry
   procedure. This checker has always used 24; it is now named so that a
   procedure reported here and one reported by another tool mean the same. */
      PREAMBLE_GAP=num('AGOD_PREAMBLE_GAP',24);
const arms=[];
const provenance=(()=>{
 let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  pipelineRevision:Pipeline.PIPELINE_REVISION,causalRevision:Causal.DETECTOR_REVISION,
  ramRevision:Ram.DETECTOR_REVISION,phaseEvidenceRevision:Phase.PHASE_EVIDENCE_REVISION};
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
result.frameParameters={hold:HOLD,release:RELEASE,bootFrames:BOOT_FRAMES,
 resourceSelection:SELECTION,
 preambleStartPulses:PREAMBLE_PULSES,preambleGapFrames:PREAMBLE_GAP,
 preambleSettleFrames:PREAMBLE_SETTLE};
save();

function machine(){
 let frameCount=0,changedFrames=0,previous=null,lastFrame=null;
 const core=new jsnes.NES({onFrame(buffer){
   frameCount++;
   if(previous){let diff=0;for(let i=0;i<buffer.length;i+=499)if(buffer[i]!==previous[i])diff++;if(diff)changedFrames++;}
   previous=buffer.slice();lastFrame=buffer;
  },onAudioSample(){}});
 core.loadROM(bytes);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  /* S9 ranking criterion 5 and the S4c counterfactual need a write. On NES this
     is a direct store into CPU RAM; on the Sega and retro cores cpu.mem is a
     read-only Proxy, which is recorded in the cross-platform plan as a blocker
     rather than worked around here. */
  poke(address,value){core.cpu.mem[address]=value&255;},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {core,driver,lastFrame(){return lastFrame;},
  motion(){return {frames:frameCount,changedFrames};},
  resetMotion(){frameCount=0;changedFrames=0;previous=null;lastFrame=null;}};
}

/* One phase instrument, shared with the eligibility gate. Nothing measured
   here is passed to the pipeline: the arms below hand Pipeline.run the raw
   driver and nothing else, so no address or pixel found here can act as a hint. */
function phaseEvidence(host,snapshot){
 const {driver}=host;
 const probe={
  restore(){driver.restore(snapshot);},
  press(mask,frames){driver.run(mask,frames);},
  pulses(mask,n){for(let i=0;i<n;i++){driver.run(mask,HOLD);driver.run(0,RELEASE);}},
  readRam:driver.readRam,
  hash(bytes){return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');},
  lastFrame(){return host.lastFrame();},
  resetMotion(){host.resetMotion();},
  motion(){return host.motion();}};
 return Phase.measurePhase(probe,{idleFrames:180,pulses:14,settleFrames:60});
}

try{
 for(const arm of [{id:'pure-boot',preamble:null},
   {id:'start-preamble',preamble:'press Start '+PREAMBLE_PULSES+' time(s) with a '+PREAMBLE_GAP+
    '-frame gap and settle '+PREAMBLE_SETTLE+
    ' frames, a declared human prior about how cartridges begin, not a RAM hint and not a reward choice'}]){
  const host=machine();const {driver}=host;
  driver.run(0,BOOT_FRAMES);
  if(arm.id==='start-preamble'){for(let i=0;i<PREAMBLE_PULSES;i++){driver.run(8,HOLD);driver.run(0,PREAMBLE_GAP);}driver.run(0,PREAMBLE_SETTLE);}
  const snapshot=driver.snapshot();
  const initialStateHash=driver.stateHash();
  const evidence=phaseEvidence(host,snapshot);

  driver.restore(snapshot);
  const started=Date.now();
  let piped=null,failure=null;
  try{piped=Pipeline.run(driver,{romHash:romSha,coreRevision:'jsnes-private-corpus',profileRevision:REV,
   contextKey:romSha+'/jsnes',nowMs:1761800000000,resourceSelection:SELECTION});}
  catch(error){failure=error.message;}
  const elapsed=Date.now()-started;

  /* Primary candidates, refusals, counterfactual checks and final verdicts are
     all recorded. A refusal is a full result here, not a missing one, so the
     evidence that led to it is kept rather than reduced to a sentence. */
  const field=f=>f?{address:f.address,width:f.width,endian:f.endian,encoding:f.encoding,
   encodingDetermined:f.encodingDetermined,step:f.step,direction:f.direction,mask:f.mask}:null;
  const traceOf=stage=>(piped&&piped.trace?piped.trace:[]).filter(t=>t.stage===stage);
  const row={arm:arm.id,declaredIntervention:arm.preamble,
   initialStateHash:initialStateHash.slice(0,32),
   phaseEvidence:evidence,
   pipeline:failure?{status:'ERROR',reason:failure}:{
    status:piped.status,stage:piped.stage,reason:piped.reason,
    pipelineRevision:piped.pipelineRevision,
    /* PRIMARY CANDIDATES, before any judgement. */
    candidates:piped.discovered?{
     resource:field(piped.discovered.resource),
     effect:field(piped.discovered.effect),
     increasingFields:piped.discovered.increasingFields.map(field),
     increasingFieldCount:piped.discovered.increasingFields.length,
     persistingAddressCountByMask:piped.discovered.persistingByMask.map(e=>({mask:e.mask,addresses:e.addresses.length})),
     neutralMovedAddressCount:piped.discovered.neutralMovedAddresses.length}:null,
    /* Which actions were shown to cause anything, and which were inconclusive. */
    attribution:traceOf('attribute').map(t=>({mask:t.mask,status:t.status})),
    /* Every span the typing stage looked at: these are the candidates it
       accepted and rejected, with the reason carried by the status. */
    typing:{spansExamined:traceOf('type').length,
     identified:traceOf('type').filter(t=>t.status==='IDENTIFIED')
      .map(t=>({mask:t.mask,span:t.span,field:field(t.field)})),
     notIdentified:(()=>{const by={};for(const t of traceOf('type'))if(t.status!=='IDENTIFIED')by[t.status]=(by[t.status]||0)+1;return by;})(),
     notIdentifiedSample:traceOf('type').filter(t=>t.status!=='IDENTIFIED').slice(0,8)
      .map(t=>({mask:t.mask,span:t.span,status:t.status}))},
    /* COUNTERFACTUAL CHECKS: the resource is driven to its floor and every
       other action is tried from there, watching whether the accumulated gains
       survive the reversal. This is what separates a cost from a sacrifice. */
    counterfactual:{reversalProbes:traceOf('reverse').map(t=>({mask:t.mask,resource:t.resource,
      floorResource:t.floorResource,gainsWatched:t.watched,gainsRetained:t.retained,
      lostGainAddresses:t.lostGainAddresses})),
     judge:traceOf('judge').map(t=>({coupledGains:t.coupledGains,playGainsWatched:t.playGainsWatched,
      floorReversible:t.floorReversible,gainRetainedAcrossReversal:t.gainRetainedAcrossReversal,
      reversalMask:t.reversalMask}))},
    induction:traceOf('induce').map(t=>({partition:t.partition,polarity:t.polarity,
     lifecycle:t.lifecycle,verifiable:t.verifiable,resourceTrack:t.resourceTrack})),
    promotion:traceOf('promote').map(t=>({verified:t.verified,lifecycle:t.lifecycle,blockers:t.blockers})),
    /* S9: the inventory, the grouping and the per-candidate attempts, present
       only in ranked mode. */
    rankedSelection:(piped.discovered&&piped.discovered.rankedSelection)?{
     specRevision:piped.discovered.rankedSelection.specRevision,
     candidatesTyped:piped.discovered.rankedSelection.candidatesTyped,
     candidatesFound:piped.discovered.rankedSelection.candidatesFound,
     maxCandidates:piped.discovered.rankedSelection.maxCandidates,
     budgetNote:piped.discovered.rankedSelection.budgetNote,
     grouping:piped.discovered.rankedSelection.grouping,
     ranked:piped.discovered.rankedSelection.ranked.map(entry=>({rank:entry.rank,
      address:entry.address,mask:entry.mask,groupAddresses:entry.groupAddresses,
      score:entry.score,
      evidence:entry.record?{causality:entry.record.causality,
       dynamics:{startsObserved:entry.record.dynamics.startsObserved,
        startsWhereItMoved:entry.record.dynamics.startsWhereItMoved,
        stepAgreesAcrossStarts:entry.record.dynamics.stepAgreesAcrossStarts,
        stepsSeen:entry.record.dynamics.stepsSeen},
       reachability:entry.record.reachability,restore:entry.record.restore,
       phase:entry.record.phase,separability:entry.record.separability,
       downstream:entry.record.downstream}:null}))}:null,
    rankedAttempts:(piped.discovered&&piped.discovered.rankedAttempts)
     ?piped.discovered.rankedAttempts:null,
    /* FINAL VERDICT, and the full detail of every refusal that produced it. */
    goal:piped.goal?{id:piped.goal.id,lifecycle:piped.goal.lifecycle,polarity:piped.goal.polarity,
     evidenceCount:piped.goal.evidenceRefs?piped.goal.evidenceRefs.length:null}:null,
    refusals:piped.refusals?piped.refusals.map(r=>({...r})):null},
   elapsedMs:elapsed};
  arms.push(row);save();
 }

 const pure=arms.find(a=>a.arm==='pure-boot'),pre=arms.find(a=>a.arm==='start-preamble');
 result.totals={
  arms:arms.length,
  phaseEvidenceRevision:Phase.PHASE_EVIDENCE_REVISION,
  resourceSelection:SELECTION,
  phaseStatuses:Object.fromEntries(arms.map(a=>[a.arm,a.phaseEvidence.phase])),
  phaseModalities:Object.fromEntries(arms.map(a=>[a.arm,a.phaseEvidence.modalities])),
  pipelineOutcomes:Object.fromEntries(arms.map(a=>[a.arm,a.pipeline.status+(a.pipeline.stage?'/'+a.pipeline.stage:'')])),
  verifiedGoalInEitherArm:arms.some(a=>a.pipeline.status==='VERIFIED'),
  preambleChangedThePhaseStatus:pure&&pre?pure.phaseEvidence.phase!==pre.phaseEvidence.phase:null,
  note:'no oracle exists for this cartridge. Nothing here is scored against a label, and no judgement about game value is recorded.'};
 result.status='COMPLETE';save();
 console.log(JSON.stringify({type:result.type,status:result.status,rom:result.rom,
  provenance:result.provenance,totals:result.totals,arms},null,1));
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
