'use strict';
// Real-ROM AGOD: entry into play, survival discovery and FDB learning on
// PRIVATE commercial cartridges, with aggregate analytics only.
//
//   AGOD_PRIVATE_ROMS=/path/to/private/dir node tools/agod_realrom_check.cjs \
//     [--fdb] [--out docs/reports/realrom/run.json] [--only <sha-prefix>]
//
// PRIVACY. ROM bytes are read from AGOD_PRIVATE_ROMS and never leave this
// process: the report carries the SHA-256, the byte size and aggregate
// results. No RAM offset, no frame, no state and no header text is written.
// Without AGOD_PRIVATE_ROMS the run is BLOCKED - no fixture is substituted.
//
// ORACLE. AGOD_PRIVATE_ROMS/oracle.json may map a SHA-256 to the resource and
// progress offsets a human established by inspection ({"<sha>":{"resource":[..],
// "progress":[..]}}). It is opened only AFTER discovery has answered, and only
// a match/no-match bit reaches the report.
//
// FDB (--fdb, needs CODE_CLASSPATH with tools/FdbGameBridge compiled): the
// production learner plays from TRAINING starts with the verified survival
// reward, then untrained / trained / seeded-random are evaluated FROZEN on
// HOLDOUT starts of separate origin.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process'),readline=require('readline');
const A=path.resolve(__dirname,'..','app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js','agod-evidence.js',
 'agod-candidates.js','agod-consumers.js','agod-platform-driver.js','agod-pipeline.js',
 'agod-goal-dto.js','agod-objective.js','agod-phase.js','agod-survival.js'])require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline,Dto=globalThis.FlyAgodGoalDto,
 Objective=globalThis.FlyAgodObjective,Phase=globalThis.FlyAgodPhase,Survival=globalThis.FlyAgodSurvival;
const MODULES={Dto,Reward:globalThis.FlyAgodReward,Evidence:globalThis.FlyAgodEvidence,Ram:globalThis.FlyAgodRam};
const Observation=require('./realrom_observation.cjs');
const Stage=require(path.join(A,'agod-stage.js'));
const Explore=require(path.join(A,'agod-explore.js'));

const args=process.argv.slice(2);
const flag=name=>args.includes(name);
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS||!fs.existsSync(ROMS)){
 console.log('BLOCKED - AGOD_PRIVATE_ROMS is not set or does not exist. This check runs only on a '
  +'private corpus; no fixture is substituted and nothing is reported as passed.');
 process.exit(0);
}
const EXT={'.gen':'sega','.md':'sega','.bin':'sega','.smd':'sega','.nes':'nes','.sfc':'snes','.smc':'snes','.gb':'gb','.gbc':'gb'};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const BUILD={
 sega:async bytes=>PD.create({platform:'sega',romBytes:bytes,SegaConsole:require(path.join(A,'sega-core.js')),
  factory:require(path.join(A,'sega','genplus.js')),moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:1e10}),
 nes:async bytes=>PD.createNesSync({romBytes:bytes,jsnes,frameBudget:1e10}),
 snes:async bytes=>retroBuild('snes',bytes),gb:async bytes=>retroBuild('gb',bytes)};
function retroBuild(platform,bytes){
 let factory;try{factory=require(path.join(A,platform,'core.js'));}
 catch(error){return {status:'CORE_UNAVAILABLE',reason:'lab/'+platform+'/core.js is not built in this checkout'};}
 return PD.create({platform,romBytes:bytes,RetroConsole:require(path.join(A,'retro-core.js')),factory,
  moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,platform,'core.wasm')),locateFile:f=>path.join(A,platform,f)},frameBudget:1e10});
}
const TRAIN_STEPS=Number(process.env.REALROM_TRAIN_STEPS||2400),EVAL_STEPS=Number(process.env.REALROM_EVAL_STEPS||300),
 STEP_FRAMES=8,SEEDS=(process.env.REALROM_SEEDS||'11,23,37').split(',').map(Number);

function bridge(){
 const child=spawn(process.env.JAVA||'java',['-Xmx2g','-cp',process.env.CODE_CLASSPATH,
  'org.node.flyconsole.FdbGameBridge',...(process.env.FDB_GRAPH?[process.env.FDB_GRAPH]:[])],
  {stdio:['pipe','pipe',process.env.REALROM_BRIDGE_LOG?fs.openSync(process.env.REALROM_BRIDGE_LOG,'a'):'ignore']});
 const pending=[];
 readline.createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(p)p.resolve(JSON.parse(line));});
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error('Java bridge exited '+code));});
 return {call:q=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(q)+'\n');}),
  close:()=>child.stdin.end()};
}
/* the learner's eyes: 16 luminance cells, the format FdbGameBridge takes */
/* the retina is tools/realrom_observation.cjs (legacy-16 is the old function, unchanged) */
/* the action set, from the pad description: nothing, each direction, the two
   first action buttons, and direction + first button. Pause/menu buttons are
   not actions. */
function actionSet(spec){
 const name=n=>(spec.buttons.find(b=>b.name===n)||{}).mask||0;
 const dirs=['←','→','↑','↓'].map(name).filter(Boolean);
 const buttons=spec.buttons.filter(b=>!['Start','Select','Mode','←','→','↑','↓'].includes(b.name)).map(b=>b.mask);
 /* REALROM_NOOP=0 drops "press nothing": the production decision rule scores
    an action as the sum over its buttons of (rate/threshold - 1), so while
    the output neurons are quiet every button costs -1 and the empty mask wins
    the frozen argmax - measured: the trained layer stood still on both
    cartridges. */
 const out=[...(process.env.REALROM_NOOP==='0'?[]:[0]),...dirs,...buttons.slice(0,2)];
 for(const d of dirs)if(buttons[0])out.push(d|buttons[0]);
 return [...new Set(out)].slice(0,12);
}
/* COMPOSITE ACTIONS for the search (REALROM_EXPLORE_ACTIONS=composite): every stick
   position (none, 4 directions, 4 diagonals) with none, one or two of the k action
   buttons discovery attributed most progress to - from the pad description and the
   attribution only. The decision set below is capped at 16 for the learner and,
   measured on a private SNES run-and-gun, had no fire with a direction other than
   the attributed one and no jump with a direction. 9 x 7 = 63 for k = 3, within
   FDB's 64-action limit, so a route found with it can be distilled. */
function compositeActions(attribution,spec,k){
 const m=n=>(spec.buttons.find(b=>b.name===n)||{}).mask||0,dirNames=['←','→','↑','↓'];
 const dirs=[0,m('←'),m('→'),m('↑'),m('↓'),m('←')|m('↑'),m('→')|m('↑'),m('←')|m('↓'),m('→')|m('↓')];
 const btns=(attribution||[]).filter(b=>!dirNames.includes(b.name)&&!['Start','Select','Mode'].includes(b.name)&&spec.buttons.some(x=>x.name===b.name&&x.mask===b.mask))
  .sort((a,b)=>(b.gainLift||0)-(a.gainLift||0)).slice(0,k).map(b=>b.mask);
 const sets=[0,...btns];for(let i=0;i<btns.length;i++)for(let j=i+1;j<btns.length;j++)sets.push(btns[i]|btns[j]);
 const out=[];for(const d of dirs)for(const b of sets)out.push(d|b);return [...new Set(out)].slice(0,64);
}
/* REALROM_DECISION=agod: the decision prior from discovery, the same function the app uses */
const decisionPrior=(attribution,spec,weight)=>Objective.decisionPrior(attribution,spec,weight);
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}

async function studyRom(file,java){
 const bytes=fs.readFileSync(file);
 const platform=EXT[path.extname(file).toLowerCase()];
 const romSha256=sha(bytes);
 const report={romSha256,bytes:bytes.length,platform};
 const t0=Date.now();
 const built=await BUILD[platform](bytes);
 if(built.status!=='READY')return {...report,status:'CORE_UNAVAILABLE'};
 const d=built.driver;
 /* 1. into play, with nothing but the pad */
 const entry=Phase.enter(d,{});
 const presses={};for(const s of entry.steps)if(s.kind==='PRESS')presses[s.button]=(presses[s.button]||0)+1;
 report.entry={status:entry.status,frames:entry.frames,steps:entry.steps.length,
  waits:entry.steps.filter(s=>s.kind==='WAIT').length,presses,
  controlledAxes:entry.probe?entry.probe.controlledAxes:null,wallMs:Date.now()-t0};
 console.log('  entry: %s in %d frames, %d steps, presses %j',entry.status,entry.frames,entry.steps.length,presses);
 if(entry.status!=='PLAYING'){built.dispose();return {...report,status:'NOT_IN_PLAY'};}
 const inPlay=entry.snapshot;
 /* 2. the classic pipeline from the same state, for comparison */
 const config={romHash:romSha256,coreRevision:platform,profileRevision:'agod-realrom-1',contextKey:romSha256+'/'+platform};
 if(!flag('--no-baseline')){
  const f0=built.framesRun(),t1=Date.now();
  const classic=Pipeline.run(d,config);
  report.classic={status:classic.status,stage:classic.stage,frames:built.framesRun()-f0,wallMs:Date.now()-t1};
  console.log('  classic pipeline from play: %s at %s, %d frames',classic.status,classic.stage,report.classic.frames);
 }
 /* 3. survival discovery */
 d.restore(inPlay);
 const f1=built.framesRun(),t2=Date.now();
 const detectorRevision=Pipeline.PIPELINE_REVISION+'+'+Phase.PHASE_REVISION+'+'+Survival.SURVIVAL_REVISION;
 const found=Survival.discover(d,{...config,detectorRevision});
 report.survival={status:found.status,stage:found.stage,reason:found.reason||null,
  frames:built.framesRun()-f1,wallMs:Date.now()-t2,
  kind:found.judgement?found.judgement.kind:null,
  discoveryRuns:(found.discovered&&found.discovered.survival||[]).map(r=>({policy:r.policy,ended:r.terminal!==null,
   framesToEnd:r.terminal,lossesOfLife:r.losses})),
  verdicts:(found.verdicts||[]).map(v=>({group:v.group,outcome:v.outcome,losses:v.losses,linked:v.linked})),
  progressFields:found.discovered&&found.discovered.progressFields?found.discovered.progressFields.length:0,
  /* aggregate only - no address leaves the run */
  candidateKind:found.discovered&&found.discovered.resource?found.discovered.resource.kind:null,
  rareCells:found.discovered&&found.discovered.rareCells||null,
  authorityDrops:found.discovered&&found.discovered.authorityDrops||null};
 console.log('  survival: %s (%s) %d frames %d ms, progress fields %d',found.status,report.survival.kind,
  report.survival.frames,report.survival.wallMs,report.survival.progressFields);
 console.log('  candidate %s, rare cells %j, control-authority drops per run %j',report.survival.candidateKind,
  report.survival.rareCells,report.survival.authorityDrops);
 /* 4. the oracle, opened only now */
 const oraclePath=path.join(ROMS,'oracle.json');
 if(fs.existsSync(oraclePath)){
  const oracle=JSON.parse(fs.readFileSync(oraclePath,'utf8'))[romSha256];
  if(oracle){
   const chosen=found.resource?found.resource.address:null;
   const prog=(found.discovered&&found.discovered.progressFields||[]).flatMap(f=>Array.from({length:f.width},(_,k)=>f.address+k));
   report.oracle={resourceMatches:chosen!==null&&(oracle.resource||[]).includes(chosen),
    progressMatches:(oracle.progress||[]).length?(oracle.progress||[]).some(a=>prog.includes(a)):null,
    progressFieldsOutsideOracle:(found.discovered&&found.discovered.progressFields||[])
     .filter(f=>!Array.from({length:f.width},(_,k)=>f.address+k).some(a=>(oracle.progress||[]).includes(a))).length};
   console.log('  oracle (opened after the answer): resource %s, progress %s, %d progress field(s) outside the oracle',
    report.oracle.resourceMatches?'MATCH':'NO MATCH',report.oracle.progressMatches===null?'(no oracle)':report.oracle.progressMatches?'MATCH':'NO MATCH',report.oracle.progressFieldsOutsideOracle);
  }
 }
 /* 4b. a second player (--2p): can port 2 join on its own, and what does the
    game take from THAT player? Only a same/different bit about the two
    players' resources is reported. */
 if(flag('--2p')&&d.ports>=2){
  d.restore(inPlay);
  const before=Phase.probe(d,{port:2});
  const join=before.phase==='PLAYING'?{status:'PLAYING',frames:0,steps:[],snapshot:d.snapshot()}:Phase.enter(d,{port:2,maxSteps:20});
  const two={port2Before:before.phase,join:join.status,joinFrames:join.frames,
   joinPresses:join.steps.filter(x=>x.kind==='PRESS').map(x=>x.button)};
  if(join.status==='PLAYING'){
   d.restore(join.snapshot);
   two.port1AfterJoin=Phase.probe(d,{port:1}).phase;
   const f2=built.framesRun(),t3=Date.now();
   const p2=Survival.discover(d,{...config,detectorRevision,port:2});
   two.survival={status:p2.status,stage:p2.stage,kind:p2.judgement?p2.judgement.kind:null,frames:built.framesRun()-f2,wallMs:Date.now()-t3,
    verdicts:(p2.verdicts||[]).map(v=>({group:v.group,outcome:v.outcome}))};
   two.sameResourceAsPort1=p2.resource&&found.resource?p2.resource.address===found.resource.address:null;
   /* does the port-1 resource move when only port 2 plays? (shared pools) */
   if(found.resource){
    d.restore(join.snapshot);const pol=Survival.randomPolicy(d.actionSpec,77);const a=found.resource.address;
    const v0=d.readRam()[a];let moved=0;for(let t=0;t<3600;t+=8){d.run(0,8,pol(t));if(d.readRam()[a]<v0)moved=1;}
    two.port1ResourceFallsUnderPort2Play=!!moved;
   }
  }
  report.twoPlayer=two;
  console.log('  2P: port 2 %s -> join %s in %d frames (%j); port-2 survival %s %s; same resource as port 1: %s; port-1 resource falls under port-2 play: %s',
   two.port2Before,two.join,two.joinFrames||0,two.joinPresses,two.survival&&two.survival.status,two.survival&&two.survival.kind,
   two.sameResourceAsPort1,two.port1ResourceFallsUnderPort2Play);
 }
 /* 5. learning */
 if((java||Number(process.env.REALROM_EXPLORE)>0)&&found.status==='VERIFIED'){
  const dto=Dto.fromPipelineResult(found,{...config,platform,driverRevision:built.driverRevision});
  const identity={romSha256,platform,coreRevision:platform,detectorRevision,
   actionSpec:built.capabilities.actionSpec,padType:built.capabilities.padType,
   observedRamBytes:built.capabilities.observedRamBytes};
  const profile=Objective.createProfile(dto,identity,MODULES);
  report.profile={status:profile.status,reason:profile.reason||null,progress:profile.progress?profile.progress.length:0};
  /* FRONTIER ARCHIVE (REALROM_EXPLORE=frameBudget): AGOD exploration on this research
     copy - then the best route is replayed from a fresh load with no restore and the
     stage detector watching; only that replay can show a stage transition */
  if(profile.status==='PROFILE'&&Number(process.env.REALROM_EXPLORE)>0)
   report.explore=await exploreRoute(built,inPlay,profile,identity,{rebuild:()=>BUILD[platform](bytes),entrySteps:entry.steps,entryProbe:entry.probe});
  if(profile.status==='PROFILE'&&java)report.learning=await learn(built,inPlay,profile,identity,java,
   {rebuild:()=>BUILD[platform](bytes),entrySteps:entry.steps,entryProbe:entry.probe,inPlayHash:(d.restore(inPlay),d.stateHash())});
 }
 report.totalFrames=built.framesRun();report.totalWallMs=Date.now()-t0;
 built.dispose();
 return {...report,status:'DONE'};
}

