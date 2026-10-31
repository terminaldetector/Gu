'use strict';
// S11C: how much of the single-transition population is invisible to typing,
// and what recovering it costs.
//
// THE DEFECT. The typing stage samples RAM only AFTER each observed event, so a
// change that happens during the FIRST event and never again has nothing to be
// compared against. S11A found this by accident: the single-transition fixture
// typed neither of its labelled cases until an arming delay moved the
// transition inside the sampled window.
//
// TWO MODES, nothing else differs between them:
//   POST_ONLY     the existing schedule: a snapshot after each event.
//   PRE_AND_POST  one snapshot taken immediately BEFORE the first event, then
//                 the same sequence of post-event snapshots.
//
// The extra snapshot RUNS NO FRAMES. It is a RAM read before the loop starts,
// so both modes emulate exactly the same number of frames and see exactly the
// same game. Masks, HOLD, RELEASE, event count, the neutral control, encodings,
// the step rules and the causal checks are all unchanged.
//
// THE TWO-TRANSITION FILTER IS OFF HERE. S11A measured that rule; mixing it
// with a change in WHEN sampling happens would make neither result readable.
//
// FOUR OUTCOMES ARE KEPT APART, because "not found" has four different causes:
//   NOT_CAUSALLY_ATTRIBUTED   the address never entered the attributed set
//   FIRST_EVENT_MISSED        attributed, but its only change was in event 1
//                             and POST_ONLY had nothing to compare
//   STRUCTURE_UNDETERMINED    the change was seen, but encoding or direction
//                             could not be settled
//   NUMERIC_FIELD_IDENTIFIED  a numeric structure was recognised - which says
//                             nothing yet about any game role
//
// VOCABULARY, used strictly from here on:
//   NUMERIC_FIELD_IDENTIFIED  a numeric structure was recognised
//   RESOURCE_CANDIDATE        the field is being considered as a resource
//   GAME_COST_EVIDENCED       the consequences of its decrease are causally shown
//   VERIFIED_GOAL             all independent verification has passed
// One numeric transition does not make a field useful, and a shortage of
// repeated transitions does not make it useless.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const HOLD=4,RELEASE=8,TYPE_EVENTS=60,FRAMES_PER_EVENT=HOLD+RELEASE;
const MASKS=[1,2,4,8,16,32,64,128];
const PROBE_FRAMES=12,SHIFT=3,PROBE_STARTS=2;
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  ramRevision:Ram.DETECTOR_REVISION,causalRevision:Causal.DETECTOR_REVISION};})();
const report={type:'gu-agod-s11c-first-event-recovery',version:1,
 question:'how much of the single-transition population does POST_ONLY sampling never observe, and what does observing it cost?',
 modes:{POST_ONLY:'a snapshot after each event, the existing schedule',
  PRE_AND_POST:'one snapshot immediately before the first event, then the same post-event sequence'},
 invariants:['the extra snapshot runs NO frames: both modes emulate the same frames',
  'masks, HOLD, RELEASE, event count, neutral control, encodings, step rules and causal checks unchanged',
  'the two-transition filter from S11A is OFF, so the sampling change is not mixed with it'],
 vocabulary:{NUMERIC_FIELD_IDENTIFIED:'a numeric structure was recognised',
  RESOURCE_CANDIDATE:'considered as a possible resource',
  GAME_COST_EVIDENCED:'the consequences of its decrease are causally shown',
  VERIFIED_GOAL:'all independent verification has passed',
  rule:'one numeric transition does not make a field useful, and a shortage of repeated transitions does not make it useless'},
 timing:'each transition is located to an observation interval, never to a frame; intervalStartFrame, intervalEndFrame and the snapshot source are recorded',
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_S11C_REPORT)
 fs.writeFileSync(process.env.AGOD_S11C_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function machine(bytes,entry){
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(bytes);
 let frames=0;
 const press=(mask,count)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<count;i++){core.frame();frames++;}};
 press(0,entry.bootFrames);
 for(let i=0;i<entry.startPulses;i++){press(8,HOLD);press(0,entry.gapFrames);}
 if(entry.settleFrames)press(0,entry.settleFrames);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 return {press,ram,framesRun(){return frames;},
  snapshot(){return JSON.stringify(core.toJSON());},
  restore(s){core.fromJSON(JSON.parse(s));},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');},
  driver(){return {restore:s=>core.fromJSON(JSON.parse(s)),
   run:(mask,count)=>press(mask,count),readRam:ram,
   snapshot(){return JSON.stringify(core.toJSON());},
   stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};}};
}
const movedBetween=samples=>{
 const moved=new Set();
 for(let i=1;i<samples.length;i++)
  for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])moved.add(a);
 return moved;
};

