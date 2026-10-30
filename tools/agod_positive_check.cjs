'use strict';
// S4: automatic POSITIVE hypotheses, and what they are worth.
//
// The rule is fixed inside agod-positive.js before any measurement and is not a
// tuned quorum. This check applies it to every increasing field it can find on
// both controlled families and scores the result against closed oracle labels:
//
//   survival family  - no field is demonstrably beneficial. The counter is an
//                      accumulator, a reset zeroes it, nothing makes a larger
//                      value better. Any proposal here is a FALSE POSITIVE.
//   sacrifice family - treasure is beneficial: produced by play, it survives the
//                      restart that refills the charges, and its gain rate rises
//                      with progress. Proposing it is a TRUE POSITIVE; proposing
//                      charges, progress, the gate or a decoy is a false one.
//
// Precision, recall and abstention are reported per family and overall, and the
// per-factor table is reported too, so a factor that did no work is visible
// rather than hidden inside a score.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      Positive=require('../app/src/main/assets/lab/agod-positive.js'),
      Reward=require('../app/src/main/assets/lab/agod-reward.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-positive-'));
const SEEDS=[0,1,2,3,4,5,6];
const FRAMES=12,SHIFT=3,STARTS=2,HOLD=4,RELEASE=8,SETTLE=30,TYPE_EVENTS=60;
const proposals=[],separation=[];
const result={type:'gu-agod-positive-check',version:1,
 scope:'host emulator; both controlled families, 7 cartridges each',
 oracle:'checker-only, read after every proposal; it carries the closed positive labels',
 rule:Positive.RULE.slice(),
 claim:'POSITIVE hypotheses can be generated automatically and scored. They remain hypotheses: a ProvisionalGoal carries no value and cannot be claimed.',
 status:'RUNNING',proposals,separation};
