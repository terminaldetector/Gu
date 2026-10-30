'use strict';
// S4b: the two findings from Sol's review of S4.
//
// (1) The oracle is gone from the proposer's inputs. The resource field and the
//     action that depletes it now come from the AGOD pipeline, and the oracle
//     FILE IS NOT EVEN READ until every proposal for a cartridge has been made -
//     a structural guarantee rather than a promise about ordering.
//
// (2) Rate modulation now names the field responsible and runs a frame-matched
//     neutral control. The old context term is still computed, so the two can be
//     compared on the same data instead of argued about.
//
// Three families now, including one written to break the rule from both ends:
// a beneficial field with a constant rate (a false negative for the S4 rule) and
// a useless field that is genuinely causally rate-modulated and persisted (a
// false positive that is expected to survive the fix, because nothing in RAM
// separates it from a quantity worth having).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Positive=require('../app/src/main/assets/lab/agod-positive.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-s4b-'));
const SEEDS=[0,1,2,3,4,5,6];
const HOLD=4,RELEASE=8,SETTLE=30,REV='profile-rev-1',CORE='jsnes-nes';
const FAMILIES=[
 {name:'survival',generator:'make_agod_test_rom.py'},
 {name:'sacrifice',generator:'make_agod_sacrifice_rom.py'},
 {name:'rate-trap',generator:'make_agod_rate_trap_rom.py'}];
const proposals=[],pipelineRuns=[];
const result={type:'gu-agod-positive-s4b-check',version:1,
 scope:'host emulator; three controlled families, 7 cartridges each',
 oracleDiscipline:'the oracle file is read only after every proposal for that cartridge is made; the proposer receives nothing from it',
 rule:Positive.RULE.slice(),supersededTerm:'contextDependentRate',
 claim:'The resource and its action come from the pipeline, not the oracle. Naming the modulating field removes one class of false positive and cannot remove the other: a useless field that is genuinely rate-modulated and persisted stays indistinguishable from a beneficial one.',
 status:'RUNNING',proposals,pipelineRuns};