/* Typing under one sampling mode. The ONLY difference is whether a pre-event
   snapshot is prepended; it costs zero frames. */
function typeUnder(host,mode){
 const pristine=host.snapshot();
 const framesBefore=host.framesRun();
 const play=mask=>{
  const samples=[];
  if(mode==='PRE_AND_POST')samples.push(host.ram());      /* no frames run */
  for(let e=0;e<TYPE_EVENTS;e++){host.press(mask,HOLD);host.press(0,RELEASE);samples.push(host.ram());}
  return samples;
 };
 host.restore(pristine);
 const neutralMoved=movedBetween(play(0));
 const typed=[],unresolved=[];
 const attributedAddresses=new Set();
 for(const mask of MASKS){
  host.restore(pristine);
  const samples=play(mask);
  const moved=movedBetween(samples);
  for(const a of moved)attributedAddresses.add(a);
  const addresses=[...moved].filter(a=>!neutralMoved.has(a)).sort((a,b)=>a-b);
  for(const span of Ram.spansOf(addresses)){
   const outcome=Ram.identifyField({samples,addresses:span,
    framesPerSample:FRAMES_PER_EVENT,samplingMode:mode});
   if(outcome.status==='IDENTIFIED'){
    const f=outcome.field,sup=f.transitionSupport;
    typed.push({mask,address:f.address,width:f.width,step:f.step,direction:f.direction,
     encoding:f.encoding,encodingDetermined:f.encodingDetermined,
     classification:'NUMERIC_FIELD_IDENTIFIED',
     resourceCandidate:f.direction==='decreasing',
     observedTransitions:sup.observedTransitions,
     transitionIntervals:sup.transitionIntervals,
     firstChangeInterval:sup.firstChangeInterval,
     samplingMode:sup.samplingMode,
     transitionSupportStatus:sup.transitionSupportStatus});
   }else unresolved.push({mask,span:[span[0],span[span.length-1]],status:outcome.status,
    reason:outcome.reason||null});
  }
 }
 return {typed,unresolved,neutralMovedCount:neutralMoved.size,
  attributedCount:attributedAddresses.size,
  framesRun:host.framesRun()-framesBefore,
  samplesPerMask:mode==='PRE_AND_POST'?TYPE_EVENTS+1:TYPE_EVENTS};
}

function evaluate(label,extra,bytes,entry,openOracle,labelsFor){
 const a=machine(bytes,entry),b=machine(bytes,entry);
 const post=typeUnder(a,'POST_ONLY');
 const pre=typeUnder(b,'PRE_AND_POST');
 const oracle=openOracle?openOracle():null;        /* only after both modes ran */
 const labels=labelsFor&&oracle?labelsFor(oracle):null;
 const classify=address=>labels
  ?(labels.find(e=>address>=e.address&&address<e.address+e.width)||null):null;

 const key=f=>f.mask+':'+f.address+':'+f.width;
 const postKeys=new Set(post.typed.map(key));
 const preKeys=new Set(pre.typed.map(key));
 const gained=pre.typed.filter(f=>!postKeys.has(key(f)));
 const kept=pre.typed.filter(f=>postKeys.has(key(f)));
 const lost=post.typed.filter(f=>!preKeys.has(key(f)));

 /* which gains are first-interval events, and what they are */
 const firstIntervalGains=gained.filter(f=>f.firstChangeInterval
  &&f.firstChangeInterval.intervalStartFrame===0);
 const scored={recoveredResources:0,newNonResourceDecreasing:0,
  gainedUnlabelled:0,gainedIncreasing:0};
 const gainedDetail=gained.map(f=>{
  const info=classify(f.address);
  if(f.direction!=='decreasing')scored.gainedIncreasing++;
  else if(!info)scored.gainedUnlabelled++;
  else if(info.isResource===true)scored.recoveredResources++;
  else scored.newNonResourceDecreasing++;
  return {mask:f.mask,address:f.address,direction:f.direction,step:f.step,
   observedTransitions:f.observedTransitions,
   firstChangeInterval:f.firstChangeInterval,
   classification:f.classification,resourceCandidate:f.resourceCandidate,
   label:info?info.name:null,isResource:info?info.isResource:null,
   gameRole:info?(info.isResource?'labelled resource':'labelled non-resource')
    :'UNKNOWN: typed as a numeric field, its game role is not established'};
 });
 /* encoding / direction / transition changes on the fields both modes typed */
 const changes=[];
 for(const f of kept){
  const before=post.typed.find(g=>key(g)===key(f));
  if(!before)continue;
  if(before.encoding!==f.encoding||before.direction!==f.direction
   ||before.step!==f.step||before.observedTransitions!==f.observedTransitions)
   changes.push({mask:f.mask,address:f.address,
    encoding:[before.encoding,f.encoding],direction:[before.direction,f.direction],
    step:[before.step,f.step],
    observedTransitions:[before.observedTransitions,f.observedTransitions]});
 }
 const row={label,...extra,
  POST_ONLY:{typed:post.typed.length,resourceCandidates:post.typed.filter(f=>f.resourceCandidate).length,
   unresolved:post.unresolved.length,attributedAddresses:post.attributedCount,
   samplesPerMask:post.samplesPerMask,framesRun:post.framesRun},
  PRE_AND_POST:{typed:pre.typed.length,resourceCandidates:pre.typed.filter(f=>f.resourceCandidate).length,
   unresolved:pre.unresolved.length,attributedAddresses:pre.attributedCount,
   samplesPerMask:pre.samplesPerMask,framesRun:pre.framesRun},
  framesIdentical:post.framesRun===pre.framesRun,
  extraSnapshotsPerMask:1,
  gainedFields:gained.length,keptFields:kept.length,lostFields:lost.length,
  gainsWhoseFirstChangeIsTheFirstInterval:firstIntervalGains.length,
  scored:labels?scored:null,
  gainedDetail:gainedDetail.slice(0,24),
  lostDetail:lost.slice(0,8).map(f=>({mask:f.mask,address:f.address,direction:f.direction})),
  fieldChangesAcrossModes:changes.slice(0,12),
  unresolvedPost:post.unresolved.slice(0,8),
  unresolvedPre:pre.unresolved.slice(0,8)};
 rows.push(row);write();
 return row;
}

