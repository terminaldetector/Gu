'use strict';
// D1 acceptance: a pre-registered THREE-step dependency whose two-step prefixes
// cannot be confirmed, found by a bounded frontier search, attributed with
// controls, reproduced, and exported as a graph that rebuilds identically.
//
// The cartridge is tools/make_agod_chain_rom.py. Its progress through the chain
// lives in cartridge RAM outside the observed window, so no pair has an effect
// of its own. The measurements, in order:
//
//   1. the PREVIOUS search (discover(), which extends only confirmed pairs)
//      does not find it at depth 3. That is the baseline, and it is run.
//   2. the frontier search finds it without trying every triple.
//   3. two resources are told apart from four counters that are not resources.
//   4. the graph and every proof replay on a fresh core, and a second search
//      from a fresh core produces the same graph digest.
//   5. negative controls: nothing multi-step is manufactured on a cartridge
//      one action solves, nor on one where no action does anything.
//
// THE ORACLE IS OPENED ONLY AFTER THE SEARCH RETURNS. No commercial ROM is used.
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
const PD=require(path.join(A,'agod-platform-driver.js'));
const Seq=require(path.join(A,'agod-sequences.js')),Graph=require(path.join(A,'agod-graph.js'));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'d1-'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
function cartridge(generator,tag,extra){
 const rom=path.join(work,tag+'.json'),oracle=path.join(work,tag+'-oracle.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,'--oracle-out',oracle,...(extra||[])]);
 return {bytes:Buffer.from(JSON.parse(fs.readFileSync(rom)).base64,'base64'),
  oracle:fs.existsSync(oracle)?JSON.parse(fs.readFileSync(oracle)):null};
}
function boot(bytes){
 const built=PD.createNesSync({romBytes:bytes,jsnes});
 for(let i=0;i<120;i++)built.core.frame();
 return built;
}
const masksOf=record=>record.steps.filter(s=>s.kind==='PRESS').map(s=>s.mask);

(async()=>{
const chain=cartridge('make_agod_chain_rom.py','chain',[]);

console.log('=== 1. baseline: the pair-extending search at depth 3 ===');
{
 const b=boot(chain.bytes);
 const r=Seq.discover(b.driver,{maxDepth:3});
 const deepest=r.confirmed.reduce((m,c)=>Math.max(m,c.stepCount),0);
 console.log('  discover(maxDepth 3): multiStep=%d deepest=%d experiments=%d frames=%d',
  r.multiStepConfirmed,deepest,r.budget.experiments,r.budget.framesSpent);
 ok(deepest<3,'the pair-extending search confirms nothing three steps long here (deepest '
  +deepest+'): with no confirmable pair it never tries a triple');
 b.dispose();
}

console.log('=== 2. the frontier search ===');
const b=boot(chain.bytes);
const r=Seq.frontier(b.driver,{});
console.log('  status=%s wall=%ss frames=%d experiments=%d restores=%d heapPeak=%dMB',
 r.status,(r.budget.wallMs/1000).toFixed(1),r.budget.framesSpent,r.budget.experiments,
 r.budget.restores,Math.round(r.budget.heapPeakBytes/1048576));
console.log('  search: %j',r.search);
console.log('  %s',r.completeness);
const triples=r.confirmed.filter(c=>c.stepCount===3);
for(const c of r.confirmed.filter(c=>c.stepCount>1)){
 console.log('  %s order=%s starts %d/%d',c.described,c.orderSensitive,c.startsAgreeing,c.startsTried);
 for(const a of c.attributed)console.log('     address %d %d->%d horizon %d%s%s',a.address,a.from,a.to,
  a.firstHorizon,a.transient?' TRANSIENT':'',a.delayInterval?' delay '+JSON.stringify(a.delayInterval):'');
 for(const w of c.windows||[])console.log('     %s',w.reading);
}
ok(r.search.expansions<r.search.exhaustiveSequences/4,
 'the search ran '+r.search.expansions+' expansions where trying everything is '
  +r.search.exhaustiveSequences+' sequences');
ok(r.budget.exhausted===null,'inside its budget');
ok(/INCOMPLETE/.test(r.completeness)===(r.search.droppedClasses>0),
 'completeness is stated honestly: '+r.search.droppedClasses+' class(es) dropped by the beam');

/* ---- the oracle, opened here ---- */
const o=chain.oracle,F=o.fields;
ok(o.twoStepPrefixesHaveNoOwnEffect===true,'the oracle states the pairs have no effect of their own');
const hit=triples.find(c=>c.attributed.some(a=>a.address===F.lives.address&&a.delta<0));
if(ok(!!hit,'a confirmed three-step dependency lowers the resource at '+F.lives.address)){
 ok(masksOf(hit).join(',')===o.chain.masks.join(','),
  'it is the pre-registered chain '+JSON.stringify(o.chain.masks)+', got '+JSON.stringify(masksOf(hit)));
 ok(hit.orderSensitive===true,'order matters');
 ok(hit.startsAgreeing===hit.startsTried&&hit.startsTried>=3,'reproduced from every independent start');
 ok(hit.controls.reductions.length>=5,'every shorter sequence was run as a control: '
  +hit.controls.reductions.join(' | '));
 const delayed=hit.attributed.find(a=>a.address===F.score.address);
 if(ok(!!delayed&&!!delayed.delayInterval,'the delayed gain was found and its delay narrowed')){
  /* the oracle counts from the press; the search counts from the END of the
     last step, which is hold+release later */
  const tail=hit.experiment.hold+hit.experiment.release;
  const expected=o.chain.delayed.delayFrames-tail;
  console.log('  delay interval %j measured from the end of the last step; oracle %d frames from the press = %d after the %d-frame step',
   delayed.delayInterval,o.chain.delayed.delayFrames,expected,tail);
  ok(delayed.delayInterval.atMost-delayed.delayInterval.moreThan<=2,
   'the delay is reported as an interval no wider than the stated resolution');
  ok(Math.abs(expected-delayed.delayInterval.atMost)<=4,
   'and the oracle delay falls at that interval, within the lag jitter of the core');
 }
 for(const w of hit.windows){
  ok(!!w.windowFrames&&o.chain.windowFrames>w.windowFrames.moreThan
   &&o.chain.windowFrames<=w.windowFrames.atMost+12,
   'the window after step '+w.afterStep+' is measured as '+JSON.stringify(w.windowFrames)
    +', consistent with the oracle '+o.chain.windowFrames);
 }
}
const falsePairs=r.confirmed.filter(c=>c.stepCount===2);
ok(falsePairs.length===0,'no two-step dependency is claimed on this cartridge (got '+falsePairs.length+')');

console.log('=== 3. resources and things that are not ===');
const role=address=>(r.resources.find(x=>x.address===address)||{}).role||'(absent)';
for(const x of r.resources)console.log('  address %d %s%s',x.address,x.role,
 x.depletion?' track '+JSON.stringify(x.depletion.track)+' restoredBy '+JSON.stringify(x.restoredBy):'');
for(const name of o.resources)
 ok(role(F[name].address)==='RESOURCE_CANDIDATE',name+' ('+F[name].address+') is a resource candidate, got '+role(F[name].address));
for(const name of o.notResource)
 ok(role(F[name].address)!=='RESOURCE_CANDIDATE',name+' ('+F[name].address+') is NOT called a resource, got '+role(F[name].address));
ok(role(F.echo.address)==='INPUT_ECHO'&&role(F.antiEcho.address)==='INPUT_ECHO',
 'both input echoes are recognised as following input, the falling one included');
ok(role(F.pseudoTimer.address)==='(absent)'&&role(F.frameCounter.address)==='(absent)',
 'the time-driven counters, one of them falling, appear in no claim at all');
for(const name of o.resources){
 const x=r.resources.find(y=>y.address===F[name].address);
 ok(x&&x.depletion&&x.depletion.reachedFloor&&x.depletion.floor===0,name+' has a measured floor at 0');
 ok(x&&Array.isArray(x.restoredBy)&&x.restoredBy.indexOf(o.resetAction.mask)>=0,
  name+' is restored from the floor by the oracle reset action '+o.resetAction.mask);
}

console.log('=== 4. the graph: export, replay, rebuild ===');
const graph=Graph.fromFrontier(r,{romHash:'d1-chain',coreRevision:'jsnes',platform:'nes'});
const text=JSON.stringify(graph);
console.log('  nodes=%d edges=%d proofs=%d fields=%d digest=%s bytes=%d',
 graph.nodes.length,graph.edges.length,graph.proofs.length,graph.fields.length,graph.digest,text.length);
ok(graph.status==='BUILT'&&graph.nodes.length<=1+3*4*8,'the graph is bounded by classes, not frames');
ok(text.length<200000&&!/"snapshot"|base64/.test(text),'the export carries no savestate and no ROM bytes');
ok(graph.nodes[0].phase.value==='RESPONSIVE'&&graph.nodes.slice(1).every(n=>n.phase.value==='UNKNOWN'),
 'phase is claimed only where it was probed; everything else is UNKNOWN');
{
 const fresh=boot(chain.bytes);
 const replayed=Graph.replay(fresh.driver,graph);
 console.log('  replay on a fresh core: %d of %d proofs reproduced',replayed.reproduced,replayed.proofs);
 ok(replayed.reproduced===replayed.proofs&&replayed.proofs>0,'every proof replays on a fresh core');
 const again=Seq.frontier(fresh.driver,{});
 const second=Graph.fromFrontier(again,{romHash:'d1-chain',coreRevision:'jsnes',platform:'nes'});
 console.log('  second search digest %s',second.digest);
 ok(second.digest===graph.digest,'a second search from a fresh core rebuilds the same graph');
 fresh.dispose();
}
b.dispose();

console.log('=== 5. negative controls ===');
{
 const plain=cartridge('make_agod_test_rom.py','single',['--seed','0']);
 const p=boot(plain.bytes);
 const n=Seq.frontier(p.driver,{});
 console.log('  one-action cartridge: multiStep=%d outcomes=%j',n.multiStepConfirmed,n.outcomes);
 ok(n.multiStepConfirmed===0,'nothing multi-step is manufactured where one action suffices');
 p.dispose();
 const seq=cartridge('make_agod_sequence_rom.py','sequence',[]);
 const s=boot(seq.bytes);
 const m=Seq.frontier(s.driver,{});
 const pair=m.confirmed.find(c=>c.stepCount===2&&masksOf(c).join(',')==='1,2');
 console.log('  G5.2 cartridge: multiStep=%d deepest=%d',m.multiStepConfirmed,m.deepestConfirmed);
 ok(!!pair,'the G5.2 two-step dependency is still found by the new search');
 ok(m.confirmed.filter(c=>c.stepCount===3).length===0,'and no three-step one is invented on top of it');
 s.dispose();
 let factory=null;try{factory=require(path.join(A,'sega','genplus.js'));}catch(e){}
 if(factory){
  const quiet=cartridge('make_agod_sega_rom.py','sega-quiet',['--negative']);
  const built=await PD.create({platform:'sega',romBytes:quiet.bytes,
   SegaConsole:require(path.join(A,'sega-core.js')),factory,
   moduleOptions:{locateFile:f=>path.join(A,'sega',f)}});
  for(let i=0;i<120;i++)built.core.frame();
  const q=Seq.frontier(built.driver,{maxDepth:2,starts:2,horizons:[0,20]});
  console.log('  Sega dead cartridge: status=%s confirmed=%d outcomes=%j',q.status,q.confirmed.length,q.outcomes);
  ok(q.confirmed.length===0,'a cartridge where no action does anything yields no claim, on a second platform');
  built.dispose();
 }else out.push('  BLOCK sega core absent: dead-state control on a second platform not run');
}

console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d assertions',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);process.exitCode=1;}
})().catch(e=>{console.log('FAILED '+e.message+'\n'+e.stack);process.exitCode=1;});
