'use strict';
// E2: does the typed-field identifier commit to the right type?
// Causal attribution (E3) narrows RAM to the bytes an action actually drives;
// this check then asks the identifier to name one type per span and scores it
// against the oracle afterwards. The baseline it is measured against is not a
// memory: it is read out of the committed E0 log in the same run.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Ram=require('../app/src/main/assets/lab/agod-ram.js'),
      jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-ram-')),seeds=[0,1,2,7,8,9,47];
const FRAMES=12,SHIFT=3,STARTS=3,EVENTS=150,HOLD=4,RELEASE=8;
const BASELINE_LOG='docs/reports/gu-agod-neural-revision-2026-10-29/logs/agod_rom_check.log';
const rows=[];
const result={type:'gu-agod-ram-type-check',version:1,
 scope:'host emulator / original controlled NES cartridges',
 oracle:'checker-only: read after every type is committed, never passed into attribution or identification',
 claim:'A causally attributed span can be typed: address, observed-active width, byte order and encoding are committed to, and signedness is reported UNKNOWN because nothing in RAM settles it.',
 status:'RUNNING',rows};
const save=()=>{if(process.env.AGOD_RAM_REPORT)fs.writeFileSync(process.env.AGOD_RAM_REPORT,JSON.stringify(result,null,2)+'\n');};save();

// The number this work has to beat, taken from the committed baseline run.
const baselineLine=fs.readFileSync(BASELINE_LOG,'utf8').split('\n').find(line=>line.startsWith('{'));
const baselineRows=JSON.parse(baselineLine).rows;
const baseline={seeds:baselineRows.length,
 counterExactTypedCandidatePresent:baselineRows.filter(r=>r.counterCoverage.exactTypedCandidatePresent).length,
 livesExactTypedCandidatePresent:baselineRows.filter(r=>r.livesCoverage.exactTypedCandidatePresent).length,
 fullTypeIdentified:baselineRows.filter(r=>r.counterCoverage.fullTypeIdentified||r.livesCoverage.fullTypeIdentified).length,
 note:'from logs/agod_rom_check.log: the baseline miner reports a candidate list; fullTypeIdentified is a constant false in that harness'};
result.baseline=baseline;save();

const spanOf=f=>{const out=[];for(let i=0;i<f.width;i++)out.push(f.address+i);return out;};
const encodingOf=field=>field.format==='bcd'?'bcd':'binary';
// An undetermined encoding is correct as long as the truth is inside the
// equivalence class the identifier reported and nothing false was claimed.
const encodingOk=(found,field)=>found.encoding===encodingOf(field)||
 (found.encoding==='undetermined'&&found.encodingCandidates.includes(encodingOf(field)));
// Where the low-order bytes of a field sit depends on its byte order: a wide
// counter whose high bytes never carry can only ever be seen as its low-order
// component, and that component is the honest answer, not a failure.
const lowOrderStart=(field,width)=>field.endian==='big'?field.address+field.width-width:field.address;
const matches=(found,field)=>!!found&&found.width<=field.width&&found.address===lowOrderStart(field,found.width)&&
 encodingOk(found,field)&&(found.width===1||found.endian===field.endian);
const insideField=(found,field)=>found.width!==undefined&&found.address>=field.address&&
 found.address+found.width<=field.address+field.width;

