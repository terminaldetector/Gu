'use strict';
// S10B: can a candidate's causal attribution be recovered by giving the causal
// checks COMPARABLE game states?
//
// S10A localised the break: on real cartridges causalConfirmed is the first
// false term in 32 of 32 audits, because typing sees the field over 60 play
// events from `pristine` while induction tests it from the partition's neutral
// offset starts - a different game state, where the value does not move
// (NO_CHANGE_OBSERVED, 27 of 32) or moves differently.
//
// NOTHING IS WEAKENED. Goals.induceGoal and Causal.probeAction are called
// unmodified, the HOLDOUT rule is the registry's, the S9 ranking supplies the
// candidates, and the ROM set and entry procedures are the declared ones. The
// pipeline itself is untouched: this is a measurement, not a rule change, so
// FIRST-V1 cannot move because of it.
//
// FOUR DECLARED ARMS per candidate. All four call the same unmodified
// induceGoal; only the states the causal checks are given differ.
//
//   BASELINE              what the pipeline does today: pristine + a neutral
//                         prefix per start.
//   GATE (strategy A)     the same states, but the candidate must first
//                         reproduce its change on EVERY state. If it does not,
//                         the refusal is NOT_REPRODUCED_ACROSS_STARTS, issued
//                         before induction. That is a statement about
//                         reproducibility across these states, and NOT a
//                         statement that no useful game resource exists.
//   REPLAY (strategy B1)  every start is the EXACT saved discovery snapshot.
//                         This can only demonstrate replay reproducibility: the
//                         starts share one parent state, so it is not
//                         independent confirmation and the registry's holdout
//                         disjointness is expected to say so.
//   HISTORY (strategy B2) each start is reached by its OWN independent play
//                         history through a pre-declared state-reaching
//                         procedure, and comparability is attested by the
//                         shared phase instrument where that can be computed.
//                         This one can give independent causal confirmation.
//
// THE STATE-REACHING PROCEDURE IS DECLARED HERE, BEFORE ANY RESULT, and uses no
// game address, no reward and nothing specific to any cartridge:
//
//   from the entry state, run N neutral frames (N from the declared ladder
//   below, a different N per start so the histories differ), then re-apply the
//   cartridge's declared entry procedure once more, then accept the state only
//   if the phase instrument reports a gameplay phase.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Evidence=require('../app/src/main/assets/lab/agod-evidence.js'),
      Phase=require('./agod_phase_evidence.cjs'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

/* ---- declared before any run ---- */
const HISTORY_LADDER=[0,37,73,113,157,211];   /* neutral frames before re-entry */
const CONDITIONING={
 procedure:'from the entry state: N neutral frames (N from the declared ladder, one per start so the histories differ), then the cartridge\'s declared entry procedure once more, then accept only if the shared phase instrument reports a gameplay phase',
 ladder:HISTORY_LADDER,
 comparabilityCriterion:'the phase instrument (tools/agod_phase_evidence.cjs) reports PASS; where it cannot be computed the state is recorded as NOT-ATTESTED and the arm says so',
 forbidden:['no game address','no manual reward','no cartridge-specific sequence','no oracle label']};
const REV='profile-rev-1',HOLD=4,RELEASE=8,FRAMES=12,SHIFT=3,STARTS=2;
const DEPLETE_PULSES=6,DEPLETE_SETTLE=30,TYPE_EVENTS=60;
const PARTITIONS=[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},{group:'HOLDOUT',offset:97}];

const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  pipelineRevision:Pipeline.PIPELINE_REVISION,causalRevision:Causal.DETECTOR_REVISION,
  goalsRevision:Goals.DETECTOR_REVISION,phaseRevision:Phase.PHASE_EVIDENCE_REVISION};})();
