'use strict';
// STAGE B / B0: does the external instrument actually do what its flags say?
//
// The rule this file is written under: "Не считать функциональность работающей
// только по наличию аргумента CLI." A flag in --help is not a capability. Every
// capability below is exercised by a real call whose result is checked against
// something known independently of the instrument - mostly the closed oracle of
// a GU synthetic fixture, whose mechanism, addresses and WRITER PROGRAM
// COUNTERS are recorded by the generator that built the ROM.
//
// That last point is what makes this an audit rather than a demonstration. The
// generator records, for every field, the PC of each instruction that writes it.
// So "the trace works" is not "a file appeared": it is "the trace contains the
// exact PC the generator says writes this field, and does not contain it when
// the driving button is never pressed".
//
// WHAT IS AUDITED (the B0 list, in order):
//   1. launching a synthetic NES ROM
//   2. executing exactly N frames
//   3. button schedules through --input
//   4. saving and restoring state
//   5. reading RAM
//   6. saving a CPU trace
//   7. read / write / execute breakpoints
//   8. obtaining a video frame
//
// Nothing here is evidence about any game, and no GPL code enters GU: the
// instrument is an external process addressed by argv and JSON Lines.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');

const AGENT=process.env.MESEN_AGENT;
if(!AGENT||!fs.existsSync(AGENT)){
 console.error('set MESEN_AGENT to the built mesen-agent binary');process.exit(2);}
const GU=path.resolve(__dirname,'..','..');
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');

const work=fs.mkdtempSync(path.join(os.tmpdir(),'gu-b0-'));
const home=path.join(work,'mesen-home');fs.mkdirSync(home);
const checks=[],failures=[];
const fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);

/* ---- the instrument, addressed only by argv and JSON Lines ---- */
let invocations=0,instrumentMs=0;
function run(args,opts){
 const started=Date.now();
 invocations++;
 let stdout='',status=0,stderr='';
 try{
  stdout=execFileSync(AGENT,[...args,'--home',home],
   {encoding:'utf8',timeout:(opts&&opts.timeoutMs)||120000,maxBuffer:64*1024*1024,
    stdio:['ignore','pipe','pipe']});
 }catch(problem){
  status=problem.status===undefined?-1:problem.status;
  stdout=problem.stdout?problem.stdout.toString():'';
  stderr=problem.stderr?problem.stderr.toString():'';
 }
 instrumentMs+=Date.now()-started;
 const records=stdout.split('\n').filter(Boolean).map(line=>{
  try{return JSON.parse(line);}catch(_){return {event:'UNPARSEABLE',line};}});
 return {records,status,stderr,
  first(event){return records.find(r=>r.event===event)||null;},
  all(event){return records.filter(r=>r.event===event);},
  summary(){return records.find(r=>r.event==='summary')||null;}};
}

/* ---- a synthetic ROM whose mechanism and writer PCs are known ---- */
function buildFixture(seed){
 const romJson=path.join(work,'fixture-'+seed+'.json');
 const oracleJson=path.join(work,'oracle-'+seed+'.json');
 execFileSync(process.env.PYTHON||'python3',
  [path.join(GU,'tools','make_agod_dual_dependence_rom.py'),
   '--seed',String(seed),'--out',romJson,'--oracle-out',oracleJson],{cwd:GU});
 const bytes=Buffer.from(JSON.parse(fs.readFileSync(romJson)).base64,'base64');
 const nes=path.join(work,'fixture-'+seed+'.nes');
 fs.writeFileSync(nes,bytes);
 return {nes,bytes,sha256:sha256(bytes),
  oracle:JSON.parse(fs.readFileSync(oracleJson))};
}
const fixture=buildFixture(1);
const F=fixture.oracle.fields;
const BUTTON_NAMES=['a','b','select','start','up','down','left','right'];
const buttonOf=mask=>{
 for(let b=0;b<8;b++)if(mask===(1<<b))return BUTTON_NAMES[b];
 throw new Error('mask '+mask+' is not a single button');
};
const dualButton=buttonOf(fixture.oracle.dualMask);
const soloButton=buttonOf(fixture.oracle.soloMask);

