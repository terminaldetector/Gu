/* AGOD phase detection and automatic entry into play (real-ROM track).

   WHY THIS EXISTS. Every AGOD stage before this one was designed on cartridges
   that are in play from the first frame. A commercial cartridge is not: it
   boots into logos, an attract loop, a title menu, a character or stage select
   and a story screen, and only then hands the pad to the player. Run from the
   title, the existing pipeline typed menu bytes driven by Start as a
   "resource" and refused after 12371 frames (measured on a private Mega Drive
   cartridge, hashes in docs/reports/realrom/). The refusal was honest; the
   frames were wasted. A background search started 1.5 s after a ROM loads is
   always at the title.

   WHAT "PLAYING" MEANS HERE, AND WHY. Not "the screen changes" and not "some
   byte answers a button": a menu cursor answers a button too. The signature
   used is a CONTROLLED INTEGRATOR: holding one direction moves some field, a
   LONGER hold moves it FURTHER, and the opposite direction does not move it
   the same way. That is a position under the player's control. A menu cursor
   moves once per press (or slowly, by auto-repeat), so it fails the growth
   test; a phase jump ("press Start") changes thousands of bytes at once and is
   classified separately; a cut-scene ignores directions entirely. Measured on
   two private cartridges before this rule was written:

     menus/title   directions leave 0..2 persistent bytes; Start/A 2000..34000
     character     L=U and R=D (identical outcome states), cursor +-1
     play          all four directions leave 40..490 persistent bytes
     after death   directions leave 0

   Every claim is a controlled comparison from ONE snapshot: arm (hold, then
   settle) against neutral of the same total length. The emulators are
   deterministic, so a difference is caused by the input and nothing else.

   ENTRY. Until a state is PLAYING the procedure presses whichever
   non-direction button made the largest persistent difference (the one that
   advances the screen), or waits when nothing does (an animation or text that
   advances on its own). A repeated state means the press led back to where it
   was, and the next candidate is tried. Every step is recorded as data, so the
   route can be replayed and audited; no route is stored per cartridge.

   NOT ORACLE. Nothing here reads a ROM name, a header, a RAM map or a
   human-made script. Platform-independent: restore / run / readRam / snapshot
   and the driver's own action specification. */
(function(root){'use strict';
const PHASE_REVISION='agod-phase-r1';
const DEFAULTS=Object.freeze({
 /* persistent-difference probe */
 hold:20,settle:20,
 /* integrator probe: a short and a long hold of the same direction */
 shortHold:8,longHold:32,integratorSettle:4,
 minIntegratorDelta:8,integratorGrowth:2.5,
 /* a press is a phase jump when it changes at least this share of the RAM
    window (and never fewer than phaseJumpMinBytes). It was an absolute 1500
    bytes, measured on a 64 KiB Mega Drive window - title and menu presses
    changed 2000..34000 bytes (>=3%), a pause in play 257..708 (<=1.1%) - and
    that number can never be reached on a 2 KiB NES, where every title would
    have probed as something other than a menu. */
 phaseJumpShare:0.02,phaseJumpMinBytes:24,
 /* a difference this small is input echo or a cursor, not a consequence */
 minPersistBytes:8,
 /* entry */
 maxSteps:60,advanceHold:8,advanceWait:40,idleWait:60,frameBudget:40000,
 confirmAfter:30});

const UP='↑',DOWN='↓',LEFT='←',RIGHT='→';
const SYSTEM_BUTTONS=new Set(['Select','Mode']);

function maskOf(spec,name){
 const b=spec&&Array.isArray(spec.buttons)?spec.buttons.find(x=>x.name===name):null;
 return b?b.mask:null;
}
function axesOf(spec){
 const axes=[];
 for(const [neg,pos,name] of [[LEFT,RIGHT,'horizontal'],[UP,DOWN,'vertical']]){
  const n=maskOf(spec,neg),p=maskOf(spec,pos);
  if(n!==null&&p!==null)axes.push({name,neg:n,pos:p});
 }
 return axes;
}
function buttonsOf(spec){
 const dirs=new Set([UP,DOWN,LEFT,RIGHT]);
 return (spec&&spec.buttons||[]).filter(b=>!dirs.has(b.name));
}
function diffCount(a,b){let c=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])c++;return c;}
function hashBytes(bytes){
 let h1=0x811c9dc5,h2=0x9e3779b9;
 for(let i=0;i<bytes.length;i++){h1=Math.imul(h1^bytes[i],0x01000193)>>>0;h2=Math.imul(h2+bytes[i]+i,0x85ebca6b)>>>0;}
 return ('0000000'+h1.toString(16)).slice(-8)+('0000000'+h2.toString(16)).slice(-8);
}
const s8=x=>x>127?x-256:x;
const s16=x=>x>32767?x-65536:x;

