'use strict';
// S10A: why do even the best-evidenced candidates fail `induce`?
//
// DIAGNOSTIC ONLY. No rule of NEGATIVE verification is changed, no threshold is
// moved, and the pulse budget is exactly S9's (config.depletePulses). Turning
// the audit off changes no verdict: it reads state and writes notes.
//
// The NEGATIVE chain in agod-goals.js is a conjunction of five terms:
//
//   causalConfirmed && resource.decreasing && resource.settledAtFloor
//                   && terminal.normalPlaySuppressed && !judgementBlocks
//
// The first four are statements about what the emulator did. The fifth is an
// INTERPRETATION - whether the observed depletion counts as a cost - and
// NEGATIVE_GAME_REWARD is that judgement, not a measurement. The audit keeps
// the two apart everywhere it reports them.
//
// For every candidate and partition it records the initial value at EVERY
// independent start, every sample with its decode state, whether a floor was
// reached inside the declared budget, which previously confirmed effects
// stopped reproducing, and which term of the conjunction was false first.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Goals=require('../app/src/main/assets/lab/agod-goals.js'),
      Candidates=require('../app/src/main/assets/lab/agod-candidates.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const REV='profile-rev-1';
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  pipelineRevision:Pipeline.PIPELINE_REVISION,goalsRevision:Goals.DETECTOR_REVISION,
  candidatesRevision:Candidates.CANDIDATES_REVISION};})();
const report={type:'gu-agod-polarity-audit',version:1,
 question:'which term of the NEGATIVE conjunction fails, on the candidates the ranking rates highest?',
 chain:'causalConfirmed && resource.decreasing && resource.settledAtFloor && terminal.normalPlaySuppressed && !judgementBlocks',
 unchanged:'NEGATIVE verification rules, thresholds and the pulse budget are exactly those of S9; the audit only reads and records',
 factVersusInterpretation:'the first four terms are observations; the fifth is the judgement NEGATIVE_GAME_REWARD and is labelled as interpretation wherever it appears',
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_POLARITY_REPORT)
 fs.writeFileSync(process.env.AGOD_POLARITY_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function nesDriver(bytes,bootFrames,preamble){
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(bytes);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const press=(mask,frames)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<frames;i++)core.frame();};
 press(0,bootFrames);
 if(preamble)for(let i=0;i<preamble.pulses;i++){press(8,4);press(0,preamble.gap);}
 if(preamble&&preamble.settle)press(0,preamble.settle);
 let frames=0;
 return {restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,count){frames+=count;press(mask,count);},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  poke(address,value){core.cpu.mem[address]=value&255;},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');},
  framesRun(){return frames;}};
}

/* One audited pipeline run, in ranked mode so the candidates examined are the
   ones the pre-registered ranking rates highest. */
function audit(label,driver,romHash,extra){
 const started=Date.now();
 let outcome=null,error=null;
 try{outcome=Pipeline.run(driver,{romHash,coreRevision:'jsnes-audit',profileRevision:REV,
  contextKey:romHash+'/audit',nowMs:1761800000000,
  resourceSelection:'ranked',auditPolarity:true});}
 catch(problem){error=problem.message;}
 const audits=outcome&&outcome.trace?outcome.trace.filter(entry=>entry.stage==='polarity-audit'):[];
 /* group the per-partition audits by candidate */
 const byCandidate=new Map();
 for(const entry of audits){
  const key=entry.candidate+'/'+entry.mask;
  if(!byCandidate.has(key))byCandidate.set(key,[]);
  byCandidate.get(key).push(entry);
 }
 const candidates=[...byCandidate.entries()].map(([key,partitionAudits])=>{
  const first=partitionAudits[0];
  const firstFalse=partitionAudits.map(entry=>entry.firstFalseTerm);
  const agreed=new Set(firstFalse).size===1?firstFalse[0]:null;
  return {candidate:key,address:first.candidate,mask:first.mask,field:first.field,
   partitions:partitionAudits.map(entry=>({
    partition:entry.partition,polarity:entry.polarity,rationale:entry.rationale,
    depletionFact:entry.depletionFact,
    firstFalseTerm:entry.firstFalseTerm,falseTerms:entry.falseTerms,
    initialByStart:entry.initialByStart,
    initialValuesDistinct:[...new Set((entry.initialByStart||[]).map(s=>s.value))],
    samples:entry.samples,decodeFailures:entry.decodeFailures,
    terms:entry.terms,coverage:entry.coverage})),
   firstFalseTermPerPartition:firstFalse,
   firstFalseTermAgreesAcrossPartitions:agreed!==null,
   firstFalseTerm:agreed};
 });
 const row={label,...(extra||{}),romHash:romHash.slice(0,16),
  status:error?'ERROR':outcome.status,stage:error?null:outcome.stage,
  reason:error?error:outcome.reason,
  selection:outcome&&outcome.discovered&&outcome.discovered.rankedSelectionPhase
   ?outcome.discovered.rankedSelectionPhase:null,
  ranking:outcome&&outcome.discovered&&outcome.discovered.rankedSelection
   ?outcome.discovered.rankedSelection.ranked.map(e=>({rank:e.rank,address:e.address,
     mask:e.mask,score:e.score.total})):null,
  candidatesAudited:candidates.length,
  candidates,
  framesRun:driver.framesRun?driver.framesRun():null,
  elapsedMs:Date.now()-started};
 rows.push(row);write();
 return row;
}

