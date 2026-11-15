'use strict';
// The AGOD research mechanisms (tools/agod_research.cjs), checked in CI without a
// private ROM, on the synthetic survival game (tools/agod_synthetic_game.cjs):
//   policy adapters    null / random / replay: deterministic, see only (k, frame)
//   frozen evaluation  fresh load, the delay, a disturbance; 0 restores; repeatable
//   recovery teacher   a policy that loses lives gets VERIFIED corrections from the
//                      frontier archive, from the actual diverged state; the whole
//                      trajectory replays from a fresh load with 0 restores
//   labeller (hold)    per-decision life-losing actions from exact states
//   frontier archive   a route, replayed from a fresh load with 0 restores
// No neural backend is involved anywhere: this is the stand that replaced the Male CNS
// / FDB one (archived on branch archive/gu-2be2dae-male-cns-fdb).
const fs=require('fs'),os=require('os'),path=require('path');
const R=require('./agod_research.cjs');
const {withCore}=require('./agod_synthetic_game.cjs');
const {Phase,Survival,Dto,Objective,MODULES}=R;
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agod-research-'));
R.setOracleDir(null);
for(const k of Object.keys(process.env))if(k.startsWith('REALROM_'))delete process.env[k];

(async()=>{
 /* ---- discovery on the synthetic game: entry, survival, profile ---- */
 const built=withCore({health:5});const d=built.driver;
 const entry=Phase.enter(d,{});
 ok(entry.status==='PLAYING','entry reaches play');
 const inPlay=entry.snapshot;d.restore(inPlay);
 const config={romHash:'b'.repeat(64),coreRevision:'synthetic',profileRevision:'research-check',contextKey:'synthetic'};
 const detectorRevision='research-check';
 const found=Survival.discover(d,{...config,detectorRevision,discoveryPolicies:6,horizon:3000});
 ok(found.status==='VERIFIED','survival discovery VERIFIES the resource');
 const identity={romSha256:config.romHash,platform:'synthetic',coreRevision:'synthetic',detectorRevision,
  actionSpec:built.capabilities.actionSpec,padType:null,observedRamBytes:256};
 const dto=Dto.fromPipelineResult(found,{...config,platform:'synthetic',driverRevision:'synthetic'});
 const profile=Objective.createProfile(dto,identity,MODULES);
 ok(profile.status==='PROFILE','a live objective profile: '+(profile.reason||''));
 const extras={rebuild:async()=>withCore({health:5}),entrySteps:entry.steps,entryProbe:entry.probe,inPlayHash:(d.restore(inPlay),d.stateHash())};
 const read=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'p',policy:'aggressive'}).read;
 const progressOf=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'p2',policy:'aggressive'}).readProgress;
 const floor=profile.dto.discovered.resource.floor,ended=ram=>read(ram)<=floor;
 const spec=d.actionSpec,actions=R.actionSet(spec),exploreActions=R.compositeActions(profile.dto.discovered.buttonAttribution,spec,3);
 const keyOptions={readProgress:progressOf,readResource:ram=>read(ram),positionFields:(entry.probe.axes||[]).filter(a=>a.integrators>0).map(a=>a.fields[0])};

 /* ---- policy adapters ---- */
 const seen=[];const spy=p=>Object.assign(Object.create(p),{decide:q=>{seen.push(Object.keys(q).sort().join(','));return p.decide(q);}});
 const r1=R.createPolicy('random:5',{actions}),r2=R.createPolicy('random:5',{actions});
 const a1=[],a2=[];for(let k=0;k<64;k++){a1.push((await r1.decide({k,actions})).mask);a2.push((await r2.decide({k,actions})).mask);}
 ok(JSON.stringify(a1)===JSON.stringify(a2)&&a1.every(m=>actions.includes(m))&&new Set(a1).size>2,'random:<seed> is a pure function of (seed, k) over the action set');
 ok((await R.createPolicy('null').decide({k:3})).mask===0,'null presses nothing');
 const trajFile=path.join(tmp,'traj.json');fs.writeFileSync(trajFile,JSON.stringify({masks:[1,2,4,8]}));
 const rp=R.createPolicy('replay:'+trajFile);
 ok((await rp.decide({k:2})).mask===4&&(await rp.decide({k:9})).mask===0,'replay:<file> follows the trajectory by decision index, then presses nothing');
 let threw=false;try{R.createPolicy('fdb:p0');}catch(e){threw=true;}
 ok(threw,'an unknown policy kind is refused (no hidden backend)');

 /* ---- frozen evaluation ---- */
 const perts='id=d0;id=d3,delay=3;id=x,at=30,len=6,kind=idle';
 const ev=await R.evaluatePolicy({policy:spy(R.createPolicy('random:9',{actions})),perturbations:perts,extras,read,progressOf,ended,identity,routeMasks:null,exploreActions,actions,maxFrames:3200});
 const ev2=await R.evaluatePolicy({policy:R.createPolicy('random:9',{actions}),perturbations:perts,extras,read,progressOf,ended,identity,routeMasks:null,exploreActions,actions,maxFrames:3200});
 ok(ev.length===3&&ev.every(e=>e.policy.restores===0),'frozen evaluation: three perturbations, 0 restores in every episode');
 ok(JSON.stringify(ev.map(e=>[e.policy.frames,e.policy.losses,e.policy.progress]))===JSON.stringify(ev2.map(e=>[e.policy.frames,e.policy.losses,e.policy.progress])),'frozen evaluation is repeatable');
 ok(ev[2].policy.disturbedDecisions===6,'the in-episode disturbance overrides exactly its decisions');
 ok(ev.every(e=>e.policy.levelClear==='NO_ORACLE'),'no oracle directory: the verdict is NO_ORACLE, never a guess');
 ok(seen.length>0&&seen.every(x=>x==='actions,core,k'),'the policy is asked with (k, core, actions) only - no RAM, no driver');

 /* ---- recovery teacher: the null policy loses lives; the archive corrects ---- */
 process.env.REALROM_EVIDENCE_DIR=tmp;process.env.REALROM_TEACHER_MAX='240';process.env.REALROM_TEACHER_BACK='12';
 process.env.REALROM_TEACHER_STALL='400';process.env.REALROM_TEACHER_BUDGET='60000';
 const teacher=await R.recoveryTeacher({policy:R.createPolicy('null'),actions,profile,identity,extras,read,progressOf,floor,keyOptions,spec,perturbations:'id=t1,delay=2'});
 const t=teacher[0];
 console.log('teacher: %d decisions = %d policy + %d correction; %d corrections, %d accepted, unsolved %j; replay restores %d, losses %d',
  t.decisions,t.policyDecisions,t.correctionDecisions,t.corrections,t.acceptedLosses,t.unsolved,t.replay.restores,t.replay.losses);
 ok(t.policy==='null'&&t.corrections>0,'the teacher found corrections for the failing policy ('+t.corrections+')');
 ok(t.replay.freshLoad&&t.replay.restores===0,'the whole teacher trajectory replays from a fresh load with 0 restores');
 ok(t.replay.losses<=t.acceptedLosses,'on that replay no life is lost beyond the losses the teacher accepted ('+t.replay.losses+' <= '+t.acceptedLosses+')');
 const tfile=path.join(tmp,'teacher-t1.json');
 ok(fs.existsSync(tfile),'the trajectory is written to the evidence directory');

 /* ---- labeller (hold mode) on the teacher trajectory ---- */
 process.env.REALROM_SUITABILITY=tfile;process.env.REALROM_SUIT_MODE='hold';process.env.REALROM_SUIT_H='4';
 process.env.REALROM_SUIT_RANGE='0,80';process.env.REALROM_SUIT_STRIDE='8';process.env.REALROM_SUIT_OUT=path.join(tmp,'suit');
 const lab=await R.suitabilityLabeller({actions,extras,read,progressOf});
 const hold=JSON.parse(fs.readFileSync(path.join(tmp,'suit','hold-'+'t1'+'-0-80.json'),'utf8'));
 ok(lab.length===1&&hold.mode==='hold'&&hold.lifeLost.filter(Boolean).length===10,'hold labels for every 8th decision of the trajectory (10)');
 for(const k of Object.keys(process.env))if(k.startsWith('REALROM_SUIT'))delete process.env[k];

 /* ---- frontier archive ---- */
 process.env.REALROM_EXPLORE='20000';
 const ex=await R.exploreRoute(built,inPlay,profile,identity,extras);
 ok(ex.routeStrides>0&&ex.replay.freshLoad&&ex.replay.restores===0,'the frontier archive returns a route that replays from a fresh load with 0 restores');
 delete process.env.REALROM_EXPLORE;

 fs.rmSync(tmp,{recursive:true,force:true});
 console.log(out.join('\n'));
 console.log(fail.length?'FAIL — '+fail.length+' of '+out.length:'PASS — '+out.length+'/'+out.length);
 process.exitCode=fail.length?1:0;
})().catch(e=>{console.log('FAILED '+e.stack);process.exitCode=1;});
