'use strict';
// G5.2 / G5.10 gate 3: a reproducible TEMPORAL dependency that the previous
// single-action search did not find.
//
// The cartridge is tools/make_agod_sequence_rom.py, whose resource is gated
// behind a latch another button sets. So:
//
//   the single-action pipeline must REFUSE here. Measured, both in its default
//   and in its ranked configuration, because "the old search misses this" is a
//   claim about the old search and has to be run, not asserted.
//
//   the sequence search must confirm A THEN B, with the controls that stop the
//   effect being credited to the last action alone, from independent starts,
//   and must locate the consequence that lands 20 frames later.
//
//   on a cartridge where single actions already do everything, the sequence
//   search must confirm NO multi-step dependency. Without that control a
//   sequence searcher that says yes to everything would pass this file.
//
// THE ORACLE IS OPENED ONLY AFTER DISCOVERY HAS RETURNED, and only here.
//
// NO COMMERCIAL ROM IS USED OR EMITTED.
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js',
 'agod-evidence.js','agod-candidates.js','agod-consumers.js',
 'agod-platform-driver.js','agod-pipeline.js','agod-sequences.js'])
 require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline,
      Seq=globalThis.FlyAgodSequences;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'g5-'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};

function cartridge(generator,tag,extra){
 const rom=path.join(work,tag+'.json'),oracle=path.join(work,tag+'-oracle.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,'--oracle-out',oracle,
  ...(extra||[])]);
 return {bytes:Buffer.from(JSON.parse(fs.readFileSync(rom)).base64,'base64'),
  oracle:JSON.parse(fs.readFileSync(oracle))};
}
function boot(bytes,budget){
 const built=PD.createNesSync({romBytes:bytes,jsnes,
  frameBudget:budget===undefined?2000000:budget});
 if(built.status!=='READY')throw new Error('driver: '+built.reason);
 for(let i=0;i<120;i++)built.core.frame();
 return built;
}

const seq=cartridge('make_agod_sequence_rom.py','sequence',[]);

console.log('=== 1. the single-action pipeline on a two-step cartridge ===');
for(const [label,config] of [['default',{}],['ranked',{resourceSelection:'ranked'}]]){
 const built=boot(seq.bytes);
 const r=Pipeline.run(built.driver,{romHash:'g5-sequence',coreRevision:'jsnes',
  profileRevision:'agod-g5',typeEvents:30,...config});
 console.log('  %s: status=%s stage=%s  %s',label,r.status,r.stage||'-',
  (r.reason||'').slice(0,74));
 ok(r.status==='REFUSED',
  'the '+label+' single-action pipeline REFUSES this cartridge (got '+r.status+')');
 ok(r.goal===null,'and returns no goal in the '+label+' configuration');
 built.dispose();
}

console.log('=== 2. the sequence search finds what one action cannot ===');
const built=boot(seq.bytes);
const started=Date.now();
const found=Seq.discover(built.driver,{maxDepth:2});
const wall=Date.now()-started;
console.log('  status=%s  wall=%s s  frames=%d experiments=%d restores=%d',
 found.status,(wall/1000).toFixed(1),found.budget.framesSpent,
 found.budget.experiments,found.budget.restores);
console.log('  completeness: %s',found.completeness);
console.log('  single-action addresses: %j',found.singleActionAddresses);
console.log('  outcomes: %j',found.outcomes);
ok(found.budget.exhausted===null,
 'the search finished inside its budget, so an absent dependency would mean something');
ok(found.independentStarts===found.starts.length,
 'every start was independent: '+found.independentStarts+' of '+found.starts.length);
const multi=found.confirmed.filter(c=>c.stepCount>1);
console.log('  multi-step confirmed: %d',multi.length);
for(const c of multi){
 console.log('    %s  orderSensitive=%s  starts %d/%d',c.described,c.orderSensitive,
  c.startsAgreeing,c.startsTried);
 for(const a of c.attributed)
  console.log('       address %d  %d -> %d  delta %d  first horizon %d',
   a.address,a.from,a.to,a.delta,a.firstHorizon);
}
ok(multi.length>=1,'at least one multi-step dependency is confirmed');

/* ---- the oracle, opened here and not before ---- */
const o=seq.oracle;
const livesAt=o.fields.lives.address,shieldAt=o.fields.shield.address,
      scoreAt=o.fields.score.address;
