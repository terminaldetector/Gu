'use strict';
// S11A: which typed fields have enough repeated transitions to support a claim
// of a constant step - and what the rule costs when it is wrong.
//
// THE RULE IS PRE-REGISTERED in agod-ram.js (TRANSITION_SUPPORT_RULE, committed
// in f2512fa before this ran on any real cartridge): at least two observed
// transitions whose non-zero steps agree. It is OFF by default, so legacy
// typing is the control arm and FIRST-V1 is untouched.
//
// SUCCESS IS NOT "suspicious fields disappeared". Two error directions are
// counted separately, and the fourth fixture family exists so that both can
// actually happen:
//
//   FALSE TYPING          a field typed as a constant-step resource that is not
//                         one. oneShotSwitch is the labelled case: rejecting it
//                         is correct.
//   LOST USEFUL CANDIDATE a real resource the rule rejects. singleUnit is the
//                         labelled case: one unit, spending it stops play, and
//                         no horizon can show a second transition. The rule
//                         MUST lose it, and that cost is measured here rather
//                         than hidden.
//
// The oracle is opened only after both arms have typed the cartridge.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const HOLD=4,RELEASE=8,TYPE_EVENTS=60,FRAMES_PER_EVENT=HOLD+RELEASE;
const MASKS=[1,2,4,8,16,32,64,128];
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  ramRevision:Ram.DETECTOR_REVISION,rule:Ram.TRANSITION_SUPPORT_RULE};})();
const report={type:'gu-agod-s11a-transition-support',version:1,
 question:'which typed fields have enough repeated transitions to support a constant step, and what does requiring that cost?',
 rule:Ram.TRANSITION_SUPPORT_RULE,
 scoring:'false typings AND lost useful candidates, counted separately. A drop in the number of typed fields is not by itself a success',
 armControl:'legacy typing (transitionSupport off) is the control; FIRST-V1 and the pipeline are untouched',
 oracleDiscipline:'opened only after both arms have typed the cartridge',
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_S11A_REPORT)
 fs.writeFileSync(process.env.AGOD_S11A_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function machine(bytes,entry){
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(bytes);
 const press=(mask,count)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<count;i++)core.frame();};
 press(0,entry.bootFrames);
 for(let i=0;i<entry.startPulses;i++){press(8,HOLD);press(0,entry.gapFrames);}
 if(entry.settleFrames)press(0,entry.settleFrames);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 return {press,ram,snapshot(){return JSON.stringify(core.toJSON());},
  restore(s){core.fromJSON(JSON.parse(s));}};
}

const movedBetween=samples=>{
 const moved=new Set();
 for(let i=1;i<samples.length;i++)
  for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])moved.add(a);
 return moved;
};

/* Type a cartridge exactly as the pipeline's typing stage does, under both
   arms. Nothing else differs between the arms. */
function typeCartridge(host){
 const pristine=host.snapshot();
 const play=(mask,events)=>{
  const samples=[];
  for(let e=0;e<events;e++){host.press(mask,HOLD);host.press(0,RELEASE);samples.push(host.ram());}
  return samples;
 };
 host.restore(pristine);
 const neutralMoved=movedBetween(play(0,TYPE_EVENTS));
 const legacy=[],ruled=[];
 for(const mask of MASKS){
  host.restore(pristine);
  const samples=play(mask,TYPE_EVENTS);
  const addresses=[...movedBetween(samples)].filter(a=>!neutralMoved.has(a)).sort((a,b)=>a-b);
  for(const span of Ram.spansOf(addresses)){
   const common={samples,addresses:span,framesPerSample:FRAMES_PER_EVENT};
   const a=Ram.identifyField(common);
   const b=Ram.identifyField({...common,transitionSupport:true});
   const record=field=>field?{address:field.address,width:field.width,
    step:field.step,direction:field.direction,encoding:field.encoding,
    support:field.transitionSupport?{
     observedTransitions:field.transitionSupport.observedTransitions,
     transitionFrameIndices:field.transitionSupport.transitionFrameIndices,
     distinctNonzeroSteps:field.transitionSupport.distinctNonzeroSteps,
     nonzeroSteps:field.transitionSupport.nonzeroSteps,
     stepAgreementAcrossTransitions:field.transitionSupport.stepAgreementAcrossTransitions,
     firstChangeFrame:field.transitionSupport.firstChangeFrame,
     lastChangeFrame:field.transitionSupport.lastChangeFrame,
     observationHorizonFrames:field.transitionSupport.observationHorizonFrames,
     transitionSupportStatus:field.transitionSupport.transitionSupportStatus}:null}:null;
   if(a.status==='IDENTIFIED')legacy.push({mask,...record(a.field)});
   if(b.status==='IDENTIFIED')ruled.push({mask,...record(b.field)});
   else if(b.status==='INSUFFICIENT_TRANSITION_SUPPORT')
    ruled.push({mask,...record(b.provisionalField),
     rejected:true,rejectedReason:b.reason,keptForDiagnosis:true});
  }
 }
 return {legacy,ruled,neutralMovedCount:neutralMoved.size};
}

