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
  {stdio:['pipe','pipe','ignore']});
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

async function exploreRoute(built,inPlay,profile,identity,extras){
 const d=built.driver,spec=d.actionSpec;
 const prior=decisionPrior(profile.dto.discovered&&profile.dto.discovered.buttonAttribution,spec,0);
 const actions=prior?prior.actions:actionSet(spec);
 const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'explore',policy:'aggressive'});
 const read=live.read,progressOf=live.readProgress,budget=Number(process.env.REALROM_EXPLORE);
 const positionFields=(extras.entryProbe&&extras.entryProbe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0]);
 const dims=()=>Observation.dims(built.core)||[256,224];
 d.restore(inPlay);
 const archive=Explore.createArchive(d,{actions,readProgress:progressOf,readResource:read,positionFields,
  screen:()=>{const [w,h]=dims();return Stage.signature(built.core.pixels,w,h);},seed:Number(process.env.REALROM_EXPLORE_SEED||1),
  allowLoss:process.env.REALROM_EXPLORE_LOSS==='1',floor:profile.dto.discovered.resource.floor,
  ...(process.env.REALROM_EXPLORE_LIFE?{lifeWeight:Number(process.env.REALROM_EXPLORE_LIFE)}:{})});
 const t0=Date.now();let lastLog=0;
 while(archive.stats().framesRun<budget){
  archive.explore();
  const st=archive.stats();
  if(st.framesRun-lastLog>=budget/20){lastLog=st.framesRun;
   console.log('  explore: %d frames, %d cells, %d explorations, best progress %d (resource %s, route %d strides) %d s',
    st.framesRun,st.cells,st.explorations,st.bestProgress,st.bestResource,st.bestTraceLength,Math.round((Date.now()-t0)/1000));}
 }
 const best=archive.best(),st=archive.stats();
 /* the route, replayed from a freshly loaded cartridge: entry without restore, then
    the trace stride by stride, the stage detector watching - no snapshot anywhere */
 const fresh=await extras.rebuild(),fd=fresh.driver;let restores=0;
 Phase.replayEntry(fd,extras.entrySteps);const realRestore=fd.restore.bind(fd);fd.restore=x=>{restores++;return realRestore(x);};
 const monitor=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});
 const fdims=Observation.dims(fresh.core)||[256,224];let progress=0,losses=0;
 for(const mask of best.trace){const before=fd.readRam();fd.run(mask,8);const after=fd.readRam();
  const pb=progressOf(before),pa=progressOf(after);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
  if(read(after)<read(before))losses+=read(before)-read(after);
  if(monitor)monitor.observe({mask,ramBefore:before,ramAfter:after,signature:Stage.signature(fresh.core.pixels,fdims[0],fdims[1])});}
 const transitions=monitor?monitor.transitions():[];
 fresh.dispose();
 if(process.env.REALROM_EVIDENCE_DIR){fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
  fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'explore-route.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:8,masks:best.trace,events:monitor?monitor.events():[]}));}
 const out={revision:Explore.EXPLORE_REVISION,budgetFrames:budget,cells:st.cells,explorations:st.explorations,framesRun:st.framesRun,
  wallSeconds:Math.round((Date.now()-t0)/1000),bestProgress:st.bestProgress,routeStrides:best.trace.length,routeFrames:best.trace.length*8,
  replay:{freshLoad:true,restores,progress,losses,stageTransitions:transitions.map(e=>({frame:e.frame,gapFrames:e.gapFrames,novelty:e.novelty}))},
  routeSha256:crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(best.trace).buffer)).digest('hex'),
  levelClear:transitions.length?'ROUTE_REACHES_A_STAGE_TRANSITION (search, not autonomous play)':'NOT_REACHED'};
 console.log('  explore result: %d cells, best progress %d, route %d frames; replayed from a fresh load (restores %d): progress %d, losses %d, stage transitions %d -> %s',
  out.cells,out.bestProgress,out.routeFrames,restores,progress,losses,transitions.length,out.levelClear);
 return out;
}

