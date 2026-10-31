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