console.log('  oracle: lives@%d shield@%d score@%d; delayed gain +%d frames',
 livesAt,shieldAt,scoreAt,o.sequences[1].delayFrames);
ok(o.noSingleActionSpendsAResource===true,
 'the oracle states that no single action spends a resource');
ok(found.singleActionAddresses.indexOf(livesAt)<0
 &&found.singleActionAddresses.indexOf(shieldAt)<0,
 'no SINGLE action was shown to move either resource ('+livesAt+', '+shieldAt
  +'); single actions reached only '+JSON.stringify(found.singleActionAddresses));
const pair=multi.find(c=>c.attributed.some(a=>a.address===livesAt));
if(ok(!!pair,'a confirmed multi-step dependency moves the resource at '+livesAt)){
 const expected=o.sequences[0].masks;
 const masks=pair.steps.filter(s=>s.kind==='PRESS').map(s=>s.mask);
 console.log('  the confirmed sequence is %j; the oracle says %j',masks,expected);
 ok(masks.join(',')===expected.join(','),
  'it is the oracle sequence '+JSON.stringify(expected)+', got '+JSON.stringify(masks));
 ok(pair.orderSensitive===true,
  'and it is order-sensitive: the same two actions reversed do not do it');
 ok(pair.startsAgreeing>=2,
  'it reproduced from '+pair.startsAgreeing+' independent starts');
 const resource=pair.attributed.find(a=>a.address===livesAt);
 ok(resource.delta<0,'the resource DECREASES under the sequence, delta '+resource.delta);
 /* the delayed consequence: the oracle says the gain lands 20 frames later */
 const delayed=pair.attributed.find(a=>a.address===scoreAt);
 if(ok(!!delayed,'the delayed consequence at '+scoreAt+' was found at all')){
  /* the horizon grid bounds the estimate: the oracle's 20 frames falls between
     the samples at 10 and 30, so 30 is the first horizon at which it COULD be
     seen. The claim is "later than immediately", not "exactly 30". */
  console.log('  delayed effect at %d first seen at horizon %d; oracle delay %d; '
   +'grid %j bounds it to (%d, %d]',scoreAt,delayed.firstHorizon,
   o.sequences[1].delayFrames,found.horizons,
   found.horizons[found.horizons.indexOf(delayed.firstHorizon)-1],
   delayed.firstHorizon);
  const grid=found.horizons;
  const previous=grid[grid.indexOf(delayed.firstHorizon)-1];
  ok(o.sequences[1].delayFrames>previous&&o.sequences[1].delayFrames<=delayed.firstHorizon,
   'the oracle delay '+o.sequences[1].delayFrames+' falls in the interval ('
    +previous+', '+delayed.firstHorizon+'] the horizon grid resolves it to');
  ok(delayed.firstHorizon>0,
   'it was NOT visible immediately - first horizon '+delayed.firstHorizon
    +' - which is why a probe that reads RAM straight after the action misses it');
  ok(delayed.delta>0,'and it is a gain, delta '+delayed.delta);
 }
 /* the controls actually ran and did not explain it */
 ok(pair.controls.lastAloneApplicable===true,
  'the last-action-alone control applies to a multi-step sequence');
 ok(pair.controls.neutralMovedCount>=0&&pair.controls.reorderedMovedCount!==null,
  'the neutral and reordered controls were both run');
}

console.log('=== 3. the window is measured, not assumed ===');
for(const t of found.timing)
 console.log('  +WAIT(%d): lost %j kept %j -> %s',t.gap,t.lostAddresses,
  t.survivedAddresses,t.verdict);
ok(found.timing.length>0,'the confirmed pair was re-run with time inserted');
const gapped=found.timing.filter(t=>t.lostAddresses.indexOf(livesAt)>=0);
ok(gapped.length>0,
 'inserting a gap between the two actions destroys the effect on '+livesAt
  +', which is the hidden condition being measured rather than assumed');