/* LEVEL_CLEAR verification, opened only AFTER a run: AGOD_PRIVATE_ROMS/oracle.json may
   hold "stage": RAM offsets a human established by inspection as the stage number.
   VERIFIED needs the detector's STAGE_TRANSITION_CANDIDATE and every oracle stage byte
   one higher than at the start of play, the step taken inside the candidate's gap
   (stage values read per stride by the caller). Only the verdict leaves the run. */
function oracleStage(romSha256){const p=path.join(ROMS,'oracle.json');if(!fs.existsSync(p))return null;const e=JSON.parse(fs.readFileSync(p,'utf8'))[romSha256];return e&&Array.isArray(e.stage)&&e.stage.length?e.stage:null;}
/* every oracle stage byte: constant from the start of play to the gap, changes only
   inside the candidate's gap (several bytes may step at different frames of it -
   measured: two stage bytes stepped 96 frames apart inside one 664-frame gap), and
   ends exactly one higher, held to the end of the run */
function verifyLevelClear(stageTrace,transitions){
 if(!stageTrace)return {verdict:'NO_ORACLE'};if(!transitions.length)return {verdict:'UNVERIFIED',reason:'no stage transition candidate'};
 const start=stageTrace[0].values,t=transitions[0],lo=t.gapStart-16,hi=(t.decidedAt||t.frame)+16,last=stageTrace[stageTrace.length-1].values;
 let insideGap=true;const changed=start.map(()=>false);
 for(let k=1;k<stageTrace.length;k++)stageTrace[k].values.forEach((v,i)=>{if(v!==stageTrace[k-1].values[i]){changed[i]=true;if(stageTrace[k].frame<lo||stageTrace[k].frame>hi)insideGap=false;}});
 const plusOne=last.every((v,i)=>v===start[i]+1);
 if(!changed.some(Boolean))return {verdict:'REFUTED',reason:'the oracle stage bytes never changed'};
 return {verdict:plusOne&&insideGap?'VERIFIED':'REFUTED',stageAdvanced:plusOne,changesOnlyInsideGap:insideGap,heldToEnd:plusOne};
}

/* ===== M4-01 RECOVERY TEACHER (research copy only; never an evaluation) =====
   Perturbation spec REALROM_TEACHER: entries separated by ';', each a list of k=v:
   id, delay (idle frames before the first decision), at/len/kind/seed (an in-episode
   disturbance: from decision `at`, `len` decisions overridden - kind idle | wrong |
   hold). For each: the CURRENT frozen Male CNS policy plays from that origin on the
   research emulator, checkpointing emulator AND brain engine every 8 decisions. At a
   failure (a life lost, or REALROM_TEACHER_STALL decisions without progress) both
   roll back to a checkpoint >= REALROM_TEACHER_BACK decisions before it, and the AGOD
   frontier archive (composite actions, causal damage counters, no life may be lost)
   searches a correction FROM THAT STATE: alive past the failure point by BACK
   decisions, and no less progress than the policy had made. The correction is replayed
   from its own origin and checked before it is accepted; the brain then observes it
   (its activity continues exactly) and the policy resumes. A disturbance is never
   searched away: a correction starts after it. Every decision keeps its provenance:
   P policy, C correction, D disturbance. A state no correction was found for ends the
   trajectory as UNSOLVED. Finally the whole trajectory is replayed from a fresh load
   with the stage detector; the oracle is opened only then. Nothing is labelled with
   the reference route's action by assumption. */
function parsePerturbations(specText){
 return String(specText).split(';').map(x=>x.trim()).filter(Boolean).map((entry,i)=>{const o={id:'p'+i,delay:0,disturb:null};
  const kv=Object.fromEntries(entry.split(',').map(x=>x.split('=').map(y=>y.trim())));
  if(kv.id)o.id=kv.id;if(kv.delay)o.delay=Number(kv.delay);if(kv.engine)o.engine=Number(kv.engine);
  if(kv.at)o.disturb={at:Number(kv.at),len:Number(kv.len||4),kind:kv.kind||'idle',seed:Number(kv.seed||1)};
  return o;});
}
function packDriver(d){const zlib=require('zlib');return Object.assign(Object.create(d),{
 snapshot(){const s=d.snapshot();return s&&s.bytes?{...s,bytes:zlib.deflateRawSync(s.bytes,{level:1}),packed:true}:s;},
 restore(s){return d.restore(s&&s.packed?{...s,bytes:new Uint8Array(zlib.inflateRawSync(s.bytes)),packed:undefined}:s);}});}
