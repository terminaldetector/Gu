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

const {execFileSync:run}=require('node:child_process');

/* COMPATIBILITY, checked before anything runs. A module can export a function
   the checker never calls, which is exactly how the published S4c ended up with
   classifyConsumer in agod-consumers.js and a one-scenario checker that ignored
   it. Presence in source is not execution, so the revisions are asserted here
   and recorded in the report. */
const EXPECTED_PROBE_REVISION='agod-consumers-s4c-3';
if(typeof Consumers.classifyConsumer!=='function')
 throw new Error('module/checker mismatch: agod-consumers exposes no classifyConsumer, this checker requires it');
if(Consumers.PROBE_REVISION!==EXPECTED_PROBE_REVISION)
 throw new Error('module/checker mismatch: expected '+EXPECTED_PROBE_REVISION+', module is '+Consumers.PROBE_REVISION);

const provenance=(()=>{
 const sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0,16);
 let head='unknown',dirty=null;
 try{head=run('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=run('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,
  checkerSha256:sha('tools/agod_consumers_check.cjs'),
  moduleSha256:sha('app/src/main/assets/lab/agod-consumers.js'),
  probeRevision:Consumers.PROBE_REVISION,
  pipelineRevision:Pipeline.PIPELINE_REVISION,
  scenariosConfigured:4};
})();

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
 provenance,
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
  poke(address,value){core.cpu.mem[address]=value&255;},
  /* CPU read and write tracing with the program counter, so a read can be
     attributed to code that writes the field or to code that does not. jsnes
     routes every CPU access through cpu.load and cpu.write; both are restored. */
  trace(addresses,body){
   const watch=new Set(addresses),reads=[],writes=[];
   const cpu=core.cpu,load=cpu.load,write=cpu.write;
   cpu.load=function(address){if(watch.has(address))reads.push(cpu.REG_PC);return load.call(this,address);};
   cpu.write=function(address,value){if(watch.has(address))writes.push(cpu.REG_PC);return write.call(this,address,value);};
   try{body();}finally{cpu.load=load;cpu.write=write;}
   const writePcs=new Set(writes);
   return {reads:reads.length,writes:writes.length,
    distinctReadPcs:new Set(reads).size,distinctWritePcs:writePcs.size,
    readsFromNonWritingPc:reads.filter(pc=>!writePcs.has(pc)).length};
  }};
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

   /* Several scenarios, because one fixed schedule can destroy its own contrast.
      The all-masks schedule presses the cost button in BOTH arms, so a resource
      is driven to its floor either way and the arms converge: that is why the
      first run called the survival lives field unconsumed, when it gates every
      edge handler in that cartridge. */
   const allMasks=[1,2,4,8,16,32,64,128];
   for(const candidate of candidates){
    const scenarios=[
     {id:'all-masks',masks:allMasks,steps:24},
     {id:'without-field-and-cost-actions',masks:allMasks.filter(m=>m!==candidate.mask&&m!==resource.mask),steps:24},
     {id:'neutral-only',masks:[0],steps:24},
     {id:'short-mixed',masks:allMasks,steps:6}];
    const perScenario=[];
    for(const scenario of scenarios){
     if(!scenario.masks.length)continue;
     driver.restore(boot);
     const outcome=Consumers.downstreamConsumer(driver,{field:candidate,fieldMask:candidate.mask,
      pristine:boot,hold:HOLD,release:RELEASE,steps:scenario.steps,driveTimes:16,masks:scenario.masks});
     perScenario.push({scenario:scenario.id,status:outcome.status,hasConsumer:outcome.hasConsumer,
      values:outcome.values||null});
    }
    const usable=perScenario.filter(r=>r.status==='OBSERVED');
    const diverged=usable.filter(r=>r.hasConsumer===true).length;
    driver.restore(boot);
    const span=[];for(let i=0;i<candidate.width;i++)span.push(candidate.address+i);
    const traced=driver.trace(span,()=>{
     for(let step=0;step<36;step++){const mask=allMasks[step%allMasks.length];
      driver.run(mask,HOLD);driver.run(0,RELEASE);}
    });
    const verdict=Consumers.classifyConsumer({scenariosRun:usable.length,scenariosDiverged:diverged,
     cpuReads:traced.reads,distinctReadPcs:traced.distinctReadPcs,
     distinctWritePcs:traced.distinctWritePcs,readsFromNonWritingPc:traced.readsFromNonWritingPc});
    const consumer={status:usable.length?'OBSERVED':'INCONCLUSIVE',hasConsumer:diverged>0,
     values:(usable[0]&&usable[0].values)||null,reason:verdict.claim,
     perScenario,traced,verdict:verdict.verdict};
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
     consumerStatus:consumer.status,verdict:consumer.verdict,hasConsumer:consumer.hasConsumer,
     scenariosRun:consumer.perScenario.filter(r=>r.status==='OBSERVED').length,
     scenariosDiverged:consumer.perScenario.filter(r=>r.hasConsumer===true).length,
     perScenario:consumer.perScenario,
     cpuReads:consumer.traced.reads,distinctReadPcs:consumer.traced.distinctReadPcs,
     distinctWritePcs:consumer.traced.distinctWritePcs,
     readsFromNonWritingPc:consumer.traced.readsFromNonWritingPc,
     consumerValues:consumer.values||null,consumerReason:consumer.reason,
     labelledBeneficial,
     labelUnsupportedByConsumerEvidence:labelledBeneficial&&consumer.verdict==='NO-OBSERVED-CONSUMER'});
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
  return {observed:rows.length,
   CONSUMED:rows.filter(f=>f.verdict==='CONSUMED').length,
   READ_WITHOUT_EFFECT:rows.filter(f=>f.verdict==='READ-WITHOUT-EFFECT').length,
   NO_OBSERVED_CONSUMER:rows.filter(f=>f.verdict==='NO-OBSERVED-CONSUMER').length,
   meanCpuReads:rows.length?Math.round(rows.reduce((a,f)=>a+f.cpuReads,0)/rows.length):0,
   meanReadsFromNonWritingPc:rows.length?Math.round(rows.reduce((a,f)=>a+f.readsFromNonWritingPc,0)/rows.length):0};};
 const labelled=fields.filter(f=>f.labelledBeneficial&&f.consumerStatus==='OBSERVED');
 result.totals={
  fieldsProbed:fields.length,inconclusive:fields.filter(f=>f.consumerStatus!=='OBSERVED').length,
  verdicts:Object.fromEntries(['CONSUMED','READ-WITHOUT-EFFECT','NO-OBSERVED-CONSUMER']
   .map(v=>[v,fields.filter(f=>f.verdict===v).length])),
  fieldsReadByNonWritingCode:fields.filter(f=>f.readsFromNonWritingPc>0).length,
  fieldsNeverReadByCpu:fields.filter(f=>f.cpuReads===0).length,
  byField:Object.fromEntries(['score','lives','level','treasure','charges','progress','gate',
   'steadyGain','fickleDecoy','fuel','unlocked','bonusCount']
   .filter(name=>named(name).length).map(name=>[name,consumersOf(name)])),
  labelledBeneficialProbed:labelled.length,
  labelledBeneficialWithConsumer:labelled.filter(f=>f.hasConsumer).length,
  labelsUnsupported:fields.filter(f=>f.labelUnsupportedByConsumerEvidence).length,
  modulationVerdicts:Object.fromEntries(['FIELD-MEDIATED','ACTION-MEDIATED-ONLY','NO-MODULATION']
   .map(v=>[v,modulation.filter(m=>m.verdict===v).length])),
  executionEvidence:{
   scenarioRunsTotal:fields.reduce((a,f)=>a+f.scenariosRun,0),
   fieldsWithFourScenarios:fields.filter(f=>f.perScenario&&f.perScenario.length===4).length,
   cpuReadsTotal:fields.reduce((a,f)=>a+f.cpuReads,0),
   fieldsWithAnyCpuRead:fields.filter(f=>f.cpuReads>0).length,
   fieldsWithVerdict:fields.filter(f=>!!f.verdict).length},
  focusFields:Object.fromEntries(['lives','treasure','fickleDecoy'].map(name=>[name,
   fields.filter(f=>f.oracleName===name).map(f=>({family:f.family,seed:f.seed,verdict:f.verdict,
    scenariosDiverged:f.scenariosDiverged,scenariosRun:f.scenariosRun,
    perScenario:f.perScenario.map(x=>x.scenario+'='+x.hasConsumer),
    cpuReads:f.cpuReads,readsFromNonWritingPc:f.readsFromNonWritingPc,
    distinctReadPcs:f.distinctReadPcs,distinctWritePcs:f.distinctWritePcs,
    labelledBeneficial:f.labelledBeneficial}))])),
  note:'a null result is about the trajectories tested. The survival lives field is a known false negative of the single-scenario counterfactual: it gates every edge handler in that cartridge, yet an all-masks schedule drives it to its floor in both arms and the contrast disappears. That is why several scenarios and CPU read tracing are used, and why no verdict here claims that nothing reads a field.'};
 save();

 const t=result.totals;
 assert(t.fieldsProbed>0);
 assert.equal(t.inconclusive,0,'every probe must reach a verdict or the instrument is not usable');
 assert(t.verdicts['CONSUMED']>0,'the instrument must find at least one consumed field or it is measuring nothing');
 /* PASS requires that the tools actually RAN, not that they exist in the
    sources. Each of these would have been satisfied trivially by the old
    one-scenario checker, and none of them is. */
 const e=t.executionEvidence;
 assert.equal(e.fieldsWithVerdict,t.fieldsProbed,'every field must carry a three-way verdict');
 assert(e.fieldsWithFourScenarios>0,'the four-scenario path must have executed');
 assert(e.scenarioRunsTotal>=t.fieldsProbed*3,'each field must have been probed in at least three usable scenarios');
 assert(e.cpuReadsTotal>0&&e.fieldsWithAnyCpuRead>0,'CPU read tracing must have observed reads, or it did not run');
 assert(['lives','treasure','fickleDecoy'].every(n=>t.focusFields[n]&&t.focusFields[n].length),
  'the three fields under specific scrutiny must each appear in the report');
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:t,fields,modulation}));
 console.log('provenance: commit '+provenance.commit.slice(0,8)+(provenance.workingTreeDirty?' (dirty)':'')+
  ', probe '+provenance.probeRevision+', checker '+provenance.checkerSha256+
  ', scenarios '+provenance.scenariosConfigured+', cpu reads '+t.executionEvidence.cpuReadsTotal);
 console.log('PASS: '+t.fieldsProbed+' fields probed across '+FAMILIES.length+' families. Verdicts '+
  JSON.stringify(t.verdicts)+'. '+t.fieldsReadByNonWritingCode+' fields are read by code that never writes them, '+
  t.fieldsNeverReadByCpu+' are never read by the CPU at all. Of '+t.labelledBeneficialProbed+
  ' fields my own labels call beneficial, '+t.labelsUnsupported+
  ' have no consumer evidence - recorded as unsupported labels, not as proof that nothing reads them.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
