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
const R={MODE:0,CURSOR:1,X:2,Y:3,HEALTH:4,STUN:5,SCORE_HI:6,SCORE_LO:7,CLOCK:8,FADE:9,RNG:10,TIMER:11,
 DEAD:12,ENEMY:16};/* enemies: 4 x (x,y,alive) from 16 */
const BUTTONS=['A','B','C','Start','↑','↓','←','→'];
function game(){
 let ram=new Uint8Array(256);
 const boot=()=>{ram.fill(0);ram[R.MODE]=0;for(let i=32;i<256;i++)ram[i]=(i*37)&255;};
 boot();
 const startPlay=()=>{
  ram[R.MODE]=2;ram[R.X]=120;ram[R.Y]=180;ram[R.HEALTH]=5;ram[R.STUN]=0;ram[R.SCORE_HI]=0;ram[R.SCORE_LO]=0;
  ram[R.CLOCK]=200;ram[R.FADE]=4;ram[R.TIMER]=0;ram[R.DEAD]=0;
  for(let e=0;e<4;e++){ram[R.ENEMY+e*3]=30+e*60;ram[R.ENEMY+e*3+1]=10+e*7;ram[R.ENEMY+e*3+2]=1;}
  for(let i=32;i<256;i++)ram[i]=0;
 };
 let last=0;
 function frame(mask){
  const pressed=mask&~last;last=mask;
  ram[R.RNG]=(ram[R.RNG]*5+1+(mask&0xf0?3:0))&255;
  const mode=ram[R.MODE];
  if(mode===0){if(pressed&8){ram[R.MODE]=1;ram[R.CURSOR]=0;for(let i=32;i<256;i++)ram[i]=(ram[i]+i+1)&255;}return;}
  if(mode===1){if(pressed&64)ram[R.CURSOR]=(ram[R.CURSOR]+3)&3;if(pressed&128)ram[R.CURSOR]=(ram[R.CURSOR]+1)&3;
   if(pressed&1)startPlay();return;}
  if(mode===3){/* game over */
   if(ram[R.FADE]>0&&(ram[R.TIMER]++&7)===7)ram[R.FADE]--;
   if(pressed&8){boot();}return;}
  /* play */
  ram[R.TIMER]=(ram[R.TIMER]+1)&255;
  if((ram[R.TIMER]&63)===0&&ram[R.CLOCK]>0)ram[R.CLOCK]--;
  if(ram[R.STUN]>0)ram[R.STUN]--;
  else{
   if(mask&64)ram[R.X]=Math.max(8,ram[R.X]-2);if(mask&128)ram[R.X]=Math.min(232,ram[R.X]+2);
   if(mask&16)ram[R.Y]=Math.max(8,ram[R.Y]-2);if(mask&32)ram[R.Y]=Math.min(216,ram[R.Y]+2);
   if(pressed&1)for(let e=0;e<4;e++){const b=R.ENEMY+e*3;
    if(ram[b+2]&&Math.abs(ram[b]-ram[R.X])<40&&ram[b+1]<ram[R.Y]){ram[b+2]=0;
     const lo=ram[R.SCORE_LO]+30;if(lo>255)ram[R.SCORE_HI]++;ram[R.SCORE_LO]=lo&255;}}
  }
  /* the sprite mirror and the camera, as a real game keeps them: moving the
     player rewrites several bytes, not one */
  ram[64]=ram[R.X];ram[65]=ram[R.Y];ram[66]=(mask&0xf0)?1+(ram[R.TIMER]>>3&3):0;ram[67]=ram[R.X]>>1;ram[68]=ram[R.Y]>>1;
  for(let e=0;e<4;e++){const b=R.ENEMY+e*3;
   if(!ram[b+2]){if(((ram[R.TIMER]+e*41)&127)===0){ram[b+2]=1;ram[b]=(ram[R.TIMER]*7+e*60)&255;ram[b+1]=8;}continue;}
   if((ram[R.TIMER]+e)%2===0){ram[b]+=Math.sign(ram[R.X]-ram[b]);ram[b+1]+=Math.sign(ram[R.Y]-ram[b+1]);}
   if(ram[R.STUN]===0&&Math.abs(ram[b]-ram[R.X])<6&&Math.abs(ram[b+1]-ram[R.Y])<6){
    ram[R.HEALTH]--;ram[R.STUN]=24;ram[b+1]=8;
    if(ram[R.HEALTH]===0){ram[R.MODE]=3;ram[R.DEAD]=1;ram[R.TIMER]=0;}
   }
  }
 }
 const driver={
  actionSpec:{buttonCount:8,buttons:BUTTONS.map((name,index)=>({index,name,mask:1<<index})),
   singleButtonMasks:BUTTONS.map((_,i)=>1<<i)},
  observedRamBytes:256,ports:1,
  run(mask,frames,mask2){if(mask2)throw new Error('one port');for(let i=0;i<frames;i++)frame(mask);},
  readRam:()=>ram.slice(),
  snapshot:()=>({ram:ram.slice(),last}),
  restore(s){ram=s.ram.slice();last=s.last;},
  stateHash(){let h=0x811c9dc5;for(const b of ram)h=Math.imul(h^b,0x01000193)>>>0;return h.toString(16);}};
 return driver;
}

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