async function recoveryTeacher(ctx){
 const {java,actions,profile,identity,extras,read,progressOf,floor,keyOptions,obsProbe,spec}=ctx;
 const OBS=process.env.REALROM_OBS||'legacy-16';
 const perts=parsePerturbations(process.env.REALROM_TEACHER);
 const exploreActions=compositeActions(profile.dto.discovered.buttonAttribution,spec,3);
 const dirMask=spec.buttons.filter(b=>['←','→','↑','↓'].includes(b.name)).reduce((m,b)=>m|b.mask,0);
 const horiz=[(spec.buttons.find(b=>b.name==='←')||{}).mask||0,(spec.buttons.find(b=>b.name==='→')||{}).mask||0];
 const BACK=Number(process.env.REALROM_TEACHER_BACK||16),STALL=Number(process.env.REALROM_TEACHER_STALL||400),
  BUDGET=Number(process.env.REALROM_TEACHER_BUDGET||300000),MAXS=Number(process.env.REALROM_TEACHER_MAX||6500),KEEP=24,MINIMAL=process.env.REALROM_TEACHER_MINIMAL==='1',
  REPLAY_ONLY=process.env.REALROM_TEACHER_REPLAY_ONLY==='1';
 const total=t=>t.value.reduce((a,v)=>a+(Number.isFinite(v)?v:0),0);
 const results=[];
 for(const p of perts){
  const t0=Date.now();
  const tb=await extras.rebuild(),td=tb.driver;Phase.replayEntry(td,extras.entrySteps);if(p.delay)td.run(0,p.delay);
  const dims=Observation.dims(tb.core)||[256,224];
  const tobs=Observation.create(OBS,tb.core,{probe:obsProbe,readRam:()=>td.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
  await java.call({op:'reset'});await java.call({op:'engineDrop'});
  const masks=[],kinds=[],corrections=[],accepted=[];const failures={loss:0,stall:0};let unsolved=null,searchFrames=0,slotSeq=0;
  /* damage counters the corrections' archives established causally; a fall in one of
     them (1..16) counts as progress for the stall clock, so a fight the policy is
     winning is not a stall - and a fight it only survives is one. */
  const knownCounters=new Set();
  let track=Explore.unwrapStep(null,progressOf(td.readRam())||[],true),best=total(track),lastGain=0;
  const ckpts=[];
  const saveCk=async()=>{const slot=++slotSeq;await java.call({op:'engineSave',slot});ckpts.push({stride:masks.length,emu:td.snapshot(),slot,track,best,lastGain});
   while(ckpts.length>KEEP+1){const x=ckpts.splice(1,1)[0];await java.call({op:'engineDrop',slot:x.slot});}};
  const dEnd=p.disturb?p.disturb.at+p.disturb.len:-1;
  const drng=rng((p.disturb?p.disturb.seed:1)*7919+13);
  const disturbMask=k=>p.disturb.kind==='idle'?0:p.disturb.kind==='hold'?(masks[k-1]||0):exploreActions[Math.floor(drng()*exploreActions.length)];
  const step=async(mask,kind)=>{const before=td.readRam();td.run(mask,STEP_FRAMES);masks.push(mask);kinds.push(kind);
   const after=td.readRam();track=Explore.unwrapStep(track,progressOf(after)||[],true);const pr=total(track);if(pr>best){best=pr;lastGain=masks.length;}
   for(const ad of knownCounters){const fl=before[ad]-after[ad];if(fl>0&&fl<=16){lastGain=masks.length;break;}}
   return {lost:read(after)<read(before),dead:read(after)<=floor};};
  /* stage clear check: the trajectory so far on a fresh load, with the detector */
  const stageCheck=async()=>{const vb=await extras.rebuild(),vd=vb.driver;Phase.replayEntry(vd,extras.entrySteps);if(p.delay)vd.run(0,p.delay);
   const mon=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const vdims=Observation.dims(vb.core)||[256,224];let k=0,at=-1;
   for(const m of masks){const b=vd.readRam();vd.run(m,STEP_FRAMES);const a=vd.readRam();k++;
    mon.observe({mask:m,ramBefore:b,ramAfter:a,signature:Stage.signature(vb.core.pixels,vdims[0],vdims[1]),scene:Stage.palette(vb.core.pixels,vdims[0],vdims[1])});
    if(at<0&&mon.transitions().length)at=k;}
   vb.dispose();return at;};
  await saveCk();let cleared=-1,nextCheck=3200,resumeStall=false,nextDump=500;
  const evDir=process.env.REALROM_EVIDENCE_DIR;
  const dump=(file,extra)=>{if(!evDir)return;fs.mkdirSync(evDir,{recursive:true});
   fs.writeFileSync(path.join(evDir,file),JSON.stringify(Object.assign({perturbation:p,entrySteps:extras.entrySteps,stepFrames:STEP_FRAMES,masks,kinds,corrections,accepted,unsolved},extra||{})));};
  /* RESUME (REALROM_TEACHER_RESUME=dir): a trajectory this teacher wrote before
     (teacher-<id>.json, else the periodic teacher-<id>.partial.json) is replayed on
     the research emulator with the brain observing every decision exactly as it did
     - legacy-16 is stateless and an engine restore is bit-exact, so emulator and
     brain reach the same state. It is cut where the CURRENT stall clock (progress
     or damage, never reset by a correction) runs out, or at a recorded UNSOLVED
     state; the teacher goes on live from there. */
  const resumeDir=process.env.REALROM_TEACHER_RESUME;
  if(resumeDir){const file=['teacher-'+p.id+'.json','teacher-'+p.id+'.partial.json'].map(f=>path.join(resumeDir,f)).find(f=>fs.existsSync(f));
   if(file){const prev=JSON.parse(fs.readFileSync(file,'utf8'));
    if(prev.perturbation.delay!==p.delay||JSON.stringify(prev.perturbation.disturb)!==JSON.stringify(p.disturb))throw new Error('resume: perturbation mismatch for '+p.id);
    let cut=prev.masks.length;if(prev.unsolved)cut=Math.min(cut,prev.unsolved.stride);
    if(process.env.REALROM_TEACHER_CUT)cut=Math.min(cut,Number(process.env.REALROM_TEACHER_CUT));
    /* REPLAY ONLY (REALROM_TEACHER_REPLAY_ONLY=1, diagnostics): no brain, no search - the
       recorded trajectory goes straight to the fresh-load verification below. */
    if(REPLAY_ONLY){masks.push(...prev.masks.slice(0,cut));kinds.push(...(prev.kinds||prev.masks.map(()=>'R')).slice(0,cut));cut=0;}
    const learnt=new Map();for(const c of prev.corrections||[])if(c.counters){const e=c.from+c.length;learnt.set(e,(learnt.get(e)||[]).concat(c.counters));}
    for(let n=0;n<cut;n++){if(masks.length%8===0&&masks.length>ckpts[ckpts.length-1].stride)await saveCk();
     await java.call({op:'decide',retina:tobs.observe(),train:false,actions,epsilon:0,windowMs:20});
     await step(prev.masks[n],prev.kinds[n]);for(const ad of learnt.get(masks.length)||[])knownCounters.add(ad);
     /* as live: the clock is read after policy and disturbance steps, not inside a correction */
     if(prev.kinds[n]!=='C'&&masks.length-lastGain>=STALL){resumeStall=true;break;}}
    for(const c of prev.corrections||[])if(c.from+c.length<=masks.length){corrections.push(c);failures[c.type]++;searchFrames+=c.searchFrames||0;}
    for(const a of prev.accepted||[])if(a.failure<=masks.length){accepted.push(a);failures[a.type]++;searchFrames+=a.searchFrames||0;}
    nextCheck=Math.max(3200,Math.ceil((masks.length+1)/400)*400);nextDump=Math.ceil((masks.length+1)/500)*500;
    console.log('  teacher %s: resumed %d of %d decisions from %s (%d corrections, %d accepted kept)%s',p.id,masks.length,prev.masks.length,path.basename(file),corrections.length,accepted.length,
     resumeStall?' - the stall clock runs out there':'');}}
  while(!REPLAY_ONLY&&masks.length<MAXS&&!unsolved){
   if(masks.length%8===0&&masks.length>ckpts[ckpts.length-1].stride)await saveCk();
   if(masks.length>=nextDump){nextDump+=500;dump('teacher-'+p.id+'.partial.json');}
   let o,stalled;
   if(resumeStall){resumeStall=false;o={lost:false,dead:false};stalled=true;}
   else{const k=masks.length;
    const r=await java.call({op:'decide',retina:tobs.observe(),train:false,actions,epsilon:0,windowMs:20});
    const inD=p.disturb&&k>=p.disturb.at&&k<dEnd;
    o=await step(inD?disturbMask(k):r.mask,inD?'D':'P');
    stalled=masks.length-lastGain>=STALL;}
   if(o.lost||stalled){
    const f=masks.length,type=o.lost?'loss':'stall';failures[type]++;
    const progAtF=best;
    const failState={emu:td.snapshot(),slot:900000+f};await java.call({op:'engineSave',slot:failState.slot});
    /* the checkpoint: >= BACK decisions before the failure (else the latest before it).
       A disturbance is never searched away: after one began, the correction starts at or
       after its end; before one, the correction may not reach into it. If the search
       fails, it ESCALATES to earlier checkpoints (~32 and ~64 decisions further back);
       if every attempt fails and lives remain, the loss is ACCEPTED - the game goes on
       after the respawn, and the BACK policy decisions that led to it are marked X
       (never labelled). Only a game over ends the trajectory as UNSOLVED. */
    const dAt=p.disturb?p.disturb.at:Infinity,afterD=f>dAt;
    const allowed=x=>x.stride<=f-1&&(!afterD||x.stride>=dEnd);
    const tries=[];{let lim=f-BACK;for(let attempt=0;attempt<3;attempt++){let c0=null;for(let i=ckpts.length-1;i>=0;i--)if(allowed(ckpts[i])&&ckpts[i].stride<=lim){c0=ckpts[i];break;}
      if(!c0&&attempt===0)for(let i=ckpts.length-1;i>=0;i--)if(allowed(ckpts[i])){c0=ckpts[i];break;}
      if(!c0||tries.includes(c0))break;tries.push(c0);lim=c0.stride-32;}}
    let c=null,goal=null,arch=null,maxLen=Infinity,needSurvive=0,needProg=0,startRes=0,triedFrames=0;
    for(const c0 of tries){
     td.restore(c0.emu);
     maxLen=!afterD&&Number.isFinite(dAt)?dAt-c0.stride:Infinity;
     startRes=read(td.readRam());needSurvive=Math.min(maxLen,f-c0.stride+BACK);needProg=Math.max(0,progAtF-c0.best)+(type==='stall'?16:0);
     arch=Explore.createArchive(packDriver(td),{actions:exploreActions,readProgress:progressOf,readResource:read,positionFields:keyOptions.positionFields,
      screen:()=>Stage.signature(tb.core.pixels,dims[0],dims[1]),seed:1000+results.length*97+corrections.length*7+tries.indexOf(c0),allowLoss:false,floor,
      damage:true,directionMask:dirMask,horizontalMasks:horiz,maxCells:6000,probeEvery:100});
     const base=arch.stats().bestProgress;
     const findGoal=()=>{let g=null;for(const cell of arch.cells().values())if(cell.resource>=startRes&&cell.trace.length>=needSurvive&&cell.progress-base>=needProg&&(!g||cell.progress>g.progress||(cell.progress===g.progress&&cell.trace.length<g.trace.length)))g=cell;return g;};
     for(let n=0;arch.stats().framesRun<BUDGET&&!goal;n++){arch.explore();if(n%5===4)goal=findGoal();}
     if(!goal)goal=findGoal();
     triedFrames+=arch.stats().framesRun;searchFrames+=arch.stats().framesRun;
     if(goal){c=c0;break;}
     console.log('  teacher %s: no correction from %d for the %s at %d (%d frames) - %s',p.id,c0.stride,type,f,arch.stats().framesRun,tries.indexOf(c0)<tries.length-1?'trying an earlier state':'no earlier state left');
    }
    if(!goal){
     /* nothing found: back to the failure state as it was, and accept the loss unless the game is over */
     if(o.dead){unsolved={stride:tries.length?tries[tries.length-1].stride:f,failure:f,type,searchFrames:triedFrames,reason:tries.length?'no correction from '+tries.length+' states':'no state after the disturbance to correct from'};
      console.log('  teacher %s: UNSOLVED %s at decision %d (game over; %d states tried, %d frames)',p.id,type,f,tries.length,triedFrames);break;}
     td.restore(failState.emu);await java.call({op:'engineRestore',slot:failState.slot});await java.call({op:'engineDrop',slot:failState.slot});
     for(let i=Math.max(0,f-BACK);i<f;i++)if(kinds[i]==='P')kinds[i]='X';
     accepted.push({failure:f,type,statesTried:tries.length,searchFrames:triedFrames});lastGain=masks.length;
     console.log('  teacher %s: %s at decision %d ACCEPTED (no correction from %d states, %d frames); %d decisions before it left unlabelled',p.id,type,f,tries.length,triedFrames,Math.min(BACK,f));
     continue;
    }
    await java.call({op:'engineDrop',slot:failState.slot});
    const corr=Array.from(goal.trace).slice(0,maxLen),counters=arch.damageCounters();
    /* independent replay of the correction from its own origin */
    td.restore(c.emu);let tr=c.track,alive=true,dmg=0;
    for(const m of corr){const b=td.readRam();td.run(m,STEP_FRAMES);const a=td.readRam();if(read(a)<startRes)alive=false;tr=Explore.unwrapStep(tr,progressOf(a)||[],true);
     let d0=0;for(const ad of counters){const fl=b[ad]-a[ad];if(fl>0&&fl<=16)d0+=fl;}dmg+=Math.min(d0,16);}
    const gained=total(tr)-total(c.track)+dmg;
    const verified=alive&&corr.length>=needSurvive&&gained>=needProg;
    if(!verified){unsolved={stride:c.stride,failure:f,type,reason:'correction did not replay'};console.log('  teacher %s: correction failed its replay',p.id);break;}
    /* accept: emulator and brain back to the checkpoint, the brain observes the correction */
    const policyTail=masks.slice(c.stride,c.stride+corr.length);let differs=0;for(let i=0;i<corr.length;i++)if(corr[i]!==policyTail[i])differs++;
    masks.length=c.stride;kinds.length=c.stride;td.restore(c.emu);await java.call({op:'engineRestore',slot:c.slot});
    while(ckpts.length&&ckpts[ckpts.length-1].stride>c.stride){const x=ckpts.pop();await java.call({op:'engineDrop',slot:x.slot});}
    track=c.track;best=c.best;lastGain=c.lastGain;
    /* MINIMAL INTERVENTION (REALROM_TEACHER_MINIMAL=1). An archive trace is one random
       sequence among the many that survive: measured, its actions carry 5.9 bits each,
       ~uniform over the 63 composite actions, so they are not a function of the state a
       readout could learn. Here, walking the verified correction, at every decision the
       brain's own choice is tried first, then the actions nearest to it (fewest buttons
       changed), each with the rest of the correction and the SAME acceptance test (alive,
       length, progress or damage); the archive's action is kept only where none passes.
       By induction the remaining correction stays valid at every step. Labels: P where
       the policy's own action passed, C where it had to change. */
    const pop=x=>{let n=0;for(;x;x&=x-1)n++;return n;};
    const checkFrom=(state,seq,dmgIn)=>{td.restore(state);let tr=track,dmgS=dmgIn;
     for(const m of seq){const b=td.readRam();td.run(m,STEP_FRAMES);const a=td.readRam();if(read(a)<startRes)return false;tr=Explore.unwrapStep(tr,progressOf(a)||[],true);
      let d0=0;for(const ad of counters){const fl=b[ad]-a[ad];if(fl>0&&fl<=16)d0+=fl;}dmgS+=Math.min(d0,16);}
     return total(tr)-total(c.track)+dmgS>=needMin;};
    /* the bar is the GAIN the verified correction itself made (progress + causal damage),
       not just the failure's minimum: measured, with the minimum a relabelled correction
       kept only the survival - at the end-of-level wall (scroll held until it falls) three
       trajectories then survived 7 000 decisions and never brought it down. */
    const needMin=Math.max(needProg,gained);
    let dmgA=0,minKept=0,minNear=0,minArchive=0,minChecks=0;
    for(let i=0;i<corr.length;i++){if(masks.length%8===0&&masks.length>ckpts[ckpts.length-1].stride)await saveCk();
     const r=await java.call({op:'decide',retina:tobs.observe(),train:false,actions,epsilon:0,windowMs:20});
     let pick=corr[i],kind='C';
     if(MINIMAL){
      if(r.mask===corr[i]){kind='P';minKept++;}
      else{const here=td.snapshot(),rest=corr.slice(i+1);
       const near=actions.filter(a=>a!==r.mask).map(a=>({a,d:pop(a^r.mask)})).filter(x=>x.d<=2).sort((x,y)=>x.d-y.d||x.a-y.a).slice(0,12).map(x=>x.a);
       let found=null;for(const a of [r.mask,...near]){if(a===corr[i]){found=a;break;}minChecks++;if(checkFrom(here,[a,...rest],dmgA)){found=a;break;}}
       if(found===null){minArchive++;}else{pick=found;if(found===r.mask){kind='P';minKept++;}else minNear++;}
       td.restore(here);}}
     const b=td.readRam();await step(pick,kind);const a=td.readRam();
     let d0=0;for(const ad of counters){const fl=b[ad]-a[ad];if(fl>0&&fl<=16)d0+=fl;}dmgA+=Math.min(d0,16);}
    if(MINIMAL)console.log('  teacher %s: minimal intervention - %d of %d correction decisions are the policy\'s own, %d nearest to it, %d the archive\'s (%d checks)',p.id,minKept,corr.length,minNear,minArchive,minChecks);
    /* the stall clock is NOT reset here: a correction that only survives leaves it
       running (measured: with the reset, a trajectory dodged the final boss for 1 000
       decisions without a stall, and never cleared). */
    for(const ad of counters)knownCounters.add(ad);
    corrections.push({from:c.stride,length:corr.length,failure:f,type,searchFrames:arch.stats().framesRun,damageCounters:counters.length,counters,actionsDifferingFromPolicy:differs,policyTailLength:policyTail.length,
     gained,minimal:MINIMAL?{policy:minKept,nearest:minNear,archive:minArchive,checks:minChecks,criterion:'gain'}:null});
    console.log('  teacher %s: %s at decision %d -> correction from %d, %d decisions, found in %d frames (verified)',p.id,type,f,c.stride,corr.length,arch.stats().framesRun);
    continue;
   }
   if(masks.length>=nextCheck){nextCheck+=400;const at=await stageCheck();if(at>0){cleared=at;
    const keep=Math.min(masks.length,at+64);masks.length=keep;kinds.length=keep;break;}}
  }
  /* final verification: fresh load, entry, the same delay, the whole trajectory, no restore */
  const vb=await extras.rebuild(),vd=vb.driver;Phase.replayEntry(vd,extras.entrySteps);if(p.delay)vd.run(0,p.delay);let vRestores=0;const vr=vd.restore.bind(vd);vd.restore=x=>{vRestores++;return vr(x);};
  const mon=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const vdims=Observation.dims(vb.core)||[256,224];
  const stageAddrs=oracleStage(identity.romSha256),stageTrace=[];if(stageAddrs)stageTrace.push({frame:0,values:stageAddrs.map(a=>vd.readRam()[a])});
  /* timeline (private evidence): every 250 decisions the unwrapped progress, the
     resource and the losses so far - where a trajectory stops advancing */
  let fr=0,losses=0,vtrack=Explore.unwrapStep(null,progressOf(vd.readRam())||[],true);const timeline=[];
  for(const m of masks){const b=vd.readRam();vd.run(m,STEP_FRAMES);fr+=STEP_FRAMES;const a=vd.readRam();if(read(a)<read(b))losses+=read(b)-read(a);
   vtrack=Explore.unwrapStep(vtrack,progressOf(a)||[],true);if((fr/STEP_FRAMES)%250===0)timeline.push([fr/STEP_FRAMES,Math.round(total(vtrack)),read(a),losses]);
   mon.observe({mask:m,ramBefore:b,ramAfter:a,signature:Stage.signature(vb.core.pixels,vdims[0],vdims[1]),scene:Stage.palette(vb.core.pixels,vdims[0],vdims[1])});
   if(stageAddrs)stageTrace.push({frame:fr,values:stageAddrs.map(x=>a[x])});}
  const transitions=mon.transitions(),verdict=verifyLevelClear(stageAddrs?stageTrace:null,transitions);vb.dispose();tb.dispose();
  await java.call({op:'engineDrop'});
  const count=kd=>kinds.filter(x=>x===kd).length;
  const traceSha=crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(masks).buffer)).digest('hex');
  const res={id:p.id,delay:p.delay,disturb:p.disturb,decisions:masks.length,policyDecisions:count('P'),correctionDecisions:count('C'),disturbanceDecisions:count('D'),
   corrections:corrections.length,acceptedLosses:accepted.length,unlabelledBeforeAcceptedLoss:count('X'),failures,unsolved,searchFrames,replay:{freshLoad:true,restores:vRestores,losses,transitions:transitions.map(e=>({frame:e.frame,gapFrames:e.gapFrames,novelty:e.novelty})),timeline},
   levelClear:verdict.verdict,levelClearOracle:verdict,traceSha256:traceSha,wallSeconds:Math.round((Date.now()-t0)/1000)};
  results.push(res);
  if(evDir&&!REPLAY_ONLY){dump('teacher-'+p.id+'.json',{traceSha256:traceSha,levelClear:verdict.verdict});try{fs.unlinkSync(path.join(evDir,'teacher-'+p.id+'.partial.json'));}catch(e){}}
  console.log('  TEACHER %s (delay %d%s): %d decisions = %d policy (+%d unlabelled) + %d correction + %d disturbance; %d corrections, %d losses accepted, failures %j, unsolved %s | replay: restores %d, losses %d, transitions %d -> %s | %d s',
   p.id,p.delay,p.disturb?', disturb '+p.disturb.kind+'@'+p.disturb.at+'x'+p.disturb.len:'',masks.length,res.policyDecisions,count('X'),res.correctionDecisions,res.disturbanceDecisions,corrections.length,accepted.length,failures,
   unsolved?unsolved.type+'@'+unsolved.failure:'none',vRestores,losses,transitions.length,verdict.verdict,res.wallSeconds);
 }
 return results;
}

