'use strict';
// Real-ROM AGOD on PRIVATE commercial cartridges, with aggregate analytics only:
// entry into play, the classic pipeline, survival discovery, the oracle opened only
// after the answer, a second player - and the AGOD research mechanisms
// (tools/agod_research.cjs): frontier archive, recovery teacher, suitability labeller,
// position bound and frozen policy evaluation, each driven by a PolicyAdapter.
//
//   AGOD_PRIVATE_ROMS=/path/to/private/dir node tools/agod_realrom_check.cjs //     [--out docs/reports/realrom/run.json] [--only <sha-prefix>] [--no-baseline] [--2p]
//
// Research modes (environment):
//   REALROM_EXPLORE=<frames>          frontier archive to a route (REALROM_EXPLORE_*)
//   REALROM_ROUTE=<file>              a reference trajectory {entrySteps, stepFrames, masks}
//   REALROM_POLICY=null|route|replay:<file>|random:<seed>
//   REALROM_TEACHER=<perturbations>   recovery teacher for the policy (REALROM_TEACHER_*)
//   REALROM_EVAL=<perturbations>      frozen evaluation of the policy (+ open-loop route)
//   REALROM_SUITABILITY=<files>       branching labels (REALROM_SUIT_*; MODE=hold)
//   REALROM_DIAG_POSITION=1           brainless position bound (REALROM_DIAG_*)
//   perturbations: 'id=..,delay=..;id=..,at=..,len=..,kind=idle|wrong|hold,seed=..'
//
// PRIVACY. ROM bytes are read from AGOD_PRIVATE_ROMS and never leave this
// process: the report carries the SHA-256, the byte size and aggregate
// results. No RAM offset, no frame, no state and no header text is written.
// Without AGOD_PRIVATE_ROMS the run is BLOCKED - no fixture is substituted.
//
// ORACLE. AGOD_PRIVATE_ROMS/oracle.json may map a SHA-256 to the resource and
// progress offsets a human established by inspection ({"<sha>":{"resource":[..],
// "progress":[..],"stage":[..]}}). It is opened only AFTER discovery or a run has
// answered, and only a match/no-match bit or a verdict reaches the report.
//
// The neural stand this replaced (Male CNS / FDB learning, distillation and the P0
// policy) is archived on branch archive/gu-2be2dae-male-cns-fdb.
const fs=require('fs'),path=require('path');
const R=require('./agod_research.cjs');
const {BUILD,EXT,sha,MODULES,Pipeline,Dto,Objective,Phase,Survival}=R;

const args=process.argv.slice(2);
const flag=name=>args.includes(name);
const option=(name,fallback)=>{const i=args.indexOf(name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS||!fs.existsSync(ROMS)){
 console.log('BLOCKED - AGOD_PRIVATE_ROMS is not set or does not exist. This check runs only on a '
  +'private corpus; no fixture is substituted and nothing is reported as passed.');
 process.exit(0);
}
R.setOracleDir(ROMS);

/* the research context: readers from the VERIFIED profile, the reference route if one is
   given (it must come from the same entry), and the action set - the discovery decision
   prior (REALROM_DECISION=agod, weight REALROM_PRIOR) or the default set, plus every
   action the route and REALROM_ACTIONS_FROM trajectories take */
async function researchModes(built,profile,identity,extras){
 const d=built.driver,spec=d.actionSpec,out={};
 const read=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe',policy:'aggressive'}).read;
 const progressOf=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'probe2',policy:'aggressive'}).readProgress;
 const floor=profile.dto.discovered.resource.floor,ended=ram=>read(ram)<=floor;
 const keyOptions={readProgress:progressOf,readResource:ram=>read(ram),
  positionFields:(extras.entryProbe&&extras.entryProbe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0])};
 let routeMasks=null;
 if(process.env.REALROM_ROUTE){const route=JSON.parse(fs.readFileSync(process.env.REALROM_ROUTE,'utf8'));
  if(JSON.stringify(route.entrySteps)!==JSON.stringify(extras.entrySteps))throw new Error('the route was found from another entry');
  routeMasks=route.masks;}
 const attribution=profile.dto.discovered&&profile.dto.discovered.buttonAttribution;
 const prior=process.env.REALROM_DECISION==='agod'?R.decisionPrior(attribution,spec,Number(process.env.REALROM_PRIOR||2)):null;
 let actions=prior?prior.actions:R.actionSet(spec);
 if(routeMasks)actions=[...new Set([...actions,...routeMasks])];
 for(const f of String(process.env.REALROM_ACTIONS_FROM||'').split(';').filter(Boolean))
  actions=[...new Set([...actions,...JSON.parse(fs.readFileSync(f,'utf8')).masks])];
 const exploreActions=R.compositeActions(attribution,spec,3);
 const policy=process.env.REALROM_POLICY?R.createPolicy(process.env.REALROM_POLICY,{routeMasks,actions}):null;
 out.actions=actions.length;out.policy=policy?policy.id:null;
 if(process.env.REALROM_SUITABILITY)out.suitability=await R.suitabilityLabeller({actions,extras,read,progressOf});
 if(process.env.REALROM_DIAG_POSITION==='1'){
  if(!routeMasks)throw new Error('the position bound needs REALROM_ROUTE');
  out.positionDiagnostic=await R.positionController({extras,read,progressOf,ended,identity,routeMasks,exploreActions,
   maxDecisions:Number(process.env.REALROM_DIAG_MAX||9000)});}
 if(process.env.REALROM_TEACHER){
  if(!policy)throw new Error('the recovery teacher needs REALROM_POLICY');
  out.teacher=await R.recoveryTeacher({policy,actions,profile,identity,extras,read,progressOf,floor,keyOptions,spec});}
 if(process.env.REALROM_EVAL){
  if(!policy)throw new Error('the frozen evaluation needs REALROM_POLICY');
  out.evaluation=await R.evaluatePolicy({policy,extras,read,progressOf,ended,identity,routeMasks,exploreActions,actions});}
 return out;
}

