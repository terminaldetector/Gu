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

const args=process.argv.slice(2);
const flag=name=>args.includes(name);
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS||!fs.existsSync(ROMS)){
 console.log('BLOCKED - AGOD_PRIVATE_ROMS is not set or does not exist. This check runs only on a '
  +'private corpus; no fixture is substituted and nothing is reported as passed.');
 process.exit(0);
}
const EXT={'.gen':'sega','.md':'sega','.bin':'sega','.smd':'sega','.nes':'nes'};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const BUILD={
 sega:async bytes=>PD.create({platform:'sega',romBytes:bytes,SegaConsole:require(path.join(A,'sega-core.js')),
  factory:require(path.join(A,'sega','genplus.js')),moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:1e10}),
 nes:async bytes=>PD.createNesSync({romBytes:bytes,jsnes,frameBudget:1e10})};
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
function retina(core){
 const p=core.pixels||(core.ppu&&null);const v=new Array(16).fill(0),n=new Array(16).fill(0);
 if(!p)return v;
 const w=p.length>=320*224?320:256,h=Math.floor(p.length/w);
 for(let y=0;y<h;y+=4)for(let x=0;x<w;x+=4){const c=p[y*w+x];const i=Math.min(3,Math.floor(y*4/h))*4+Math.min(3,Math.floor(x*4/w));
  v[i]+=(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255))/255;n[i]++;}
 return v.map((s,i)=>n[i]?s/n[i]:0);
}
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
  progressFields:found.discovered&&found.discovered.progressFields?found.discovered.progressFields.length:0};
 console.log('  survival: %s (%s) %d frames %d ms, progress fields %d',found.status,report.survival.kind,
  report.survival.frames,report.survival.wallMs,report.survival.progressFields);
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
 if(java&&found.status==='VERIFIED'){
  const dto=Dto.fromPipelineResult(found,{...config,platform,driverRevision:built.driverRevision});
  const identity={romSha256,platform,coreRevision:platform,detectorRevision,
   actionSpec:built.capabilities.actionSpec,padType:built.capabilities.padType,
   observedRamBytes:built.capabilities.observedRamBytes};
  const profile=Objective.createProfile(dto,identity,MODULES);
  report.profile={status:profile.status,reason:profile.reason||null,progress:profile.progress?profile.progress.length:0};
  if(profile.status==='PROFILE')report.learning=await learn(built,inPlay,profile,identity,java);
 }
 report.totalFrames=built.framesRun();report.totalWallMs=Date.now()-t0;
 built.dispose();
 return {...report,status:'DONE'};
}