/* ---- 1. launching the ROM ---- */
{
 const r=run([fixture.nes,'--frames','0']);
 const loaded=r.first('loaded');
 checks.push({capability:'1. launch a synthetic NES ROM',
  method:'--frames 0 and read the loaded record',
  romSha256:fixture.sha256,
  observed:loaded,exitStatus:r.status,
  pass:expect(!!loaded&&loaded.console==='Nes'&&r.status===0,
   'the ROM did not load: status '+r.status+', record '+JSON.stringify(loaded)
   +(r.stderr?', stderr '+r.stderr.slice(0,200):''))});
}

/* ---- 2. executing exactly N frames ----
   Three independent facts, because "frames_executed: N" is the instrument
   quoting its own argument back. The fixture carries a free-running 16-bit
   counter, so the RAM itself can be asked. */
{
 const readCounter=extra=>{
  const r=run([fixture.nes,...extra,
   '--read-memory','NesInternalRam:'+F.frameCounter.address+':2']);
  const rec=r.all('memory_read').pop();
  if(!rec||!rec.hex)return {value:null,r};
  const low=parseInt(rec.hex.slice(0,2),16),high=parseInt(rec.hex.slice(2,4),16);
  return {value:low+256*high,r,hex:rec.hex};
 };
 const rows=[];
 for(const n of [1,10,60,600]){
  const a=readCounter(['--frames',String(n)]);
  const b=readCounter(['--frames',String(n)]);
  rows.push({frames:n,
   reportedFramesExecuted:a.r.summary()?a.r.summary().frames_executed:null,
   loopIterationsCounter:a.value,
   repeatIdentical:a.value!==null&&a.value===b.value});
 }
 const reportedExact=rows.every(e=>e.reportedFramesExecuted===e.frames);
 /* SCOPED after row 9 below was measured. This "deterministic" is about the
    fixture's own INITIALISED counter, which the reset handler sets. It is NOT a
    claim that whole-RAM content repeats across fresh boots: it does not, because
    this instrument randomises power-on RAM. Row 9 measures that separately. */
 const deterministic=rows.every(e=>e.repeatIdentical);
 const monotone=rows.every((e,i)=>i===0||e.loopIterationsCounter>rows[i-1].loopIterationsCounter);
 /* and N vs N+1 must differ, or "exact" means nothing */
 const atN=readCounter(['--frames','120']).value;
 const atN1=readCounter(['--frames','121']).value;
 checks.push({capability:'2. execute exactly N frames',
  method:'the summary record, the fixture own free-running counter read out of RAM, '
   +'a repeat of each run, and N against N+1',
  determinismScope:'the repeat comparison is on the fixture INITIALISED counter. It is '
   +'not a claim about whole-RAM repeatability across fresh boots - see row 9.',
  rows,oneMoreFrameDiffers:{at120:atN,at121:atN1,differ:atN!==atN1},
  pass:expect(reportedExact&&deterministic&&monotone&&atN!==atN1,
   'frame execution is not exact or not deterministic: reportedExact='+reportedExact
   +' deterministic='+deterministic+' monotone='+monotone+' 120vs121='+atN+'/'+atN1)});
}

/* ---- 3. button schedules through --input ----
   cadenceOnly steps down once every K press edges of the dual button and is
   moved by NOTHING else. So a schedule with a known number of press edges
   predicts the value, and a schedule with the WRONG button must not move it. */
{
 const K=fixture.oracle.edgesPerStep;
 const start=fixture.oracle.startValue;
 const readCadence=inputs=>{
  const args=[fixture.nes,'--frames','400'];
  for(const i of inputs)args.push('--input',i);
  args.push('--read-memory','NesInternalRam:'+F.cadenceOnly.address+':1');
  const r=run(args);
  const rec=r.all('memory_read').pop();
  return {value:rec&&rec.hex?parseInt(rec.hex.slice(0,2),16):null,r};
 };
 /* six separated presses of the dual button: six press edges -> two steps */
 const edges=6;
 const pressSchedule=[];
 for(let e=0;e<edges;e++){
  const at=20+e*20;
  pressSchedule.push('0:'+dualButton+'@'+at+'-'+(at+3));
 }
 const pressed=readCadence(pressSchedule);
 const neutral=readCadence([]);
 /* the same number of edges on the WRONG button */
 const wrong=readCadence(pressSchedule.map(s=>s.replace(dualButton,soloButton)));
 /* one long hold of the same total duration: ONE press edge, below K */
 const held=readCadence(['0:'+dualButton+'@20-139']);
 const expectedSteps=Math.floor(edges/K);
 checks.push({capability:'3. button schedules through --input',
  method:'cadenceOnly steps once per '+K+' press edges of '+dualButton
   +' and is moved by nothing else, so the schedule predicts the value',
  dualButton,soloButton,edgesPerStep:K,startValue:start,
  pressEdgesScheduled:edges,expectedSteps,
  observed:{underPresses:pressed.value,neutral:neutral.value,
   wrongButton:wrong.value,oneLongHold:held.value},
  predicted:{underPresses:start-expectedSteps,neutral:start,
   wrongButton:start,oneLongHold:start},
  pass:expect(pressed.value===start-expectedSteps&&neutral.value===start
   &&wrong.value===start&&held.value===start,
   'input scheduling did not produce the predicted mechanism: presses gave '
   +pressed.value+' (expected '+(start-expectedSteps)+'), neutral '+neutral.value
   +', wrong button '+wrong.value+', one long hold '+held.value
   +' (all three expected '+start+')')});
}