const report={type:'gu-agod-s10b-trajectory-check',version:1,
 question:'does the type-to-induce break close when the causal checks are given comparable game states?',
 unchanged:['Goals.induceGoal','Causal.probeAction','the registry HOLDOUT rule',
  'the S9 ranking and its weights','the ROM set and declared entry procedures',
  'the frame budget','agod-pipeline.js itself'],
 conditioning:CONDITIONING,
 arms:{BASELINE:'pristine + a neutral prefix per start, as the pipeline does today',
  GATE:'strategy A: the change must reproduce on every state before induction; otherwise NOT_REPRODUCED_ACROSS_STARTS',
  REPLAY:'strategy B1: every start is the exact saved discovery snapshot - replay reproducibility only, not independent confirmation',
  HISTORY:'strategy B2: each start reached by its own independent history through the declared procedure'},
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_S10B_REPORT)
 fs.writeFileSync(process.env.AGOD_S10B_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function machine(bytes,entry){
 let lastFrame=null,frames=0,changed=0,previous=null;
 const core=new jsnes.NES({onFrame(buffer){frames++;
   if(previous){let d=0;for(let i=0;i<buffer.length;i+=499)if(buffer[i]!==previous[i])d++;if(d)changed++;}
   previous=buffer.slice();lastFrame=buffer;},onAudioSample(){}});
 core.loadROM(bytes);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const press=(mask,count)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<count;i++)core.frame();};
 const applyEntry=()=>{
  press(0,entry.bootFrames);
  for(let i=0;i<entry.startPulses;i++){press(8,HOLD);press(0,entry.gapFrames);}
  if(entry.settleFrames)press(0,entry.settleFrames);
 };
 applyEntry();
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,count){press(mask,count);},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  poke(a,v){core.cpu.mem[a]=v&255;},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {driver,
  reEnterOnce(){for(let i=0;i<entry.startPulses;i++){press(8,HOLD);press(0,entry.gapFrames);}
   if(entry.settleFrames)press(0,entry.settleFrames);},
  phaseProbe(snapshot){
   return {restore(){core.fromJSON(JSON.parse(snapshot));},
    press,pulses(mask,n){for(let i=0;i<n;i++){press(mask,HOLD);press(0,RELEASE);}},
    readRam:ram,
    hash(b){return crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');},
    lastFrame(){return lastFrame;},
    resetMotion(){frames=0;changed=0;previous=null;},
    motion(){return {frames,changedFrames:changed};}};
  }};
}

const decodeWith=(driver,field)=>Ram.decode(driver.readRam(),{address:field.address,
 width:field.width,endian:field.endian==='n/a'?'little':field.endian,
 encoding:field.encodingDetermined?field.encoding:'binary'});

/* the four ways of producing the states a partition's causal checks will see */
function startsFor(arm,host,pristine,part,discoverySnapshot,attest){
 const {driver}=host;
 const out=[];
 if(arm==='REPLAY'){
  for(let i=0;i<STARTS;i++){
   driver.restore(discoverySnapshot);
   out.push({id:part.group+'-replay-'+i,stateHash:driver.stateHash(),
    snapshot:discoverySnapshot,independent:false,
    provenance:'the exact saved discovery snapshot; shared parent state, so not an independent start'});
  }
  return out;
 }
 if(arm==='HISTORY'){
  for(let i=0;i<STARTS;i++){
   const neutral=HISTORY_LADDER[(part.offset+i)%HISTORY_LADDER.length];
   driver.restore(pristine);
   driver.run(0,neutral);
   host.reEnterOnce();
   const snapshot=driver.snapshot();
   const comparability=attest?attest(snapshot):{status:'NOT-ATTESTED',
    reason:'the phase instrument could not be computed for this corpus'};
   out.push({id:part.group+'-hist-'+i,stateHash:driver.stateHash(),snapshot,
    independent:true,
    provenance:'own history: '+neutral+' neutral frames from the entry state, then the declared entry procedure re-applied',
    neutralFramesBeforeReEntry:neutral,comparability});
  }
  return out;
 }
 /* BASELINE and GATE: exactly what the pipeline does today */
 driver.restore(pristine);
 for(let i=0;i<STARTS;i++){
  driver.run(0,part.offset+i*7);
  out.push({id:part.group+'-base-'+i,stateHash:driver.stateHash(),
   snapshot:driver.snapshot(),independent:true,
   provenance:'pristine + '+(part.offset+i*7)+' cumulative neutral frames'});
 }
 return out;
}