/* signed field deltas of arm against neutral, bytes and big/little words */
function deltas(arm,neutral,words){
 const out=new Map();
 for(let a=0;a<arm.length;a++){const d=s8((arm[a]-neutral[a])&255);if(d)out.set('b'+a,d);}
 if(words)for(let a=0;a+1<arm.length;a+=1){
  const be=s16((((arm[a]<<8)|arm[a+1])-((neutral[a]<<8)|neutral[a+1]))&0xffff);
  if(Math.abs(be)>=128)out.set('w'+a,be);
 }
 return out;
}

/* Drive one controller port; the other is released. Port 1 is what every
   caller before the 2P track used. */
function driverFor(driver,port){
 if(port===2){
  if(!(driver.ports>=2))throw new Error('this driver has no second controller port');
  return (mask,frames)=>driver.run(0,frames,mask);
 }
 return (mask,frames)=>driver.run(mask,frames);
}

function probe(driver,options){
 const cfg={...DEFAULTS,...(options||{})};
 const spec=driver.actionSpec;
 const drive=driverFor(driver,cfg.port);
 const start=driver.snapshot();
 const total=cfg.hold+cfg.settle;
 drive(0,total);const neutral=driver.readRam();
 const arms=[];
 const masks=(spec&&spec.buttons||[]).map(b=>({name:b.name,mask:b.mask}));
 for(const m of masks){
  driver.restore(start);drive(m.mask,cfg.hold);drive(0,cfg.settle);
  const ram=driver.readRam(),persist=diffCount(ram,neutral);
  arms.push({name:m.name,mask:m.mask,persist,outcome:persist>=cfg.minPersistBytes?hashBytes(ram):null});
 }
 /* integrators, per axis */
 const axes=[];
 const words=(driver.observedRamBytes||0)>=0x2000;
 for(const axis of axesOf(spec)){
  const run=(mask,h)=>{driver.restore(start);drive(mask,h);drive(0,cfg.integratorSettle+cfg.longHold-h);return driver.readRam();};
  const n=run(0,cfg.longHold);
  const ps=deltas(run(axis.pos,cfg.shortHold),n,words),pl=deltas(run(axis.pos,cfg.longHold),n,words);
  const ns=deltas(run(axis.neg,cfg.shortHold),n,words),nl=deltas(run(axis.neg,cfg.longHold),n,words);
  /* BOTH directions, opposite signs, each growing with the hold. A byte the
     input merely perturbs (a random-number generator advanced by polling)
     passes one side by chance; passing both with opposite signs and growth is
     what a controlled position does. A player pinned against one wall fails
     this axis and is caught by the other one, or by the confirmation probe. */
  const found=[];
  const grows=(S,L)=>Math.abs(L)>=cfg.minIntegratorDelta&&S!==0&&Math.sign(S)===Math.sign(L)
   &&Math.abs(L)>=cfg.integratorGrowth*Math.abs(S);
  /* A WALL. A player pinned against one edge moves away from it freely and
     towards it only until it stops: measured on a second player who had just
     joined at the left edge, left gave -16 then -24 while right gave 16 then
     64. That side passes if it moved the opposite way at the SAME short-hold
     speed and did not come back - a speed match a perturbed byte does not
     produce by accident. */
  const clipped=(S,L,NS,NL)=>grows(S,L)&&NS!==0&&Math.sign(NS)===-Math.sign(S)
   &&Math.sign(NL)===Math.sign(NS)&&Math.abs(NL)>=Math.abs(NS)
   &&Math.abs(NS)>=cfg.minIntegratorDelta/2
   &&Math.abs(S)<=1.34*Math.abs(NS)&&Math.abs(NS)<=1.34*Math.abs(S);
  for(const [key,L] of pl){
   const S=ps.get(key)||0,NL=nl.get(key)||0,NS=ns.get(key)||0;
   if(grows(S,L)&&grows(NS,NL)&&Math.sign(L)===-Math.sign(NL))
    found.push({field:key,pos:[S,L],neg:[NS,NL]});
   else if(clipped(S,L,NS,NL)||clipped(NS,NL,S,L))
    found.push({field:key,pos:[S,L],neg:[NS,NL],clipped:true});
  }
  axes.push({axis:axis.name,neg:axis.neg,pos:axis.pos,integrators:found.length,examples:found.slice(0,4),
   fields:found.filter(f=>f.field[0]==='b').slice(0,16).map(f=>Number(f.field.slice(1))),
   /* which way each field moves for the axis' POSITIVE direction (+1 or -1):
      what a passive control-authority check compares the commanded
      direction against */
   fieldSigns:found.filter(f=>f.field[0]==='b').slice(0,16).map(f=>Math.sign(f.pos[1])||1)});
 }
 driver.restore(start);
 const dirNames=new Set([UP,DOWN,LEFT,RIGHT]);
 const dirArms=arms.filter(a=>dirNames.has(a.name)),btnArms=arms.filter(a=>!dirNames.has(a.name));
 const distinctDirections=new Set(dirArms.map(a=>a.outcome).filter(Boolean)).size;
 const jumpBytes=Number.isInteger(cfg.phaseJumpBytes)?cfg.phaseJumpBytes
  :Math.max(cfg.phaseJumpMinBytes,Math.round(cfg.phaseJumpShare*neutral.length));
 const jumps=btnArms.filter(a=>a.persist>=jumpBytes);
 const controlled=axes.filter(a=>a.integrators>0);
 let phase;
 if(controlled.length)phase='PLAYING';
 else if(jumps.length)phase='MENU';
 else if(arms.some(a=>a.persist>=cfg.minPersistBytes))phase='TRANSITION';
 else phase='INERT';
 return {revision:PHASE_REVISION,port:cfg.port===2?2:1,phase,arms:arms.map(({name,mask,persist})=>({name,mask,persist})),
  distinctDirections,controlledAxes:controlled.map(a=>a.axis),axes,
  /* Select and Mode move a menu cursor more often than they confirm one: on a
     private SNES title, Select moved "1 PLAYER" to "2 PLAYERS", and every
     later measurement was of a two-player game with an idle second player.
     They are used only when no other button advances the screen; choosing
     another menu entry is the job of an explicit request (the 2P entry). */
  advance:btnArms.filter(a=>a.persist>=cfg.minPersistBytes)
   .sort((a,b)=>(SYSTEM_BUTTONS.has(a.name)-SYSTEM_BUTTONS.has(b.name))||(b.persist-a.persist))
   .map(a=>({name:a.name,mask:a.mask,persist:a.persist})),
  framesUsed:total*(1+masks.length)+(cfg.longHold+cfg.integratorSettle)*5*axes.length};
}