/* ---- 4. saving and restoring state ---- */
{
 const state=path.join(work,'at200.mss');
 const ramAt=(args)=>{
  const r=run([fixture.nes,...args,'--dump-memory','NesInternalRam='+path.join(work,'ram.bin')]);
  return {sha:fs.existsSync(path.join(work,'ram.bin'))
   ?sha256(fs.readFileSync(path.join(work,'ram.bin'))):null,r};
 };
 const saved=run([fixture.nes,'--frames','200','--save-state',state,
  '--dump-memory','NesInternalRam='+path.join(work,'ram200.bin')]);
 const shaAt200=fs.existsSync(path.join(work,'ram200.bin'))
  ?sha256(fs.readFileSync(path.join(work,'ram200.bin'))):null;
 const restored=ramAt(['--load-state',state,'--frames','0']);
 const continued=ramAt(['--load-state',state,'--frames','50']);
 const fresh=ramAt(['--frames','250']);
 checks.push({capability:'4. save and restore state',
  method:'save at frame 200, reload and run 0 frames (RAM must match), then reload '
   +'and run 50 more and compare with a fresh 250-frame run',
  stateFileBytes:fs.existsSync(state)?fs.statSync(state).size:0,
  ramSha256:{atSave:shaAt200,afterRestoreZeroFrames:restored.sha,
   restoredPlus50:continued.sha,freshRun250:fresh.sha},
  restoreIsExact:shaAt200!==null&&shaAt200===restored.sha,
  resumeMatchesFreshRun:continued.sha!==null&&continued.sha===fresh.sha,
  pass:expect(shaAt200!==null&&shaAt200===restored.sha,
   'restoring a saved state did not reproduce the RAM it was saved from: '
   +shaAt200+' vs '+restored.sha)});
}

/* ---- 5. reading RAM ----
   Checked against values the oracle predicts, not merely for being non-empty.

   CORRECTED AFTER THE FIRST RUN, and the correction was mine. The first version
   read at --frames 0 and expected the declared start value; it got [237,24].
   --frames 0 inspects the state BEFORE the reset handler has run, so RAM there
   is power-on content and the fixture has not initialised anything yet. The
   read was working; the expectation was wrong. Both facts are now asserted: the
   fields hold their declared value once reset has run, and they do NOT at frame
   zero - which also documents what --frames 0 means. */
{
 const readPair=frames=>{
  const r=run([fixture.nes,'--frames',String(frames),
   '--read-memory','NesInternalRam:'+F.pureAction.address+':1',
   '--read-memory','NesInternalRam:'+F.cadenceOnly.address+':1']);
  return {r,values:r.all('memory_read').map(x=>parseInt(x.hex.slice(0,2),16))};
 };
 /* pureAction and cadenceOnly are edge-driven only, so neutral frames leave
    them at the start value however many are run. */
 const afterReset=readPair(5);
 const beforeReset=readPair(0);
 const listing=run([fixture.nes,'--frames','0','--list-memory']);
 const spaces=listing.records.find(x=>Array.isArray(x.spaces)||Array.isArray(x.memory)
  ||x.event==='memory_spaces'||x.event==='memory_list');
 const start=fixture.oracle.startValue;
 checks.push({capability:'5. read RAM',
  method:'read two edge-driven fields after 5 neutral frames and compare with the '
   +'declared start value; read the same two at --frames 0 to show that is a '
   +'pre-reset state; and list the memory spaces',
  declaredStartValue:start,
  valuesAfterReset:afterReset.values,
  valuesAtFrameZero:beforeReset.values,
  frameZeroIsPreReset:beforeReset.values.some(v=>v!==start),
  memorySpacesListed:!!spaces,
  memorySpaceSample:spaces?JSON.stringify(spaces).slice(0,300):null,
  pass:expect(afterReset.values.length===2&&afterReset.values.every(v=>v===start),
   'RAM read did not return the declared start value '+start+' after reset: got '
   +JSON.stringify(afterReset.values))});
}