const save=()=>{if(process.env.AGOD_S4B_REPORT)fs.writeFileSync(process.env.AGOD_S4B_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};
const S4_RULE=['monotoneNotTimeDriven','survivesResourceReversal','contextDependentRate'];

function cartridge(generator,seed){
 const cart=path.join(directory,generator+'-'+seed+'.json'),orc=path.join(directory,generator+'-'+seed+'-o.json');
 execFileSync(process.env.PYTHON||'python3',['tools/'+generator,'--seed',String(seed),'--out',cart,'--oracle-out',orc]);
 const descriptor=JSON.parse(fs.readFileSync(cart));
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
 for(let i=0;i<60;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const driver={restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
 /* The oracle path is returned, not its contents. Reading it is a separate,
    later step, so no accidental use can creep in. */
 return {descriptor,driver,oraclePath:orc};
}

try{
 for(const family of FAMILIES){
  for(const seed of SEEDS){
   const {descriptor,driver,oraclePath}=cartridge(family.generator,seed);
   const boot=driver.snapshot();

   // Everything the proposer needs comes from here.
   const piped=Pipeline.run(driver,{romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV,
    contextKey:descriptor.sha256+'/'+CORE,nowMs:1761800000000});
   const discovered=piped.discovered;
   pipelineRuns.push({family:family.name,seed,status:piped.status,stage:piped.stage,
    reason:piped.reason,
    discoveredResource:discovered?{address:discovered.resource.address,mask:discovered.resource.mask,step:discovered.resource.step}:null,
    increasingFieldCount:discovered?discovered.increasingFields.length:0});save();
   assert(discovered,family.name+'/'+seed+': the pipeline must report what it discovered even when it refuses');

   const resource=discovered.resource,resourceMask=discovered.resource.mask;
   const neutralMoved=new Set(discovered.neutralMovedAddresses);
   const modulators=[...discovered.increasingFields.map(field=>({field,mask:field.mask})),
    {field:resource,mask:resourceMask}];
   const made=[];
   for(const candidate of discovered.increasingFields){
    driver.restore(boot);
    const proposal=Positive.proposePositive(driver,{
     candidate,candidateMask:candidate.mask,resource,resourceMask,
     modulators,pristine:boot,neutralMoved,hold:HOLD,release:RELEASE,settle:SETTLE});
    const s4Missing=S4_RULE.filter(name=>!proposal.factors[name]);
    made.push({candidate,proposal,s4Proposed:s4Missing.length===0});
    assert(!has(proposal,'value'),'a proposal must never carry a value key');
    assert.notEqual(proposal.lifecycle,'VERIFIED','a proposal must never be VERIFIED');
   }

   // ---- only now is the oracle opened, to score what was already decided ----
   const oracle=JSON.parse(fs.readFileSync(oraclePath));
   const label=oracle.positiveLabel;
   const beneficial=label.anyFieldDemonstrablyBeneficial?oracle.fields[label.field]:null;
   const trapFalsePositive=oracle.traps?oracle.fields[oracle.traps.falsePositiveUnderS4Rule.field]:null;
   const names=Object.entries(oracle.fields);
   for(const {candidate,proposal,s4Proposed} of made){
    const addresses=spanOf(candidate);
    const named=names.find(([,field])=>spanOf(field).some(a=>addresses.includes(a)));
    proposals.push({family:family.name,seed,romHash:descriptor.sha256,
     mask:candidate.mask,address:candidate.address,width:candidate.width,step:candidate.step,
     oracleName:named?named[0]:null,
     labelledBeneficial:!!beneficial&&spanOf(beneficial).some(a=>addresses.includes(a)),
     isDesignedTrapFalsePositive:!!trapFalsePositive&&spanOf(trapFalsePositive).some(a=>addresses.includes(a)),
     s4RuleProposed:s4Proposed,
     s4bRuleProposed:proposal.status==='PROVISIONAL_GOAL',
     factors:{monotoneNotTimeDriven:proposal.factors.monotoneNotTimeDriven,
      survivesResourceReversal:proposal.factors.survivesResourceReversal,
      causallyModulatedByAttributedField:proposal.factors.causallyModulatedByAttributedField,
      unlocksNewMode:proposal.factors.unlocksNewMode,
      contextDependentRate:proposal.factors.contextDependentRate,
      changesAvailableActions:proposal.factors.changesAvailableActions,
      reachesStatesNeutralPlayDoesNot:proposal.factors.reachesStatesNeutralPlayDoesNot},
     attributedModulators:proposal.factors.detail.attributedModulators,
     unlockedMasks:proposal.factors.detail.unlockedMasks});
   }
   save();
  }
 }

 const score=(rows,key)=>{
  const proposed=rows.filter(r=>r[key]);
  const truePositives=proposed.filter(r=>r.labelledBeneficial).length;
  const beneficial=rows.filter(r=>r.labelledBeneficial).length;
  return {candidates:rows.length,proposed:proposed.length,
   truePositives,falsePositives:proposed.length-truePositives,
   missed:beneficial-proposed.filter(r=>r.labelledBeneficial).length,
   precision:proposed.length?truePositives/proposed.length:null,
   recall:beneficial?truePositives/beneficial:null,
   abstentionRate:rows.length?(rows.length-proposed.length)/rows.length:null};
 };
 const group=name=>proposals.filter(r=>r.family===name);
 const factorTable=rows=>{
  const out={};
  for(const factor of Object.keys(rows[0].factors))
   out[factor]={onBeneficial:rows.filter(r=>r.labelledBeneficial&&r.factors[factor]).length,
    beneficialTotal:rows.filter(r=>r.labelledBeneficial).length,
    onOther:rows.filter(r=>!r.labelledBeneficial&&r.factors[factor]).length,
    otherTotal:rows.filter(r=>!r.labelledBeneficial).length};
  return out;
 };
 const traps=proposals.filter(r=>r.isDesignedTrapFalsePositive);
 const constantRateBeneficial=group('rate-trap').filter(r=>r.labelledBeneficial);
 result.totals={
  familiesMeasured:FAMILIES.length,cartridgesPerFamily:SEEDS.length,
  oracleInProposerInputs:false,
  s4Rule:{overall:score(proposals,'s4RuleProposed'),
   survival:score(group('survival'),'s4RuleProposed'),
   sacrifice:score(group('sacrifice'),'s4RuleProposed'),
   rateTrap:score(group('rate-trap'),'s4RuleProposed')},
  s4bRule:{overall:score(proposals,'s4bRuleProposed'),
   survival:score(group('survival'),'s4bRuleProposed'),
   sacrifice:score(group('sacrifice'),'s4bRuleProposed'),
   rateTrap:score(group('rate-trap'),'s4bRuleProposed')},
  trapA_constantRateBeneficial:{candidates:constantRateBeneficial.length,
   caughtByS4Rule:constantRateBeneficial.filter(r=>r.s4RuleProposed).length,
   caughtByS4bRule:constantRateBeneficial.filter(r=>r.s4bRuleProposed).length,
   note:'a beneficial field whose gain rate never changes; the S4 rule cannot see it, the unlock term can'},
  trapB_usefulLookingDecoy:{candidates:traps.length,
   proposedByS4Rule:traps.filter(r=>r.s4RuleProposed).length,
   proposedByS4bRule:traps.filter(r=>r.s4bRuleProposed).length,
   causallyModulated:traps.filter(r=>r.factors.causallyModulatedByAttributedField).length,
   note:'useless, yet monotone, persisted and genuinely causally rate-modulated: it stays a false positive, and that is a limit of what RAM can show'},
  factorsOverall:factorTable(proposals)};
 save();

 const t=result.totals;
 assert.equal(t.trapA_constantRateBeneficial.caughtByS4Rule,0,
  'trap A must be invisible to the S4 rule, otherwise it is not the trap it claims to be');
 assert.equal(t.trapA_constantRateBeneficial.caughtByS4bRule,t.trapA_constantRateBeneficial.candidates,
  'the unlock term must catch every constant-rate beneficial field');
 assert.equal(t.trapB_usefulLookingDecoy.proposedByS4Rule,t.trapB_usefulLookingDecoy.candidates,
  'trap B must fool the S4 rule');
 assert(t.s4bRule.overall.recall===1,'every labelled beneficial field must still be proposed');
 assert(t.s4bRule.overall.falsePositives>0,
  'trap B is expected to survive the fix: a precision of 1 here would mean the trap was not built as described');
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:t,pipelineRuns,proposals}));
 console.log('PASS: the proposer takes the resource and its action from the pipeline and the oracle file is read only afterwards. '+
  'Across 3 families: the S4 rule scores precision '+String(t.s4Rule.overall.precision)+' / recall '+String(t.s4Rule.overall.recall)+
  ', the S4b rule precision '+t.s4bRule.overall.precision.toFixed(3)+' / recall '+t.s4bRule.overall.recall.toFixed(3)+
  '. Trap A (beneficial, constant rate) is missed by the S4 rule '+t.trapA_constantRateBeneficial.candidates+'/'+t.trapA_constantRateBeneficial.candidates+
  ' and caught by the unlock term. Trap B (useless, causally rate-modulated, persisted) fools both rules '+
  t.trapB_usefulLookingDecoy.proposedByS4bRule+'/'+t.trapB_usefulLookingDecoy.candidates+
  ' - naming the modulator proves causality and still cannot prove worth.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