async function learn(built,inPlay,profile,identity,java,extras){
 const d=built.driver,spec=d.actionSpec,core=built.core;
 const prior=process.env.REALROM_DECISION==='agod'
  ?decisionPrior(profile.dto.discovered&&profile.dto.discovered.buttonAttribution,spec,Number(process.env.REALROM_PRIOR||2)):null;
 const actions=prior?prior.actions:actionSet(spec);
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
  let distill=null,routeKeys=null,routeMasks=null,firstOffRoute=null;const keyOptions={readProgress:progressOf,readResource:ram=>read(ram),
   positionFields:(extras.entryProbe&&extras.entryProbe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0])};
  if(process.env.REALROM_DISTILL){
   const route=JSON.parse(fs.readFileSync(process.env.REALROM_DISTILL,'utf8'));routeMasks=route.masks;
   if(JSON.stringify(route.entrySteps)!==JSON.stringify(extras.entrySteps))throw Error('the route was found from another entry');
   const rb=await extras.rebuild(),rd=rb.driver;let rRestores=0;Phase.replayEntry(rd,extras.entrySteps);const routeEntryHash=rd.stateHash();const rr=rd.restore.bind(rd);rd.restore=x=>{rRestores++;return rr(x);};
   const keyer=Explore.createKeyer(keyOptions),rdims=Observation.dims(rb.core)||[256,224],steps=[];
   for(const mask of route.masks){steps.push([keyer.key(rd.readRam(),Stage.signature(rb.core.pixels,rdims[0],rdims[1])),mask]);rd.run(mask,STEP_FRAMES);}
   rb.dispose();
   await java.call({op:'skill',profile:'skill-v1'});
   for(let i=0;i<steps.length;i+=500)await java.call({op:'demonstrate',steps:steps.slice(i,i+500)});
   /* IMITATION: the brain's readout learns the route - REALROM_IMITATE passes, each on its
      own freshly loaded cartridge, a training decision per route step from what the
      brain sees there, then the readout step towards the route's action (no reward) */
   const passes=Number(process.env.REALROM_IMITATE||0);let imitated=0;
   for(let pass=0;pass<passes;pass++){
    const ib=await extras.rebuild(),idv=ib.driver;Phase.replayEntry(idv,extras.entrySteps);
    const iobs=Observation.create(OBS,ib.core,{probe:obsProbe,readRam:()=>idv.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
    await java.call({op:'reset'});
    for(const mask of route.masks){const dd=await java.call({op:'decide',retina:iobs.observe(),train:true,actions,epsilon:0,windowMs:20});
     const im=await java.call({op:'imitate',id:dd.id,mask});if(im.accepted)imitated++;idv.run(mask,STEP_FRAMES);}
    ib.dispose();await java.call({op:'boundary'});
    console.log('  imitation pass %d: %d route steps',pass+1,route.masks.length);
   }
   const st=await java.call({op:'state'});
   distill={imitationPasses:passes,imitated,routeStrides:route.masks.length,replayRestores:rRestores,demonstrations:steps.length,distinctKeys:new Set(steps.map(x=>x[0])).size,memory:st.skills,
    routeEntrySameState:routeEntryHash===extras.inPlayHash};routeKeys=steps.map(x=>x[0]);
   console.log('  distill: route %d strides replayed from a fresh load (restores %d) -> %d demonstrations, %d distinct state keys in FDB skill memory',
    route.masks.length,rRestores,steps.length,distill.distinctKeys);
  }
  async function runEpisode(useMemory){
    const fresh=await extras.rebuild();const fd=fresh.driver;let restores=0;
    Phase.replayEntry(fd,extras.entrySteps);
    const sameStart=fd.stateHash()===extras.inPlayHash;
    const realRestore=fd.restore.bind(fd);fd.restore=x=>{restores++;return realRestore(x);};
    const fobs=Observation.create(OBS,fresh.core,{probe:obsProbe,readRam:()=>fd.readRam(),readResource:ram=>read(ram),initialResource:profile.dto.discovered.resource.initial});
    const monitor=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});
    const dims=Observation.dims(fresh.core)||[256,224];
    const stream=rng(SEEDS[SEEDS.length-1]*104729+1);
    const fkeyer=distill&&useMemory?Explore.createKeyer(keyOptions):null;let proposals=0,memoryDecided=0,brainAgreed=0;
    const before0=learnerDigest(await java.call({op:'state'}));
    await java.call({op:'reset'});
    const log=[],t0=Date.now();let frames=0,losses=0,progress=0,best=0,ended_=false,followed=0;const lat=[];
    while(frames<maxFrames){
     const ramBefore=fd.readRam();const t=Date.now();
     const skill=fkeyer?fkeyer.key(ramBefore,Stage.signature(fresh.core.pixels,dims[0],dims[1])):null;
     const r=await java.call({op:'decide',retina:fobs.observe(),train:false,actions,epsilon:0,windowMs:20,...(sampled?{sample:stream()}:{}),...(skill?{skill}:{})});lat.push(Date.now()-t);
     if(r.skillProposal>=0){proposals++;if(r.skillDecided)memoryDecided++;if(r.brainMask===r.skillProposal)brainAgreed++;}
     if(routeKeys&&firstOffRoute===null&&log.length<routeKeys.length&&skill!==routeKeys[log.length]){firstOffRoute=log.length;
      /* private console only: keys carry RAM-derived values */
      console.log('  [private] first state off the route at decision %d:\n    route %s\n    live  %s',log.length,routeKeys[log.length],skill);}
     if(routeMasks&&followed===log.length&&log.length<routeMasks.length&&r.mask===routeMasks[log.length])followed++;
     fd.run(r.mask,STEP_FRAMES);frames+=STEP_FRAMES;log.push(r.mask);
     const ramAfter=fd.readRam();const rb=read(ramBefore),ra=read(ramAfter);if(ra<rb)losses+=rb-ra;
     const pb=progressOf(ramBefore),pa=progressOf(ramAfter);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
     best=Math.max(best,progress);
     if(monitor)monitor.observe({mask:r.mask,ramBefore,ramAfter,signature:Stage.signature(fresh.core.pixels,dims[0],dims[1])});
     if(ended(ramAfter)){ended_=true;break;}
    }
    const after0=learnerDigest(await java.call({op:'state'}));
    const q=p=>{const s2=[...lat].sort((a,b)=>a-b);return s2.length?s2[Math.min(s2.length-1,Math.floor(p*s2.length))]:null;};
    const transitions=monitor?monitor.transitions():[];
    const logSha=crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(log).buffer)).digest('hex');
    if(process.env.REALROM_EVIDENCE_DIR){fs.mkdirSync(process.env.REALROM_EVIDENCE_DIR,{recursive:true});
     fs.writeFileSync(path.join(process.env.REALROM_EVIDENCE_DIR,'full-episode-actions.json'),JSON.stringify({entrySteps:extras.entrySteps,stepFrames:STEP_FRAMES,masks:log,events:monitor?monitor.events():[]}));}
    const episodeResult={runMode:'FROZEN_FULL_EPISODE',memory:!!fkeyer,policy:sampled?'sampled (harness stream)':'argmax',freshLoad:true,entryReplayedSameState:sameStart,
     evalRestores:restores,humanInputFrames:0,framesExecuted:frames,decisions:log.length,losses,ended:ended_,
     progress,highestProgress:best,stageEvents:monitor?monitor.events().filter(e=>e.kind!=='LOSS').length:null,
     transitions:transitions.map(e=>({frame:e.frame,gapFrames:e.gapFrames,novelty:e.novelty})),
     levelClear:transitions.length?'CANDIDATE':'UNVERIFIED',levelClearEvidence:transitions.length?'stage transition detected; frames and action trace kept privately':null,
     weightsChangedInEval:before0!==after0,actionTraceSha256:logSha,
     routeStepsFollowedFromStart:routeMasks?followed:null,routeStrides:routeMasks?routeMasks.length:null,
     distill,skillMemory:distill?{decisionsWithProposal:proposals,decidedByMemoryAgainstBrain:memoryDecided,brainAlreadyAgreed:brainAgreed,firstDecisionOffRoute:firstOffRoute}:null,decisionLatencyMs:{p50:q(.5),p95:q(.95)},wallSeconds:Math.round((Date.now()-t0)/1000)};
    if(routeMasks)console.log('  route steps reproduced from the start before the first deviation: %d of %d',followed,routeMasks.length);
    if(distill&&fkeyer)console.log('  skill memory in the frozen episode: %d of %d decisions had a proposal; it overrode the brain %d times, the brain already agreed %d times',
     proposals,log.length,memoryDecided,brainAgreed);
    console.log('  FULL EPISODE (%s%s): fresh load, entry same state %s, restores %d | frames %d, decisions %d, losses %d, ended %s | progress %d | stage transitions %d -> LEVEL_CLEAR %s | frozen %s | p50 %s ms',
     episodeResult.policy,fkeyer?', skill memory':(distill?', brain only':''),sameStart,restores,frames,log.length,losses,ended_,best,transitions.length,episodeResult.levelClear,before0===after0?'clean':'CHANGED',episodeResult.decisionLatencyMs.p50);
    fresh.dispose();
    return episodeResult;
  }
  fullEpisode=await runEpisode(true);
  if(distill)fullEpisode.brainOnly=await runEpisode(false);
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