/* ---- 6. saving a CPU trace ----
   The decisive check: the generator recorded the PC of every writer site. The
   trace must contain the writer PC of cadenceOnly when the button is pressed,
   and must NOT when it is never pressed. */
{
 const writerPcs=(fixture.oracle.writerSites.cadenceOnly||[]).map(s=>s.pc);
 const traceOf=(inputs,tag)=>{
  const file=path.join(work,'trace-'+tag+'.log');
  const args=[fixture.nes,'--frames','400','--trace',file];
  for(const i of inputs)args.push('--input',i);
  const r=run(args,{timeoutMs:240000});
  const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  return {file,r,bytes:text.length,lines:text?text.split('\n').length:0,
   text:text.slice(0,0)/* never kept */,
   containsAny(pcs){
    return pcs.some(pc=>{
     const hex=pc.toString(16).toUpperCase().padStart(4,'0');
     return text.includes(hex);
    });
   },
   firstLines:text.split('\n').slice(0,3)};
 };
 const edges=6,schedule=[];
 for(let e=0;e<edges;e++){const at=20+e*20;
  schedule.push('0:'+dualButton+'@'+at+'-'+(at+3));}
 const withPress=traceOf(schedule,'pressed');
 const withoutPress=traceOf([],'neutral');
 checks.push({capability:'6. save a CPU trace',
  method:'the generator recorded the writer PCs of cadenceOnly. The trace must '
   +'contain one of them when the driving button is pressed and none of them when '
   +'it never is. A file merely existing is not the capability.',
  writerPcsFromOracle:writerPcs.map(p=>'0x'+p.toString(16)),
  traceBytes:{pressed:withPress.bytes,neutral:withoutPress.bytes},
  traceLines:{pressed:withPress.lines,neutral:withoutPress.lines},
  sampleTraceLines:withPress.firstLines,
  writerPcPresent:{whenPressed:withPress.containsAny(writerPcs),
   whenNeverPressed:withoutPress.containsAny(writerPcs)},
  pass:expect(withPress.bytes>0&&withPress.containsAny(writerPcs)
   &&!withoutPress.containsAny(writerPcs),
   'the CPU trace did not discriminate: bytes='+withPress.bytes
   +', writer PC present when pressed='+withPress.containsAny(writerPcs)
   +', present when never pressed='+withoutPress.containsAny(writerPcs))});
}

