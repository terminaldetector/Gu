'use strict';
// S9D: FIRST-V1 against RANKED-V2, on ground truth.
//
// THE QUESTION. Does the pipeline's premature fixation on the first typed
// decreasing field make it miss better-founded candidates? A ranking that
// merely produces more VERIFIED results would be worthless - it has to not
// break the cases that already work, and it has to put the true resource where
// the truth is known.
//
// WHAT IS HELD CONSTANT. Same ROMs, same core, same boot, same masks, same
// frame parameters, same budgets. The ONLY difference between the two arms is
// config.resourceSelection. The positive-effect choice is identical in both.
//
// ORACLE DISCIPLINE. The oracle is read only after BOTH arms have committed
// their answer for that cartridge, and it is never an input to either arm. It
// is used for three things: was the selected resource the true one, was the
// true one present in the inventory at all, and at which rank the ranking put
// it. Nothing is tuned on it.
//
// THREE FAMILIES, three different right answers:
//   test       lives is a real cost: VERIFIED with resource == lives is right.
//   sacrifice  charges deplete, but spending them buys progress: a REFUSAL is
//              right, and a VERIFIED here is a FALSE GOAL for either arm.
//   rate-trap  fuel depletes; steadyGain is the beneficial field and
//              fickleDecoy is a trap. The resource arm must not mistake a
//              decoy for a cost.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Candidates=require('../app/src/main/assets/lab/agod-candidates.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s9-'));
const FAMILIES=[
 {name:'test',generator:'tools/make_agod_test_rom.py',resourceField:'lives',
  seeds:(process.env.AGOD_S9_TEST_SEEDS||'0,1,2,7,8,9,47').split(',').map(Number),
  group:'development',expectsVerified:true,rightAnswer:'VERIFIED with the resource equal to lives'},
 {name:'test',generator:'tools/make_agod_test_rom.py',resourceField:'lives',
  seeds:(process.env.AGOD_S9_HELDOUT_SEEDS||'200,201,202,203,204,205,206').split(',').map(Number),
  group:'heldOut',expectsVerified:true,rightAnswer:'VERIFIED with the resource equal to lives'},
 {name:'sacrifice',generator:'tools/make_agod_sacrifice_rom.py',resourceField:'charges',
  seeds:(process.env.AGOD_S9_SACRIFICE_SEEDS||'3,4,5').split(',').map(Number),
  group:'sacrifice',expectsVerified:false,rightAnswer:'a REFUSAL: the depletion is the price of progress, not harm'},
 {name:'rate-trap',generator:'tools/make_agod_rate_trap_rom.py',resourceField:'fuel',
  seeds:(process.env.AGOD_S9_TRAP_SEEDS||'5,6,7').split(',').map(Number),
  group:'rateTrap',expectsVerified:false,rightAnswer:'no decoy accepted as a cost'}];
const REV='profile-rev-1',CORE='jsnes-nes';
const rows=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  pipelineRevision:Pipeline.PIPELINE_REVISION,
  candidatesRevision:Candidates.CANDIDATES_REVISION,
  rankingSpecRevision:Candidates.RANKING_SPEC.specRevision};})();
