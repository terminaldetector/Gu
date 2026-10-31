'use strict';
// T2: is the experimental adapter the same instrument as Causal.probeAction?
//
// RECOVERED_BY_CADENCE compares a pulse train against a continuous control
// which, at 144/360/720 frames, runs in the adapter rather than in the standard
// detector. If the adapter behaves differently, that comparison is between two
// instruments and not between two action structures. So this check GATES the
// synthetic trials: they do not start until it passes, and on divergence both
// results are kept, the cause is localised, and RECOVERED_BY_CADENCE is not
// assigned at all until then.
//
// Horizons 12 and 48, where the standard detector is applicable. Identical
// start states, identical masks, identical shift tolerance.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),
      path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Adapter=require('./agod_s11b_adapter.cjs'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const HORIZONS=[12,48],SHIFT=3,STARTS=3,MAX_ADDRESSES=256;
const rows=[];
const provenance=(()=>{let head='unknown';
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch(_){}
 return {commit:head,node:process.version,
  causalRevision:Causal.DETECTOR_REVISION,adapterRevision:Adapter.ADAPTER_REVISION};})();
const report={type:'gu-agod-s11b-t2-equivalence',version:1,
 question:'does the experimental adapter produce the same result as Causal.probeAction on identical starts, masks and horizons?',
 gate:'the synthetic trials do not start until this passes; on divergence both results are kept, the cause is localised, and RECOVERED_BY_CADENCE is withheld',
 horizons:HORIZONS,shiftTolerance:SHIFT,startsPerTrial:STARTS,
 compared:['action arm RAM hash','neutral control RAM hash','alternative mask RAM hash',
  'phase tolerance and trajectory arm count','attributed address sets',
  'cross-start contradictions','causal confirmation for the target address'],
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_T2_REPORT)
 fs.writeFileSync(process.env.AGOD_T2_REPORT,JSON.stringify(report,null,2)+'\n');};write();

function machine(bytes,bootFrames){
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(bytes);
 for(let i=0;i<bootFrames;i++)core.frame();
 const ram=()=>core.cpu.mem.slice(0,0x800);
 return {restore(s){core.fromJSON(JSON.parse(s));},
  run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
   for(let i=0;i<frames;i++)core.frame();},
  readRam:ram,snapshot(){return JSON.stringify(core.toJSON());},
  stateHash(){return crypto.createHash('sha256').update(Buffer.from(ram())).digest('hex');}};
}
const sameSet=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

try{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-t2-'));
 const seeds=(process.env.AGOD_T2_SEEDS||'0,200').split(',').map(Number);
 for(const seed of seeds){
  const out=path.join(directory,'rom-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',
   ['tools/make_agod_test_rom.py','--seed',String(seed),'--out',out]);
  const bytes=Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64');
  for(const horizon of HORIZONS){
   for(const mask of [2,64]){
    /* ONE machine, ONE set of start snapshots, used by both instruments. */
    const driver=machine(bytes,60);
    const pristine=driver.snapshot();
    const starts=[];
    driver.restore(pristine);
    for(let i=0;i<STARTS;i++){
     driver.run(0,17+i*7);
     starts.push({id:'s'+i,stateHash:driver.stateHash(),
      snapshot:driver.snapshot(),independent:true});
    }
    const alternative=mask===1?2:1;
    const limits={maxFramesPerArm:600,maxAddressesReported:MAX_ADDRESSES,
     maxStarts:8,maxArmsPerStart:32,maxRamBytes:2048,maxTotalFrames:400000,maxShiftTolerance:12};
    const standard=Causal.probeAction(driver,{starts,mask,neutralMask:0,
     alternativeMask:alternative,frames:horizon,shiftTolerance:SHIFT,limits});
    const adapted=Adapter.probe(driver,{kind:'hold',starts,mask,neutralMask:0,
     alternativeMask:alternative,frames:horizon,shiftTolerance:SHIFT,
     maxAddressesReported:MAX_ADDRESSES,sampleEvery:0});

    const perStart=[];
    for(let i=0;i<starts.length;i++){
     const s=standard.perStart[i],a=adapted.perStart[i];
     const standardHashes={action:Adapter.hash(s.after||[]),neutral:null};
     perStart.push({startId:starts[i].id,
      standardStatus:s.status,adapterStatus:a.status,
      statusMatch:s.status===a.status,
      attributedMatch:sameSet(s.attributed||[],a.attributed||[]),
      standardAttributed:(s.attributed||[]).length,adapterAttributed:(a.attributed||[]).length,
      rawMatch:sameSet(s.rawAttributed||[],a.rawAttributed||[]),
      shiftExplainedMatch:sameSet(s.shiftExplainedAddresses||[],a.shiftExplainedAddresses||[]),
      specificMatch:sameSet(s.specificToMask||[],a.specificToMask||[]),
      sharedMatch:sameSet(s.sharedWithAlternative||[],a.sharedWithAlternative||[]),
      neutralWindowsMatch:s.neutralWindows===a.neutralWindows,
      standardNeutralWindows:s.neutralWindows,adapterNeutralWindows:a.neutralWindows});
    }
    const confirmedMatch=sameSet(standard.confirmed.map(e=>e.address),
     adapted.confirmed.map(e=>e.address));
    const contradictedMatch=sameSet(standard.contradicted.map(e=>e.address),
     adapted.contradicted.map(e=>e.address));
    const allMatch=perStart.every(e=>e.statusMatch&&e.attributedMatch&&e.rawMatch
     &&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch&&e.neutralWindowsMatch)
     &&confirmedMatch&&contradictedMatch;
    rows.push({seed,horizon,mask,alternative,
     equivalent:allMatch,
     confirmedMatch,contradictedMatch,
     standardConfirmed:standard.confirmed.map(e=>e.address).slice(0,16),
     adapterConfirmed:adapted.confirmed.map(e=>e.address).slice(0,16),
     standardUsableStarts:standard.usableStarts,adapterUsableStarts:adapted.usableStarts,
     perStart,
     divergenceDetail:allMatch?null:perStart.filter(e=>!(e.statusMatch&&e.attributedMatch
      &&e.rawMatch&&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch&&e.neutralWindowsMatch))});
    write();
   }
  }
 }
 const equivalent=rows.filter(r=>r.equivalent).length;
 report.totals={trials:rows.length,equivalent,divergent:rows.length-equivalent,
  gatePassed:equivalent===rows.length,
  verdict:equivalent===rows.length
   ?'the adapter and the standard detector agree on every compared quantity: the synthetic trials may start and RECOVERED_BY_CADENCE may be used'
   :'DIVERGENCE: both results are kept, the cause must be localised, and RECOVERED_BY_CADENCE is withheld until then (ADAPTER_DIVERGENCE_UNRESOLVED)'};
 report.status=equivalent===rows.length?'PASS':'DIVERGENT';write();
 console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals},null,1));
 if(equivalent!==rows.length)process.exitCode=1;
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