/* ---- 7. read / write / execute breakpoints ----

   CORRECTED AFTER THE FIRST RUN, and again the fault was mine. The first
   version expected a write breakpoint on cadenceOnly NOT to fire when the
   driving button was never pressed. It fired, because the fixture's own RESET
   HANDLER writes cadenceOnly = startValue at boot. That is a real write to that
   address and catching it is correct behaviour; the discriminator was wrong.

   The audit therefore starts from a POST-BOOT saved state, so the
   initialisation write is already behind us, and discriminates on WHERE the
   stop happened: the PC must be at or just past one of the writer PCs the
   generator recorded for this field. A stop at an unrelated PC would not be
   evidence about this field at all. */
{
 const bootState=path.join(work,'post-boot.mss');
 run([fixture.nes,'--frames','10','--save-state',bootState]);
 const writerPcs=(fixture.oracle.writerSites.cadenceOnly||[]).map(s=>s.pc);
 const readerPcsExist=Object.keys(fixture.oracle.writerSites);
 const probe=(spec,inputs,tag)=>{
  const args=[fixture.nes,'--load-state',bootState,'--frames','400',
   '--breakpoint',spec,'--pc'];
  for(const i of inputs)args.push('--input',i);
  const r=run(args,{timeoutMs:240000});
  /* the record is {"event":"program_counter","cpu":"Nes","value":33192} - a
     DECIMAL value, which the first version of this check did not parse */
  const pcRecord=r.records.find(x=>x.event==='program_counter');
  const numericPc=pcRecord&&typeof pcRecord.value==='number'?pcRecord.value:null;
  const stopped=!!(r.summary()&&r.summary().reason&&/break/i.test(r.summary().reason));
  return {spec,tag,summary:r.summary(),
   pc:numericPc,pcHex:numericPc===null?null:'0x'+numericPc.toString(16),
   numericPc,stopped,
   /* The PC is only evidence about a site when the run actually BROKE there. On
      a run that reached its frame limit, --pc reports wherever execution
      happened to be, which is not a finding about anything. */
   atWriterPc:stopped&&writerPcs.some(w=>numericPc!==null&&Math.abs(numericPc-w)<=6)};
 };
 const edges=6,schedule=[];
 for(let e=0;e<edges;e++){const at=20+e*20;
  schedule.push('0:'+dualButton+'@'+at+'-'+(at+3));}
 const writeBp=probe('NesMemory:0x'+F.cadenceOnly.address.toString(16)+':w',schedule,'write-pressed');
 const writeNoPress=probe('NesMemory:0x'+F.cadenceOnly.address.toString(16)+':w',[],'write-neutral');
 const readBp=probe('NesMemory:0x'+F.cadenceOnly.address.toString(16)+':r',schedule,'read-pressed');
 const execBp=probe('NesMemory:0x'+writerPcs[0].toString(16)+':x',schedule,'exec-at-writer');
 checks.push({capability:'7. read / write / execute breakpoints',
  method:'from a POST-BOOT state, so the reset handler initialisation write is already '
   +'done. A write breakpoint on cadenceOnly must stop only when the driving button is '
   +'pressed, and the PC it reports must be at or within a few bytes of a writer PC the '
   +'generator recorded. An execute breakpoint is set directly on that writer PC.',
  writerPcsFromOracle:writerPcs.map(p=>'0x'+p.toString(16)),
  fieldsWithRecordedWriters:readerPcsExist,
  write:{reason:writeBp.summary?writeBp.summary.reason:null,pc:writeBp.pc,
   stopped:writeBp.stopped,pcIsAtRecordedWriter:writeBp.atWriterPc,
   pcHex:writeBp.pcHex},
  writeWithoutPress:{reason:writeNoPress.summary?writeNoPress.summary.reason:null,
   pc:writeNoPress.pc,pcHex:writeNoPress.pcHex,stopped:writeNoPress.stopped,
   pcIsAtRecordedWriter:writeNoPress.atWriterPc,
   pcNoteWhenNotStopped:'this run reached its frame limit, so the reported PC is '
    +'wherever execution happened to be and is not evidence about any site'},
  read:{reason:readBp.summary?readBp.summary.reason:null,pc:readBp.pc,
   stopped:readBp.stopped},
  execute:{reason:execBp.summary?execBp.summary.reason:null,pc:execBp.pc,
   stopped:execBp.stopped,pcIsAtRecordedWriter:execBp.atWriterPc,
   pcHex:execBp.pcHex},
  pass:expect(writeBp.stopped&&writeBp.atWriterPc
   &&!writeNoPress.stopped
   &&execBp.stopped&&execBp.atWriterPc,
   'breakpoints did not discriminate by site: write-pressed stopped='+writeBp.stopped
   +' atWriter='+writeBp.atWriterPc+' pc='+writeBp.pcHex
   +'; write-neutral stopped='+writeNoPress.stopped
   +'; exec stopped='+execBp.stopped+' atWriter='+execBp.atWriterPc+' pc='+execBp.pcHex)});
}

