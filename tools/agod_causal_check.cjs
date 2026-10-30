'use strict';
// E3 causal validation on controlled cartridges only.
// The oracle is consulted AFTER the detector has produced its attribution and is
// never passed into agod-causal.js: the module receives only a driver and masks.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-causal-')),seeds=[0,1,2,7,8,9,47];
const FRAMES=12,NEUTRAL=0,STARTS=4,SHIFT=3;
const rows=[],result={type:'gu-agod-causal-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 oracle:'checker-only; never passed into the causal module',
 engine:'actual JSNES 2.1.0',
 method:'per start: restore snapshot, replay neutral twice (sham/determinism control), replay the probed mask, replay an alternative mask; an address is attributed only when the action arm differs from the neutral arm replayed from the same snapshot',
 meaning:'attribution is action->RAM causal evidence under replay. It is NOT polarity, reward, goal or game meaning, and it is measured on a synthetic generator family, not on real games',
 status:'RUNNING',rows};
const save=()=>{if(process.env.AGOD_CAUSAL_REPORT)fs.writeFileSync(process.env.AGOD_CAUSAL_REPORT,JSON.stringify(result,null,2)+'\n');};save();

const ramOf=core=>core.cpu.mem.slice(0,0x800);
const hashOf=bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const spanOf=field=>{const out=[];for(let i=0;i<field.width;i++)out.push(field.address+i);return out;};
const overlaps=(addresses,field)=>spanOf(field).some(address=>addresses.includes(address));