async function exploreRoute(built,inPlay,profile,identity,extras){
 const d=built.driver,spec=d.actionSpec;
 const prior=decisionPrior(profile.dto.discovered&&profile.dto.discovered.buttonAttribution,spec,0);
 const actions=process.env.REALROM_EXPLORE_ACTIONS==='composite'?compositeActions(profile.dto.discovered&&profile.dto.discovered.buttonAttribution,spec,3)
  :prior?prior.actions:actionSet(spec);
 console.log('  explore: %d actions (%s), selection %s',actions.length,process.env.REALROM_EXPLORE_ACTIONS==='composite'?'composite':'decision set',process.env.REALROM_EXPLORE_SELECT||'frontier');
 const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'explore',policy:'aggressive'});
 const read=live.read,progressOf=live.readProgress,budget=Number(process.env.REALROM_EXPLORE);
 const positionFields=(extras.entryProbe&&extras.entryProbe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0]);
 const dims=()=>Observation.dims(built.core)||[256,224];
 d.restore(inPlay);
 /* the archive keeps a savestate per cell: 823 KB each on SNES, about 39 KB after
    a level-1 deflate (~1 ms) - measured: 9 600 uncompressed cells ran this
    process out of memory. REALROM_EXPLORE_CELLS bounds the archive (default 20 000). */
 const zlib=require('zlib');
 const packed=Object.assign(Object.create(d),{
  snapshot(){const s=d.snapshot();return s&&s.bytes?{...s,bytes:zlib.deflateRawSync(s.bytes,{level:1}),packed:true}:s;},
  restore(s){return d.restore(s&&s.packed?{...s,bytes:new Uint8Array(zlib.inflateRawSync(s.bytes)),packed:undefined}:s);}});
 const archive=Explore.createArchive(packed,{actions,readProgress:progressOf,readResource:read,positionFields,
  maxCells:Number(process.env.REALROM_EXPLORE_CELLS||20000),select:process.env.REALROM_EXPLORE_SELECT||'frontier',damage:process.env.REALROM_EXPLORE_DAMAGE==='1',directionMask:spec.buttons.filter(b=>['←','→','↑','↓'].includes(b.name)).reduce((m,b)=>m|b.mask,0),
  horizontalMasks:[(spec.buttons.find(b=>b.name==='←')||{}).mask||0,(spec.buttons.find(b=>b.name==='→')||{}).mask||0],
  screen:()=>{const [w,h]=dims();return Stage.signature(built.core.pixels,w,h);},seed:Number(process.env.REALROM_EXPLORE_SEED||1),
  allowLoss:process.env.REALROM_EXPLORE_LOSS==='1',floor:profile.dto.discovered.resource.floor,
  ...(process.env.REALROM_EXPLORE_LIFE?{lifeWeight:Number(process.env.REALROM_EXPLORE_LIFE)}:{})});
 if(process.env.REALROM_EXPLORE_SEED_ROUTE){const seed=JSON.parse(fs.readFileSync(process.env.REALROM_EXPLORE_SEED_ROUTE,'utf8'));
  if(JSON.stringify(seed.entrySteps)!==JSON.stringify(extras.entrySteps))throw Error('the seed route was found from another entry');
  const r=archive.seedRoute(seed.masks);console.log('  explore: seeded with a %d-stride route (%d cells), best progress %d',r.strides,r.added,archive.stats().bestProgress);}
 const t0=Date.now();let lastLog=0;
 /* SIGUSR2: write the current best route now (private evidence dir) */
 let dumpNow=false;const onDump=()=>{dumpNow=true;};process.on('SIGUSR2',onDump);
 while(archive.stats().framesRun<budget){
  archive.explore();
  if(dumpNow&&process.env.REALROM_EVIDENCE_DIR){dumpNow=false;const b=archive.best(),st0=archive.stats();fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
   fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'explore-route-partial.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:8,masks:b.trace,progress:b.progress,resource:b.resource,framesRun:st0.framesRun}));
   console.log('  explore: best route written on request (progress %d, %d strides)',b.progress,b.trace.length);}
  const st=archive.stats();
  if(st.framesRun-lastLog>=budget/20){lastLog=st.framesRun;
   console.log('  explore: %d frames, %d cells (%d evicted), %d explorations, best progress %d (resource %s, route %d strides) %d s, rss %d MiB, frontier by resource %j, damage counters %d (%d probes)',
    st.framesRun,st.cells,st.evicted,st.explorations,st.bestProgress,st.bestResource,st.bestTraceLength,Math.round((Date.now()-t0)/1000),Math.round(process.memoryUsage().rss/1048576),st.frontierByResource,st.damageCounters,st.probes);
   /* the current best route, private, so it can be checked before the budget ends */
   if(process.env.REALROM_EVIDENCE_DIR){const b=archive.best();fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'explore-route-partial.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:8,masks:b.trace,progress:b.progress,resource:b.resource,framesRun:st.framesRun}));}}
 }
 process.removeListener('SIGUSR2',onDump);
 const best=archive.best(),st=archive.stats();
 /* the route, replayed from a freshly loaded cartridge: entry without restore, then
    the trace stride by stride, the stage detector watching - no snapshot anywhere */
 const fresh=await extras.rebuild(),fd=fresh.driver;let restores=0;
 Phase.replayEntry(fd,extras.entrySteps);const realRestore=fd.restore.bind(fd);fd.restore=x=>{restores++;return realRestore(x);};
 const monitor=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});
 const fdims=Observation.dims(fresh.core)||[256,224];let progress=0,losses=0,framesDone=0;
 const stageAddrs=oracleStage(identity.romSha256),stageTrace=[];if(stageAddrs)stageTrace.push({frame:0,values:stageAddrs.map(a=>fd.readRam()[a])});
 for(const mask of best.trace){const before=fd.readRam();fd.run(mask,8);const after=fd.readRam();
  const pb=progressOf(before),pa=progressOf(after);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
  if(read(after)<read(before))losses+=read(before)-read(after);
  if(monitor)monitor.observe({mask,ramBefore:before,ramAfter:after,signature:Stage.signature(fresh.core.pixels,fdims[0],fdims[1]),scene:Stage.palette(fresh.core.pixels,fdims[0],fdims[1])});
  framesDone+=8;if(stageAddrs)stageTrace.push({frame:framesDone,values:stageAddrs.map(a=>after[a])});}
 const transitions=monitor?monitor.transitions():[];
 const levelClearCheck=verifyLevelClear(stageAddrs?stageTrace:null,transitions);
 fresh.dispose();
 if(process.env.REALROM_EVIDENCE_DIR){fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
  fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'explore-route.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:8,masks:best.trace,events:monitor?monitor.events():[]}));}
 const out={revision:Explore.EXPLORE_REVISION,budgetFrames:budget,cells:st.cells,explorations:st.explorations,framesRun:st.framesRun,
  wallSeconds:Math.round((Date.now()-t0)/1000),bestProgress:st.bestProgress,routeStrides:best.trace.length,routeFrames:best.trace.length*8,
  replay:{freshLoad:true,restores,progress,losses,stageTransitions:transitions.map(e=>({frame:e.frame,gapFrames:e.gapFrames,novelty:e.novelty}))},
  routeSha256:crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(best.trace).buffer)).digest('hex'),
  levelClear:transitions.length?'ROUTE_REACHES_A_STAGE_TRANSITION (search, not autonomous play)':'NOT_REACHED',levelClearOracle:levelClearCheck};
 console.log('  explore result: %d cells, best progress %d, route %d frames; replayed from a fresh load (restores %d): progress %d, losses %d, stage transitions %d -> %s; oracle (opened after the run): %s',
  out.cells,out.bestProgress,out.routeFrames,restores,progress,losses,transitions.length,out.levelClear,levelClearCheck.verdict);
 return out;
}