try{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s11c-'));
 const build=(generator,seed,extraArgs)=>{
  const tag=path.basename(generator)+'-'+seed+'-'+(extraArgs||[]).join('');
  const out=path.join(directory,'rom-'+tag+'.json'),orc=path.join(directory,'oracle-'+tag+'.json');
  execFileSync(process.env.PYTHON||'python3',
   [generator,'--seed',String(seed),'--out',out,'--oracle-out',orc,...(extraArgs||[])]);
  return {bytes:Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64'),
   openOracle:()=>JSON.parse(fs.readFileSync(orc))};
 };
 const bootOnly={bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0};
 const transitionLabels=oracle=>[
  {name:'oneShotSwitch',address:oracle.fields.oneShotSwitch.address,width:1,isResource:false},
  {name:'singleUnit',address:oracle.fields.singleUnit.address,width:1,isResource:true},
  {name:'score',address:oracle.fields.score.address,width:1,isResource:false},
  {name:'pressCount',address:oracle.fields.pressCount.address,width:1,isResource:false},
  {name:'frameCounter',address:oracle.fields.frameCounter.address,width:2,isResource:false},
  {name:'noise',address:oracle.fields.noise.address,width:1,isResource:false}];

 /* 1 and 2: both mechanisms fire on the FIRST press - the invisible case */
 for(const seed of (process.env.AGOD_S11C_SEEDS||'1,2').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_transition_rom.py',seed,['--arm-presses','1']);
  evaluate('single-transition seed '+seed+' arm=1 (fires on the first press)',
   {corpus:'synthetic',family:'single-transition',seed,armPresses:1},
   bytes,bootOnly,openOracle,transitionLabels);
 }
 /* 3: the same two mechanisms delayed to the fourth press */
 for(const seed of (process.env.AGOD_S11C_SEEDS||'1,2').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_transition_rom.py',seed,['--arm-presses','4']);
  evaluate('single-transition seed '+seed+' arm=4 (delayed to the fourth press)',
   {corpus:'synthetic',family:'single-transition',seed,armPresses:4},
   bytes,bootOnly,openOracle,transitionLabels);
 }
 /* 4: the existing families */
 for(const seed of (process.env.AGOD_S11C_POSITIVE||'0,200').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_test_rom.py',seed);
  evaluate('test seed '+seed,{corpus:'synthetic',family:'test',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'lives',address:oracle.fields.lives.address,width:oracle.fields.lives.width,isResource:true},
    {name:'score',address:oracle.fields.score.address,width:oracle.fields.score.width,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false},
    {name:'frameCounter',address:oracle.fields.frameCounter.address,width:4,isResource:false},
    {name:'noise',address:oracle.fields.noise.address,width:1,isResource:false}]);
 }
 for(const seed of (process.env.AGOD_S11C_SACRIFICE||'3').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_sacrifice_rom.py',seed);
  evaluate('sacrifice seed '+seed,{corpus:'synthetic',family:'sacrifice',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'charges',address:oracle.fields.charges.address,width:1,isResource:true},
    {name:'treasure',address:oracle.fields.treasure.address,width:oracle.fields.treasure.width,isResource:false},
    {name:'progress',address:oracle.fields.progress.address,width:1,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false}]);
 }
 for(const seed of (process.env.AGOD_S11C_TRAP||'5').split(',').map(Number)){
  const {bytes,openOracle}=build('tools/make_agod_rate_trap_rom.py',seed);
  evaluate('rate-trap seed '+seed,{corpus:'synthetic',family:'rate-trap',seed},bytes,bootOnly,openOracle,
   oracle=>[{name:'fuel',address:oracle.fields.fuel.address,width:1,isResource:true},
    {name:'steadyGain',address:oracle.fields.steadyGain.address,width:1,isResource:false},
    {name:'fickleDecoy',address:oracle.fields.fickleDecoy.address,width:1,isResource:false},
    {name:'timer',address:oracle.fields.timer.address,width:1,isResource:false}]);
 }
 /* 5: the real cartridges on the same entry procedures */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 if(ROMS){
  for(const spec of (process.env.AGOD_S11C_PROCEDURES||'lifeforce:1:60,lifeforce:6:60,contra:6:300')
   .split(',').map(s=>{const [rom,pulses,settle]=s.split(':');return {rom,pulses:+pulses,settle:+settle};})){
   const file=path.join(ROMS,spec.rom+'.nes');
   if(!fs.existsSync(file)){rows.push({label:spec.rom,status:'BLOCKED: not present'});write();continue;}
   evaluate(spec.rom+' '+spec.pulses+'/'+spec.settle,
    {corpus:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
     entryProcedure:{bootFrames:240,startPulses:spec.pulses,gapFramesBetweenPresses:24,settleFrames:spec.settle},
     noLabelsExist:'no oracle exists for a real cartridge: every gained field is reported with game role UNKNOWN and is NOT counted as a recovered resource'},
    fs.readFileSync(file),
    {bootFrames:240,startPulses:spec.pulses,gapFrames:24,settleFrames:spec.settle},null,null);
  }
 }else report.privateCorpus='AGOD_PRIVATE_ROMS not set: the real half was not run';

 const labelled=rows.filter(r=>r.scored);
 const sum=key=>labelled.reduce((t,r)=>t+r.scored[key],0);
 const total=key=>rows.reduce((t,r)=>t+(r[key]||0),0);
 report.totals={
  cartridges:rows.length,labelledCartridges:labelled.length,
  typedPostOnly:rows.reduce((t,r)=>t+((r.POST_ONLY&&r.POST_ONLY.typed)||0),0),
  typedPreAndPost:rows.reduce((t,r)=>t+((r.PRE_AND_POST&&r.PRE_AND_POST.typed)||0),0),
  resourceCandidatesPostOnly:rows.reduce((t,r)=>t+((r.POST_ONLY&&r.POST_ONLY.resourceCandidates)||0),0),
  resourceCandidatesPreAndPost:rows.reduce((t,r)=>t+((r.PRE_AND_POST&&r.PRE_AND_POST.resourceCandidates)||0),0),
  gainedFields:total('gainedFields'),keptFields:total('keptFields'),lostFields:total('lostFields'),
  gainsWhoseFirstChangeIsTheFirstInterval:total('gainsWhoseFirstChangeIsTheFirstInterval'),
  /* labelled outcomes, separately */
  recoveredResources:sum('recoveredResources'),
  newNonResourceDecreasing:sum('newNonResourceDecreasing'),
  gainedIncreasing:sum('gainedIncreasing'),
  gainedUnlabelled:sum('gainedUnlabelled'),
  /* cost */
  framesIdenticalEverywhere:rows.every(r=>r.framesIdentical!==false),
  extraSnapshotsPerMaskPerCartridge:1,
  fieldChangesAcrossModes:rows.reduce((t,r)=>t+((r.fieldChangesAcrossModes||[]).length),0),
  note:'more typed fields is NOT automatically an improvement: read recoveredResources against newNonResourceDecreasing, and note that on real cartridges no gained field is counted as recovered because no labels exist'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
