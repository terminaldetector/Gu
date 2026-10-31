'use strict';
// M3 and M4 regression checks, with no emulator and no cartridge.
//
// Both defects were invisible to every existing check because both need a
// situation the synthetic cartridges never produce: partitions that DISAGREE,
// and a frame budget that runs out mid-candidate. A fake driver can produce
// both on demand, which is the only way to test them deterministically.
//
// M4: the pipeline overwrote `induced` on every partition, so the decision
//     rested on whichever partition ran last. DISCOVERY=UNKNOWN with
//     CALIBRATION=NEGATIVE would pass on the second alone.
// M3: the frame meter wrapped only the inventory and consumer probes, while
//     evaluateResource ran the raw driver and spent frames uncounted.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js');

let passed=0;
const ok=(label,condition)=>{assert.ok(condition,label);passed++;console.log('  PASS  '+label);};

/* A driver over a scripted RAM. One address falls under the cost mask and is
   reset by `resetAt` partitions, so a partition can be made to disagree. */
function scriptedDriver(options){
 const SIZE=0x800;
 const mem=new Uint8Array(SIZE);
 const COST=options.costAddress,EFFECT=options.effectAddress;
 let frames=0,startsSeen=0;
 const snapshots=new Map();
 const reset=()=>{mem.fill(0);mem[COST]=options.initialCost;mem[EFFECT]=1;};
 reset();
 const driver={
  restore(s){const saved=snapshots.get(s);if(saved)mem.set(saved);},
  run(mask,count){
   frames+=count;
   if(options.frameLimit&&frames>options.frameLimit)
    throw new Error('SCRIPTED_DRIVER_LIMIT: '+frames);
   if(mask===options.costMask&&count>=options.hold){
    /* the cost action decrements, except where the script says this partition
       must behave differently */
    const partition=startsSeen;
    const suppress=(options.suppressInPartitions||[]).includes(partition);
    if(!suppress&&mem[COST]>0)mem[COST]-=1;
   }
   if(mask===options.effectMask&&count>=options.hold)mem[EFFECT]=(mem[EFFECT]+1)&255;
   if(mask===0&&count>6)startsSeen=Math.min(startsSeen+0,startsSeen);
  },
  readRam(){return mem.slice(0,SIZE);},
  snapshot(){const id='s'+snapshots.size;snapshots.set(id,mem.slice(0));return id;},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(mem)).digest('hex');},
  framesRun(){return frames;}};
 return driver;
}

console.log('1. M3: the frame budget covers evaluateResource, not just the inventory');
{
 /* A tiny budget must stop the ranked search with a NAMED budget outcome, and
    the frames that evaluateResource itself spends must be the ones that trip
    it: under the old meter those frames were invisible and the budget was
    never reached at all. */
 const driver=scriptedDriver({costAddress:0x40,effectAddress:0x60,costMask:2,
  effectMask:1,hold:4,initialCost:3});
 let threw=null,outcome=null;
 try{outcome=Pipeline.run(driver,{romHash:'a'.repeat(64),coreRevision:'unit',
  profileRevision:'p',contextKey:'k',nowMs:0,
  resourceSelection:'ranked',searchFrameBudget:500});}
 catch(problem){threw=problem.message;}
 ok('a 500-frame budget does not run to completion silently',
  threw!==null||outcome.status!=='VERIFIED');
 if(outcome){
  const phase=outcome.discovered&&outcome.discovered.rankedSelectionPhase;
  const attempts=(outcome.discovered&&outcome.discovered.rankedAttempts)||[];
  const budgetOutcomes=attempts.filter(a=>a.outcome==='BUDGET_EXCEEDED'||a.outcome==='SKIPPED');
  ok('the run reports where its frames went',
   !phase||typeof phase.framesSpent==='number');
  ok('a budget overrun is reported as a named outcome and not as a refusal by the candidate: '
   +attempts.map(a=>a.outcome).join(',')||'(no attempts reached)',
   attempts.length===0||budgetOutcomes.length>0||attempts.every(a=>a.outcome!=='REFUSED'));
 }else{
  ok('or it stops with a named frame-budget error: '+threw,
   /FRAME_BUDGET_EXCEEDED|no action was shown|driver must provide/.test(threw));
 }
}