function evaluate(label,extra,bytes,entry,openOracle,labelsFor){
 const host=machine(bytes,entry);
 const typed=typeCartridge(host);                 /* both arms commit here */
 const oracle=openOracle?openOracle():null;       /* only now */
 const identifiedLegacy=typed.legacy;
 const identifiedRuled=typed.ruled.filter(f=>!f.rejected);
 const rejected=typed.ruled.filter(f=>f.rejected);

 /* label each field where the oracle can say what it is */
 const labels=labelsFor&&oracle?labelsFor(oracle):null;
 const classify=address=>{
  if(!labels)return null;
  const hit=labels.find(entry=>address>=entry.address&&address<entry.address+entry.width);
  return hit||null;
 };
 const scored={falseTypingsLegacy:0,falseTypingsRuled:0,
  lostUsefulCandidates:0,keptUsefulCandidates:0,
  correctRejections:0,unlabelled:0,typedIncreasingNotScored:0};
 const perField=[];
 /* SCORING CORRECTION. The first version counted every typed non-resource as a
    false typing, including fields typed as INCREASING - but an increasing score
    field typed as a constant-step increasing field is correct behaviour, not an
    error, and the resource question is about decreasing fields. Only fields
    typed `decreasing` are scored against the resource labels; increasing ones
    are reported separately and not scored in either direction. */
 for(const field of typed.legacy){
  const info=classify(field.address);
  const stillTyped=identifiedRuled.some(f=>f.address===field.address&&f.mask===field.mask);
  const isDecreasing=field.direction==='decreasing';
  const row={address:field.address,mask:field.mask,step:field.step,
   direction:field.direction,
   transitions:field.support?field.support.observedTransitions:null,
   typedByLegacy:true,typedByRule:stillTyped,
   label:info?info.name:null,isResource:info?info.isResource:null,
   scoredAsResourceCandidate:isDecreasing};
  if(!isDecreasing)scored.typedIncreasingNotScored++;
  else if(!info)scored.unlabelled++;
  else if(info.isResource===false){
   scored.falseTypingsLegacy++;
   if(stillTyped)scored.falseTypingsRuled++;else scored.correctRejections++;
  }else if(info.isResource===true){
   if(stillTyped)scored.keptUsefulCandidates++;else scored.lostUsefulCandidates++;
  }
  perField.push(row);
 }
 const row={label,...extra,
  typedByLegacy:identifiedLegacy.length,
  typedByRule:identifiedRuled.length,
  rejectedByRule:rejected.length,
  rejectedKeptForDiagnosis:rejected.every(f=>f.keptForDiagnosis===true),
  neutralMovedAddresses:typed.neutralMovedCount,
  singleTransitionFields:typed.legacy.filter(f=>f.support&&f.support.observedTransitions===1).length,
  observationHorizonFrames:TYPE_EVENTS*FRAMES_PER_EVENT,
  scored:labels?scored:null,
  fields:perField.slice(0,40),
  rejectedFields:rejected.slice(0,20).map(f=>({address:f.address,mask:f.mask,step:f.step,
   transitions:f.support?f.support.observedTransitions:null,
   transitionFrameIndices:f.support?f.support.transitionFrameIndices:null,
   reason:f.rejectedReason}))};
 rows.push(row);write();
 return row;
}