async function learn(built,inPlay,profile,identity,java,extras){
 const d=built.driver,spec=d.actionSpec,core=built.core;
 const prior=process.env.REALROM_DECISION==='agod'
  ?decisionPrior(profile.dto.discovered&&profile.dto.discovered.buttonAttribution,spec,Number(process.env.REALROM_PRIOR||2)):null;
 let actions=prior?prior.actions:actionSet(spec);
 /* a route to distil may use actions outside the decision set (a composite search):
    the brain's action set then also holds every action the route takes (<= 128, FdbLearning.ACTION_LIMIT) */
 if(process.env.REALROM_DISTILL){const used=[...new Set(JSON.parse(fs.readFileSync(process.env.REALROM_DISTILL,'utf8')).masks)];
  actions=[...new Set([...actions,...used])];if(actions.length>128)throw Error('the route uses more actions than FDB decides between');}
 /* M4-02: a training set of several trajectories - the brain's action set holds every
    action any of them takes. REALROM_ACTIONS_FROM adds the actions of further files
    (an evaluation of a checkpoint trained on them must decide between the same set). */
 for(const f of [...String(process.env.REALROM_TRAINSET||'').split(';'),...String(process.env.REALROM_ACTIONS_FROM||'').split(';')].filter(Boolean)){
  actions=[...new Set([...actions,...JSON.parse(fs.readFileSync(f,'utf8')).masks])];if(actions.length>128)throw Error('the training set uses more actions than FDB decides between');}
 /* REALROM_CREDIT_PROFILE=dual-time-v1: two eligibility traces by game time
    (15 / 90 frames). REALROM_PAUSE=1: an interval in which the passive
    control-authority tracker says the player had no control joins the traces
    as a PAUSE (decay, nothing added) instead of a carry. */
 const creditProfile=process.env.REALROM_CREDIT_PROFILE||null;
 const pauseOnDrop=process.env.REALROM_PAUSE==='1';
 d.restore(inPlay);
 const authorityProbe=pauseOnDrop?Phase.probe(d):null;
 /* REALROM_READOUT=action-v1 (P2): every action, "press nothing" included,
    gets a learned score from the verified outcomes (FdbLearning readout) */
 const readoutProfile=process.env.REALROM_READOUT||'none';
 let brainIdentity=null;
 const init=async seed=>{const id=await java.call({op:'init',seed,mode:'base'});
  brainIdentity={model:id.model,label:id.label,ports:id.ports,neurons:id.neurons,graphSha:id.graphSha,stimulated:id.stimulated,sensorProfile:id.sensorProfile||null};
  if(creditProfile)await java.call({op:'credit',profile:creditProfile});
  if(readoutProfile!=='none')await java.call({op:'readout',profile:readoutProfile});
  if(prior)for(const p of prior.priors)if(p.weight>0)await java.call({op:'prior',output:p.output,weight:p.weight});};
 const read=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe',policy:'aggressive'}).read;
 const progressOf=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe2',policy:'aggressive'}).readProgress;
 const floor=profile.dto.discovered.resource.floor;
 /* starts of separate origin: training from seeds 1000+, evaluation from 5000+ */
 const starts=(base,count)=>{const out=[];for(let k=0;k<count;k++){
  d.restore(inPlay);const p=Survival.randomPolicy(spec,base+k);for(let t=0;t<120+40*k;t+=8)d.run(p(t),8);
  out.push(d.snapshot());}return out;};
 const trainStarts=starts(1000,4),evalStarts=starts(5000,3);
 const ended=ram=>read(ram)<=floor;
 /* REWIND FAN (REALROM_REWIND=K, training only). At a VERIFIED loss of life
    the research copy of the emulator returns to the state REALROM_REWIND_BACK
    frames earlier and runs K branches. Each branch's first decision is the
    agent's own policy choosing among the actions NOT yet tried from that state
    (the one the original trajectory took is excluded); the branch then plays
    on with the policy for up to twice the rewind distance or until a loss.
    Everything a branch executes is an ordinary training interval from a
    snapshot - observed after the restore, paid only through the live
    objective: a branch that dies pays its verified loss, a branch that does
    not pays nothing for the death it avoided. Branch steps count against the
    same training budget. The pair (original lost / branch did not) is counted
    as evidence, not as reward. Never in evaluation, never in a person's game. */
 const REWIND=Math.max(0,Number(process.env.REALROM_REWIND||0)|0);
 const BACK_STEPS=Math.max(1,Math.round(Number(process.env.REALROM_REWIND_BACK||96)/STEP_FRAMES));
 const BRANCH_STEPS=2*BACK_STEPS;
 /* PAYMENT BUDGET (REALROM_BUDGET=x): provisional progress paid between two
    verified events is capped at x (a loss of life pays -1); past it a gain is
    UNKNOWN - carried, unpaid. agod-objective.js createLiveReward. */
 const BUDGET=process.env.REALROM_BUDGET!==undefined&&process.env.REALROM_BUDGET!==''?Number(process.env.REALROM_BUDGET):null;
 /* OBSERVATION ENCODER (REALROM_OBS=legacy-16|motion-16|fused-16, P1):
    tools/realrom_observation.cjs. Its revision is part of the policy's
    identity in the report; positions come only from the causal probe. */
 const OBS=process.env.REALROM_OBS||'legacy-16';
 d.restore(inPlay);
 const obsProbe=OBS==='fused-16'?Phase.probe(d):null;
 const observer=Observation.create(OBS,core,{probe:obsProbe,readRam:()=>d.readRam(),readResource:ram=>read(ram),
  initialResource:profile.dto.discovered.resource.initial});
 /* the learner's whole state, for "frozen means frozen" */
 const learnerDigest=st=>crypto.createHash('sha256').update(JSON.stringify([st.weights,st.learningState,st.rng,st.updates,
  st.baseUpdates,st.neuronUpdates,st.born,st.pruned,st.deltas,st.edges,st.thresholdParameters,st.pending,st.layerBytesEstimate])).digest('hex');
 /* one executed interval: run, observe, pay or carry */
 async function step(pick,train,live,stats,authority){
  const before=d.readRam();
  d.run(pick.mask,STEP_FRAMES);
  const after=d.readRam();
  const rb=read(before),ra=read(after),lost=ra<rb?rb-ra:0;
  const pb=progressOf(before),pa=progressOf(after);let gained=0;
  for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])gained+=pa[i]-pb[i];
  /* the tracker sees every stride, so a run of ignored commands is never
     stitched across strides it did not look at */
  const noControl=authority?authority.observe(pick.mask,before,after).dropped:false;
  let packet=null;
  if(train&&live){
   stats.frame+=STEP_FRAMES;
   packet=live.observe({ramBefore:before,ramAfter:after,endFrame:stats.frame,requestedMask:pick.mask,
    executed:{mask:pick.mask,frames:STEP_FRAMES,complete:true,manualOverride:false},phase:'PLAYING'});
   if(packet.status==='VERIFIED'||packet.status==='PROVISIONAL'){
    stats[packet.status]++;
    if(packet.status==='PROVISIONAL')stats.provisionalPaid=(stats.provisionalPaid||0)+packet.value;
    /* typed credit: a PROVISIONAL gain reaches the learner as PROVISIONAL and does not train it */
    const r=await java.call({op:'reward',id:pick.id,mask:pick.mask,reward:packet.value,tier:packet.status,seconds:STEP_FRAMES/60,frames:STEP_FRAMES});
    stats.changed+=r.changed;
   }else if(process.env.REALROM_CREDIT==='carry'&&packet.status==='UNKNOWN'){
    /* no verified event: the decision joins the eligibility traces, nothing is
       paid - or, with no control, the traces only decay */
    stats.unknown++;
    if(/budget/.test(packet.reason||''))stats.overBudget=(stats.overBudget||0)+1;
    const c=await java.call({op:'carry',id:pick.id,mask:pick.mask,seconds:STEP_FRAMES/60,frames:STEP_FRAMES,accumulate:!noControl});
    if(c.accepted)stats[noControl?'paused':'carried']=(stats[noControl?'paused':'carried']||0)+1;
   }else{stats.unknown++;await java.call({op:'boundary'});}
  }
  return {after,lost,gained,packet};
 }
 async function fan(ring,choose,live,stats,budget){
  const origin=ring[0],here=d.snapshot();
  const tried=new Set([origin.mask]);let used=0;
  stats.rewinds=(stats.rewinds||0)+1;
  for(let b=0;b<REWIND&&used<budget;b++){
   const others=actions.filter(a=>!tried.has(a));if(others.length<2)break;
   d.restore(origin.snapshot);observer.reset();await java.call({op:'boundary'});
   let lost=false;
   for(let h=0;h<BRANCH_STEPS&&used<budget;h++){
    const pick=await choose(h===0?others:null);if(h===0)tried.add(pick.mask);
    const r=await step(pick,true,live,stats,null);used++;
    if(r.lost){lost=true;break;}
    if(ended(r.after))break;
   }
   stats.branches=(stats.branches||0)+1;stats[lost?'branchLost':'branchSurvived']=(stats[lost?'branchLost':'branchSurvived']||0)+1;
  }
  stats.branchSteps=(stats.branchSteps||0)+used;
  d.restore(here);observer.reset();await java.call({op:'boundary'});
  return used;
 }
 async function episode(start,choose,train,steps,live,stats){
  d.restore(start);d.run(0,1);observer.reset();
  let n=0,losses=0,progress=0,extra=0;
  const authority=pauseOnDrop&&authorityProbe?Survival.authorityTracker(authorityProbe):null;
  const ring=[];
  for(;n+extra<steps;n++){
   const rewinding=train&&live&&REWIND>0;
   if(rewinding){ring.push({snapshot:d.snapshot(),mask:null});if(ring.length>BACK_STEPS)ring.shift();}
   const pick=await choose(null);
   if(rewinding)ring[ring.length-1].mask=pick.mask;
   const r=await step(pick,train,live,stats,authority);
   losses+=r.lost;progress+=r.gained;
   if(ended(r.after)){n++;break;}
   if(rewinding&&r.packet&&r.packet.status==='VERIFIED'&&r.packet.value<0&&ring.length===BACK_STEPS){
    extra+=await fan(ring,choose,live,stats,steps-n-1-extra);ring.length=0;
   }
  }
  return {steps:n,extraSteps:extra,frames:n*STEP_FRAMES,losses,progress};
 }
 const rows=[];
 for(const seed of SEEDS){
  /* evaluated twice, both FROZEN: argmax (what the app's frozen mode does)
     and sampled from the layer's own policy. The sampled draws come from the
     harness's own seeded stream (decide train:false, sample:u), so the learner
     takes no RNG step and keeps no pending decision during evaluation: the
     whole learner state is compared before and after, not just the weights. */
  const brain=(train,sampled,stream)=>async only=>{const r=await java.call({op:'decide',retina:observer.observe(),train,actions:only||actions,
   epsilon:train?.1:0,windowMs:20,...(sampled?{sample:stream()}:{})});return {mask:r.mask,id:r.id};};
  const evaluate=async make=>{const out=[];for(const s of evalStarts)out.push(await episode(s,make(),false,EVAL_STEPS,null,null));return out;};
  const sampledBrain=()=>{const stream=rng(seed*7919+5);return brain(false,true,stream);};
  await init(seed);
  const freshBefore=learnerDigest(await java.call({op:'state'}));
  const untrained=await evaluate(()=>brain(false,false));
  const untrainedSampled=await evaluate(sampledBrain);
  const freshAfter=learnerDigest(await java.call({op:'state'}));
  await init(seed);
  const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'realrom-'+seed,policy:'aggressive',
   ...(BUDGET!==null?{provisionalBudget:BUDGET}:{})});
  const stats={VERIFIED:0,PROVISIONAL:0,unknown:0,changed:0,frame:0};
  let done=0,k=0;
  while(done<TRAIN_STEPS){const e=await episode(trainStarts[k++%trainStarts.length],brain(true,false),true,TRAIN_STEPS-done,live,stats);done+=e.steps+e.extraSteps;await java.call({op:'boundary'});}
  await java.call({op:'reset'});
  const frozenBefore=await java.call({op:'state'});
  const trained=await evaluate(()=>brain(false,false));
  const trainedSampled=await evaluate(sampledBrain);
  const frozenAfter=await java.call({op:'state'});
  const r=rng(seed);const random=await evaluate(()=>async()=>({mask:actions[Math.floor(r()*actions.length)],id:null}));
  const sum=(list,key)=>list.reduce((s,x)=>s+x[key],0);
  /* per evaluation: survival, deaths, progress summed and the best single
     episode (the furthest point one frozen run reached), frames played. No
     stage-clear detector exists yet, so no row can claim a level: UNVERIFIED. */
  const evalRow=list=>({survivalSteps:sum(list,'steps'),frames:sum(list,'frames'),losses:sum(list,'losses'),
   progress:sum(list,'progress'),bestEpisodeProgress:Math.max(...list.map(x=>x.progress)),
   levelClear:'UNVERIFIED',levelClearEvidence:null});
  const before=learnerDigest(frozenBefore),after=learnerDigest(frozenAfter);
  const row={seed,trainSteps:TRAIN_STEPS,trainFrames:stats.frame,verified:stats.VERIFIED,provisional:stats.PROVISIONAL,unknown:stats.unknown,
   provisionalPaid:+(stats.provisionalPaid||0).toFixed(3),overBudget:stats.overBudget||0,
   rewinds:stats.rewinds||0,branches:stats.branches||0,branchLost:stats.branchLost||0,branchSurvived:stats.branchSurvived||0,branchSteps:stats.branchSteps||0,
   nativeChanges:stats.changed,carried:stats.carried||0,paused:stats.paused||0,readoutUpdates:frozenAfter.readoutUpdates||0,
   frozenClean:before===after&&freshBefore===freshAfter,weightsChangedInEval:frozenBefore.weights!==frozenAfter.weights,
   learnerStateDigestEval:before===after?before.slice(0,16):'CHANGED',
   untrained:evalRow(untrained),trained:evalRow(trained),random:evalRow(random),
   untrainedSampled:evalRow(untrainedSampled),trainedSampled:evalRow(trainedSampled)};
  rows.push(row);
  console.log('  seed %d: verified %d provisional %d native changes %d | survival steps untrained %d trained %d random %d | losses %d/%d/%d | progress %d/%d/%d',
   seed,row.verified,row.provisional,row.nativeChanges,row.untrained.survivalSteps,row.trained.survivalSteps,row.random.survivalSteps,
   row.untrained.losses,row.trained.losses,row.random.losses,row.untrained.progress,row.trained.progress,row.random.progress);
  console.log('          sampled: survival untrained %d trained %d | losses %d/%d | progress %d/%d',
   row.untrainedSampled.survivalSteps,row.trainedSampled.survivalSteps,row.untrainedSampled.losses,row.trainedSampled.losses,
   row.untrainedSampled.progress,row.trainedSampled.progress);
  console.log('          train frames %d, provisional paid %s (over budget %d), rewinds %d: branches %d lost %d survived %d (%d steps) | frozen %s',
   row.trainFrames,row.provisionalPaid,row.overBudget,row.rewinds,row.branches,row.branchLost,row.branchSurvived,row.branchSteps,row.frozenClean?'clean':'CHANGED');
 }
 /* FULL EPISODE (REALROM_FULL_EPISODE=maxFrames, directive M2.2): the last trained
    learner, FROZEN, plays one continuous episode on a freshly loaded cartridge -
    entry replayed without any restore (Phase.replayEntry; the state hash must
    equal the original start), no snapshot, no rewind, no restore during play
    (counted), until the game ends or the frame cap. The stage detector watches
    every stride; the action trace (and the frames around a detected transition)
    go to REALROM_EVIDENCE_DIR - private, never the repository. */
 let fullEpisode=null;
 if(Number(process.env.REALROM_FULL_EPISODE)>0&&extras){
  const maxFrames=Number(process.env.REALROM_FULL_EPISODE),sampled=process.env.REALROM_FULL_POLICY==='sampled';
  /* DISTILLATION (REALROM_DISTILL=route.json, directive section 6 stage C): FDB's skill
     memory learns a route AGOD found - only after the route, replayed on its own
     freshly loaded cartridge with no restore, gave the same entry and ran; the
     demonstrations are (state key, action) along that replay. Keys: the archive's
     cell + dwell (agod-explore.js), from what AGOD sees. */
  let distill=null,routeKeys=null,routeMasks=null,firstOffRoute=null,populationInfo=null;const routeActivity=[];const keyOptions={readProgress:progressOf,readResource:ram=>read(ram),
   positionFields:(extras.entryProbe&&extras.entryProbe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0])};
  if(process.env.REALROM_DISTILL){
   const route=JSON.parse(fs.readFileSync(process.env.REALROM_DISTILL,'utf8'));routeMasks=route.masks;
   if(JSON.stringify(route.entrySteps)!==JSON.stringify(extras.entrySteps))throw Error('the route was found from another entry');
   const rb=await extras.rebuild(),rd=rb.driver;let rRestores=0;Phase.replayEntry(rd,extras.entrySteps);const routeEntryHash=rd.stateHash();const rr=rd.restore.bind(rd);rd.restore=x=>{rRestores++;return rr(x);};
   const keyer=Explore.createKeyer(keyOptions),rdims=Observation.dims(rb.core)||[256,224],steps=[];
   for(const mask of route.masks){steps.push([keyer.key(rd.readRam(),Stage.signature(rb.core.pixels,rdims[0],rdims[1])),mask]);rd.run(mask,STEP_FRAMES);}
   rb.dispose();
   /* REALROM_LOAD_CHECKPOINT=path: the learner (readout, population, dataset identity)
      from a private file written by REALROM_SAVE_CHECKPOINT - no distillation passes */
   const loadPath=process.env.REALROM_LOAD_CHECKPOINT;
   if(loadPath){const ld=await java.call({op:'loadCheckpoint',path:loadPath});
    distill={loaded:true,readout:ld.readoutProfile,population:{neurons:ld.population},dataset:ld.dataset,routeStrides:route.masks.length,routeEntrySameState:routeEntryHash===extras.inPlayHash};
    console.log('  learner loaded from a private checkpoint: readout %s, population %d, dataset %s',ld.readoutProfile,ld.population,ld.dataset);}
   else if(process.env.REALROM_TRAINSET){
    /* M4-02 MULTI-TRAJECTORY DISTILLATION: every training trajectory replayed from its own
       origin (fresh load, entry, its start delay; its disturbance decisions are in its
       trace) with the brain observing. The population is chosen from the UNION of their
       activity statistics; the readout is fitted to every decision labelled R (reference
       route), P (the policy's own, kept) or C (a verified AGOD correction) - never D (an
       injected disturbance) and nothing by assumption. W0 and the plastic layer unchanged. */
    /* an entry may end in *k (k=2..4): its demonstrations enter the fit k times - a
       stated weight, part of the dataset identity */
    const set=process.env.REALROM_TRAINSET.split(';').filter(Boolean).map(e=>{const wm=/\*([2-4])$/.exec(e),f=wm?e.slice(0,-2):e,weight=wm?Number(wm[1]):1;const t=JSON.parse(fs.readFileSync(f,'utf8'));
     if(JSON.stringify(t.entrySteps)!==JSON.stringify(extras.entrySteps))throw Error('a training trajectory was made from another entry');
     return {id:t.perturbation?t.perturbation.id:'reference',delay:t.perturbation?t.perturbation.delay||0:0,disturb:t.perturbation?t.perturbation.disturb:null,
      weight,masks:t.masks,kinds:t.kinds||t.masks.map(()=>'R'),sha:crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(t.masks).buffer)).digest('hex')};})
    /* REALROM_TRAIN_ENGINE_SEEDS=a,b,..: every trajectory is replayed once per engine
       seed (the Poisson input stream). The labels are game actions verified on the
       emulator, valid whatever the brain's noise; a readout that has to meet them under
       several streams cannot use one stream as a clock. */
    .flatMap(t=>{const es=(process.env.REALROM_TRAIN_ENGINE_SEEDS||'').split(',').map(Number).filter(x=>x>0);
     return es.length?es.map(e=>Object.assign({},t,{id:t.id+'@'+e,engine:e})):[t];});
    /* every pass runs in its own worker bridge (REALROM_WORKERS, default 4; same engine
       seed, the same reset per trajectory - the activity is the same as in one bridge);
       statistics and demonstrations come back through private files, demonstrations
       loaded in trajectory order so the fit is deterministic */
    const tmpBase=process.env.REALROM_EVIDENCE_DIR||require('os').tmpdir();fs.mkdirSync(tmpBase,{recursive:true});
    const tmp=fs.mkdtempSync(path.join(tmpBase,'trainset-'));
    const nW=Math.max(1,Math.min(set.length,Number(process.env.REALROM_WORKERS||4)));
    const seedNow=SEEDS[SEEDS.length-1];
    const workers=[];for(let w=0;w<nW;w++){const b=bridge();await b.call({op:'init',seed:seedNow,mode:'base'});await b.call({op:'readout',profile:readoutProfile});workers.push(b);}
    const trajPass=async(jb,t,fn)=>{const ib=await extras.rebuild(),idv=ib.driver;Phase.replayEntry(idv,extras.entrySteps);if(t.delay)idv.run(0,t.delay);
     await jb.call({op:'engineSeed',seed:t.engine||seedNow});
     const iobs=Observation.create(OBS,ib.core,{probe:obsProbe,readRam:()=>idv.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
     await jb.call({op:'reset'});for(let k=0;k<t.masks.length;k++){await fn(jb,iobs.observe(),t.masks[k],t.kinds[k]);idv.run(t.masks[k],STEP_FRAMES);}
     ib.dispose();await jb.call({op:'boundary'});};
    const runQueue=async job=>{let next=0;await Promise.all(workers.map(async jb=>{while(next<set.length){const i=next++;await job(jb,set[i],i);}}));};
    await runQueue(async(jb,t,i)=>{await trajPass(jb,t,async(b,retina)=>{await b.call({op:'decide',retina,train:false,actions,epsilon:0,windowMs:20,stats:true});});
     console.log('  training set: activity statistics over %s (%d decisions)',t.id,t.masks.length);});
    for(let w=0;w<nW;w++){const f=path.join(tmp,'stats-'+w+'.bin');await workers[w].call({op:'statsDump',path:f});await java.call({op:'statsLoad',path:f});fs.unlinkSync(f);}
    const chosen=await java.call({op:'population',size:Number(process.env.REALROM_POPULATION||2048)});
    const neurons=(await java.call({op:'populationGet'})).neurons;
    const provenance=new Array(set.length);
    const demoKinds=new Array(set.length),demoAt=new Array(set.length);
    await runQueue(async(jb,t,i)=>{const lab={R:0,P:0,C:0,D:0};demoKinds[i]=[];demoAt[i]=[];let at=0;await jb.call({op:'population',neurons});
     await trajPass(jb,t,async(b,retina,mask,kind)=>{const k0=at++;if(kind!=='R'&&kind!=='P'&&kind!=='C'){await b.call({op:'decide',retina,train:false,actions,epsilon:0,windowMs:20});lab.D++;return;}
      const dd=await b.call({op:'decide',retina,train:true,actions,epsilon:0,windowMs:20});const im=await b.call({op:'imitate',id:dd.id,mask});if(im.accepted){lab[kind]++;demoKinds[i].push(kind);demoAt[i].push(k0);}});
     await jb.call({op:'imitationDump',path:path.join(tmp,'demo-'+i+'.bin')});
     provenance[i]={id:t.id,delay:t.delay,disturb:t.disturb,weight:t.weight,engineSeed:t.engine||null,decisions:t.masks.length,labelled:{reference:lab.R,policy:lab.P,correction:lab.C},disturbanceUnlabelled:lab.D,traceSha256:t.sha};
     console.log('  training set: imitation over %s - labelled R %d, P %d, C %d; D %d left unlabelled',t.id,lab.R,lab.P,lab.C,lab.D);});
    for(let i=0;i<set.length;i++){const f=path.join(tmp,'demo-'+i+'.bin');for(let r=0;r<set[i].weight;r++)await java.call({op:'imitationLoad',path:f});fs.unlinkSync(f);}
    for(const w of workers)w.close();fs.rmdirSync(tmp);
    const tf=Date.now();const fit=await java.call({op:'fit',epochs:Number(process.env.REALROM_FIT_EPOCHS||400),margin:Number(process.env.REALROM_FIT_MARGIN||1),rate:.05,dropout:Number(process.env.REALROM_FIT_DROPOUT||0)});
    /* the fit by provenance: where the readout's argmax is the demonstrated action, per
       trajectory and label kind - labels that conflict over indistinguishable states show
       up here, not in the total */
    const metStr=(await java.call({op:'imitationMet'})).met;let off=0;const fitBy={};
    for(let i=0;i<set.length;i++){const row={},miss=[];for(let r=0;r<set[i].weight;r++){let j=0;for(const k of demoKinds[i]){const met=metStr[off++]==='1';if(r>0){j++;continue;}
      row[k]=row[k]||[0,0];row[k][1]++;if(met)row[k][0]++;else miss.push(demoAt[i][j]);j++;}}
     fitBy[set[i].id]=Object.fromEntries(Object.entries(row).map(([k,[m,n]])=>[k,{met:m,of:n}]));
     /* where the misses are (decision indices, private log): one early miss on the
        reference route is enough to leave it */
     const hist={};for(const d of miss){const b=Math.floor(d/500)*500;hist[b]=(hist[b]||0)+1;}
     console.log('  training fit %s%s: %s | misses first at %s, per 500 %j',set[i].id,set[i].weight>1?' (x'+set[i].weight+')':'',Object.entries(row).map(([k,[m,n]])=>k+' '+(100*m/n).toFixed(1)+'% of '+n).join(', '),
      miss.length?miss.slice(0,6).join(','):'-',hist);}
    const id='set:'+crypto.createHash('sha256').update(JSON.stringify(provenance.map(x=>[x.id,x.delay,x.disturb,x.traceSha256,x.labelled].concat(x.weight>1?[x.weight]:[],x.engineSeed?[x.engineSeed]:[])))).digest('hex').slice(0,16);
    await java.call({op:'dataset',id});
    distill={trainingSet:provenance,readout:readoutProfile,population:{neurons:chosen.population,varying:chosen.varying},
     fit:{met:fit.met,epochs:fit.epochs,updates:fit.fitUpdates,demonstrations:fit.demonstrations,wallSeconds:Math.round((Date.now()-tf)/1000),byProvenance:fitBy},dataset:id,actions:actions.length,routeStrides:route.masks.length};
    console.log('  training set %s: %d trajectories, population %d of %d varying, readout fitted to %s of %d demonstrations after %d epochs',id,set.length,chosen.population,chosen.varying,(fit.met*100).toFixed(1)+'%',fit.demonstrations,fit.epochs);
    if(process.env.REALROM_SAVE_CHECKPOINT){const sv=await java.call({op:'saveCheckpoint',path:process.env.REALROM_SAVE_CHECKPOINT});console.log('  learner saved to a private checkpoint (population %d, dataset %s)',sv.population,id);}
   }
   else{
   await java.call({op:'skill',profile:'skill-v1'});
   for(let i=0;i<steps.length;i+=500)await java.call({op:'demonstrate',steps:steps.slice(i,i+500)});
   /* IMITATION: the brain's readout learns the route - REALROM_IMITATE passes, each on its
      own freshly loaded cartridge, a training decision per route step from what the
      brain sees there, then the readout step towards the route's action (no reward) */
   /* POPULATION READOUT (REALROM_READOUT=action-pop-v1): first a frozen pass along the
      route collects every neuron's activity; the REALROM_POPULATION (default 2048)
      neurons that vary most become the readout's population; one imitation pass
      records what they do at each route step; the readout is then fitted to the
      route (FdbLearning.fitImitation) - the brain's own activity, nothing from RAM */
   const pop=readoutProfile==='action-pop-v1';
   const routePass=async(fn)=>{const ib=await extras.rebuild(),idv=ib.driver;Phase.replayEntry(idv,extras.entrySteps);
    const iobs=Observation.create(OBS,ib.core,{probe:obsProbe,readRam:()=>idv.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
    await java.call({op:'reset'});for(let k=0;k<route.masks.length;k++){await fn(iobs.observe(),route.masks[k],k);idv.run(route.masks[k],STEP_FRAMES);}
    ib.dispose();await java.call({op:'boundary'});};
   if(pop){await routePass(async retina=>{await java.call({op:'decide',retina,train:false,actions,epsilon:0,windowMs:20,stats:true});});
    const chosen=await java.call({op:'population',size:Number(process.env.REALROM_POPULATION||2048)});
    populationInfo={neurons:chosen.population,varying:chosen.varying};
    console.log('  population: %d neurons varied along the route, %d read by the readout',chosen.varying,chosen.population);}
   const passes=Number(process.env.REALROM_IMITATE||(pop?1:0));let imitated=0;
   for(let pass=0;pass<passes;pass++){
    await routePass(async(retina,mask,k)=>{const dd=await java.call({op:'decide',retina,train:true,actions,epsilon:0,windowMs:20});
     if(pass===0)routeActivity[k]=dd.activityHash;
     const im=await java.call({op:'imitate',id:dd.id,mask});if(im.accepted)imitated++;});
    console.log('  imitation pass %d: %d route steps',pass+1,route.masks.length);
   }
   if(pop){const t=Date.now();const fit=await java.call({op:'fit',epochs:Number(process.env.REALROM_FIT_EPOCHS||400),margin:Number(process.env.REALROM_FIT_MARGIN||1),rate:.05,dropout:Number(process.env.REALROM_FIT_DROPOUT||0)});
    populationInfo.fit={met:fit.met,epochs:fit.epochs,updates:fit.fitUpdates,demonstrations:fit.demonstrations,wallSeconds:Math.round((Date.now()-t)/1000)};
    console.log('  readout fitted to the route: %s of %d demonstrations met after %d epochs (%d updates, %d s)',(fit.met*100).toFixed(1)+'%',fit.demonstrations,fit.epochs,fit.fitUpdates,populationInfo.fit.wallSeconds);}
   const st=await java.call({op:'state'});
   distill={imitationPasses:passes,imitated,readout:readoutProfile,population:populationInfo,routeStrides:route.masks.length,replayRestores:rRestores,demonstrations:steps.length,distinctKeys:new Set(steps.map(x=>x[0])).size,memory:st.skills,
    routeEntrySameState:routeEntryHash===extras.inPlayHash};routeKeys=steps.map(x=>x[0]);
   console.log('  distill: route %d strides replayed from a fresh load (restores %d) -> %d demonstrations, %d distinct state keys in FDB skill memory',
    route.masks.length,rRestores,steps.length,distill.distinctKeys);
   if(process.env.REALROM_SAVE_CHECKPOINT){const id='route:'+crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(route.masks).buffer)).digest('hex').slice(0,16)+'/delay0';
    await java.call({op:'dataset',id});const sv=await java.call({op:'saveCheckpoint',path:process.env.REALROM_SAVE_CHECKPOINT});distill.dataset=id;
    console.log('  learner saved to a private checkpoint (population %d, dataset %s)',sv.population,id);}
   }
  }
  /* perturb (REALROM_PERTURB=frames): the episode starts that many idle frames late, so
     from the first decision on the brain sees what it never saw on the route - in a
     deterministic emulator reproducing a route from the identical start is close to
     replaying it; this shows whether the policy still steers when the input differs */
  async function runEpisode(useMemory,perturb,disturb){
    const fresh=await extras.rebuild();const fd=fresh.driver;let restores=0;
    Phase.replayEntry(fd,extras.entrySteps);
    const sameStart=fd.stateHash()===extras.inPlayHash;
    if(perturb)fd.run(0,perturb);
    const realRestore=fd.restore.bind(fd);fd.restore=x=>{restores++;return realRestore(x);};
    const fobs=Observation.create(OBS,fresh.core,{probe:obsProbe,readRam:()=>fd.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
    const monitor=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});
    const dims=Observation.dims(fresh.core)||[256,224];
    const stream=rng(SEEDS[SEEDS.length-1]*104729+1);
    const fkeyer=distill&&useMemory?Explore.createKeyer(keyOptions):null;let proposals=0,memoryDecided=0,brainAgreed=0;
    const before0=learnerDigest(await java.call({op:'state'}));
    await java.call({op:'reset'});
    const log=[],t0=Date.now();let frames=0,losses=0,progress=0,best=0,ended_=false,followed=0,activitySame=0,firstDivergence=null,disturbedDecisions=0,progressAtDisturbEnd=null,lossesAfterDisturb=0;const lat=[];
    const stageAddrs=oracleStage(identity.romSha256),stageTrace=[];if(stageAddrs)stageTrace.push({frame:0,values:stageAddrs.map(a=>fd.readRam()[a])});
    while(frames<maxFrames){
     const ramBefore=fd.readRam();const t=Date.now();
     const skill=fkeyer?fkeyer.key(ramBefore,Stage.signature(fresh.core.pixels,dims[0],dims[1])):null;
     const r=await java.call({op:'decide',retina:fobs.observe(),train:false,actions,epsilon:0,windowMs:20,...(sampled?{sample:stream()}:{}),...(skill?{skill}:{})});lat.push(Date.now()-t);
     if(r.skillProposal>=0){proposals++;if(r.skillDecided)memoryDecided++;if(r.brainMask===r.skillProposal)brainAgreed++;}
     if(routeKeys&&firstOffRoute===null&&log.length<routeKeys.length&&skill!==routeKeys[log.length]){firstOffRoute=log.length;
      /* private console only: keys carry RAM-derived values */
      console.log('  [private] first state off the route at decision %d:\n    route %s\n    live  %s',log.length,routeKeys[log.length],skill);}
     if(routeMasks&&followed===log.length&&log.length<routeMasks.length&&r.mask===routeMasks[log.length])followed++;
     if(routeActivity.length&&log.length<routeActivity.length&&r.activityHash===routeActivity[log.length])activitySame++;
     /* M4-03 in-episode disturbance: the brain keeps observing, its action is overridden */
     const inDist=disturb&&log.length>=disturb.at&&log.length<disturb.at+disturb.len;
     const actMask=inDist?(disturb.kind==='idle'?0:disturb.kind==='hold'?(log[log.length-1]||0):disturb.pick()):r.mask;
     if(firstDivergence===null&&routeMasks&&log.length<routeMasks.length&&r.mask!==routeMasks[log.length])firstDivergence=log.length;
     if(inDist)disturbedDecisions++;
     fd.run(actMask,STEP_FRAMES);frames+=STEP_FRAMES;log.push(actMask);
     const ramAfter=fd.readRam();const rb=read(ramBefore),ra=read(ramAfter);if(ra<rb){losses+=rb-ra;if(disturb&&log.length>disturb.at)lossesAfterDisturb+=rb-ra;}
     if(disturb&&log.length===disturb.at+disturb.len)progressAtDisturbEnd=progress;
     const pb=progressOf(ramBefore),pa=progressOf(ramAfter);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
     best=Math.max(best,progress);
     if(monitor)monitor.observe({mask:r.mask,ramBefore,ramAfter,signature:Stage.signature(fresh.core.pixels,dims[0],dims[1]),scene:Stage.palette(fresh.core.pixels,dims[0],dims[1])});
     if(stageAddrs)stageTrace.push({frame:frames,values:stageAddrs.map(a=>ramAfter[a])});
     if(ended(ramAfter)){ended_=true;break;}
    }
    const after0=learnerDigest(await java.call({op:'state'}));
    const q=p=>{const s2=[...lat].sort((a,b)=>a-b);return s2.length?s2[Math.min(s2.length-1,Math.floor(p*s2.length))]:null;};
    const transitions=monitor?monitor.transitions():[];
    /* the oracle, opened only now, after the frozen episode */
    const levelClearCheck=verifyLevelClear(stageAddrs?stageTrace:null,transitions);
    const logSha=crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(log).buffer)).digest('hex');
    if(process.env.REALROM_EVIDENCE_DIR){fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
     fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'full-episode-actions.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:STEP_FRAMES,masks:log,events:monitor?monitor.events():[]}));}
    const episodeResult={runMode:'FROZEN_FULL_EPISODE',memory:!!fkeyer,startDelayFrames:perturb||0,
     disturbance:disturb?{at:disturb.at,len:disturb.len,kind:disturb.kind,seed:disturb.seed,decisionsOverridden:disturbedDecisions,lossesAfter:lossesAfterDisturb,
      progressGainedAfter:progressAtDisturbEnd===null?null:best-progressAtDisturbEnd,recovered:progressAtDisturbEnd!==null&&!ended_&&best>progressAtDisturbEnd}:null,
     firstPolicyDivergenceFromRoute:firstDivergence,policy:sampled?'sampled (harness stream)':'argmax',freshLoad:true,entryReplayedSameState:sameStart,
     evalRestores:restores,humanInputFrames:0,framesExecuted:frames,decisions:log.length,losses,ended:ended_,
     progress,highestProgress:best,stageEvents:monitor?monitor.events().filter(e=>e.kind!=='LOSS').length:null,
     transitions:transitions.map(e=>({frame:e.frame,gapFrames:e.gapFrames,novelty:e.novelty})),
     levelClear:levelClearCheck.verdict==='VERIFIED'?'VERIFIED':transitions.length?'CANDIDATE':'UNVERIFIED',levelClearOracle:levelClearCheck,
     levelClearEvidence:transitions.length?'stage transition detected (frame '+transitions[0].frame+', gap '+transitions[0].gapFrames+' frames, palette novelty '+transitions[0].novelty+'); oracle stage bytes: '+levelClearCheck.verdict+'; frames and action trace kept privately':null,
     weightsChangedInEval:before0!==after0,actionTraceSha256:logSha,
     routeStepsFollowedFromStart:routeMasks?followed:null,routeStrides:routeMasks?routeMasks.length:null,
     routeStepsWithIdenticalBrainActivity:routeActivity.length?activitySame:null,
     distill,skillMemory:distill?{decisionsWithProposal:proposals,decidedByMemoryAgainstBrain:memoryDecided,brainAlreadyAgreed:brainAgreed,firstDecisionOffRoute:firstOffRoute}:null,decisionLatencyMs:{p50:q(.5),p95:q(.95)},wallSeconds:Math.round((Date.now()-t0)/1000)};
    if(routeMasks)console.log('  route steps reproduced from the start before the first deviation: %d of %d%s',followed,routeMasks.length,
     routeActivity.length?' (brain activity identical to the imitation pass on '+activitySame+' steps)':'');
    if(distill&&fkeyer)console.log('  skill memory in the frozen episode: %d of %d decisions had a proposal; it overrode the brain %d times, the brain already agreed %d times',
     proposals,log.length,memoryDecided,brainAgreed);
    console.log('  FULL EPISODE (%s%s): fresh load, entry same state %s, restores %d | frames %d, decisions %d, losses %d, ended %s | progress %d | stage transitions %d -> LEVEL_CLEAR %s | frozen %s | p50 %s ms',
     episodeResult.policy,(fkeyer?', skill memory':(distill?', brain only':''))+(perturb?', start '+perturb+' frames late':''),sameStart,restores,frames,log.length,losses,ended_,best,transitions.length,episodeResult.levelClear,before0===after0?'clean':'CHANGED',episodeResult.decisionLatencyMs.p50);
    fresh.dispose();
    return episodeResult;
  }
  /* REALROM_MEMORY_EPISODE=0: only the brain-only episode (the skill-memory one is a control);
     REALROM_SKIP_EPISODES=1: none (a teacher run) */
  if(process.env.REALROM_SKIP_EPISODES==='1'){fullEpisode={skipped:true};}
  else if(distill&&process.env.REALROM_MEMORY_EPISODE==='0'){fullEpisode={brainOnly:await runEpisode(false)};}
  else{fullEpisode=await runEpisode(true);if(distill)fullEpisode.brainOnly=await runEpisode(false);}
  if(distill&&process.env.REALROM_PERTURB){fullEpisode.brainOnlyPerturbed=[];
   for(const late of String(process.env.REALROM_PERTURB).split(',').map(Number).filter(x=>x>0))fullEpisode.brainOnlyPerturbed.push(await runEpisode(false,late));}
  /* M4-03: REALROM_EVAL (the teacher's perturbation syntax): frozen brain-only episodes
     under each perturbation, and the reference route replayed BLIND under the same one */
  if(distill&&process.env.REALROM_EVAL){fullEpisode.evaluation=[];
   const exploreActions=compositeActions(profile.dto.discovered.buttonAttribution,spec,3);
   for(const p of parsePerturbations(process.env.REALROM_EVAL)){
    const mkDist=()=>p.disturb?{...p.disturb,pick:(r=>()=>exploreActions[Math.floor(r()*exploreActions.length)])(rng(p.disturb.seed*7919+13))}:null;
    /* engine=<seed>: this episode's brain runs on another Poisson input stream */
    const prevSeed=p.engine?(await java.call({op:'engineSeed',seed:p.engine})).previous:null;
    const brain=await runEpisode(false,p.delay,mkDist());
    if(prevSeed!==null)await java.call({op:'engineSeed',seed:prevSeed});
    /* blind replay: the route's own actions, the same delay and disturbance, no brain */
    const ob=await extras.rebuild(),od=ob.driver;Phase.replayEntry(od,extras.entrySteps);if(p.delay)od.run(0,p.delay);
    const omon=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const odims=Observation.dims(ob.core)||[256,224];
    const sa=oracleStage(identity.romSha256),st=[];if(sa)st.push({frame:0,values:sa.map(a=>od.readRam()[a])});
    const dd=mkDist();let ofr=0,olos=0,oprog=0,oended=false,last=0;const olog=[];
    for(let k=0;k<routeMasks.length&&ofr<maxFrames;k++){const inD=dd&&k>=dd.at&&k<dd.at+dd.len;const m=inD?(dd.kind==='idle'?0:dd.kind==='hold'?last:dd.pick()):routeMasks[k];last=m;
     const b=od.readRam();od.run(m,STEP_FRAMES);ofr+=STEP_FRAMES;const a=od.readRam();if(read(a)<read(b))olos+=read(b)-read(a);
     const pb=progressOf(b),pa=progressOf(a);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])oprog+=pa[i]-pb[i];
     omon.observe({mask:m,ramBefore:b,ramAfter:a,signature:Stage.signature(ob.core.pixels,odims[0],odims[1]),scene:Stage.palette(ob.core.pixels,odims[0],odims[1])});
     if(sa)st.push({frame:ofr,values:sa.map(x=>a[x])});if(ended(a)){oended=true;break;}}
    const ov=verifyLevelClear(sa?st:null,omon.transitions());ob.dispose();
    fullEpisode.evaluation.push({id:p.id,delay:p.delay,disturb:p.disturb,engineSeed:p.engine||null,brain:{levelClear:brain.levelClear,ended:brain.ended,losses:brain.losses,frames:brain.framesExecuted,
      progress:brain.highestProgress,latencyMs:brain.decisionLatencyMs,firstDivergence:brain.firstPolicyDivergenceFromRoute,disturbance:brain.disturbance,frozen:!brain.weightsChangedInEval,restores:brain.evalRestores},
     openLoop:{levelClear:ov.verdict,ended:oended,losses:olos,frames:ofr,progress:oprog}});
    console.log('  EVAL %s (delay %d%s%s): brain %s, game over %s, losses %d, progress %d | blind replay %s, game over %s, losses %d, progress %d',p.id,p.delay,
     p.disturb?', '+p.disturb.kind+'@'+p.disturb.at+'x'+p.disturb.len:'',p.engine?', engine seed '+p.engine:'',brain.levelClear,brain.ended,brain.losses,brain.highestProgress,ov.verdict,oended,olos,oprog);}
  }
  if(distill&&process.env.REALROM_TEACHER)fullEpisode.teacher=await recoveryTeacher({java,actions,profile,identity,extras,read,progressOf,floor,keyOptions,obsProbe,spec});
 }
 return {brain:brainIdentity,actions:actions.length,stepFrames:STEP_FRAMES,evalStarts:3,evalStepsCap:EVAL_STEPS,fullEpisode,
  evaluation:'frozen, both argmax (untrained/trained) and sampled from the policy with the harness RNG (untrainedSampled/trainedSampled); whole learner state digest compared',
  encoderRevision:observer.revision,readoutProfile,budget:BUDGET,rewind:REWIND?{branches:REWIND,backFrames:BACK_STEPS*STEP_FRAMES,branchFrames:BRANCH_STEPS*STEP_FRAMES}:null,
  decision:prior?{source:'survival discovery button attribution',actions:prior.actions,priors:prior.priors}:'default action set, no prior',
  creditProfile:creditProfile||'single-v1',pauseOnAuthorityDrop:pauseOnDrop,
  credit:process.env.REALROM_CREDIT==='carry'?'UNKNOWN intervals carried into the traces, unpaid':'UNKNOWN intervals clear the traces',
  noOpAction:process.env.REALROM_NOOP!=='0',
  graph:brainIdentity&&brainIdentity.label==='COMMERCIAL'?'Male CNS, routing profile (COMMERCIAL)':process.env.FDB_GRAPH?'graph, NOT_COMMERCIAL ports':'30-neuron mechanism fixture (NOT_COMMERCIAL)',rows};
}