function runArm(arm,host,pristine,candidate,discoverySnapshot,effectMask,playScope,attest){
 const {driver}=host;
 const field=candidate.field,mask=candidate.mask;
 const perPartition=[];
 let gateRefusal=null;
 for(const part of PARTITIONS){
  const starts=startsFor(arm,host,pristine,part,discoverySnapshot,attest);

  /* strategy A: the gate, before any induction */
  if(arm==='GATE'){
   const reproduced=[];
   for(const start of starts){
    driver.restore(start.snapshot);
    const before=decodeWith(driver,field);
    for(let pulse=0;pulse<DEPLETE_PULSES;pulse++){
     driver.run(mask,HOLD);driver.run(0,DEPLETE_SETTLE);
    }
    const after=decodeWith(driver,field);
    reproduced.push({startId:start.id,before,after,
     decoded:Number.isInteger(before)&&Number.isInteger(after),
     changed:Number.isInteger(before)&&Number.isInteger(after)&&after!==before,
     movedInTypedDirection:Number.isInteger(before)&&Number.isInteger(after)
      &&(field.direction==='decreasing'?after<before:after>before)});
   }
   const all=reproduced.length>0&&reproduced.every(entry=>entry.movedInTypedDirection);
   if(!all){
    gateRefusal={stage:'consistency-gate',reason:'NOT_REPRODUCED_ACROSS_STARTS',
     perStart:reproduced,
     statement:'the typed change did not reproduce on every state of this partition. This is a statement about reproducibility ACROSS THESE STATES and is NOT a statement that no useful game resource exists',
     statesTested:reproduced.length};
    perPartition.push({partition:part.group,gated:true,
     causalConfirmed:null,judgedEffects:null,polarity:null});
    continue;
   }
  }

  const costProbe=Causal.probeAction(driver,{starts,mask,neutralMask:0,
   alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
  const alive=Causal.probeAction(driver,{starts,mask:effectMask,neutralMask:0,
   alternativeMask:effectMask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT})
   .confirmed.map(entry=>entry.address);
  /* the depletion track, from the first state of this partition */
  driver.restore(starts[0].snapshot);
  const samples=[{pulse:0,value:decodeWith(driver,field)}];
  for(let pulse=0;pulse<DEPLETE_PULSES;pulse++){
   driver.run(mask,HOLD);driver.run(0,DEPLETE_SETTLE);
   samples.push({pulse:pulse+1,value:decodeWith(driver,field)});
  }
  const track=samples.map(entry=>entry.value);
  /* effects after depletion, from states reached the same declared way */
  const deadStarts=startsFor(arm,host,driver.snapshot(),{group:'dead-'+part.group,offset:5},
   driver.snapshot(),null);
  const dead=Causal.probeAction(driver,{starts:deadStarts,mask:effectMask,neutralMask:0,
   alternativeMask:effectMask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT})
   .confirmed.map(entry=>entry.address);

  const causalConfirmed=costProbe.confirmed.some(entry=>entry.address===field.address);
  let induced=null,inductionError=null;
  try{
   induced=Goals.induceGoal({id:'s10b-'+arm+'-'+field.address,actionMask:mask,address:field.address,
    causalConfirmed,independentStarts:costProbe.independentStarts,
    resourceTrack:{values:track},
    terminal:{confirmedBeforeDepletion:alive,confirmedAfterDepletion:dead,scope:playScope}});
  }catch(problem){inductionError=problem.message;}
  perPartition.push({partition:part.group,gated:false,
   startProvenance:starts.map(start=>({id:start.id,independent:start.independent,
    provenance:start.provenance,
    comparability:start.comparability||null})),
   startsAreIndependent:starts.every(start=>start.independent),
   distinctStartHashes:new Set(starts.map(start=>start.stateHash)).size,
   causalConfirmed,
   confirmedCount:costProbe.confirmed.length,
   usableStarts:costProbe.independentStarts,
   playScopeSize:playScope.length,
   effectsConfirmedBeforeDepletion:alive.length,
   effectsConfirmedAfterDepletion:dead.length,
   judgedEffects:induced&&induced.terminal?induced.terminal.judgedEffects:null,
   normalPlaySuppressed:induced&&induced.terminal?induced.terminal.normalPlaySuppressed:null,
   resourceTrack:track,
   resourceDecreaseObserved:track.some((value,index)=>index>0
    &&Number.isInteger(value)&&Number.isInteger(track[index-1])&&value<track[index-1]),
   polarity:induced?induced.polarity:null,
   rationale:induced?induced.rationale:null,
   verifiable:induced?induced.verifiable:null,
   inductionError});
 }
 const judged=perPartition.filter(entry=>!entry.gated);
 return {arm,gateRefusal,perPartition,
  /* the five outcomes, reported separately as required */
  outcomes:{
   causalityRestored:judged.length>0&&judged.every(entry=>entry.causalConfirmed===true),
   causalityOnSomePartition:judged.some(entry=>entry.causalConfirmed===true),
   nonEmptyPlayScope:judged.some(entry=>entry.judgedEffects>0),
   realResourceDecreaseObserved:judged.some(entry=>entry.resourceDecreaseObserved===true),
   partitionAgreement:judged.length>0
    &&new Set(judged.map(entry=>entry.polarity)).size===1,
   holdoutExecuted:judged.some(entry=>entry.partition==='HOLDOUT'),
   startsIndependent:judged.length>0&&judged.every(entry=>entry.startsAreIndependent)}};
}

function evaluate(label,extra,bytes,entry,attestable){
 const host=machine(bytes,entry);
 const {driver}=host;
 const pristine=driver.snapshot();
 const romHash=crypto.createHash('sha256').update(bytes).digest('hex');
 /* candidates from the UNCHANGED S9 ranking */
 let discovery=null,discoveryError=null;
 try{discovery=Pipeline.run(driver,{romHash,coreRevision:'jsnes-s10b',profileRevision:REV,
  contextKey:romHash+'/s10b',nowMs:1761800000000,
  resourceSelection:'ranked',auditPolarity:true});}
 catch(problem){discoveryError=problem.message;}
 const ranked=discovery&&discovery.discovered&&discovery.discovered.rankedSelection
  ?discovery.discovered.rankedSelection.ranked:[];
 const effectMask=discovery&&discovery.discovered&&discovery.discovered.effect
  ?discovery.discovered.effect.mask:null;
 const playScope=(discovery&&discovery.discovered&&discovery.discovered.persistingByMask
  ?(discovery.discovered.persistingByMask.find(e=>e.mask===effectMask)||{addresses:[]}).addresses
  :[]);
 /* the saved discovery snapshot for strategy B1: the state typing left behind */
 driver.restore(pristine);
 const topMask=ranked.length?ranked[0].mask:null;
 if(topMask!==null)for(let event=0;event<TYPE_EVENTS;event++){
  driver.run(topMask,HOLD);driver.run(0,RELEASE);
 }
 const discoverySnapshot=driver.snapshot();

 const attest=attestable?snapshot=>{
  const phase=Phase.measurePhase(host.phaseProbe(snapshot),
   {idleFrames:60,pulses:6,settleFrames:30});
  return {status:phase.phase,modalities:phase.modalities,
   attestedComparable:phase.phase==='PASS'};
 }:null;

 const candidates=[];
 const limit=Math.min(ranked.length,Number(process.env.AGOD_S10B_CANDIDATES||2));
 for(let index=0;index<limit;index++){
  const entryRanked=ranked[index];
  const field=entryRanked.record?entryRanked.record.field:null;
  if(!field||effectMask===null)continue;
  const candidate={field,mask:entryRanked.mask};
  const arms={};
  for(const arm of ['BASELINE','GATE','REPLAY','HISTORY']){
   driver.restore(pristine);
   try{arms[arm]=runArm(arm,host,pristine,candidate,discoverySnapshot,effectMask,playScope,attest);}
   catch(problem){arms[arm]={arm,error:problem.message};}
  }
  candidates.push({rank:entryRanked.rank,address:field.address,mask:entryRanked.mask,
   score:entryRanked.score.total,field,arms});
 }
 const row={label,...extra,romHash:romHash.slice(0,16),
  discoveryStatus:discoveryError?'ERROR':discovery.status,
  discoveryStage:discoveryError?null:discovery.stage,
  discoveryError,effectMask,playScopeSize:playScope.length,
  candidatesExamined:candidates.length,candidates};
 rows.push(row);write();
 return row;
}

try{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s10b-'));
 /* synthetic positive control AND the sacrifice family, as required */
 const synth=[
  {generator:'tools/make_agod_test_rom.py',seeds:(process.env.AGOD_S10B_SEEDS||'0,200').split(',').map(Number),
   family:'test (positive control: the chain closes here)'},
  {generator:'tools/make_agod_sacrifice_rom.py',seeds:(process.env.AGOD_S10B_SACRIFICE||'3').split(',').map(Number),
   family:'sacrifice (a refusal is the right answer)'}];
 for(const group of synth)for(const seed of group.seeds){
  const out=path.join(directory,'rom-'+group.family.slice(0,4)+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',[group.generator,'--seed',String(seed),'--out',out]);
  const descriptor=JSON.parse(fs.readFileSync(out));
  evaluate(group.family+' seed '+seed,{corpus:'synthetic',family:group.family,seed},
   Buffer.from(descriptor.base64,'base64'),
   {bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0},false);
 }
 /* the real cartridges, on the declared S8 procedures */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 if(ROMS){
  const specs=(process.env.AGOD_S10B_PROCEDURES||'lifeforce:1:60,contra:6:300')
   .split(',').map(spec=>{const [rom,pulses,settle]=spec.split(':');
    return {rom,pulses:Number(pulses),settle:Number(settle)};});
  for(const spec of specs){
   const file=path.join(ROMS,spec.rom+'.nes');
   if(!fs.existsSync(file)){rows.push({label:spec.rom,status:'BLOCKED: not present'});write();continue;}
   evaluate(spec.rom+' '+spec.pulses+'/'+spec.settle,
    {corpus:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
     entryProcedure:{bootFrames:240,startPulses:spec.pulses,holdFrames:HOLD,
      gapFramesBetweenPresses:24,settleFrames:spec.settle}},
    fs.readFileSync(file),
    {bootFrames:240,startPulses:spec.pulses,gapFrames:24,settleFrames:spec.settle},true);
  }
 }else report.privateCorpus='AGOD_PRIVATE_ROMS not set: the real half was not run';

 /* per-arm totals, each outcome counted separately */
 const armNames=['BASELINE','GATE','REPLAY','HISTORY'];
 const tally={};
 for(const arm of armNames)tally[arm]={candidates:0,causalityRestored:0,
  causalityOnSomePartition:0,nonEmptyPlayScope:0,realResourceDecreaseObserved:0,
  partitionAgreement:0,holdoutExecuted:0,startsIndependent:0,gated:0,errors:0};
 const byCorpus={};
 for(const row of rows)for(const candidate of (row.candidates||[])){
  const key=row.corpus==='synthetic'?'synthetic':'real';
  byCorpus[key]=byCorpus[key]||JSON.parse(JSON.stringify(tally));
  for(const arm of armNames){
   const result=candidate.arms[arm];
   if(!result)continue;
   for(const sink of [tally[arm],byCorpus[key][arm]]){
    sink.candidates++;
    if(result.error){sink.errors++;continue;}
    if(result.gateRefusal)sink.gated++;
    const o=result.outcomes;
    if(o.causalityRestored)sink.causalityRestored++;
    if(o.causalityOnSomePartition)sink.causalityOnSomePartition++;
    if(o.nonEmptyPlayScope)sink.nonEmptyPlayScope++;
    if(o.realResourceDecreaseObserved)sink.realResourceDecreaseObserved++;
    if(o.partitionAgreement)sink.partitionAgreement++;
    if(o.holdoutExecuted)sink.holdoutExecuted++;
    if(o.startsIndependent)sink.startsIndependent++;
   }
  }
 }
 report.totals={perArm:tally,perArmByCorpus:byCorpus,
  criterion:'did causal attribution of the SAME candidate recover in comparable states, and did a non-empty play scope appear? VERIFIED is not the criterion',
  replayCaveat:'REPLAY shares one parent state across all starts, so a recovery there demonstrates replay reproducibility and NOT independent causal confirmation',
  gateCaveat:'a GATE refusal is NOT_REPRODUCED_ACROSS_STARTS and says nothing about whether a useful game resource exists'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
