'use strict';
// Phase detection, entry into play and survival discovery on a synthetic game
// that behaves like the commercial cartridges they were built against, so the
// mechanism is checked in CI without a private ROM.
//
// THE GAME (pure JS, deterministic, snapshot/restore by value, 256 bytes RAM):
//   title     Start leaves it (thousands of... here: most bytes rewritten)
//   menu      a cursor: Left/Right move it by one, A confirms
//   play      the player at (x,y) moves 2 px/frame, clipped to the arena;
//             enemies home in on the player; contact costs one health point
//             and 24 frames of knock-back (no control); health 0 is death:
//             control is lost for good and a GAME OVER screen waits for Start
//             A fires: an enemy in the player's column is destroyed and the
//             two-byte score rises by 30 (low byte carries into the high)
//   distractors, each the kind that fooled a first version on real ROMs:
//             CLOCK  a byte that falls every 64 frames whatever the player does
//             FADE   a byte that counts down 4..0 only AFTER death
//             RNG    a byte the pad perturbs (polling advances it)
// The oracle (which byte is health, which is the score) is a constant of this
// file and is consulted only after discovery has answered.
const path=require('path');
const A=path.resolve(__dirname,'..','app/src/main/assets/lab');
for(const f of ['agod-ram.js','agod-reward.js','agod-evidence.js','agod-goal-dto.js','agod-objective.js','agod-phase.js','agod-survival.js'])require(path.join(A,f));
const Phase=globalThis.FlyAgodPhase,Survival=globalThis.FlyAgodSurvival,Dto=globalThis.FlyAgodGoalDto,
 Objective=globalThis.FlyAgodObjective;
const MODULES={Dto,Reward:globalThis.FlyAgodReward,Evidence:globalThis.FlyAgodEvidence,Ram:globalThis.FlyAgodRam};
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};

/* RAM layout - the ORACLE, read only after discovery */
const {R,BUTTONS,game}=require('./agod_synthetic_game.cjs');

/* ---- 1. phase ---- */
const d=game();
d.run(0,10);
const title=Phase.probe(d);
ok(title.phase==='MENU','the title is a MENU (got '+title.phase+'), Start advances it: '
 +JSON.stringify(title.advance.slice(0,1)));
d.run(8,4);d.run(0,10);
const menu=Phase.probe(d);
ok(menu.phase!=='PLAYING','a cursor menu is not PLAYING (got '+menu.phase+'; directions move a cursor by one, not further the longer they are held)');
/* ---- 2. entry ---- */
const fresh=game();
const entry=Phase.enter(fresh,{});
ok(entry.status==='PLAYING','entry from power-on reaches PLAYING with no script ('+entry.steps.map(s=>s.kind+(s.button?':'+s.button:'')).join(' ')+')');
ok(entry.probe&&entry.probe.controlledAxes.length===2,'both axes are under control in play: '+JSON.stringify(entry.probe&&entry.probe.controlledAxes));
let threw=false;try{Phase.probe(fresh,{port:2});}catch(e){threw=/second controller/.test(e.message);}
ok(threw,'a one-port driver refuses a port-2 probe instead of silently driving port 1');
/* ---- 3. survival ---- */
fresh.restore(entry.snapshot);
const found=Survival.discover(fresh,{romHash:'a'.repeat(64),coreRevision:'synthetic',profileRevision:'survival-check',
 contextKey:'synthetic',discoveryPolicies:6,horizon:3000});
console.log('survival: %s %s %s',found.status,found.stage,found.reason||'');
for(const t of found.trace)if(t.stage!=='candidates')console.log('   '+JSON.stringify(t).slice(0,200));
ok(found.status==='VERIFIED','survival discovery VERIFIES a goal');
const chosen=found.resource?found.resource.address:null;
/* the oracle, opened now */
ok(chosen===R.HEALTH,'the verified resource is HEALTH (got '+chosen+')');
ok(chosen!==R.CLOCK,'not the CLOCK, which falls on the same frames under every policy');
ok(chosen!==R.FADE,'not the FADE, which counts down only after control is gone');
const progress=(found.discovered&&found.discovered.progressFields||[]);
const covers=(f,a)=>a>=f.address&&a<f.address+f.width;
ok(progress.some(f=>covers(f,R.SCORE_LO)),'the score is progress: '+JSON.stringify(progress.map(f=>[f.address,f.width,f.endian])));
ok(progress.some(f=>covers(f,R.SCORE_LO)&&f.width===2&&f.address===R.SCORE_HI&&f.endian==='big'),
 'and as a two-byte big-endian word, because its low byte carries into the high byte');
ok(!progress.some(f=>covers(f,R.X)||covers(f,R.Y)),'player position is not progress');
ok(!progress.some(f=>covers(f,R.RNG)),'the pad-perturbed RNG byte is not progress');
ok((found.verdicts||[]).length===2&&found.verdicts.every(v=>v.outcome==='confirmed'),
 'calibration and holdout, from starts of their own origin, both confirm: '+JSON.stringify((found.verdicts||[]).map(v=>v.group+':'+v.outcome)));