try{
 for(const seed of seeds){
  const cartridge=path.join(directory,'rom-'+seed+'.json'),oraclePath=path.join(directory,'oracle-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cartridge,'--oracle-out',oraclePath]);
  const descriptor=JSON.parse(fs.readFileSync(cartridge)),oracle=JSON.parse(fs.readFileSync(oraclePath));
  const bytes=Buffer.from(descriptor.base64,'base64');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),descriptor.sha256);

  const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
  core.loadROM(bytes);
  const driver={
   restore(snapshot){core.fromJSON(JSON.parse(snapshot));},
   run(mask,frames){for(let bit=0;bit<8;bit++)(mask&(1<<bit)?core.buttonDown:core.buttonUp)(1,bit);for(let i=0;i<frames;i++)core.frame();},
   readRam(){return ramOf(core);}
  };

  // Independent starts: advance the machine by different amounts of neutral play.
  // Each start's own state hash is recorded, so independence is evidenced rather
  // than asserted from a fresh identifier.
  const starts=[];
  for(let i=0;i<60;i++)core.frame();
  for(let index=0;index<STARTS;index++){
   driver.run(NEUTRAL,17+index*13);
   starts.push({id:'start-'+seed+'-'+index,stateHash:hashOf(ramOf(core)),snapshot:JSON.stringify(core.toJSON())});
  }

  // Probe every single-button mask. The module is given no hint about which of
  // them the cartridge actually wires to an event.
  const perMask={};
  for(let bit=0;bit<8;bit++){
   const mask=1<<bit,alternative=mask===1?2:1;
   const report=Causal.probeAction(driver,{starts,mask,neutralMask:NEUTRAL,alternativeMask:alternative,frames:FRAMES,shiftTolerance:SHIFT});
   // Naive difference, kept for comparison: what a plain action-vs-neutral test
   // would have attributed before the phase-shift control removed it.
   const naive=new Set();
   for(const entry of report.perStart)for(const address of (entry.rawAttributed||[]))naive.add(address);
   perMask[mask]={causalStatus:report.causalStatus,confirmed:report.confirmed.map(entry=>entry.address),
    contradicted:report.contradicted.map(entry=>entry.address),usableStarts:report.usableStarts,
    excludedStarts:report.excludedStarts,independentStarts:report.independentStarts,
    naiveAttributedAddresses:[...naive].sort((a,b)=>a-b),
    rawAttributedTotal:report.rawAttributedTotal,shiftExplainedTotal:report.shiftExplainedTotal,
    polarity:report.polarity,rewardStatus:report.rewardStatus};
   assert.equal(report.polarity,'unknown','causal evidence must not invent polarity');
   assert.equal(report.rewardStatus,'UNKNOWN','causal evidence must not invent reward');
   assert.equal(report.excludedStarts,0,'every start must replay deterministically on a controlled cartridge');
  }

  // --- oracle comparison starts here; nothing above has seen it ---
  const positive=perMask[oracle.positiveMask],negative=perMask[oracle.negativeMask],menu=perMask[oracle.menuMask];
  const scoreHit=overlaps(positive.confirmed,oracle.fields.score);
  const livesHit=overlaps(negative.confirmed,oracle.fields.lives);
  const menuHit=overlaps(menu.confirmed,oracle.fields.menu);

  // Time-driven decoys must never be attributed to ANY action: they advance
  // identically in the neutral arm, so a correct engine cancels them out.
  const decoys=['frameCounter','timer','noise','highScoreDecoy'];
  const decoyLeaks=[],naiveDecoyLeaks=[];
  for(const [mask,entry] of Object.entries(perMask))
   for(const name of decoys){
    if(overlaps(entry.confirmed,oracle.fields[name]))decoyLeaks.push({mask:Number(mask),field:name});
    if(overlaps(entry.naiveAttributedAddresses,oracle.fields[name]))naiveDecoyLeaks.push({mask:Number(mask),field:name});
   }

  // The cartridge echoes each button's own state into echoAddresses, so every
  // mask legitimately changes one echo byte. Specificity is therefore measured
  // on effects BEYOND that echo: a button wired to no event must have none.
  const echo=new Set(oracle.echoAddresses.flatMap(base=>[base,base+16]));
  const beyondEcho=entry=>entry.confirmed.filter(address=>!echo.has(address));
  const levelMask=1<<(oracle.negativeMask===2?6:1);
  const wiredMasks=new Set([oracle.positiveMask,oracle.negativeMask,oracle.menuMask,oracle.resetMask,levelMask]);
  const effectfulMasks=Object.entries(perMask).filter(([,entry])=>entry.causalStatus==='CAUSAL-EVIDENCE').map(([mask])=>Number(mask));
  const effectsBeyondEcho=Object.fromEntries(Object.entries(perMask).map(([mask,entry])=>[mask,beyondEcho(entry)]));
  const unwiredWithRealEffect=Object.entries(effectsBeyondEcho)
   .filter(([mask,addresses])=>!wiredMasks.has(Number(mask))&&addresses.length>0)
   .map(([mask,addresses])=>({mask:Number(mask),addresses}));
  const ownEchoRecovered=Object.entries(perMask).every(([mask,entry])=>{
   const bit=Math.log2(Number(mask));
   return entry.confirmed.includes(oracle.echoAddresses[bit]);
  });

  rows.push({seed,romHash:descriptor.sha256,
   oracleMasks:{positive:oracle.positiveMask,negative:oracle.negativeMask,menu:oracle.menuMask,reset:oracle.resetMask},
   recovered:{scoreFromPositiveAction:scoreHit,livesFromNegativeAction:livesHit,menuFromMenuAction:menuHit},
   decoyLeaks,naiveDecoyLeaks,shiftTolerance:SHIFT,effectfulMasks,effectsBeyondEcho,unwiredWithRealEffect,ownEchoRecovered,levelMask,
   // An unexpected effectful mask is not automatically an error: the level
   // button is also wired, and reset/menu touch several bytes. It is reported
   // so the number is visible rather than hidden behind a pass.
   perMask,
   frames:FRAMES,startsPerProbe:STARTS,
   note:'single-button masks only; held for the whole window; one cartridge family'});
  save();

  assert(scoreHit,'seed '+seed+': the positive action must be shown to change the score bytes');
  assert(livesHit,'seed '+seed+': the negative action must be shown to change the lives byte');
  assert(menuHit,'seed '+seed+': the menu action must be shown to change the menu byte');
  assert.equal(decoyLeaks.length,0,'seed '+seed+': no time-driven decoy may be attributed to an action: '+JSON.stringify(decoyLeaks));
  assert(ownEchoRecovered,'seed '+seed+': every button must be shown to change its own input-echo byte');
  assert.equal(unwiredWithRealEffect.length,0,'seed '+seed+': a button wired to no event must show no effect beyond its own echo: '+JSON.stringify(unwiredWithRealEffect));
 }

 const totals={seeds:rows.length,
  scoreRecovered:rows.filter(row=>row.recovered.scoreFromPositiveAction).length,
  livesRecovered:rows.filter(row=>row.recovered.livesFromNegativeAction).length,
  menuRecovered:rows.filter(row=>row.recovered.menuFromMenuAction).length,
  decoyLeaks:rows.reduce((sum,row)=>sum+row.decoyLeaks.length,0),
  naiveDecoyLeaksAvoided:rows.reduce((sum,row)=>sum+row.naiveDecoyLeaks.length,0),
  allOwnEchoesRecovered:rows.every(row=>row.ownEchoRecovered),
  unwiredButtonsWithRealEffect:rows.reduce((sum,row)=>sum+row.unwiredWithRealEffect.length,0)};
 result.totals=totals;result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals,
  rows:rows.map(({perMask,...row})=>row)}));
 console.log('PASS: actual action-vs-neutral replay attribution on seven controlled cartridges; deterministic sham control, independent starts, zero time-driven decoy attribution, UNKNOWN polarity/reward preserved; real games, frozen generalization and Android remain untested');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