try{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s11a-'));
 const build=(generator,seed)=>{
  const out=path.join(directory,'rom-'+path.basename(generator)+'-'+seed+'.json');
  const orc=path.join(directory,'oracle-'+path.basename(generator)+'-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',[generator,'--seed',String(seed),'--out',out,'--oracle-out',orc]);
  return {bytes:Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64'),
   openOracle:()=>JSON.parse(fs.readFileSync(orc))};
 };
 const bootOnly={bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0};

 /* the fourth family: the two cases with opposite right answers */
 for(const seed of (process.env.AGOD_S11A_TRANSITION_SEEDS||'1,2').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_transition_rom.py',seed);
  evaluate('single-transition seed '+seed,{corpus:'synthetic',family:'single-transition',seed},
   bytes,bootOnly,openOracle,oracle=>[
   {name:'oneShotSwitch',address:oracle.fields.oneShotSwitch.address,width:1,isResource:false},
   {name:'singleUnit',address:oracle.fields.singleUnit.address,width:1,isResource:true},
   {name:'score',address:oracle.fields.score.address,width:1,isResource:false},
   {name:'frameCounter',address:oracle.fields.frameCounter.address,width:2,isResource:false},
   {name:'noise',address:oracle.fields.noise.address,width:1,isResource:false}]);
 }
 /* the positive control */
 for(const seed of (process.env.AGOD_S11A_SEEDS||'0,200').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_test_rom.py',seed);
  evaluate('test seed '+seed,{corpus:'synthetic',family:'test',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'lives',address:oracle.fields.lives.address,width:oracle.fields.lives.width,isResource:true},
    {name:'score',address:oracle.fields.score.address,width:oracle.fields.score.width,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false},
    {name:'frameCounter',address:oracle.fields.frameCounter.address,width:4,isResource:false},
    {name:'noise',address:oracle.fields.noise.address,width:1,isResource:false}]);
 }
 /* sacrifice and rate-trap */
 for(const seed of (process.env.AGOD_S11A_SACRIFICE||'3').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_sacrifice_rom.py',seed);
  evaluate('sacrifice seed '+seed,{corpus:'synthetic',family:'sacrifice',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'charges',address:oracle.fields.charges.address,width:1,isResource:true},
    {name:'treasure',address:oracle.fields.treasure.address,width:oracle.fields.treasure.width,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false},
    {name:'frameCounter',address:oracle.fields.frameCounter.address,width:4,isResource:false}]);
 }
 for(const seed of (process.env.AGOD_S11A_TRAP||'5').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_rate_trap_rom.py',seed);
  evaluate('rate-trap seed '+seed,{corpus:'synthetic',family:'rate-trap',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'fuel',address:oracle.fields.fuel.address,width:1,isResource:true},
    {name:'steadyGain',address:oracle.fields.steadyGain.address,width:1,isResource:false},
    {name:'fickleDecoy',address:oracle.fields.fickleDecoy.address,width:1,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false}]);
 }
 /* the same real ROMs and procedures as S10B - no labels exist there */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 if(ROMS){
  for(const spec of (process.env.AGOD_S11A_PROCEDURES||'lifeforce:1:60,lifeforce:6:60,contra:6:300')
   .split(',').map(s=>{const [rom,pulses,settle]=s.split(':');return {rom,pulses:+pulses,settle:+settle};})){
   const file=path.join(ROMS,spec.rom+'.nes');
   if(!fs.existsSync(file)){rows.push({label:spec.rom,status:'BLOCKED: not present'});write();continue;}
   evaluate(spec.rom+' '+spec.pulses+'/'+spec.settle,
    {corpus:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
     entryProcedure:{bootFrames:240,startPulses:spec.pulses,gapFramesBetweenPresses:24,settleFrames:spec.settle},
     noLabelsExist:'no oracle exists for a real cartridge, so no field here is scored as a false typing or a lost candidate'},
    fs.readFileSync(file),
    {bootFrames:240,startPulses:spec.pulses,gapFrames:24,settleFrames:spec.settle},null,null);
  }
 }else report.privateCorpus='AGOD_PRIVATE_ROMS not set: the real half was not run';

 const labelled=rows.filter(row=>row.scored);
 const sum=key=>labelled.reduce((total,row)=>total+row.scored[key],0);
 report.totals={
  cartridges:rows.length,labelledCartridges:labelled.length,
  typedByLegacy:rows.reduce((t,r)=>t+(r.typedByLegacy||0),0),
  typedByRule:rows.reduce((t,r)=>t+(r.typedByRule||0),0),
  rejectedByRule:rows.reduce((t,r)=>t+(r.rejectedByRule||0),0),
  singleTransitionFields:rows.reduce((t,r)=>t+(r.singleTransitionFields||0),0),
  allRejectedKeptForDiagnosis:rows.every(r=>r.rejectedByRule===0||r.rejectedKeptForDiagnosis===true),
  /* the two error directions, separately */
  falseTypingsLegacy:sum('falseTypingsLegacy'),
  falseTypingsUnderRule:sum('falseTypingsRuled'),
  correctRejections:sum('correctRejections'),
  lostUsefulCandidates:sum('lostUsefulCandidates'),
  keptUsefulCandidates:sum('keptUsefulCandidates'),
  unlabelledTypedFields:sum('unlabelled'),
  typedIncreasingNotScored:sum('typedIncreasingNotScored'),
  /* A separate defect found while building this stage, reported because it
     bites exactly the population the rule is about. */
  firstEventBlindness:{
   defect:'the typing stage samples RAM only AFTER each observed event, so a change that happens during the FIRST event and never again has nothing to be compared against and is invisible to typing',
   where:'play() in agod-pipeline.js, and the same schedule reproduced here',
   consequence:'part of the single-transition population the transition-support rule is meant to judge never reaches typing at all, so neither arm can see it',
   foundBy:'the single-transition fixture typed neither of its labelled cases until an arming delay was added to move their transition inside the sampled window',
   fixedHere:false,
   note:'not fixed in this stage: changing when typing samples is a change to the typer and belongs to its own declared stage'},
  note:'a fall in typedByRule is not a success on its own; read falseTypings against lostUsefulCandidates'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