/* ---- 3b. which button does the game pay for? ---- */
const attribution=(found.discovered&&found.discovered.buttonAttribution)||[];
const ranked=attribution.filter(b=>b.gainLift!==null).sort((a,b)=>b.gainLift-a.gainLift);
console.log('button attribution (gain lift): '+ranked.map(b=>b.name+' '+b.gainLift).join(', '));
ok(ranked.length>0&&ranked[0].name==='A'&&ranked[0].gainLift>1.2,
 'the button held before score rises is A, the only one that scores (lift '+(ranked[0]&&ranked[0].gainLift)+')');
const prior=Objective.decisionPrior(attribution,fresh.actionSpec,2);
ok(prior&&prior.actions.includes(0)&&prior.actions.includes(1)&&prior.actions.includes(64|1),
 'the decision prior keeps the default set (nothing, A, a direction with A): '+JSON.stringify(prior&&prior.actions));
ok(prior&&prior.priors.some(p=>p.button==='A'),'and biases toward A, the button the game pays for: '+JSON.stringify(prior&&prior.priors.map(p=>p.button)));
ok(Objective.decisionPrior([{name:'A',mask:1,gainLift:1.0,gainEvents:50}],fresh.actionSpec,2)===null,
 'no button above the lift threshold: no prior at all');
/* ---- 3c. HP that cannot run out within the horizon: found through hit-stuns ---- */
{const tough=game({health:200,invulnerable:90});
 const e2=Phase.enter(tough,{});tough.restore(e2.snapshot);
 const hp=Survival.discover(tough,{romHash:'b'.repeat(64),coreRevision:'synthetic',profileRevision:'survival-check',
  contextKey:'synthetic-hp',discoveryPolicies:6,horizon:3000});
 const stuns=(hp.trace||[]).filter(t=>t.stage==='rollout').reduce((n,t)=>n+(t.stuns||0),0);
 console.log('HP game: %s %s kind=%s stuns=%d rare=%j',hp.status,hp.stage,hp.judgement&&hp.judgement.kind,stuns,hp.discovered&&hp.discovered.rareCells);
 ok(stuns>0,'the authority tracker sees hit-stuns while the player is pressing ('+stuns+')');
 ok(hp.status==='VERIFIED'&&hp.resource&&hp.resource.address===R.HEALTH&&hp.judgement.kind==='HIT_POINTS',
  'with no game over in reach, HEALTH is still VERIFIED, as hit points (got '+(hp.resource&&hp.resource.address)+' '+(hp.judgement&&hp.judgement.kind)+')');}
/* ---- 4. into the reward path ---- */
const dto=Dto.fromPipelineResult(found,{romHash:'a'.repeat(64),coreRevision:'synthetic',profileRevision:'survival-check',contextKey:'synthetic',platform:'synthetic'});
const valid=Dto.validate(dto,{});
ok(valid.valid,'the survival result is a valid goal record: '+valid.problems.join('; '));
const identity={romSha256:'a'.repeat(64),platform:'synthetic',coreRevision:'synthetic',detectorRevision:Survival.SURVIVAL_REVISION,
 actionSpec:{buttonCount:8},padType:null,observedRamBytes:256};
const profile=Objective.createProfile(dto,identity,MODULES);
ok(profile.status==='PROFILE'&&profile.progress.length>=1,'it becomes an objective profile with progress fields ('+(profile.reason||profile.progress.length)+')');
if(profile.status==='PROFILE'){
 const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'s',policy:'aggressive'});
 const before=new Uint8Array(256),after=new Uint8Array(256);
 before[R.HEALTH]=3;after[R.HEALTH]=2;
 const loss=live.observe({ramBefore:before,ramAfter:after,endFrame:8,requestedMask:1,executed:{mask:1,frames:8,complete:true,manualOverride:false},phase:'PLAYING'});
 ok(loss.status==='VERIFIED'&&loss.value===-1,'a health point lost pays VERIFIED -1 (got '+loss.status+' '+loss.value+')');
 const b2=new Uint8Array(256),a2=new Uint8Array(256);b2[R.HEALTH]=a2[R.HEALTH]=3;b2[R.SCORE_LO]=250;a2[R.SCORE_LO]=24;a2[R.SCORE_HI]=1;
 const gain=live.observe({ramBefore:b2,ramAfter:a2,endFrame:16,requestedMask:1,executed:{mask:1,frames:8,complete:true,manualOverride:false},phase:'PLAYING'});
 ok(gain.status==='PROVISIONAL'&&gain.value>0,'a score gain across the low-byte carry pays PROVISIONAL (got '+gain.status+')');
 const idle=live.observe({ramBefore:b2,ramAfter:b2,endFrame:24,requestedMask:0,executed:{mask:0,frames:8,complete:true,manualOverride:false},phase:'PLAYING'});
 ok(idle.status==='UNKNOWN'&&!('value' in idle),'an interval with neither is UNKNOWN with no value');
}
/* ---- 5. signed resource read ---- */
const Ram=globalThis.FlyAgodRam;
ok(Ram.decode(Uint8Array.of(255),{address:0,width:1,endian:'little',encoding:'binary',signed:true})===-1
 &&Ram.decode(Uint8Array.of(255),{address:0,width:1,endian:'little',encoding:'binary'})===255,
 'a field seen crossing zero is read signed (255 -> -1) only when the spec says so');

console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length)process.exitCode=1;