/* Drive from the current state into play. */
function enter(driver,options){
 const cfg={...DEFAULTS,...(options||{})};
 const drive=driverFor(driver,cfg.port);
 const steps=[],seen=new Map();
 let frames=0,lastProbe=null,idleStreak=0;
 const spend=f=>{frames+=f;};
 for(let i=0;i<cfg.maxSteps;i++){
  if(frames>cfg.frameBudget)return {status:'BUDGET_EXHAUSTED',revision:PHASE_REVISION,steps,frames,lastPhase:lastProbe&&lastProbe.phase};
  const p=probe(driver,cfg);spend(p.framesUsed);lastProbe=p;
  if(p.phase==='PLAYING'){
   /* confirm: still playing a little later, so a one-frame window of a
      menu animation cannot pass */
   const at=driver.snapshot();drive(0,cfg.confirmAfter);spend(cfg.confirmAfter);
   const q=probe(driver,cfg);spend(q.framesUsed);
   driver.restore(at);
   if(q.phase==='PLAYING'){
    steps.push({kind:'CONFIRMED',phase:'PLAYING',axes:p.controlledAxes});
    return {status:'PLAYING',revision:PHASE_REVISION,steps,frames,probe:p,snapshot:driver.snapshot()};
   }
   steps.push({kind:'UNCONFIRMED',phase:p.phase,laterPhase:q.phase});
  }
  const h=driver.stateHash();
  const tried=seen.get(h)||0;seen.set(h,tried+1);
  const candidates=p.advance;
  if(candidates.length){
   const pick=candidates[Math.min(tried,candidates.length-1)];
   drive(pick.mask,cfg.advanceHold);drive(0,cfg.advanceWait);spend(cfg.advanceHold+cfg.advanceWait);
   steps.push({kind:'PRESS',button:pick.name,mask:pick.mask,phase:p.phase,persist:pick.persist,attempt:tried});
  }else{
   /* NOTHING ANSWERS: an intro, a logo, a story scroll. Each probe costs
      ~700 frames of restored search and the wait 60 of real game time, so a
      long attract sequence (a private SNES RPG: ~3000 frames before its title
      takes input) ate the whole budget in probes. Waits double while nothing
      answers, up to 16x, and reset as soon as something does. */
   const wait=cfg.idleWait*Math.pow(2,Math.min(4,idleStreak));idleStreak++;
   drive(0,wait);spend(wait);
   steps.push({kind:'WAIT',frames:wait,phase:p.phase});
   continue;
  }
  idleStreak=0;
 }
 return {status:'NOT_REACHED',revision:PHASE_REVISION,steps,frames,lastPhase:lastProbe&&lastProbe.phase};
}

/* REPLAY AN ENTRY on a freshly loaded cartridge, WITHOUT any snapshot or restore:
   the probes enter() ran all returned to their own start, so the live timeline
   of an entry is only its presses (hold, then wait) and its waits. This is the
   system entry controller of a clean evaluation run: the presses AGOD found, not
   gameplay. The caller compares the resulting stateHash with the original. */
function replayEntry(driver,steps,options){
 const cfg={...DEFAULTS,...(options||{})};
 const drive=driverFor(driver,cfg.port);let frames=0;
 for(const s of steps){
  if(s.kind==='PRESS'){drive(s.mask,cfg.advanceHold);drive(0,cfg.advanceWait);frames+=cfg.advanceHold+cfg.advanceWait;}
  else if(s.kind==='WAIT'){drive(0,s.frames);frames+=s.frames;}
 }
 return {frames};
}

const api=Object.freeze({PHASE_REVISION,DEFAULTS,probe,enter,replayEntry,axesOf,buttonsOf,driverFor});
root.FlyAgodPhase=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