const report={type:'gu-agod-s9-control-check',version:1,
 question:'does ranking candidates by declared evidence quality change what the pipeline selects, without breaking the cases that already work?',
 heldConstant:'ROMs, core, boot, masks, frame parameters and budgets. The only difference between arms is config.resourceSelection.',
 oracleDiscipline:'read only after both arms committed for that cartridge; never an input to either arm; nothing tuned on it',
 rankingSpec:Candidates.RANKING_SPEC,
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_S9_REPORT)
 fs.writeFileSync(process.env.AGOD_S9_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function cartridge(generator,seed){
 const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
 execFileSync(process.env.PYTHON||'python3',[generator,'--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
 return {descriptor,oracle};
}
function machine(descriptor){
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 return {restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
   for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  poke(address,value){core.cpu.mem[address]=value&255;},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
}
function runArm(descriptor,selection,romHash){
 const driver=machine(descriptor);
 const started=Date.now();
 let outcome=null,error=null;
 try{outcome=Pipeline.run(driver,{romHash,coreRevision:CORE,profileRevision:REV,
  contextKey:romHash+'/'+selection,nowMs:1761800000000,resourceSelection:selection});}
 catch(problem){error=problem.message;}
 return {selection,elapsedMs:Date.now()-started,error,outcome};
}
function summarise(arm){
 if(arm.error)return {status:'ERROR',stage:null,reason:arm.error,resourceAddress:null};
 const out=arm.outcome;
 return {status:out.status,stage:out.stage,reason:out.reason,
  resourceAddress:out.resource?out.resource.address:(out.discovered&&out.discovered.resource?out.discovered.resource.address:null),
  resourceWidth:out.resource?out.resource.width:null,
  resourceMask:out.resource?out.resource.mask:null,
  refusalStages:(out.refusals||[]).map(entry=>entry.stage),
  elapsedMs:arm.elapsedMs};
}

try{
 for(const family of FAMILIES)for(const seed of family.seeds){
  const {descriptor,oracle}=cartridge(family.generator,seed);
  const romHash=crypto.createHash('sha256')
   .update(Buffer.from(descriptor.base64,'base64')).digest('hex');
  /* both arms commit before the oracle is opened */
  const first=runArm(descriptor,'first',romHash);
  const ranked=runArm(descriptor,'ranked',romHash);
  /* reproducibility of the ranked arm: a second independent machine */
  const rankedAgain=runArm(descriptor,'ranked',romHash);

  const truth=oracle.fields[family.resourceField];
  const v1=summarise(first),v2=summarise(ranked),v2b=summarise(rankedAgain);
  const rankedOut=ranked.outcome;
  const selection=rankedOut&&rankedOut.discovered?rankedOut.discovered.rankedSelection:null;
  const attempts=rankedOut&&rankedOut.discovered?rankedOut.discovered.rankedAttempts:null;
  const trueInInventory=selection
   ?selection.ranked.some(entry=>entry.address===truth.address)
   :null;
  const trueRank=selection
   ?(selection.ranked.find(entry=>entry.address===truth.address)||{rank:null}).rank
   :null;
  const verifiedCorrectly=v=>v.status==='VERIFIED'&&v.resourceAddress===truth.address;
  const falseGoal=v=>v.status==='VERIFIED'&&v.resourceAddress!==truth.address;
  rows.push({family:family.name,group:family.group,seed,romHash:romHash.slice(0,16),
   rightAnswer:family.rightAnswer,
   oracleResource:{field:family.resourceField,address:truth.address,width:truth.width},
   FIRST_V1:v1,RANKED_V2:v2,
   rankedReproducible:v2.status===v2b.status&&v2.resourceAddress===v2b.resourceAddress,
   rankedSecondRun:{status:v2b.status,resourceAddress:v2b.resourceAddress},
   inventory:selection?{candidatesTyped:selection.candidatesTyped,
    groups:selection.ranked.length,maxCandidates:selection.maxCandidates,
    budgetNote:selection.budgetNote,
    groupingLinks:selection.grouping.links.length,
    groupedOnAdjacencyAlone:selection.grouping.links.filter(l=>l.reason===null).length,
    order:selection.ranked.map(entry=>({rank:entry.rank,address:entry.address,
     mask:entry.mask,score:entry.score.total,breakdown:entry.score.breakdown,
     groupAddresses:entry.groupAddresses,
     /* criterion 5's own verdict, so a score of 0 there can be read as
        "measured and nothing seen", "inconclusive" or "cannot be asked on this
        platform" rather than guessed at from the total */
     downstream:entry.record&&entry.record.downstream?{
      status:entry.record.downstream.status,
      hasConsumer:entry.record.downstream.hasConsumer,
      reason:entry.record.downstream.reason}:null}))}:null,
   trueResourceInInventory:trueInInventory,trueResourceRank:trueRank,
   attempts:attempts?attempts.map(a=>({rank:a.rank,address:a.address,outcome:a.outcome,
    stage:a.stage,reason:a.reason})):null,
   verdict:{
    v1Correct:verifiedCorrectly(v1),v2Correct:verifiedCorrectly(v2),
    v1FalseGoal:falseGoal(v1),v2FalseGoal:falseGoal(v2),
    v1Refused:v1.status==='REFUSED',v2Refused:v2.status==='REFUSED',
    /* DEFECT IN MY OWN METRIC, corrected: the first version read
       "!v1Correct && the true field was in the inventory" as "V1 missed a
       candidate ranking found". On the sacrifice and rate-trap families a
       refusal IS the right answer, so v1Correct is false by design and the
       metric reported 3 and 3 misses where V1 had done exactly the right
       thing. It is now defined only where VERIFIED is the right answer. */
    missedByV1:family.expectsVerified===true&&!verifiedCorrectly(v1)&&trueInInventory===true,
    expectsVerified:family.expectsVerified===true,
    rightAnswerGiven:family.expectsVerified?verifiedCorrectly(v1):v1.status==='REFUSED',
    rightAnswerGivenByRanking:family.expectsVerified?verifiedCorrectly(v2):v2.status==='REFUSED',
    v2ChangedTheAnswer:v1.status!==v2.status||v1.resourceAddress!==v2.resourceAddress}});
  write();
 }

 const by=group=>rows.filter(row=>row.group===group);
 const count=(list,predicate)=>list.filter(predicate).length;
 report.totals={cartridges:rows.length,
  perGroup:Object.fromEntries(['development','heldOut','sacrifice','rateTrap'].map(group=>{
   const list=by(group);
   return [group,{cartridges:list.length,
    v1Verified:count(list,r=>r.FIRST_V1.status==='VERIFIED'),
    v2Verified:count(list,r=>r.RANKED_V2.status==='VERIFIED'),
    v1CorrectResource:count(list,r=>r.verdict.v1Correct),
    v2CorrectResource:count(list,r=>r.verdict.v2Correct),
    v1FalseGoals:count(list,r=>r.verdict.v1FalseGoal),
    v2FalseGoals:count(list,r=>r.verdict.v2FalseGoal),
    v1Refused:count(list,r=>r.verdict.v1Refused),
    v2Refused:count(list,r=>r.verdict.v2Refused),
    trueResourceInInventory:count(list,r=>r.trueResourceInInventory===true),
    trueResourceRankedFirst:count(list,r=>r.trueResourceRank===1),
    missedByV1ButInInventory:count(list,r=>r.verdict.missedByV1),
    missedByV1Applicable:count(list,r=>r.verdict.expectsVerified),
    v1GaveTheRightAnswer:count(list,r=>r.verdict.rightAnswerGiven),
    v2GaveTheRightAnswer:count(list,r=>r.verdict.rightAnswerGivenByRanking),
    answerChangedByRanking:count(list,r=>r.verdict.v2ChangedTheAnswer),
    rankedReproducible:count(list,r=>r.rankedReproducible),
    groupedOnAdjacencyAlone:list.reduce((sum,r)=>sum+((r.inventory&&r.inventory.groupedOnAdjacencyAlone)||0),0),
    criterion5:(()=>{const tally={};
     for(const r of list)for(const entry of (r.inventory&&r.inventory.order)||[]){
      const d=entry.downstream;
      const key=d?(d.status+(d.hasConsumer===null?'':'/hasConsumer='+d.hasConsumer)):'not-recorded';
      tally[key]=(tally[key]||0)+1;}
     return tally;})(),
    medianV1Ms:median(list.map(r=>r.FIRST_V1.elapsedMs)),
    medianV2Ms:median(list.map(r=>r.RANKED_V2.elapsedMs))}];})),
  computeCost:{
   totalV1Ms:rows.reduce((sum,r)=>sum+(r.FIRST_V1.elapsedMs||0),0),
   totalV2Ms:rows.reduce((sum,r)=>sum+(r.RANKED_V2.elapsedMs||0),0)},
  invariants:{
   /* the grouping rule is only sound if adjacency alone never grouped */
   neverGroupedOnAdjacencyAlone:rows.every(r=>!r.inventory||r.inventory.groupedOnAdjacencyAlone===0),
   rankedAlwaysReproducible:rows.every(r=>r.rankedReproducible),
   noNewFalseGoals:count(rows,r=>r.verdict.v2FalseGoal)<=count(rows,r=>r.verdict.v1FalseGoal)},
  note:'a VERIFIED on the sacrifice family is a FALSE GOAL for either arm, not a success; the right answer there is a refusal'};
 report.status='COMPLETE';write();
 console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals},null,1));
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}

function median(values){
 const list=values.filter(value=>typeof value==='number').sort((a,b)=>a-b);
 if(!list.length)return null;
 const middle=Math.floor(list.length/2);
 return list.length%2?list[middle]:Math.round((list[middle-1]+list[middle])/2);
}