console.log('=== 4. the recorded experiment replays ===');
{
 const target=multi[0];
 const replay=boot(seq.bytes);
 const rd=()=>replay.driver.readRam();
 const snapshot=replay.driver.snapshot();
 replay.driver.restore(snapshot);
 const before=rd().slice(0,256);
 for(const step of target.steps){
  if(step.kind==='PRESS'){replay.driver.run(step.mask,step.hold);replay.driver.run(0,step.release);}
  else if(step.kind==='WAIT')replay.driver.run(0,step.frames);
  else if(step.kind==='HOLD')replay.driver.run(step.mask,step.frames);
 }
 /* EACH ADDRESS AT ITS OWN RECORDED HORIZON, which is how the search observed
    it. Reading them all at the last horizon fails on a TRANSIENT: payTimer is
    +10 immediately and back to 0 thirty frames later, so a single late sample
    reports it as unchanged and the replay looks like a 2-of-3 failure. The
    recorded experiment carries the horizon grid precisely so a replay can walk
    it. */
 const horizons=target.experiment.horizons;
 const seen=new Map();
 let elapsed=0;
 for(const horizon of horizons){
  if(horizon>elapsed){replay.driver.run(0,horizon-elapsed);elapsed=horizon;}
  const now=rd();
  for(const a of target.attributed)
   if(!seen.has(a.address)&&now[a.address]!==before[a.address])
    seen.set(a.address,{horizon,delta:now[a.address]-before[a.address]});
 }
 const reproduced=target.attributed.filter(a=>{
  const got=seen.get(a.address);
  return got&&Math.sign(got.delta)===Math.sign(a.delta)&&got.horizon===a.firstHorizon;
 });
 console.log('  replaying %s on a fresh core over horizons %j:',target.described,horizons);
 for(const a of target.attributed){
  const got=seen.get(a.address);
  console.log('     address %d expected delta %d at horizon %d -> got %s',
   a.address,a.delta,a.firstHorizon,
   got?('delta '+got.delta+' at horizon '+got.horizon):'nothing');
 }
 ok(reproduced.length===target.attributed.length,
  'the recorded experiment reproduces every attributed effect, at its own '
   +'horizon, on a fresh core ('+reproduced.length+' of '
   +target.attributed.length+')');
 replay.dispose();
}
built.dispose();

console.log('=== 5. false positives: a cartridge where one action is enough ===');
{
 const plain=cartridge('make_agod_test_rom.py','single',['--seed','0']);
 const b=boot(plain.bytes);
 const r=Seq.discover(b.driver,{maxDepth:2});
 const singles=r.depth1.filter(d=>d.verdict==='CONFIRMED').length;
 console.log('  depth-1 confirmed: %d of %d; multi-step confirmed: %d; outcomes %j',
  singles,r.depth1.length,r.multiStepConfirmed,r.outcomes);
 ok(singles>0,'single actions really do act on this cartridge ('+singles+' confirmed), '
  +'so the absence of a sequence below is not an inert machine');
 ok(r.multiStepConfirmed===0,
  'NO multi-step dependency is manufactured where one action suffices (got '
   +r.multiStepConfirmed+')');
 b.dispose();
}

console.log('=== 6. the budget is enforced and exhaustion is named ===');
{
 const b=boot(seq.bytes);
 const r=Seq.discover(b.driver,{maxDepth:2,frameBudget:400,experimentBudget:1000});
 console.log('  tiny budget: exhausted=%s  frames=%d  completeness=%s',
  r.budget.exhausted,r.budget.framesSpent,r.completeness.slice(0,60));
 ok(r.budget.exhausted==='FRAMES','a frame budget that cannot finish is reported as FRAMES');
 ok(/INCOMPLETE/.test(r.completeness),
  'and the result says an absent dependency is not evidence of absence');
 b.dispose();
}

console.log('=== 7. a platform that declares no actions is refused ===');
{
 const b=boot(seq.bytes);
 const bare={restore:b.driver.restore.bind(b.driver),run:b.driver.run.bind(b.driver),
  readRam:b.driver.readRam.bind(b.driver),snapshot:b.driver.snapshot.bind(b.driver),
  stateHash:b.driver.stateHash.bind(b.driver)};
 const r=Seq.discover(bare,{});
 console.log('  no action spec -> %s: %s',r.status,(r.reason||'').slice(0,70));
 ok(r.status==='REFUSED'&&/action/.test(r.reason||''),
  'a driver with no action specification is refused, not given a guessed pad');
 b.dispose();
}

console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d assertions',fail.length?'FAIL ('+fail.length+')':'PASS',
 out.length-fail.length,out.length);
if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);
 process.exitCode=1;}
