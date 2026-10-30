'use strict';
// S4c: does the cartridge read the variable, and whose causality is the
// modulation - the action's or the field's?
//
// This check is allowed to contradict my own closed labels, and it is written
// expecting to. The sacrifice family labels `treasure` beneficial because play
// produces it, it survives the restart and its gain rate rises with progress.
// None of that says anything reads it. If poking treasure changes nothing the
// machine does, then by the standard the user set - an accumulated variable must
// not become beneficial because a label says so - that label was unjustified,
// and the S4/S4b true positives that rest on it are weaker than reported.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Pipeline=require('../app/src/main/assets/lab/agod-pipeline.js'),
      Consumers=require('../app/src/main/assets/lab/agod-consumers.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-consumers-'));
const SEEDS=[0,1,2],HOLD=4,RELEASE=8,SETTLE=30,REV='profile-rev-1',CORE='jsnes-nes';
const FAMILIES=[
 {name:'survival',generator:'make_agod_test_rom.py'},
 {name:'sacrifice',generator:'make_agod_sacrifice_rom.py'},
 {name:'rate-trap',generator:'make_agod_rate_trap_rom.py'}];
const fields=[],modulation=[];
const result={type:'gu-agod-consumers-check',version:1,
 scope:'host emulator; three controlled families, 3 cartridges each',
 instrument:'a counterfactual on the field itself: write a reachable second value, leave everything else identical, run a fixed schedule and compare RAM outside the field own bytes',
 claim:'Whether a cartridge reads a variable is measurable, and it does not follow from the variable accumulating, persisting or being rate-modulated. Where this disagrees with a closed label, the label is the thing that is wrong.',
 status:'RUNNING',fields,modulation};
const save=()=>{if(process.env.AGOD_CONSUMERS_REPORT)fs.writeFileSync(process.env.AGOD_CONSUMERS_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};

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
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');},
  /* Only the checker may do this. It is how a counterfactual on a field is
     possible at all, and it is not something a player could do. */
  poke(address,value){core.cpu.mem[address]=value&255;}};
 return {descriptor,driver,oraclePath:orc};
}

try{
 for(const family of FAMILIES){
  for(const seed of SEEDS){
   const {descriptor,driver,oraclePath}=cartridge(family.generator,seed);
   const boot=driver.snapshot();
   const piped=Pipeline.run(driver,{romHash:descriptor.sha256,coreRevision:CORE,profileRevision:REV,
    contextKey:descriptor.sha256+'/'+CORE,nowMs:1761800000000});
   const discovered=piped.discovered;
   assert(discovered,family.name+'/'+seed+': discovery must report its findings');
   const resource=discovered.resource;
   const candidates=[...discovered.increasingFields,{...resource,isResource:true}];

   for(const candidate of candidates){
    driver.restore(boot);
    const consumer=Consumers.downstreamConsumer(driver,{field:candidate,fieldMask:candidate.mask,
     pristine:boot,hold:HOLD,release:RELEASE,steps:24,driveTimes:16});
    driver.restore(boot);
    const against=discovered.increasingFields.find(f=>f.address!==candidate.address)||resource;
    const causality=candidate.isResource?null:Consumers.fieldCausality(driver,{
     candidate,candidateMask:candidate.mask,
     modulator:resource,modulatorMask:resource.mask,
     pristine:boot,hold:HOLD,release:RELEASE,settle:SETTLE,modulatorPulses:2});

    // ---- the oracle, read only now, and only to find the disagreements ----
    const oracle=JSON.parse(fs.readFileSync(oraclePath));
    const label=oracle.positiveLabel;
    const named=Object.entries(oracle.fields).find(([,field])=>
     spanOf(field).some(a=>spanOf(candidate).includes(a)));
    const labelledBeneficial=label.anyFieldDemonstrablyBeneficial&&
     spanOf(oracle.fields[label.field]).some(a=>spanOf(candidate).includes(a));
    fields.push({family:family.name,seed,oracleName:named?named[0]:null,
     address:candidate.address,width:candidate.width,mask:candidate.mask,
     isDiscoveredResource:!!candidate.isResource,
     consumerStatus:consumer.status,hasConsumer:consumer.hasConsumer,
     consumerValues:consumer.values||null,consumerReason:consumer.reason,
     labelledBeneficial,
     labelContradictedByConsumerTest:labelledBeneficial&&consumer.hasConsumer===false});
    if(causality)modulation.push({family:family.name,seed,oracleName:named?named[0]:null,
     address:candidate.address,modulatorAddress:resource.address,
     baseStep:causality.baseStep,stepAfterAction:causality.stepAfterAction,
     stepAfterPokingField:causality.stepAfterPokingField,
     verdict:causality.verdict,actionMediated:causality.actionMediated,fieldMediated:causality.fieldMediated});
    save();
   }
  }
 }

 const named=name=>fields.filter(f=>f.oracleName===name);
 const consumersOf=name=>{const rows=named(name).filter(f=>f.consumerStatus==='OBSERVED');
  return {observed:rows.length,withConsumer:rows.filter(f=>f.hasConsumer).length};};
 const labelled=fields.filter(f=>f.labelledBeneficial&&f.consumerStatus==='OBSERVED');
 result.totals={
  fieldsProbed:fields.length,inconclusive:fields.filter(f=>f.consumerStatus!=='OBSERVED').length,
  withConsumer:fields.filter(f=>f.hasConsumer===true).length,
  withoutConsumer:fields.filter(f=>f.hasConsumer===false).length,
  byField:Object.fromEntries(['score','lives','level','treasure','charges','progress','gate',
   'steadyGain','fickleDecoy','fuel','unlocked','bonusCount']
   .filter(name=>named(name).length).map(name=>[name,consumersOf(name)])),
  labelledBeneficialProbed:labelled.length,
  labelledBeneficialWithConsumer:labelled.filter(f=>f.hasConsumer).length,
  labelsContradicted:fields.filter(f=>f.labelContradictedByConsumerTest).length,
  modulationVerdicts:Object.fromEntries(['FIELD-MEDIATED','ACTION-MEDIATED-ONLY','NO-MODULATION']
   .map(v=>[v,modulation.filter(m=>m.verdict===v).length])),
  note:'a label contradicted here is a label that was wrong, not a probe that failed'};
 save();

 const t=result.totals;
 assert(t.fieldsProbed>0);
 assert.equal(t.inconclusive,0,'every probe must reach a verdict or the instrument is not usable');
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:t,fields,modulation}));
 console.log('PASS: '+t.fieldsProbed+' fields probed, '+t.withConsumer+' have a downstream consumer and '+
  t.withoutConsumer+' have none. Of '+t.labelledBeneficialProbed+' fields my own closed labels call beneficial, '+
  t.labelledBeneficialWithConsumer+' are actually read by the cartridge, so '+t.labelsContradicted+' label(s) are contradicted by this test.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