const save=()=>{if(process.env.AGOD_POSITIVE_REPORT)fs.writeFileSync(process.env.AGOD_POSITIVE_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};

function cartridge(generator,seed){
 const cart=path.join(directory,generator+'-'+seed+'.json'),orc=path.join(directory,generator+'-'+seed+'-o.json');
 execFileSync(process.env.PYTHON||'python3',['tools/'+generator,'--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 return {descriptor,oracle,driver};
}

try{
 // ---------------- the three mechanisms stay apart ----------------
 {const note=(name,expectation,observed)=>{separation.push({name,expectation,observed});save();};
  const list=Reward.channels();
  note('three mechanisms are named','exactly one carries a value key',
   list.map(c=>c.mechanism+(c.carriesValueKey?'[value]':'[no value]')).join(' '));
  assert.equal(list.length,3);
  assert.equal(list.filter(c=>c.carriesValueKey).length,1,'only the verified channel may carry a value');
  const provisional=Reward.provisionalSignal('candidate',4),intrinsic=Reward.intrinsicSignal('novelty',0.7);
  note('a provisional signal','no value key, before or after JSON',
   'hasValue '+has(provisional,'value')+', afterJson '+has(JSON.parse(JSON.stringify(provisional)),'value'));
  assert(!has(provisional,'value')&&!has(JSON.parse(JSON.stringify(provisional)),'value'));
  assert(!has(intrinsic,'value'));
  assert.equal(provisional.provisionalValue,4);
  // A provisional goal offered to the broker must not pay.
  const broker=Reward.createBroker({profileRevision:'rev','contextKey':'ctx'});
  const claim=broker.claim({eventId:'e1',source:'verified-goal',profileRevision:'rev',contextKey:'ctx',
   goal:{id:'g',lifecycle:'CANDIDATE',polarity:'UNKNOWN'},
   executedAction:{mask:1,frames:6,complete:true,manualOverride:false},
   requestedMask:1,magnitude:1,phase:'PLAYING',episode:{partition:'discovery'},ageMs:5});
  note('a provisional goal offered to the broker','refused, with no value key',claim.status+', hasValue '+has(claim,'value'));
  assert.equal(claim.status,'UNKNOWN');assert(!has(claim,'value'));}

 // ---------------- proposals on both families ----------------
 for(const family of [
  {name:'survival',generator:'make_agod_test_rom.py',resourceName:'lives',resourceMask:o=>o.negativeMask},
  {name:'sacrifice',generator:'make_agod_sacrifice_rom.py',resourceName:'charges',resourceMask:o=>o.spendMask}]){
  for(const seed of SEEDS){
   const {descriptor,oracle,driver}=cartridge(family.generator,seed);
   const pristine=driver.snapshot();
   const label=oracle.positiveLabel;
   const resourceField=oracle.fields[family.resourceName],resourceMask=family.resourceMask(oracle);

   // Find the increasing fields without the oracle: attribution then typing.
   const starts=[];
   for(let i=0;i<STARTS;i++){driver.run(0,17+i*13);starts.push({id:'s'+i,stateHash:driver.stateHash(),snapshot:driver.snapshot()});}
   const play=(mask,events)=>{const samples=[];
    for(let e=0;e<events;e++){driver.run(mask,HOLD);driver.run(0,RELEASE);samples.push(driver.readRam());}return samples;};
   const movedIn=samples=>{const out=new Set();
    for(let i=1;i<samples.length;i++)for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])out.add(a);return out;};
   driver.restore(pristine);
   const neutralMoved=movedIn(play(0,TYPE_EVENTS));
   const candidates=[];
   for(let bit=0;bit<8;bit++){
    const mask=1<<bit;
    driver.restore(pristine);
    const probe=Causal.probeAction(driver,{starts,mask,neutralMask:0,
     alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
    if(!probe.confirmed.length)continue;
    driver.restore(pristine);
    const samples=play(mask,TYPE_EVENTS);
    const addresses=[...movedIn(samples)].filter(a=>!neutralMoved.has(a)).sort((a,b)=>a-b);
    for(const span of Ram.spansOf(addresses)){
     const typed=Ram.identifyField({samples,addresses:span});
     if(typed.status==='IDENTIFIED'&&typed.field.direction==='increasing')candidates.push({mask,field:typed.field});
    }
   }

   for(const candidate of candidates){
    driver.restore(pristine);
    const proposal=Positive.proposePositive(driver,{
     candidate:candidate.field,candidateMask:candidate.mask,
     resource:resourceField,resourceMask,
     pristine,neutralMoved,hold:HOLD,release:RELEASE,settle:SETTLE});
    // Only now is the label consulted, to score what was already decided.
    const trueField=label.anyFieldDemonstrablyBeneficial?oracle.fields[label.field]:null;
    const isTrue=!!trueField&&spanOf(candidate.field).some(a=>spanOf(trueField).includes(a));
    proposals.push({family:family.name,seed,romHash:descriptor.sha256,
     mask:candidate.mask,field:{address:candidate.field.address,width:candidate.field.width,step:candidate.field.step},
     status:proposal.status,factors:{...proposal.factors,detail:undefined},
     factorsHeld:proposal.factorsHeld,factorsMissing:proposal.factorsMissing,
     detail:proposal.factors.detail,
     labelledBeneficial:isTrue,
     carriesValueKey:has(proposal,'value'),
     everVerified:proposal.status==='PROVISIONAL_GOAL'&&proposal.lifecycle==='VERIFIED'});
    save();
    assert(!has(proposal,'value'),'a proposal must never carry a value key');
    assert.notEqual(proposal.lifecycle,'VERIFIED','a proposal must never be VERIFIED');
    if(proposal.status==='PROVISIONAL_GOAL')assert.equal(proposal.channel,'provisional');
   }
   assert(candidates.length>0,family.name+'/'+seed+': at least one increasing field must be found');
  }
 }

 const group=name=>proposals.filter(row=>row.family===name);
 const score=rows=>{
  const proposed=rows.filter(r=>r.status==='PROVISIONAL_GOAL');
  const truePositives=proposed.filter(r=>r.labelledBeneficial).length;
  const falsePositives=proposed.length-truePositives;
  const beneficial=rows.filter(r=>r.labelledBeneficial).length;
  const found=rows.filter(r=>r.labelledBeneficial&&r.status==='PROVISIONAL_GOAL').length;
  return {candidates:rows.length,proposed:proposed.length,abstained:rows.length-proposed.length,
   truePositives,falsePositives,
   precision:proposed.length?truePositives/proposed.length:null,
   recall:beneficial?found/beneficial:null,
   abstentionRate:rows.length?(rows.length-proposed.length)/rows.length:null,
   labelledBeneficialCandidates:beneficial};
 };
 const factorTable=name=>{
  const rows=group(name),out={};
  for(const factor of [...Positive.RULE,...Positive.RECORDED_ONLY])
   out[factor]={onBeneficial:rows.filter(r=>r.labelledBeneficial&&r.factors[factor]).length,
    beneficialTotal:rows.filter(r=>r.labelledBeneficial).length,
    onOther:rows.filter(r=>!r.labelledBeneficial&&r.factors[factor]).length,
    otherTotal:rows.filter(r=>!r.labelledBeneficial).length};
  return out;
 };
 result.totals={cartridgesPerFamily:SEEDS.length,
  survival:score(group('survival')),sacrifice:score(group('sacrifice')),
  overall:score(proposals),
  factorsSurvival:factorTable('survival'),factorsSacrifice:factorTable('sacrifice'),
  proposalsCarryingValueKey:proposals.filter(r=>r.carriesValueKey).length,
  proposalsEverVerified:proposals.filter(r=>r.everVerified).length,
  separationChecks:separation.length};
 save();

 const overall=result.totals.overall,sacrifice=result.totals.sacrifice,survival=result.totals.survival;
 assert.equal(result.totals.proposalsCarryingValueKey,0,'no proposal may carry a value');
 assert.equal(result.totals.proposalsEverVerified,0,'no proposal may be VERIFIED');
 assert.equal(survival.falsePositives,0,'the survival family has no beneficial field: every proposal there is a false positive');
 assert.equal(sacrifice.recall,1,'treasure must be proposed on every sacrifice cartridge');
 assert.equal(overall.precision,1,'a false positive would mean the rule asserts game meaning it cannot see');
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,proposals,separation}));
 console.log('PASS: the pre-registered rule proposed '+overall.proposed+' of '+overall.candidates+
  ' increasing fields across both families - precision '+overall.precision.toFixed(3)+
  ', recall '+overall.recall.toFixed(3)+', abstention '+overall.abstentionRate.toFixed(3)+
  '; 0 false positives on the family where nothing is beneficial, 0 proposals carried a value key and 0 were ever VERIFIED. Game semantics still need an independent oracle.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