try{
 /* --- synthetic control: a cartridge where the chain is known to CLOSE, so the
        audit is shown to be able to see a passing chain and not only failures */
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s10a-'));
 const synthSeeds=(process.env.AGOD_S10A_SEEDS||'0,200').split(',').map(Number);
 for(const seed of synthSeeds){
  const cart=path.join(directory,'rom-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',
   ['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart]);
  const descriptor=JSON.parse(fs.readFileSync(cart));
  const bytes=Buffer.from(descriptor.base64,'base64');
  const romHash=crypto.createHash('sha256').update(bytes).digest('hex');
  audit('synthetic seed '+seed,nesDriver(bytes,60,null),romHash,
   {corpus:'synthetic generator (control: the chain is known to close here)',seed});
 }

 /* --- the real cartridges, on the S9 procedures that reach gameplay */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 if(ROMS){
  const specs=(process.env.AGOD_S10A_PROCEDURES||'lifeforce:1:60,lifeforce:6:60,contra:6:300')
   .split(',').map(spec=>{const [rom,pulses,settle]=spec.split(':');
    return {rom,pulses:Number(pulses),settle:Number(settle)};});
  for(const spec of specs){
   const file=path.join(ROMS,spec.rom+'.nes');
   if(!fs.existsSync(file)){rows.push({label:spec.rom,status:'BLOCKED: not present'});write();continue;}
   const bytes=fs.readFileSync(file);
   const romHash=crypto.createHash('sha256').update(bytes).digest('hex');
   audit(spec.rom+' '+spec.pulses+'/'+spec.settle,
    nesDriver(bytes,240,{pulses:spec.pulses,gap:24,settle:spec.settle}),romHash,
    {corpus:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
     entryProcedure:{bootFrames:240,startPulses:spec.pulses,holdFrames:4,
      gapFramesBetweenPresses:24,settleFrames:spec.settle}});
  }
 }else{
  report.privateCorpus='AGOD_PRIVATE_ROMS not set: the real-cartridge half was not run';
 }

 /* --- which term fails, across everything audited */
 const all=rows.filter(row=>row.candidates&&row.candidates.length);
 const tally={},perCorpus={};
 for(const row of all){
  const corpusKey=row.corpus&&row.corpus.startsWith('synthetic')?'synthetic':'real';
  perCorpus[corpusKey]=perCorpus[corpusKey]||{};
  for(const candidate of row.candidates)
   for(const part of candidate.partitions){
    const key=part.firstFalseTerm===null||part.firstFalseTerm===undefined
     ?'none (the chain closed)':part.firstFalseTerm;
    tally[key]=(tally[key]||0)+1;
    perCorpus[corpusKey][key]=(perCorpus[corpusKey][key]||0)+1;
   }
 }
 const vacuous=[],zeroStart=[],floorMissed=[];
 for(const row of all)for(const candidate of row.candidates)for(const part of candidate.partitions){
  const terminalTerm=part.terms.find(entry=>entry.term==='terminal.normalPlaySuppressed');
  if(terminalTerm&&terminalTerm.detail&&terminalTerm.detail.vacuousBecauseNothingWasConfirmed)
   vacuous.push({row:row.label,address:candidate.address,partition:part.partition});
  if((part.initialValuesDistinct||[]).every(value=>value===0))
   zeroStart.push({row:row.label,address:candidate.address,partition:part.partition});
  const floorTerm=part.terms.find(entry=>entry.term==='resource.settledAtFloor');
  if(floorTerm&&floorTerm.detail&&floorTerm.detail.floorReachedWithinBudget===false)
   floorMissed.push({row:row.label,address:candidate.address,partition:part.partition});
 }
 report.totals={runs:rows.length,runsWithCandidates:all.length,
  firstFalseTerm:tally,firstFalseTermByCorpus:perCorpus,
  diagnoses:{
   terminalTermVacuous:{count:vacuous.length,
    meaning:'no previously confirmed effect fell inside the play scope, so "every confirmed effect stopped" is true of an empty set and the term is false by construction rather than by observation',
    cases:vacuous.slice(0,24)},
   resourceZeroAtEveryStart:{count:zeroStart.length,
    meaning:'the candidate reads the same zero at every independent start, so there is no depletion to observe at all',
    cases:zeroStart.slice(0,24)},
   floorNotReachedInsideBudget:{count:floorMissed.length,
    meaning:'the minimum arrived only on the last sample or not at all, which is the one diagnosis a larger pulse budget could change. NOT acted on here: any other budget is a separately declared comparison',
    cases:floorMissed.slice(0,24)}},
  note:'the pulse budget was not changed in this stage'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