async function studyRom(file){
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
 /* 5. AGOD research (needs a VERIFIED survival profile): the frontier archive, and on
    the research context the labeller, the position bound, the recovery teacher and the
    frozen policy evaluation - each only when asked for. No neural backend anywhere. */
 const research=Number(process.env.REALROM_EXPLORE)>0||process.env.REALROM_TEACHER||process.env.REALROM_SUITABILITY||process.env.REALROM_DIAG_POSITION==='1'||process.env.REALROM_EVAL;
 if(research&&found.status==='VERIFIED'){
  const dto=Dto.fromPipelineResult(found,{...config,platform,driverRevision:built.driverRevision});
  const identity={romSha256,platform,coreRevision:platform,detectorRevision,
   actionSpec:built.capabilities.actionSpec,padType:built.capabilities.padType,
   observedRamBytes:built.capabilities.observedRamBytes};
  const profile=Objective.createProfile(dto,identity,MODULES);
  report.profile={status:profile.status,reason:profile.reason||null,progress:profile.progress?profile.progress.length:0};
  const extras={rebuild:()=>BUILD[platform](bytes),entrySteps:entry.steps,entryProbe:entry.probe,inPlayHash:(d.restore(inPlay),d.stateHash())};
  /* FRONTIER ARCHIVE (REALROM_EXPLORE=frameBudget): AGOD exploration on this research
     copy - then the best route is replayed from a fresh load with no restore and the
     stage detector watching; only that replay can show a stage transition */
  if(profile.status==='PROFILE'&&Number(process.env.REALROM_EXPLORE)>0)
   report.explore=await R.exploreRoute(built,inPlay,profile,identity,extras);
  if(profile.status==='PROFILE')report.research=await researchModes(built,profile,identity,extras);
 }
 report.totalFrames=built.framesRun();report.totalWallMs=Date.now()-t0;
 built.dispose();
 return {...report,status:'DONE'};
}

(async()=>{
 const files=fs.readdirSync(ROMS).filter(f=>EXT[path.extname(f).toLowerCase()]).sort();
 const only=option('--only',null);
 const results=[];
 for(const f of files){
  const bytes=fs.readFileSync(path.join(ROMS,f));
  if(only&&!sha(bytes).startsWith(only))continue;
  console.log('ROM sha256 %s (%d bytes)',sha(bytes).slice(0,16),bytes.length);
  try{results.push(await studyRom(path.join(ROMS,f)));}
  catch(error){results.push({romSha256:sha(bytes),status:'ERROR',error:String(error.message||error).slice(0,300)});console.log('  ERROR',error.message);}
 }
 const report={tool:'agod_realrom_check',revisions:{pipeline:Pipeline.PIPELINE_REVISION,phase:Phase.PHASE_REVISION,
  survival:Survival.SURVIVAL_REVISION,objective:Objective.OBJECTIVE_REVISION},
  privacy:'hashes, sizes and aggregates only; no ROM bytes, RAM offsets, frames or states',results};
 const out=option('--out',null);
 if(out){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,1)+'\n');console.log('report: '+out);}
})().catch(e=>{console.log('FAILED '+e.stack);process.exitCode=1;});
