'use strict';
/* AGOD RESEARCH LIBRARY (research emulator only; never shipped, never a frozen agent).

   The AGOD research mechanisms that used to live inside the mixed Male CNS / FDB stand
   (tools/agod_realrom_check.cjs at 2be2dae), kept whole and without any neural backend:
     exploreRoute         frontier archive to a route, replayed from a fresh load
     recoveryTeacher      a POLICY plays from a perturbed origin; at a failure the archive
                          searches a verified correction from the actual diverged state
     suitabilityLabeller  per-decision branching labels from exact states (route / hold)
     positionController   brainless upper bound: re-locate on a route by the screen
     evaluatePolicy       frozen protocol: fresh load, no restore, stage detector, the
                          oracle opened only after the run; open-loop replay alongside
   The policy is a PolicyAdapter (createPolicy): replay of a trajectory, null, seeded
   random - and later the vision-action agent. An adapter sees decision index and frame
   (core pixels), never RAM; its save/restore exist for the teacher's checkpoints only.
   Savestates are used here, on the research copy of the emulator, and nowhere else. */
const fs=require('fs'),path=require('path'),crypto=require('crypto');
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
const STEP_FRAMES=8;
/* the oracle directory (AGOD_PRIVATE_ROMS): opened only after a run, by oracleStage() */
let ROMS=process.env.AGOD_PRIVATE_ROMS||null;
function setOracleDir(dir){ROMS=dir;}
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
function compositeActions(attribution,spec,k){
 const m=n=>(spec.buttons.find(b=>b.name===n)||{}).mask||0,dirNames=['←','→','↑','↓'];
 const dirs=[0,m('←'),m('→'),m('↑'),m('↓'),m('←')|m('↑'),m('→')|m('↑'),m('←')|m('↓'),m('→')|m('↓')];
 const btns=(attribution||[]).filter(b=>!dirNames.includes(b.name)&&!['Start','Select','Mode'].includes(b.name)&&spec.buttons.some(x=>x.name===b.name&&x.mask===b.mask))
  .sort((a,b)=>(b.gainLift||0)-(a.gainLift||0)).slice(0,k).map(b=>b.mask);
 const sets=[0,...btns];for(let i=0;i<btns.length;i++)for(let j=i+1;j<btns.length;j++)sets.push(btns[i]|btns[j]);
 const out=[];for(const d of dirs)for(const b of sets)out.push(d|b);return [...new Set(out)].slice(0,64);
}
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}
function oracleStage(romSha256){if(!ROMS)return null;const p=path.join(ROMS,'oracle.json');if(!fs.existsSync(p))return null;const e=JSON.parse(fs.readFileSync(p,'utf8'))[romSha256];return e&&Array.isArray(e.stage)&&e.stage.length?e.stage:null;}
function verifyLevelClear(stageTrace,transitions){
 if(!stageTrace)return {verdict:'NO_ORACLE'};if(!transitions.length)return {verdict:'UNVERIFIED',reason:'no stage transition candidate'};
 const start=stageTrace[0].values,t=transitions[0],lo=t.gapStart-16,hi=(t.decidedAt||t.frame)+16,last=stageTrace[stageTrace.length-1].values;
 let insideGap=true;const changed=start.map(()=>false);
 for(let k=1;k<stageTrace.length;k++)stageTrace[k].values.forEach((v,i)=>{if(v!==stageTrace[k-1].values[i]){changed[i]=true;if(stageTrace[k].frame<lo||stageTrace[k].frame>hi)insideGap=false;}});
 const plusOne=last.every((v,i)=>v===start[i]+1);
 if(!changed.some(Boolean))return {verdict:'REFUTED',reason:'the oracle stage bytes never changed'};
 return {verdict:plusOne&&insideGap?'VERIFIED':'REFUTED',stageAdvanced:plusOne,changesOnlyInsideGap:insideGap,heldToEnd:plusOne};
}
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
async function positionController(ctx){
 const {extras,read,progressOf,ended,identity,exploreActions,routeMasks,maxDecisions}=ctx;
 const GW=Observation.GW,GH=Observation.GH,C=16,Rr=12;
 const pool=g=>{const o=new Float64Array(C*Rr),n=new Float64Array(C*Rr);for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const i=Math.floor(y*Rr/GH)*C+Math.floor(x*C/GW);o[i]+=g[y*GW+x];n[i]++;}return o.map((v,i)=>v/n[i]);};
 const buf=fs.readFileSync(process.env.REALROM_DIAG_FRAMES),T=buf.length/(4*GW*GH);
 const ref=Array.from({length:T},(_,t)=>pool(new Float32Array(buf.buffer,buf.byteOffset+t*4*GW*GH,GW*GH)));
 const sets=[];for(const f of process.env.REALROM_DIAG_SETS.split(';').filter(Boolean)){const u=JSON.parse(fs.readFileSync(f,'utf8'));u.suitable.forEach((x,k)=>{if(x)sets[k]=x;});}
 const freq=new Map();for(const x of sets)if(x)for(const a of x)freq.set(a,(freq.get(a)||0)+1);
 const constA=[...freq.entries()].sort((a,b)=>b[1]-a[1])[0][0];
 const vote=(c,W)=>{const sc=new Map();for(let k=Math.max(0,c-W);k<=Math.min(sets.length-1,c+W);k++)if(sets[k])for(const a of sets[k])sc.set(a,(sc.get(a)||0)+1);
  let b=constA,bs=-1;for(const [a,v] of sc){const s=v+1e-6*(freq.get(a)||0);if(s>bs){bs=s;b=a;}}return b;};
 const d2=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=(a[i]-b[i])**2;return s;};
 /* REALROM_DIAG_CLOCK=x: leaving the expected next decision costs x times the route's
    median screen change per decision - so the tracker advances with time and re-syncs
    only on a clearly better match; 0 = screen only (identical screens to the next) */
 const steps=[];for(let t=0;t+1<T;t++)steps.push(d2(ref[t],ref[t+1]));steps.sort((a,b)=>a-b);
 const LAMBDA=Math.max(1e-7,Number(process.env.REALROM_DIAG_CLOCK||0)*(steps[steps.length>>1]||0));
 const out=[];
 for(const p of parsePerturbations(process.env.REALROM_DIAG_EVAL))for(const mode of (process.env.REALROM_DIAG_MODES||'route,vote8').split(',')){
  const b=await extras.rebuild(),d=b.driver;Phase.replayEntry(d,extras.entrySteps);if(p.delay)d.run(0,p.delay);
  const mon=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const dims=Observation.dims(b.core)||[256,224];
  const sa=oracleStage(identity.romSha256),st=[];if(sa)st.push({frame:0,values:sa.map(a=>d.readRam()[a])});
  const dr=p.disturb?rng(p.disturb.seed*7919+13):null;
  let pos=-1,fr=0,los=0,prog=0,isEnded=false,last=0,best=0,bestAt=0,stalled=false;const W=Number((mode.match(/^vote(\d+)$/)||[])[1]||0);
  for(let k=0;k<maxDecisions;k++){
   /* the screen before decision k; identical screens go to the expected next decision */
   const g=Observation.grid(b.core);if(g){const f=pool(g);let bi=pos+1,bd=Infinity;for(let i=Math.max(0,pos-8);i<=Math.min(T-1,pos+48);i++){const e=d2(f,ref[i])+LAMBDA*Math.abs(i-pos-1);if(e<bd){bd=e;bi=i;}}pos=bi;}
   const inD=p.disturb&&k>=p.disturb.at&&k<p.disturb.at+p.disturb.len;
   const m=inD?(p.disturb.kind==='idle'?0:p.disturb.kind==='hold'?last:exploreActions[Math.floor(dr()*exploreActions.length)])
    :mode==='blind'?routeMasks[Math.min(routeMasks.length-1,k)]:mode==='route'?routeMasks[Math.max(0,Math.min(routeMasks.length-1,pos))]:mode==='const'?constA:vote(Math.max(0,pos),W);last=m;
   const bf=d.readRam();d.run(m,STEP_FRAMES);fr+=STEP_FRAMES;const af=d.readRam();if(read(af)<read(bf))los+=read(bf)-read(af);
   const pb=progressOf(bf),pa=progressOf(af);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])prog+=pa[i]-pb[i];
   mon.observe({mask:m,ramBefore:bf,ramAfter:af,signature:Stage.signature(b.core.pixels,dims[0],dims[1]),scene:Stage.palette(b.core.pixels,dims[0],dims[1])});
   if(sa)st.push({frame:fr,values:sa.map(x=>af[x])});
   if(prog>best){best=prog;bestAt=k;}if(k-bestAt>Number(process.env.REALROM_DIAG_STALL||2500)){stalled=true;break;}
   if(ended(af)){isEnded=true;break;}if(mon.transitions().length)break;}
  const v=verifyLevelClear(sa?st:null,mon.transitions());b.dispose();
  const r={id:p.id,delay:p.delay,disturb:p.disturb,mode,levelClear:v.verdict,ended:isEnded,stalled,losses:los,progress:prog,decisions:fr/STEP_FRAMES,lastRoutePosition:pos};out.push(r);
  console.log('  POSITION-DIAG %s (delay %d%s) %s: %s, game over %s, stalled %s, losses %d, progress %d, decisions %d, route position %d of %d',p.id,p.delay,p.disturb?', '+p.disturb.kind+'@'+p.disturb.at+'x'+p.disturb.len:'',mode,v.verdict,isEnded,stalled,los,prog,fr/STEP_FRAMES,pos,T-1);}
 return {kind:'diagnostic upper bound - reads the route; not the agent',results:out};
}
async function suitabilityLabeller(ctx){
 const {actions,extras,read,progressOf}=ctx;
 const crypto=require('crypto');
 const H=Number(process.env.REALROM_SUIT_H||16),out=process.env.REALROM_SUIT_OUT;fs.mkdirSync(out,{recursive:true});
 const files=process.env.REALROM_SUITABILITY.split(';').filter(Boolean);
 const counterFiles=[...files,...String(process.env.REALROM_SUIT_COUNTERS_FROM||'').split(';').filter(Boolean)];
 const counters=[...new Set(counterFiles.flatMap(f=>(JSON.parse(fs.readFileSync(f,'utf8')).corrections||[]).flatMap(c=>c.counters||[])))];
 const [from0,to0]=String(process.env.REALROM_SUIT_RANGE||'0,1e9').split(',').map(Number),STRIDE=Math.max(1,Number(process.env.REALROM_SUIT_STRIDE||1));
 const HOLD=process.env.REALROM_SUIT_MODE==='hold';
 const total=t=>t.value.reduce((a,v)=>a+(Number.isFinite(v)?v:0),0);
 const fall=(b,a)=>{let d=0;for(const ad of counters){const f=b[ad]-a[ad];if(f>0&&f<=16)d+=f;}return Math.min(d,16);};
 const ramKey=ram=>crypto.createHash('sha1').update(Buffer.from(ram)).digest('hex');
 const fullKey=d=>crypto.createHash('sha1').update(Buffer.from(d.snapshot().bytes)).digest('hex');
 const results=[];
 for(const f of files){
  const t=JSON.parse(fs.readFileSync(f,'utf8')),p=t.perturbation||{id:'reference',delay:0},kinds=t.kinds||t.masks.map(()=>'R'),M=t.masks,N=M.length;
  if(JSON.stringify(t.entrySteps)!==JSON.stringify(extras.entrySteps))throw Error('suitability: another entry');
  const from=Math.max(0,from0),to=Math.min(N,to0);
  const b=await extras.rebuild(),d=b.driver;Phase.replayEntry(d,extras.entrySteps);if(p.delay)d.run(0,p.delay);
  /* pass 1: the trajectory's own course - lives, progress, cumulative damage, RAM key */
  const lives=new Float64Array(N+1),prog=new Float64Array(N+1),dmg=new Float64Array(N+1),rk=new Array(N+1);
  let track=Explore.unwrapStep(null,progressOf(d.readRam())||[],true);let ram=d.readRam();lives[0]=read(ram);prog[0]=total(track);rk[0]=ramKey(ram);
  const t1=Date.now();
  /* DIAGNOSTIC (REALROM_SUIT_FRAMES=dir): the screen the learner would face at each
     decision, as the encoder's GW x GH luminance grid, Float32 per decision - private
     evidence for an offline test of what an observation can tell; never committed */
  const framesDir=process.env.REALROM_SUIT_FRAMES,frameFd=framesDir?(fs.mkdirSync(framesDir,{recursive:true}),fs.openSync(path.join(framesDir,'grid-'+p.id+'.f32'),'w')):null;
  const dumpFrame=()=>{if(frameFd===null)return;const g=Observation.grid(b.core)||new Float32Array(Observation.GW*Observation.GH);fs.writeSync(frameFd,Buffer.from(g.buffer,g.byteOffset,g.byteLength));};
  dumpFrame();
  for(let k=0;k<N;k++){const bf=ram;d.run(M[k],STEP_FRAMES);ram=d.readRam();track=Explore.unwrapStep(track,progressOf(ram)||[],true);
   lives[k+1]=read(ram);prog[k+1]=total(track);dmg[k+1]=dmg[k]+fall(bf,ram);rk[k+1]=ramKey(ram);dumpFrame();}
  if(frameFd!==null){fs.closeSync(frameFd);console.log('  suitability %s: %d frames of %dx%d written',p.id,N+1,Observation.GW,Observation.GH);}
  if(process.env.REALROM_SUIT_PASS1_ONLY==='1'){b.dispose();continue;}
  const pass1=(Date.now()-t1)/1000;
  /* pass 2: from each decision's exact state, every action */
  b.dispose();const b2=await extras.rebuild(),d2=b2.driver;Phase.replayEntry(d2,extras.entrySteps);if(p.delay)d2.run(0,p.delay);
  let tr2=Explore.unwrapStep(null,progressOf(d2.readRam())||[],true);
  const trAt=[];const suitable=new Array(N).fill(null),lifeLost=new Array(N).fill(null);const stat={asked:0,branches:0,converged:0,lifeLost:0,behind:0,suitable:0,steps:0};const t2=Date.now();
  for(let k=0;k<to;k++){
   /* REALROM_SUIT_MODE=hold: IMMINENT DANGER only - each action held for H decisions from the
      exact state, no route continuation; lifeLost = the actions that lost a life, no suitable set */
   if(HOLD&&k>=from&&kinds[k]!=='D'&&k%STRIDE===0){stat.asked++;const here=d2.snapshot(),lost=[];
    for(const a of actions){stat.branches++;d2.restore(here);for(let j=0;j<H;j++){d2.run(a,STEP_FRAMES);stat.steps++;if(read(d2.readRam())<lives[k]){lost.push(a);stat.lifeLost++;break;}}}
    d2.restore(here);lifeLost[k]=lost.sort((x,y)=>x-y);}
   else if(k>=from&&kinds[k]!=='D'&&k%STRIDE===0){stat.asked++;const here=d2.snapshot(),trHere=tr2,set=[M[k]],lost=[];
    for(const a of actions){if(a===M[k])continue;stat.branches++;d2.restore(here);let tr=trHere,ok=true,dm=0,r0=d2.readRam(),conv=false;
     const end=Math.min(N,k+1+H);
     for(let j=k;j<end;j++){const bf=r0;d2.run(j===k?a:M[j],STEP_FRAMES);stat.steps++;r0=d2.readRam();tr=Explore.unwrapStep(tr,progressOf(r0)||[],true);dm+=fall(bf,r0);
      if(read(r0)<lives[j+1]){ok=false;stat.lifeLost++;lost.push(a);break;}
      if(ramKey(r0)===rk[j+1]){/* RAM equal: confirm on the whole state against the trajectory's own */
       const mine=fullKey(d2);if(!trAt[j+1]){const s=d2.snapshot();d2.restore(here);for(let i=k;i<=j;i++)d2.run(M[i],STEP_FRAMES);trAt[j+1]=fullKey(d2);d2.restore(s);}
       if(mine===trAt[j+1]){conv=true;break;}}}
     if(conv){stat.converged++;set.push(a);continue;}
     if(!ok)continue;
     const jEnd=Math.min(N,k+1+H);if(total(tr)+dm>=prog[jEnd]-prog[k]+total(trHere)+(dmg[jEnd]-dmg[k])){set.push(a);}else stat.behind++;}
    d2.restore(here);suitable[k]=set.sort((x,y)=>x-y);lifeLost[k]=lost.sort((x,y)=>x-y);stat.suitable+=set.length;}
   const bf=d2.readRam();d2.run(M[k],STEP_FRAMES);tr2=Explore.unwrapStep(tr2,progressOf(d2.readRam())||[],true);
   if(k%250===0&&k>=from)console.log('  suitability %s: decision %d of %d, mean suitable %s of %d, %s s',p.id,k,to,(stat.suitable/Math.max(1,stat.asked)).toFixed(1),actions.length,((Date.now()-t2)/1000).toFixed(0));}
  b2.dispose();
  const sizes=suitable.filter(Boolean).map(s=>s.length),only=sizes.filter(x=>x===1).length;
  const freq={};for(const s of suitable)if(s)for(const a of s)freq[a]=(freq[a]||0)+1;
  const r={id:p.id,file:path.basename(f),stride:STRIDE,traceSha256:crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(M).buffer)).digest('hex'),range:[from,to],horizon:H,actions,counters:counters.length,stat,
   meanSuitable:sizes.reduce((a,x)=>a+x,0)/Math.max(1,sizes.length),onlyOwn:only,pass1Seconds:pass1,seconds:(Date.now()-t2)/1000,suitable,
   /* the actions whose branch lost a life the trajectory kept (a subset of the unsuitable) */lifeLost};
  fs.writeFileSync(path.join(out,(HOLD?'hold-':'suit-')+p.id+'-'+from+'-'+to+'.json'),JSON.stringify(Object.assign(r,{mode:HOLD?'hold':'route-continuation'})));
  const top=Object.entries(freq).sort((x,y)=>y[1]-x[1]).slice(0,6).map(([a,n])=>a+':'+(100*n/sizes.length).toFixed(0)+'%');
  console.log('  SUITABILITY %s [%d,%d) H %d: %d asked, mean %s of %d actions suitable, only the own action %d; branches %d (converged %d, life lost %d, behind %d); most often suitable %s | %s s',
   p.id,from,to,H,stat.asked,r.meanSuitable.toFixed(1),actions.length,only,stat.branches,stat.converged,stat.lifeLost,stat.behind,top.join(' '),r.seconds.toFixed(0));
  results.push(Object.assign({},r,{suitable:undefined,lifeLost:undefined}));}
 return results;
}
async function recoveryTeacher(ctx){
 const {policy,actions,profile,identity,extras,read,progressOf,floor,keyOptions,spec}=ctx;
 if(!policy)throw new Error('recoveryTeacher needs a policy adapter (REALROM_POLICY)');
 const perts=parsePerturbations(ctx.perturbations||process.env.REALROM_TEACHER);
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
  await policy.begin({perturbation:p,core:tb.core,actions});
  const masks=[],kinds=[],corrections=[],accepted=[];const failures={loss:0,stall:0};let unsolved=null,searchFrames=0,slotSeq=0;
  /* damage counters the corrections' archives established causally; a fall in one of
     them (1..16) counts as progress for the stall clock, so a fight the policy is
     winning is not a stall - and a fight it only survives is one. */
  const knownCounters=new Set();
  let track=Explore.unwrapStep(null,progressOf(td.readRam())||[],true),best=total(track),lastGain=0;
  const ckpts=[];
  const saveCk=async()=>{const slot=++slotSeq;await policy.save(slot);ckpts.push({stride:masks.length,emu:td.snapshot(),slot,track,best,lastGain});
   while(ckpts.length>KEEP+1){const x=ckpts.splice(1,1)[0];await policy.drop(x.slot);}};
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
     await policy.decide({k:masks.length,core:tb.core,actions});
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
    const r=await policy.decide({k:masks.length,core:tb.core,actions});
    const inD=p.disturb&&k>=p.disturb.at&&k<dEnd;
    o=await step(inD?disturbMask(k):r.mask,inD?'D':'P');
    stalled=masks.length-lastGain>=STALL;}
   if(o.lost||stalled){
    const f=masks.length,type=o.lost?'loss':'stall';failures[type]++;
    const progAtF=best;
    const failState={emu:td.snapshot(),slot:900000+f};await policy.save(failState.slot);
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
     td.restore(failState.emu);await policy.restore(failState.slot);await policy.drop(failState.slot);
     for(let i=Math.max(0,f-BACK);i<f;i++)if(kinds[i]==='P')kinds[i]='X';
     accepted.push({failure:f,type,statesTried:tries.length,searchFrames:triedFrames});lastGain=masks.length;
     console.log('  teacher %s: %s at decision %d ACCEPTED (no correction from %d states, %d frames); %d decisions before it left unlabelled',p.id,type,f,tries.length,triedFrames,Math.min(BACK,f));
     continue;
    }
    await policy.drop(failState.slot);
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
    masks.length=c.stride;kinds.length=c.stride;td.restore(c.emu);await policy.restore(c.slot);
    while(ckpts.length&&ckpts[ckpts.length-1].stride>c.stride){const x=ckpts.pop();await policy.drop(x.slot);}
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
     const r=await policy.decide({k:masks.length,core:tb.core,actions});
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
  await policy.end();
  const count=kd=>kinds.filter(x=>x===kd).length;
  const traceSha=crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(masks).buffer)).digest('hex');
  const res={id:p.id,policy:policy.id,delay:p.delay,disturb:p.disturb,decisions:masks.length,policyDecisions:count('P'),correctionDecisions:count('C'),disturbanceDecisions:count('D'),
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

/* ===== POLICY ADAPTERS =====
   createPolicy(spec, {routeMasks, actions})
     null            every decision presses nothing
     route           the reference route (REALROM_ROUTE) by decision index - open loop
     replay:<file>   any trajectory file ({masks}) by decision index - open loop
     random:<seed>   a seeded choice among the actions, a pure function of (seed, k)
   Interface: begin({perturbation, core, actions}), decide({k, core, actions}) -> {mask},
   save(slot) / restore(slot) / drop(slot) for the teacher's checkpoints, end().
   decide() gets the decision index and the core (its frame), never RAM. These adapters
   are stateless (a function of k), so save/restore only record that they were asked. */
function createPolicy(spec,options){
 const o=options||{};const text=String(spec||'').trim();
 if(!text)throw new Error('a policy spec is required (null | route | replay:<file> | random:<seed>)');
 const stats={decisions:0,saves:0,restores:0};
 const base=(id,kind,choose)=>({id,kind,stats,
  async begin(){},async end(){},
  async decide(q){stats.decisions++;return {mask:choose(q.k,q.actions||o.actions||[])};},
  async save(){stats.saves++;},async restore(){stats.restores++;},async drop(){}});
 if(text==='null')return base('null','null',()=>0);
 if(text==='route'||text.startsWith('replay:')){
  const masks=text==='route'?o.routeMasks:JSON.parse(fs.readFileSync(text.slice(7),'utf8')).masks;
  if(!Array.isArray(masks)||!masks.length)throw new Error('policy '+text+': no trajectory');
  const digest=crypto.createHash('sha256').update(Buffer.from(Uint16Array.from(masks).buffer)).digest('hex').slice(0,16);
  return base('replay:'+digest,'replay',k=>k<masks.length?masks[k]:0);
 }
 if(text.startsWith('random:')){
  const seed=Number(text.slice(7))>>>0;
  const pick=(k,acts)=>{if(!acts.length)return 0;let h=(seed*2654435761+k*40503+0x9e3779b9)>>>0;h=(h^(h>>>16))>>>0;h=Math.imul(h,0x45d9f3b)>>>0;h=(h^(h>>>16))>>>0;return acts[h%acts.length];};
  return base('random:'+seed,'random',pick);
 }
 throw new Error('unknown policy spec '+text);
}

/* ===== FROZEN POLICY EVALUATION (research copy; the directive's frozen protocol) =====
   For each perturbation (the teacher's syntax): the policy plays from a FRESH load -
   entry replayed, the delay, then decisions every STEP_FRAMES frames; an in-episode
   disturbance overrides its action (it keeps being asked). The driver's restore is
   counted (must stay 0), nothing is trained, the oracle is opened only after the run.
   With a route, the route is replayed open loop under the same perturbation. */
async function evaluatePolicy(ctx){
 const {policy,extras,read,progressOf,ended,identity,routeMasks,exploreActions,actions}=ctx;
 const maxFrames=Number(ctx.maxFrames||process.env.REALROM_FULL_EPISODE||40800);
 const out=[];
 for(const p of parsePerturbations(ctx.perturbations||process.env.REALROM_EVAL)){
  const mkDist=()=>p.disturb?{...p.disturb,pick:(r=>()=>exploreActions[Math.floor(r()*exploreActions.length)])(rng(p.disturb.seed*7919+13))}:null;
  const fresh=await extras.rebuild(),fd=fresh.driver;Phase.replayEntry(fd,extras.entrySteps);if(p.delay)fd.run(0,p.delay);
  let restores=0;const realRestore=fd.restore.bind(fd);fd.restore=x=>{restores++;return realRestore(x);};
  const monitor=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const dims=Observation.dims(fresh.core)||[256,224];
  const sa=oracleStage(identity.romSha256),st=[];if(sa)st.push({frame:0,values:sa.map(a=>fd.readRam()[a])});
  await policy.begin({perturbation:p,core:fresh.core,actions});
  const dd=mkDist();let frames=0,losses=0,progress=0,isEnded=false,last=0,disturbed=0,firstDivergence=null;const lat=[];
  for(let k=0;frames<maxFrames;k++){
   const t=Date.now();const r=await policy.decide({k,core:fresh.core,actions});lat.push(Date.now()-t);
   const inD=dd&&k>=dd.at&&k<dd.at+dd.len;const m=inD?(dd.kind==='idle'?0:dd.kind==='hold'?last:dd.pick()):r.mask;last=m;if(inD)disturbed++;
   if(firstDivergence===null&&routeMasks&&k<routeMasks.length&&r.mask!==routeMasks[k])firstDivergence=k;
   const b=fd.readRam();fd.run(m,STEP_FRAMES);frames+=STEP_FRAMES;const a=fd.readRam();if(read(a)<read(b))losses+=read(b)-read(a);
   const pb=progressOf(b),pa=progressOf(a);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])progress+=pa[i]-pb[i];
   monitor.observe({mask:m,ramBefore:b,ramAfter:a,signature:Stage.signature(fresh.core.pixels,dims[0],dims[1]),scene:Stage.palette(fresh.core.pixels,dims[0],dims[1])});
   if(sa)st.push({frame:frames,values:sa.map(x=>a[x])});if(ended(a)){isEnded=true;break;}}
  await policy.end();
  const v=verifyLevelClear(sa?st:null,monitor.transitions());fresh.dispose();
  const q=x=>{const s2=[...lat].sort((u,w)=>u-w);return s2.length?s2[Math.min(s2.length-1,Math.floor(x*s2.length))]:null;};
  const entry={id:p.id,delay:p.delay,disturb:p.disturb,policy:{id:policy.id,levelClear:v.verdict,ended:isEnded,losses,frames,progress,restores,
   disturbedDecisions:disturbed,firstDivergenceFromRoute:firstDivergence,decisionLatencyMs:{p50:q(.5),p95:q(.95)}}};
  if(routeMasks){
   /* blind replay: the route's own actions, the same delay and disturbance */
   const ob=await extras.rebuild(),od=ob.driver;Phase.replayEntry(od,extras.entrySteps);if(p.delay)od.run(0,p.delay);
   const omon=Stage.createMonitor({probe:extras.entryProbe,readResource:ram=>read(ram)});const odims=Observation.dims(ob.core)||[256,224];
   const st2=[];if(sa)st2.push({frame:0,values:sa.map(a=>od.readRam()[a])});
   const d2=mkDist();let ofr=0,olos=0,oprog=0,oended=false,olast=0;
   for(let k=0;k<routeMasks.length&&ofr<maxFrames;k++){const inD=d2&&k>=d2.at&&k<d2.at+d2.len;const m=inD?(d2.kind==='idle'?0:d2.kind==='hold'?olast:d2.pick()):routeMasks[k];olast=m;
    const b=od.readRam();od.run(m,STEP_FRAMES);ofr+=STEP_FRAMES;const a=od.readRam();if(read(a)<read(b))olos+=read(b)-read(a);
    const pb=progressOf(b),pa=progressOf(a);for(let i=0;i<pb.length;i++)if(Number.isFinite(pb[i])&&Number.isFinite(pa[i])&&pa[i]>pb[i])oprog+=pa[i]-pb[i];
    omon.observe({mask:m,ramBefore:b,ramAfter:a,signature:Stage.signature(ob.core.pixels,odims[0],odims[1]),scene:Stage.palette(ob.core.pixels,odims[0],odims[1])});
    if(sa)st2.push({frame:ofr,values:sa.map(x=>a[x])});if(ended(a)){oended=true;break;}}
   const ov=verifyLevelClear(sa?st2:null,omon.transitions());ob.dispose();
   entry.openLoop={levelClear:ov.verdict,ended:oended,losses:olos,frames:ofr,progress:oprog};
  }
  out.push(entry);
  console.log('  EVAL %s (delay %d%s): policy %s %s, game over %s, losses %d, progress %d, restores %d%s',p.id,p.delay,
   p.disturb?', '+p.disturb.kind+'@'+p.disturb.at+'x'+p.disturb.len:'',policy.id,entry.policy.levelClear,isEnded,losses,progress,restores,
   entry.openLoop?' | open-loop replay '+entry.openLoop.levelClear+', game over '+entry.openLoop.ended+', losses '+entry.openLoop.losses+', progress '+entry.openLoop.progress:'');
 }
 return out;
}

const decisionPrior=(attribution,spec,weight)=>Objective.decisionPrior(attribution,spec,weight);
module.exports={STEP_FRAMES,EXT,sha,BUILD,MODULES,PD,Pipeline,Dto,Objective,Phase,Survival,Stage,Explore,Observation,
 setOracleDir,oracleStage,verifyLevelClear,parsePerturbations,packDriver,rng,actionSet,compositeActions,decisionPrior,
 createPolicy,exploreRoute,recoveryTeacher,suitabilityLabeller,positionController,evaluatePolicy};