(async()=>{
 const files=fs.readdirSync(ROMS).filter(f=>EXT[path.extname(f).toLowerCase()]).sort();
 const only=option('--only',null);
 const java=flag('--fdb')&&process.env.CODE_CLASSPATH?bridge():null;
 if(flag('--fdb')&&!java)console.log('FDB: BLOCKED - CODE_CLASSPATH is not set');
 const results=[];
 for(const f of files){
  const bytes=fs.readFileSync(path.join(ROMS,f));
  if(only&&!sha(bytes).startsWith(only))continue;
  console.log('ROM sha256 %s (%d bytes)',sha(bytes).slice(0,16),bytes.length);
  try{results.push(await studyRom(path.join(ROMS,f),java));}
  catch(error){results.push({romSha256:sha(bytes),status:'ERROR',error:String(error.message||error).slice(0,300)});console.log('  ERROR',error.message);}
 }
 if(java)java.close();
 const report={tool:'agod_realrom_check',revisions:{pipeline:Pipeline.PIPELINE_REVISION,phase:Phase.PHASE_REVISION,
  survival:Survival.SURVIVAL_REVISION,objective:Objective.OBJECTIVE_REVISION},
  privacy:'hashes, sizes and aggregates only; no ROM bytes, RAM offsets, frames or states',results};
 const out=option('--out',null);
 if(out){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,1)+'\n');console.log('report: '+out);}
})().catch(e=>{console.log('FAILED '+e.stack);process.exitCode=1;});