async function learn(built,inPlay,profile,identity,java){
 const d=built.driver,spec=d.actionSpec,core=built.core;
 const actions=actionSet(spec);
 const read=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe',policy:'aggressive'}).read;
 const progressOf=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe2',policy:'aggressive'}).readProgress;
 const floor=profile.dto.discovered.resource.floor;
 /* starts of separate origin: training from seeds 1000+, evaluation from 5000+ */
 const starts=(base,count)=>{const out=[];for(let k=0;k<count;k++){
  d.restore(inPlay);const p=Survival.randomPolicy(spec,base+k);for(let t=0;t<120+40*k;t+=8)d.run(p(t),8);
  out.push(d.snapshot());}return out;};
 const trainStarts=starts(1000,4),evalStarts=starts(5000,3);
 const ended=ram=>read(ram)<=floor;
 async function episode(start,choose,train,steps,live,stats){
  d.restore(start);d.run(0,1);
  let n=0,losses=0,progress=0;
  for(;n<steps;n++){
   const before=d.readRam();
   const pick=await choose(train);
   d.run(pick.mask,STEP_FRAMES);
   const after=d.readRam();
   const rb=read(before),ra=read(after);if(ra<rb)losses+=rb-ra;
   const pb=progressOf(before),pa=progressOf(after);
   for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
   if(train&&live){
    stats.frame+=STEP_FRAMES;
    const packet=live.observe({ramBefore:before,ramAfter:after,endFrame:stats.frame,requestedMask:pick.mask,
     executed:{mask:pick.mask,frames:STEP_FRAMES,complete:true,manualOverride:false},phase:'PLAYING'});
    if(packet.status==='VERIFIED'||packet.status==='PROVISIONAL'){
     stats[packet.status]++;
     const r=await java.call({op:'reward',id:pick.id,mask:pick.mask,reward:packet.value,seconds:STEP_FRAMES/60,frames:STEP_FRAMES});
     stats.changed+=r.changed;
    }else if(process.env.REALROM_CREDIT==='carry'&&packet.status==='UNKNOWN'){
     /* no verified event: the decision joins the eligibility traces, nothing is paid */
     stats.unknown++;const c=await java.call({op:'carry',id:pick.id,mask:pick.mask,seconds:STEP_FRAMES/60,frames:STEP_FRAMES});
     if(c.accepted)stats.carried=(stats.carried||0)+1;
    }else{stats.unknown++;await java.call({op:'boundary'});}
   }
   if(ended(after)){n++;break;}
  }
  return {steps:n,losses,progress};
 }
 const rows=[];
 for(const seed of SEEDS){
  /* REALROM_EVAL=stochastic: evaluation samples from the layer's own policy
     (decide in sampling mode, epsilon 0) and never sends feedback, so weights
     and update counts stay frozen - checked below - but the frozen argmax's
     "press nothing" tie no longer decides every step */
  const stochastic=process.env.REALROM_EVAL==='stochastic';
  const brain=train=>async()=>{const r=await java.call({op:'decide',retina:retina(core),train:train||stochastic,actions,
   epsilon:train?.1:0,windowMs:20});return {mask:r.mask,id:r.id};};
  const evaluate=async choose=>{const out=[];for(const s of evalStarts)out.push(await episode(s,choose,false,EVAL_STEPS,null,null));return out;};
  await java.call({op:'init',seed,mode:'base'});
  const untrained=await evaluate(brain(false));
  await java.call({op:'init',seed,mode:'base'});
  const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'realrom-'+seed,policy:'aggressive'});
  const stats={VERIFIED:0,PROVISIONAL:0,unknown:0,changed:0,frame:0};
  let done=0,k=0;
  while(done<TRAIN_STEPS){const e=await episode(trainStarts[k++%trainStarts.length],brain(true),true,TRAIN_STEPS-done,live,stats);done+=e.steps;await java.call({op:'boundary'});}
  await java.call({op:'reset'});
  const frozenBefore=await java.call({op:'state'});
  const trained=await evaluate(brain(false));
  const frozenAfter=await java.call({op:'state'});
  const r=rng(seed);const random=await evaluate(async()=>({mask:actions[Math.floor(r()*actions.length)],id:null}));
  const sum=(list,key)=>list.reduce((s,x)=>s+x[key],0);
  const row={seed,trainSteps:TRAIN_STEPS,verified:stats.VERIFIED,provisional:stats.PROVISIONAL,unknown:stats.unknown,
   nativeChanges:stats.changed,carried:stats.carried||0,frozenClean:frozenBefore.weights===frozenAfter.weights&&frozenBefore.updates===frozenAfter.updates,
   untrained:{survivalSteps:sum(untrained,'steps'),losses:sum(untrained,'losses'),progress:sum(untrained,'progress')},
   trained:{survivalSteps:sum(trained,'steps'),losses:sum(trained,'losses'),progress:sum(trained,'progress')},
   random:{survivalSteps:sum(random,'steps'),losses:sum(random,'losses'),progress:sum(random,'progress')}};
  rows.push(row);
  console.log('  seed %d: verified %d provisional %d native changes %d | survival steps untrained %d trained %d random %d | losses %d/%d/%d | progress %d/%d/%d',
   seed,row.verified,row.provisional,row.nativeChanges,row.untrained.survivalSteps,row.trained.survivalSteps,row.random.survivalSteps,
   row.untrained.losses,row.trained.losses,row.random.losses,row.untrained.progress,row.trained.progress,row.random.progress);
 }
 return {actions:actions.length,stepFrames:STEP_FRAMES,evalStarts:3,evalStepsCap:EVAL_STEPS,
  evaluation:process.env.REALROM_EVAL==='stochastic'?'frozen, sampled from the policy':'frozen, argmax',
  credit:process.env.REALROM_CREDIT==='carry'?'UNKNOWN intervals carried into the traces, unpaid':'UNKNOWN intervals clear the traces',
  noOpAction:process.env.REALROM_NOOP!=='0',
  graph:process.env.FDB_GRAPH?'connectome':'30-neuron mechanism fixture',rows};
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