/* ---- 8. obtaining a video frame ---- */
{
 const shot=tag=>{
  const file=path.join(work,'shot-'+tag+'.png');
  const r=run([fixture.nes,'--frames',tag==='early'?'30':'400','--screenshot',file]);
  const exists=fs.existsSync(file);
  const bytes=exists?fs.readFileSync(file):null;
  const isPng=!!bytes&&bytes.length>24
   &&bytes.slice(0,8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  return {file,r,exists,size:bytes?bytes.length:0,isPng,
   /* IHDR: width and height are big-endian 32-bit at offsets 16 and 20 */
   width:isPng?bytes.readUInt32BE(16):null,
   height:isPng?bytes.readUInt32BE(20):null,
   sha:bytes?sha256(bytes):null};
 };
 const early=shot('early'),late=shot('late');
 /* CORRECTED AFTER THE FIRST RUN. The first version required the PNG to exceed
    1000 bytes. The frames came back at 718 bytes and the check failed - but 718
    bytes is the CORRECT size for this fixture's picture: the ROM never programs
    the PPU for a real background, so the screen is near-uniform and compresses
    to almost nothing. A byte threshold was an arbitrary proxy for "a real
    picture". The capability is: a valid PNG of the console's actual resolution,
    and two different points of the run giving different images. Both were
    already true on the first run; the threshold was the only thing failing. */
 checks.push({capability:'8. obtain a video frame',
  method:'a PNG at two different points of the same run: valid signature, the IHDR '
   +'dimensions of the NES frame, and the two images must differ or the pipeline is '
   +'handing back a constant. No byte-size threshold: a blank fixture screen '
   +'legitimately compresses to a few hundred bytes.',
  early:{size:early.size,isPng:early.isPng,width:early.width,height:early.height,
   sha256:early.sha},
  late:{size:late.size,isPng:late.isPng,width:late.width,height:late.height,
   sha256:late.sha},
  framesDiffer:early.sha!==null&&early.sha!==late.sha,
  expectedDimensions:'256x240',
  note:'this fixture renders a near-uniform screen, so the picture is small by nature. '
   +'A cartridge that draws a real background is exercised in B3, not here.',
  pass:expect(early.isPng&&late.isPng
   &&early.width===256&&early.height===240
   &&late.width===256&&late.height===240
   &&early.sha!==late.sha,
   'no usable video frame: earlyPng='+early.isPng+' latePng='+late.isPng
   +' dims='+early.width+'x'+early.height+' differ='+(early.sha!==late.sha))});
}

/* ---- 9. is a fresh boot reproducible at all? ----

   NOT ON THE ORIGINAL B0 LIST. It was measured because row 4 reported that a
   restored state was bit-exact while restore-plus-50-frames did not match a
   fresh longer run, and that had to be explained rather than filed away.

   The explanation is a property of this instrument: Core/Shared/SettingTypes.h
   declares RamState { Random = 0, AllZeros = 1, AllOnes = 2 } and
   Core/NES/NesConsole.cpp initialises RAM from NesConfig.RamPowerOnState, whose
   default is therefore Random. Headless/AgentCli.cpp sets no settings at all, so
   the CLI offers NO WAY to select it. Every fresh boot has different
   uninitialised bytes.

   That is a capability gap, not a defect: real hardware does not guarantee a
   zeroed RAM either, and jsnes - which zeroes it - is the one making the
   convenient assumption. But it has to be controlled, declared, or both, and
   the mitigation is measured here rather than assumed. */
{
 const dump=(args,tag)=>{
  const file=path.join(work,'ram-'+tag+'.bin');
  run([fixture.nes,...args,'--dump-memory','NesInternalRam='+file]);
  return fs.existsSync(file)?sha256(fs.readFileSync(file)):null;
 };
 const freshBoots=[1,2,3].map(i=>dump(['--frames','200'],'fresh'+i));
 const powerOn=[1,2,3].map(i=>dump(['--frames','0'],'poweron'+i));
 const canonical=path.join(work,'canonical.mss');
 run([fixture.nes,'--frames','200','--save-state',canonical]);
 const fromState=[1,2,3].map(i=>dump(['--load-state',canonical,'--frames','50'],'state'+i));
 const schedule=['0:'+dualButton+'@10-13','0:'+dualButton+'@30-33'];
 const withInput=[1,2].map(i=>dump(['--load-state',canonical,'--frames','100',
  '--input',schedule[0],'--input',schedule[1]],'input'+i));
 const noInput=dump(['--load-state',canonical,'--frames','100'],'noinput');
 const allSame=list=>list.every(h=>h!==null&&h===list[0]);
 checks.push({capability:'9. reproducibility of a fresh boot, and the mitigation',
  notOnTheOriginalList:true,
  method:'three identical fresh runs, three reads of power-on RAM, then three runs from '
   +'ONE canonical saved state, and two runs from that state with an identical input '
   +'schedule',
  freshBootsIdentical:allSame(freshBoots),freshBootHashes:freshBoots,
  powerOnRamIdentical:allSame(powerOn),powerOnHashes:powerOn,
  fromCanonicalStateIdentical:allSame(fromState),fromCanonicalStateHashes:fromState,
  withIdenticalInputIdentical:allSame(withInput),
  inputChangesTheResult:withInput[0]!==noInput,
  cause:'Core/Shared/SettingTypes.h RamState{Random=0,AllZeros=1,AllOnes=2}; '
   +'Core/NES/NesConsole.cpp initialises RAM from NesConfig.RamPowerOnState, default Random; '
   +'Headless/AgentCli.cpp sets no settings, so the CLI cannot select it',
  capabilityGap:'the power-on RAM state is not selectable from this CLI',
  mitigation:'drive every comparison from ONE canonical saved state. Verified bit-identical '
   +'across repeats, with and without input, and input still changes the result. This is the '
   +'same discipline GU declared starts already use, so no new assumption is introduced.',
  consequenceForB2:'a cross-core comparison against jsnes, which zeroes RAM, may not compare '
   +'whole-RAM hashes from independent boots. It must either run both cores from a declared '
   +'procedure and compare only addresses the ROM itself initialises, or compare trajectories '
   +'rather than absolute content. Recorded before B2 rather than discovered during it.',
  pass:expect(!allSame(freshBoots)&&allSame(fromState)&&allSame(withInput)
   &&withInput[0]!==noInput,
   'the mitigation is not established: freshBootsDiffer='+!allSame(freshBoots)
   +' fromStateIdentical='+allSame(fromState)+' withInputIdentical='+allSame(withInput)
   +' inputMatters='+(withInput[0]!==noInput))});
}

/* ---- what the instrument does NOT give, recorded now rather than discovered later ---- */
const sourceNotes={
 memoryCallbackArguments:'Core/Debugger/ScriptingContext.cpp InternalCallMemoryCallback '
  +'pushes exactly TWO values to the Lua callback: the relative address and the value. '
  +'It does NOT pass the program counter, the CPU cycle, the frame number or the input '
  +'state. Those must be sampled inside the callback via emu.getState(), which is a '
  +'DIFFERENT provenance claim - a sample taken at callback time, not a field of the '
  +'event - and B4 must record it as such.',
 powerOnRamState:'Core/Shared/SettingTypes.h RamState{Random=0,AllZeros=1,AllOnes=2}. '
  +'Core/NES/NesConsole.cpp initialises RAM from NesConfig.RamPowerOnState, so the default is '
  +'Random, and Headless/AgentCli.cpp sets no settings - the CLI cannot select it. Row 9 '
  +'measures the consequence and the mitigation.',
 nesCpuStateFields:'Core/NES/NesTypes.h NesCpuState carries CycleCount, PC, SP, A, X, Y, '
  +'PS, IrqFlag, NmiFlag. So a cycle index and a PC are available to a callback, from the '
  +'CPU state at the moment the callback runs.',
 licence:'GPL-3.0 (LICENSE, 674 lines, GNU GPL v3). No source from this project is copied '
  +'into GU. The instrument is used as a separate process addressed by argv and JSON Lines, '
  +'which is the architecture the specification prescribes; the licence analysis itself is '
  +'part of B5 and is not settled by this file.'};

const report={type:'gu-stage-b-b0-capability-audit',version:1,
 stage:'B0 - build and capability audit',
 rule:'a CLI argument is not a capability. Every row was exercised by a real call and '
  +'checked against something known independently of the instrument - mostly the closed '
  +'oracle of a GU synthetic fixture, including the writer program counters its generator '
  +'recorded.',
 instrument:{
  path:AGENT,
  repository:'https://github.com/atonamy/mesen-agent',
  sha:process.env.MESEN_SHA||null,
  shaMatchesSpecification:process.env.MESEN_SHA
   ?process.env.MESEN_SHA==='dbc2c744ad52e1c89a8570d22d7fa92507ad4816':null,
  binarySha256:sha256(fs.readFileSync(AGENT)),
  buildToolchain:process.env.MESEN_TOOLCHAIN||null,
  licence:'GPL-3.0'},
 fixture:{generator:'tools/make_agod_dual_dependence_rom.py',seed:1,
  romSha256:fixture.sha256,
  note:'MIT fixture generated locally. Its oracle is used only to CHECK the instrument '
   +'and is never handed to discovery.'},
 checks,
 cost:{instrumentInvocations:invocations,instrumentWallClockMs:instrumentMs},
 sourceNotes,
 totals:{capabilities:checks.length,passing:checks.filter(c=>c.pass===true).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'PARTIAL'};
if(process.env.B0_REPORT)fs.writeFileSync(process.env.B0_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 capabilities:checks.map(c=>({capability:c.capability,pass:c.pass})),
 cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