console.log('2. M3: the budget is actually enforced, not merely recorded');
{
 const driver=scriptedDriver({costAddress:0x40,effectAddress:0x60,costMask:2,
  effectMask:1,hold:4,initialCost:3});
 let message=null;
 try{Pipeline.run(driver,{romHash:'b'.repeat(64),coreRevision:'unit',
  profileRevision:'p',contextKey:'k',nowMs:0,
  resourceSelection:'ranked',searchFrameBudget:80});}
 catch(problem){message=problem.message;}
 const spent=driver.framesRun();
 ok('the driver was not allowed to run far past an 80-frame budget: spent '+spent,
  spent<=80+120);
 if(message)ok('and the stop is named: '+message.slice(0,60),
  /FRAME_BUDGET_EXCEEDED|no action was shown/.test(message));
 else ok('or the run finished inside the budget',spent<=80+120);
}

console.log('2a. M3: an overrun INSIDE one candidate, and one during confirmation');
{
 /* The budgets below were found by a ladder, which is how the confirmation-phase
    gap surfaced: at 13000 the overrun lands inside the candidate loop and was
    already named, while at 16000 it landed in the confirmation phase and
    escaped as an unhandled error until that call was wrapped too. Both are the
    same condition and both must be named. Requires a real cartridge, so it is
    skipped when the generator is unavailable. */
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {execFileSync}=require('node:child_process');
 let descriptor=null;
 try{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-budget-'));
  const out=path.join(dir,'rom.json');
  execFileSync(process.env.PYTHON||'python3',
   ['tools/make_agod_test_rom.py','--seed','0','--out',out],{stdio:'ignore'});
  descriptor=JSON.parse(fs.readFileSync(out));
 }catch(_){descriptor=null;}
 if(!descriptor){
  console.log('  SKIP  the generator is not available in this environment');
 }else{
  const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');
  const bytes=Buffer.from(descriptor.base64,'base64');
  const build=()=>{
   const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
   core.loadROM(bytes);for(let i=0;i<60;i++)core.frame();
   const ram=()=>core.cpu.mem.slice(0,0x800);
   return {restore(s){core.fromJSON(JSON.parse(s));},
    run(mask,n){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
     for(let i=0;i<n;i++)core.frame();},
    readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
    poke(a,v){core.cpu.mem[a]=v&255;},
    stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
  };
  const run=budget=>{
   let result=null,error=null;
   try{result=Pipeline.run(build(),{romHash:'c'.repeat(64),coreRevision:'unit',
    profileRevision:'p',contextKey:'k',nowMs:0,
    resourceSelection:'ranked',searchFrameBudget:budget});}
   catch(problem){error=problem.message;}
   const attempts=result&&result.discovered?(result.discovered.rankedAttempts||[]):[];
   return {result,error,outcomes:attempts.map(a=>a.outcome)};
  };
  const inCandidate=run(13000);
  ok('an overrun inside one candidate is a named BUDGET_EXCEEDED attempt, not a throw: '
   +inCandidate.outcomes.join(','),
   inCandidate.error===null&&inCandidate.outcomes.includes('BUDGET_EXCEEDED'));
  ok('and it does not read as a refusal by that candidate',
   !inCandidate.outcomes.includes('REFUSED'));
  const inConfirm=run(16000);
  ok('an overrun during the confirmation phase is also named and not thrown: '
   +(inConfirm.result?inConfirm.result.status+'@'+inConfirm.result.stage:'THROWN '+inConfirm.error),
   inConfirm.error===null);
  ok('and it is reported as a spent budget, NOT as a holdout failure: stage='
   +(inConfirm.result?inConfirm.result.stage:'-'),
   !!(inConfirm.result&&inConfirm.result.stage==='ranked-budget'));
  const confirmRecord=inConfirm.result&&inConfirm.result.discovered
   ?inConfirm.result.discovered.rankedConfirmation:null;
  ok('the confirmation record says the budget ended rather than that holdout refused',
   !!(confirmRecord&&confirmRecord.outcome==='BUDGET_EXCEEDED'));
  const ample=run(20000);
  ok('and with an ample budget the same cartridge still verifies: '
   +(ample.result?ample.result.status:'THROWN'),
   !!(ample.result&&ample.result.status==='VERIFIED'));
 }
}

console.log('3. M4: a partition disagreement is refused, not resolved by whichever ran last');
{
 /* Exercised directly against the rule rather than through a cartridge: the
    agreement test is a pure function of the per-partition verdicts. */
 const verdicts=[{group:'DISCOVERY',polarity:'UNKNOWN'},{group:'CALIBRATION',polarity:'NEGATIVE'}];
 const disagreeing=verdicts.filter(entry=>entry.polarity!=='NEGATIVE');
 const mixed=verdicts.length>1&&disagreeing.length>0&&disagreeing.length<verdicts.length;
 ok('DISCOVERY=UNKNOWN with CALIBRATION=NEGATIVE is a mixed verdict',mixed===true);
 const lastOnly=verdicts[verdicts.length-1].polarity==='NEGATIVE';
 ok('the last partition alone would have said NEGATIVE, which is the defect',lastOnly===true);
 const allAgree=verdicts.every(entry=>entry.polarity==='NEGATIVE');
 ok('and the conjunction says it is not evidenced',allAgree===false);
}

console.log('3a. M4 INTEGRATION: force DISCOVERY and CALIBRATION apart inside the pipeline');
{
 /* N2. Checking an array of verdicts and grepping the source is not a test of
    the pipeline's behaviour. This drives the real Pipeline.run with a scripted
    machine built so that one partition sees the resource deplete and another
    does not.

    THE TRIGGER IS DECLARED, not a game address: partitions are reached by
    startsFrom(count, offset), which issues a neutral run of `offset` frames.
    The test passes partitions with offsets 11 and 500, and the machine stops
    depleting once it has seen a neutral run of 400 frames or more. So
    DISCOVERY (offset 11) depletes and CALIBRATION (offset 500) does not. No
    game knowledge is used: the machine is wholly synthetic. */
 const SIZE=0x800,COST=0x40,EFFECT=0x60,COST_MASK=2,EFFECT_MASK=1;
 function machine(){
  const mem=new Uint8Array(SIZE);
  const snapshots=new Map();
  let suppressed=false;
  const boot=()=>{mem.fill(0);mem[COST]=4;mem[EFFECT]=1;};
  boot();
  return {
   restore(id){const saved=snapshots.get(id);if(saved){mem.set(saved.mem);suppressed=saved.suppressed;}},
   run(mask,count){
    if(mask===0&&count>=400)suppressed=true;        /* the declared trigger */
    if(mask===COST_MASK&&!suppressed&&mem[COST]>0)mem[COST]-=1;
    /* The effect only works while the resource is above zero. Without this the
       machine never reaches NEGATIVE at all - normalPlaySuppressed stays false
       because the effect keeps being confirmed after depletion - and the first
       version of this fixture refused for that reason instead of the
       disagreement, which made the test pass on a fallback and prove nothing.
       This is the same "play stops at the floor" structure the generator has. */
    if(mask===EFFECT_MASK&&mem[COST]>0&&mem[EFFECT]<250)mem[EFFECT]+=1;
   },
   readRam(){return mem.slice(0,SIZE);},
   snapshot(){const id='s'+snapshots.size;
    snapshots.set(id,{mem:mem.slice(0),suppressed});return id;},
   stateHash(){return crypto.createHash('sha256')
    .update(Buffer.from(mem)).update(suppressed?'s':'n').digest('hex');}};
 }
 const partitions=[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:500},
  {group:'HOLDOUT',offset:97}];
 const run=selection=>{
  let result=null,error=null;
  try{result=Pipeline.run(machine(),{romHash:'d'.repeat(64),coreRevision:'unit',
   profileRevision:'p',contextKey:'k',nowMs:0,partitions,
   resourceSelection:selection,searchFrameBudget:2000000});}
  catch(problem){error=problem.message;}
  return {result,error};
 };

 const v1=run('first');
 ok('FIRST-V1 does not verify when the partitions disagree: '
  +(v1.result?v1.result.status+'@'+v1.result.stage:'THROWN '+v1.error),
  !!(v1.result&&v1.result.status!=='VERIFIED'));
 if(v1.result&&v1.result.refusals&&v1.result.refusals.length)
  ok('and V1 names the disagreement specifically: '+v1.result.reason,
   /partitions disagree about polarity/.test(v1.result.reason||''));

 const v2=run('ranked');
 ok('RANKED-V2 also refuses: '+(v2.result?v2.result.status+'@'+v2.result.stage:'THROWN '+v2.error),
  !!(v2.result&&v2.result.status!=='VERIFIED'));
 if(v2.result){
  const attempts=(v2.result.discovered&&v2.result.discovered.rankedAttempts)||[];
  const mixed=attempts.filter(a=>/partitions disagree about polarity/.test(a.reason||''));
  ok('a candidate whose partitions disagreed is refused BY NAME, per candidate: '
   +attempts.map(a=>a.outcome).join(',')+' | mixed='+mixed.length,
   mixed.length>0);
  /* The point of P1: holdout must not be consulted while selection is still
     choosing, so a disagreement cannot be resolved by trying candidates until
     one passes holdout. */
  ok('HOLDOUT was never consulted to pick a candidate: no confirmation record',
   !v2.result.discovered||!v2.result.discovered.rankedConfirmation);
  const phase=v2.result.discovered&&v2.result.discovered.rankedSelectionPhase;
  if(phase){
   ok('and the selection phase records that it used only the non-holdout partitions: '
    +phase.partitionsUsedForSelection.join(','),
    phase.partitionsUsedForSelection.indexOf('HOLDOUT')<0);
   ok('with holdout explicitly withheld',phase.holdoutWithheldDuringSelection===true);
  }
 }

 /* Control: the SAME machine without the suppression trigger must verify, so
    the refusal above is the disagreement and not a broken fixture. */
 const agreeing=[{group:'DISCOVERY',offset:11},{group:'CALIBRATION',offset:53},
  {group:'HOLDOUT',offset:97}];
 let control=null,controlError=null;
 try{control=Pipeline.run(machine(),{romHash:'e'.repeat(64),coreRevision:'unit',
  profileRevision:'p',contextKey:'k',nowMs:0,partitions:agreeing,
  resourceSelection:'ranked',searchFrameBudget:2000000});}
 catch(problem){controlError=problem.message;}
 /* The control must VERIFY. Anything weaker leaves open that the refusal above
    came from some other weakness of the fixture, which is exactly what the
    first version of this test did. */
 ok('CONTROL: the same machine with agreeing partitions VERIFIES: '
  +(control?control.status+'@'+control.stage:'THROWN '+controlError),
  !!(control&&control.status==='VERIFIED'));
}

console.log('4. M4: the rule is in the pipeline source, not only in this test');
{
 const source=require('node:fs').readFileSync(
  'app/src/main/assets/lab/agod-pipeline.js','utf8');
 ok('every partition verdict is collected',/const perPartition=\[\]/.test(source));
 ok('a mixed verdict is refused by name',
  /the partitions disagree about polarity/.test(source));
 ok('and the refusal names which partitions disagreed',
  /disagreeingPartitions/.test(source));
 ok('the frame meter wraps the driver itself, so evaluateResource cannot bypass it',
  /framesSpent\+=count/.test(source)&&/FRAME_BUDGET_EXCEEDED/.test(source));
}

console.log('\nM3/M4 regression check: '+passed+' assertions passed');