try{
 for(const seed of seeds){
  const cart=path.join(directory,'rom-'+seed+'.json'),orc=path.join(directory,'oracle-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',['tools/make_agod_test_rom.py','--seed',String(seed),'--out',cart,'--oracle-out',orc]);
  const descriptor=JSON.parse(fs.readFileSync(cart)),oracle=JSON.parse(fs.readFileSync(orc));
  const core=new jsnes.NES({onFrame(){},onAudioSample(){}});core.loadROM(Buffer.from(descriptor.base64,'base64'));
  const ram=()=>core.cpu.mem.slice(0,0x800);
  const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  const driver={restore(s){core.fromJSON(JSON.parse(s));},
   run(mask,frames){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);for(let i=0;i<frames;i++)core.frame();},
   readRam(){return ram();}};

  for(let i=0;i<60;i++)core.frame();
  const pristine=JSON.stringify(core.toJSON());

  // 1. Causal attribution, all eight single-button masks, no oracle involved.
  const starts=[];
  for(let i=0;i<STARTS;i++){driver.run(0,17+i*13);starts.push({id:'st-'+seed+'-'+i,stateHash:hash(ram()),snapshot:JSON.stringify(core.toJSON())});}
  const attributed=new Map();
  for(let bit=0;bit<8;bit++){
   const mask=1<<bit;
   const probe=Causal.probeAction(driver,{starts,mask,neutralMask:0,alternativeMask:mask===1?2:1,frames:FRAMES,shiftTolerance:SHIFT});
   attributed.set(mask,probe.confirmed.map(e=>e.address));
  }

  // 2. Long-horizon attribution with a length-matched neutral control.
  // The short probe can only attribute what moves inside a 12-frame window, so
  // a counter's high byte is invisible to it: the carry happens later. The
  // control that keeps this honest is a neutral run of the same length and
  // cadence - a byte that moves without any action is time-driven, whatever
  // its phase, so it can never join a span.
  const movedIn=samples=>{const out=new Set();
   for(let i=1;i<samples.length;i++)for(let a=0;a<samples[i].length;a++)if(samples[i][a]!==samples[i-1][a])out.add(a);
   return out;};
  const play=(mask)=>{driver.restore(pristine);const samples=[];
   for(let event=0;event<EVENTS;event++){driver.run(mask,HOLD);driver.run(0,RELEASE);samples.push(ram());}
   return samples;};
  const neutralMoved=movedIn(play(0));

  const identified=[],naive=[];let longOnly=0,shortOnly=0;
  const typeSpans=(samples,addresses,into)=>{
   for(const span of Ram.spansOf(addresses)){
    const outcome=Ram.identifyField({samples,addresses:span});
    if(outcome.status==='IDENTIFIED')into.push({...outcome.field});
    else into.push({status:outcome.status,span:[span[0],span[span.length-1]],reason:outcome.reason||null});
   }
  };
  for(const [mask,shortAttributed] of attributed){
   const samples=play(mask);
   const moved=[...movedIn(samples)].sort((a,b)=>a-b);
   const longAttributed=moved.filter(address=>!neutralMoved.has(address));
   longOnly+=longAttributed.filter(a=>!shortAttributed.includes(a)).length;
   shortOnly+=shortAttributed.filter(a=>!longAttributed.includes(a)).length;
   // What the same identifier would type without the neutral control: the
   // measure of what the control is worth, not an alternative to it.
   const naiveForMask=[];typeSpans(samples,moved,naiveForMask);
   naive.push(...naiveForMask.map(f=>({mask,...f})));
   if(!longAttributed.length)continue;
   const forMask=[];typeSpans(samples,longAttributed,forMask);
   identified.push(...forMask.map(f=>({mask,...f})));
  }

  // 3. Only now is the oracle opened.
  const find=(mask,field)=>identified.find(f=>f.mask===mask&&insideField(f,field));
  const score=find(oracle.positiveMask,oracle.fields.score),lives=find(oracle.negativeMask,oracle.fields.lives);
  const decoySpans=['frameCounter','timer','highScoreDecoy','noise'].flatMap(name=>spanOf(oracle.fields[name]));
  const touchesDecoy=f=>f.width!==undefined&&spanOf(f).some(a=>decoySpans.includes(a));
  const decoysTyped=identified.filter(touchesDecoy),naiveDecoysTyped=naive.filter(touchesDecoy);

  const row={seed,romHash:descriptor.sha256,
   oracleScore:{address:oracle.fields.score.address,width:oracle.fields.score.width,format:oracle.fields.score.format,endian:oracle.fields.score.endian},
   score:score?{address:score.address,width:score.width,endian:score.endian,encoding:score.encoding,
    encodingDetermined:score.encodingDetermined,signedness:score.signedness,step:score.step,direction:score.direction}:null,
   scoreTypeCorrectOnActiveSpan:matches(score,oracle.fields.score),
   scoreFullWidthIdentified:!!score&&matches(score,oracle.fields.score)&&score.width===oracle.fields.score.width,
   scoreActiveWidth:score?score.width:null,scoreDeclaredWidth:oracle.fields.score.width,
   scoreFullWidthReachable:'a byte that never carried cannot be shown to belong to the span',
   lives:lives?{address:lives.address,width:lives.width,encoding:lives.encoding,
    encodingDetermined:lives.encodingDetermined,step:lives.step,direction:lives.direction}:null,
   livesTypeCorrect:matches(lives,oracle.fields.lives)&&!!lives&&lives.width===oracle.fields.lives.width,
   attributedOnlyByLongHorizon:longOnly,attributedOnlyByShortProbe:shortOnly,
   identifiedFields:identified.filter(f=>f.width!==undefined).length,
   unresolvedSpans:identified.filter(f=>f.width===undefined).length,
   decoysTyped:decoysTyped.length,
   naiveDecoysTyped:naiveDecoysTyped.length,
   naiveDecoyFields:naiveDecoysTyped.map(f=>({mask:f.mask,address:f.address,width:f.width,encoding:f.encoding,step:f.step})).slice(0,12)};
  rows.push(row);save();

  assert(score,'seed '+seed+': a component of the action-driven counter must be typed');
  assert(row.scoreTypeCorrectOnActiveSpan,'seed '+seed+': the typed counter must be the correct low-order component of the oracle field, got '+JSON.stringify(row.score));
  assert(row.livesTypeCorrect,'seed '+seed+': lives must be typed exactly, got '+JSON.stringify(row.lives));
  assert.equal(row.decoysTyped,0,'seed '+seed+': no time-driven decoy may be typed as an action-driven field');
  assert.equal(score.signedness,'UNKNOWN','seed '+seed+': signedness must not be claimed');
  // A determined encoding is a claim, and a wrong claim is worse than none.
  for(const [name,found,field] of [['score',score,oracle.fields.score],['lives',lives,oracle.fields.lives]])
   if(found.encodingDetermined)
    assert.equal(found.encoding,encodingOf(field),'seed '+seed+': '+name+' encoding was claimed and is wrong');
 }

 const count=predicate=>rows.filter(predicate).length;
 result.totals={seeds:rows.length,
  scoreTypeCorrectOnActiveSpan:count(r=>r.scoreTypeCorrectOnActiveSpan),
  scoreFullWidthIdentified:count(r=>r.scoreFullWidthIdentified),
  livesTypeCorrect:count(r=>r.livesTypeCorrect),
  scoreEncodingDetermined:count(r=>r.score&&r.score.encodingDetermined),
  livesEncodingDetermined:count(r=>r.lives&&r.lives.encodingDetermined),
  encodingClaimedAndWrong:0,
  decoysTyped:rows.reduce((sum,r)=>sum+r.decoysTyped,0),
  naiveDecoysTypedWithoutNeutralControl:rows.reduce((sum,r)=>sum+r.naiveDecoysTyped,0),
  signednessClaimed:0,
  baselineCounterExactTypedCandidatePresent:baseline.counterExactTypedCandidatePresent,
  baselineFullTypeIdentified:baseline.fullTypeIdentified};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,baseline,totals:result.totals,rows}));
 console.log('PASS: counter typed correctly on its observed-active span '+result.totals.scoreTypeCorrectOnActiveSpan+'/'+rows.length+
  ' (full declared width '+result.totals.scoreFullWidthIdentified+'/'+rows.length+'), lives typed exactly '+result.totals.livesTypeCorrect+'/'+rows.length+
  ', 0 decoys typed, signedness never claimed; baseline had the exact typed counter merely present in its candidate list on '+baseline.counterExactTypedCandidatePresent+'/'+baseline.seeds+' and committed to no type at all');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
finally{fs.rmSync(directory,{recursive:true,force:true});}
