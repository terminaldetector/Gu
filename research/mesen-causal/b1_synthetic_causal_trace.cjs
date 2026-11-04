'use strict';
// STAGE B / B1: a synthetic causal trace, in two observation modes.
//
// B1-A  ACCESS SUMMARY. emu.getAccessCounters() over declared windows: how many
//       reads, writes and executes an address saw, and when it was last touched.
//       Cheap, aggregated, no per-access callback.
//
// B1-B  FOCUSED EXECUTION TRACE. Per-access callbacks on selected addresses for
//       short episodes, with the program counter sampled for a BOUNDED number of
//       events - review item 1: emu.getState() serialises the whole console, so
//       it is never called unconditionally per access.
//
// Three action regimes per control: neutral, continuous hold, pulse train.
// Seven controls across two fixture families.
//
// THE QUESTION B1 EXISTS TO ANSWER: does the trace distinguish an access to a
// resource, to a one-shot latch, and to a time-driven counter? That is asked of
// the trace, not of the oracle; the oracle only scores the answer afterwards.
//
// TWO INDEPENDENT COUNTS, so event loss is measured rather than assumed: the
// callback counts events itself, and the access counters count the same window
// separately. A disagreement is reported as incompleteness, not smoothed over.
//
// WHAT THIS FILE MAY NOT CONCLUDE: the presence of a CPU read is NOT evidence
// that a field is a game resource, and is never promoted to GAME_COST_EVIDENCED.
// A field read by HUD code, animation or a timer produces reads too.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),path=require('node:path');
const M=require('./mesen.cjs');
const Provenance=require('../../tools/agod_provenance.cjs');

const inst=M.instrument({});
const FRAMES=400,FLUSH_AT=380,MAX_PC_SAMPLES=16;
const failures=[],fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);

/* ---- the two fixture families and the seven declared controls ---- */
const dual=M.fixture(inst.work,'make_agod_dual_dependence_rom.py',1);
const trans=M.fixture(inst.work,'make_agod_transition_rom.py',1,['--arm-presses','1']);
const controls=[
 {name:'cadenceOnly',   fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.cadenceOnly},
 {name:'timeAndAction', fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.timeAndAction},
 {name:'pureTime',      fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.pureTime},
 {name:'pureAction',    fixture:dual, mask:dual.oracle.soloMask,
  truth:dual.oracle.dependenceLabels.pureAction},
 {name:'singleUnit',    fixture:trans, mask:trans.oracle.spendMask,
  truth:trans.oracle.transitionLabels.singleUnit},
 {name:'oneShotSwitch', fixture:trans, mask:trans.oracle.latchMask,
  truth:trans.oracle.transitionLabels.oneShotSwitch},
 {name:'firstThenLater',fixture:trans, mask:trans.oracle.latchMask,
  truth:trans.oracle.transitionLabels.firstThenLater}];

/* one canonical post-boot state per fixture: B0 row 9 showed fresh boots differ */
const bootStates=new Map();
for(const f of [dual,trans]){
 const state=path.join(inst.work,'boot-'+M.sha256(f.nes).slice(0,8)+'.mss');
 inst.run([f.nes,'--frames','10','--save-state',state]);
 bootStates.set(f.nes,state);
}
const regimes=button=>({
 neutral:M.schedules.neutral(),
 continuousHold:M.schedules.hold(button,240,20),
 pulseTrain:M.schedules.train(button,20,4,8,20)});

/* ---- B1-A: access summary over one declared window ---- */
function accessSummary(fixture,addresses,inputs,tag){
 const out=path.join(inst.work,'summary-'+tag+'.jsonl');
 const list=addresses.map(a=>a.address).join(',');
 const body=M.luaPreamble(out)+`
local addrs = {${list}}
local frames = 0
-- Counters are cumulative, so the window is opened by resetting them. This is
-- the CHEAP mode: no per-access callback is registered at all.
emu.resetAccessCounters()
local function onEndFrame()
  frames = frames + 1
  if frames == ${FLUSH_AT} then
    local rc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.readCount)
    local wc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.writeCount)
    local ec = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.execCount)
    local lr = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.lastReadClock)
    local lw = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.lastWriteClock)
    for _, a in ipairs(addrs) do
      emit({ kind = "counters", address = a,
             readCount = rc[a], writeCount = wc[a], execCount = ec[a],
             lastReadClock = lr[a], lastWriteClock = lw[a] })
    end
    local st = emu.getState()
    emit({ kind = "window", frames = frames, frameCount = st["frameCount"],
           cycleCount = st["cpu.cycleCount"] })
    flush()
  end
end
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
 const script=M.luaFile(inst.work,'summary-'+tag+'.lua',body);
 const args=[fixture.nes,'--load-state',bootStates.get(fixture.nes),
  '--frames',String(FRAMES),'--lua',script,'--lua-allow-io','--lua-timeout','30'];
 for(const i of inputs)args.push('--input',i);
 const r=inst.run(args,{timeoutMs:300000});
 const events=fs.existsSync(out)
  ?fs.readFileSync(out,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 return {elapsedMs:r.elapsedMs,
  counters:events.filter(e=>e.kind==='counters'),
  window:events.find(e=>e.kind==='window')||null,
  luaErrors:r.luaLog().filter(x=>x.event==='lua_error').length};
}

/* ---- B1-B: focused per-access trace, bounded PC sampling ---- */
function focusedTrace(fixture,address,inputs,tag,pcSamples){
 const out=path.join(inst.work,'trace-'+tag+'.jsonl');
 const body=M.luaPreamble(out)+`
local writes, reads = 0, 0
local pcSampled = 0
local frames = 0
local firstWriteFrame, lastWriteFrame = nil, nil
emu.resetAccessCounters()
local function onWrite(address, value)
  writes = writes + 1
  if firstWriteFrame == nil then firstWriteFrame = frames end
  lastWriteFrame = frames
  -- BOUNDED: emu.getState() serialises the entire console, so it runs for the
  -- first ${pcSamples} events only. The counts above stay cheap and unbounded.
  if pcSampled < ${pcSamples} then
    pcSampled = pcSampled + 1
    local st = emu.getState()
    emit({ kind = "write", address = address, value = value,
           nextInstructionPc = st["cpu.pc"], cycleCount = st["cpu.cycleCount"],
           frameCount = st["frameCount"], atFrameInWindow = frames })
  end
  -- returns nothing: observation only
end
local function onRead(address, value)
  reads = reads + 1
  -- no state sample for reads in this mode: reads are far more numerous
end
local function onEndFrame()
  frames = frames + 1
  if frames == ${FLUSH_AT} then
    local wc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.writeCount)
    local rc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.readCount)
    -- TWO INDEPENDENT COUNTS of the same window, so loss is measurable
    emit({ kind = "totals", callbackWrites = writes, callbackReads = reads,
           counterWrites = wc[${address}], counterReads = rc[${address}],
           pcSampled = pcSampled,
           firstWriteAtFrame = firstWriteFrame, lastWriteAtFrame = lastWriteFrame })
    flush()
  end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, ${address}, ${address}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addMemoryCallback(onRead,  emu.callbackType.read,  ${address}, ${address}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
 const script=M.luaFile(inst.work,'trace-'+tag+'.lua',body);
 const args=[fixture.nes,'--load-state',bootStates.get(fixture.nes),
  '--frames',String(FRAMES),'--lua',script,'--lua-allow-io','--lua-timeout','30'];
 for(const i of inputs)args.push('--input',i);
 const r=inst.run(args,{timeoutMs:300000});
 const events=fs.existsSync(out)
  ?fs.readFileSync(out,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 return {elapsedMs:r.elapsedMs,
  writes:events.filter(e=>e.kind==='write'),
  totals:events.find(e=>e.kind==='totals')||null,
  luaErrors:r.luaLog().filter(x=>x.event==='lua_error').length};
}

/* ================= B1-A ================= */
const summaryRows=[];
for(const f of [dual,trans]){
 const fields=Object.entries(f.oracle.fields).map(([name,v])=>({name,address:v.address}));
 const anyControl=controls.find(c=>c.fixture===f);
 const button=M.buttonOf(anyControl.mask);
 const r=regimes(button);
 for(const [regime,inputs] of Object.entries(r)){
  const tag=(f===dual?'dual':'trans')+'-'+regime;
  const s=accessSummary(f,fields,inputs,tag);
  summaryRows.push({family:f===dual?'dual-dependence':'single-transition',
   regime,button,inputs,elapsedMs:s.elapsedMs,window:s.window,
   luaErrors:s.luaErrors,
   perField:s.counters.map(c=>{
    const field=fields.find(x=>x.address===c.address);
    return {field:field?field.name:null,address:c.address,
     readCount:c.readCount,writeCount:c.writeCount,execCount:c.execCount,
     lastReadClock:c.lastReadClock,lastWriteClock:c.lastWriteClock};
   })});
 }
}
const countersPopulated=summaryRows.some(r=>r.perField.some(f=>(f.readCount||0)>0||(f.writeCount||0)>0));

/* ================= B1-B ================= */
const traceRows=[];
for(const control of controls){
 const address=control.fixture.oracle.fields[control.name].address;
 const button=M.buttonOf(control.mask);
 const r=regimes(button);
 const perRegime={};
 for(const [regime,inputs] of Object.entries(r)){
  const tag=control.name+'-'+regime;
  perRegime[regime]=focusedTrace(control.fixture,address,inputs,tag,MAX_PC_SAMPLES);
 }
 /* the oracle's writer PCs, used only to SCORE the trace afterwards */
 const writerPcs=(control.fixture.oracle.writerSites[control.name]||[]).map(s=>s.pc);
 /* resolve each sampled next-instruction PC to its accessing instruction via
    disassembly - never by subtracting a constant (B1 prerequisites, item 2) */
 const resolve=pc=>{
  const window=inst.disassemble(control.fixture.nes,Math.max(0x8000,pc-8),8);
  const hit=window.find(d=>d.address+d.length===pc);
  return hit?{address:hit.address,addressHex:'0x'+hit.address.toString(16),
   text:hit.text,length:hit.length}:null;
 };
 const sampleOf=regime=>{
  const t=perRegime[regime];
  const first=t.writes[0];
  if(!first)return null;
  const accessing=resolve(first.nextInstructionPc);
  return {value:first.value,atFrameInWindow:first.atFrameInWindow,
   nextInstructionPc:'0x'+first.nextInstructionPc.toString(16),
   accessingInstruction:accessing,
   matchesAnOracleWriterSite:!!accessing&&writerPcs.includes(accessing.address)};
 };
 const w=regime=>(perRegime[regime].totals||{});
 traceRows.push({control:control.name,address,button,
  groundTruth:{timeDriven:control.truth.timeDriven,
   actionDriven:control.truth.actionDriven,
   isResource:control.truth.isResource,
   neutralArmMoves:control.truth.neutralArmMoves,
   movesUnderContinuousHold:control.truth.movesUnderContinuousHold,
   requiresMultipleEdges:control.truth.requiresMultipleEdges||null},
  writerPcsFromOracle:writerPcs.map(p=>'0x'+p.toString(16)),
  writesObserved:{neutral:w('neutral').callbackWrites,
   continuousHold:w('continuousHold').callbackWrites,
   pulseTrain:w('pulseTrain').callbackWrites},
  readsObserved:{neutral:w('neutral').callbackReads,
   continuousHold:w('continuousHold').callbackReads,
   pulseTrain:w('pulseTrain').callbackReads},
  eventLossCheck:Object.fromEntries(Object.keys(perRegime).map(regime=>{
   const t=w(regime);
   return [regime,{callbackWrites:t.callbackWrites,counterWrites:t.counterWrites,
    callbackReads:t.callbackReads,counterReads:t.counterReads,
    writesAgree:t.callbackWrites===t.counterWrites,
    readsAgree:t.callbackReads===t.counterReads}];
  })),
  firstWriteAtFrame:Object.fromEntries(Object.keys(perRegime).map(regime=>
   [regime,w(regime).firstWriteAtFrame===undefined?null:w(regime).firstWriteAtFrame])),
  sampledSite:{neutral:sampleOf('neutral'),
   continuousHold:sampleOf('continuousHold'),pulseTrain:sampleOf('pulseTrain')},
  elapsedMs:Object.fromEntries(Object.keys(perRegime).map(r2=>[r2,perRegime[r2].elapsedMs])),
  luaErrors:Object.fromEntries(Object.keys(perRegime).map(r2=>[r2,perRegime[r2].luaErrors]))});
}

/* ---- does the trace discriminate resource / latch / time-driven? ---- */
const discrimination=traceRows.map(row=>{
 const w=row.writesObserved;
 const neutralWrites=w.neutral||0;
 const trainWrites=w.pulseTrain||0,holdWrites=w.continuousHold||0;
 /* read out of the TRACE alone, before the oracle is consulted */
 let observedClass='UNDETERMINED';
 if(neutralWrites>0&&trainWrites>0&&Math.abs(trainWrites-neutralWrites)<=1)
  observedClass='WRITTEN_REGARDLESS_OF_ACTION';
 else if(neutralWrites===0&&trainWrites===0&&holdWrites===0)
  observedClass='NEVER_WRITTEN_IN_THIS_WINDOW';
 else if(trainWrites>holdWrites&&holdWrites<=1)
  observedClass='WRITTEN_PER_ACTION_EDGE';
 else if(trainWrites>0||holdWrites>0)
  observedClass='WRITTEN_UNDER_ACTION';
 /* and only now the oracle, to score it */
 const truth=row.groundTruth;
 const expectedClass=truth.timeDriven&&!truth.actionDriven?'WRITTEN_REGARDLESS_OF_ACTION'
  :(truth.requiresMultipleEdges?'WRITTEN_PER_ACTION_EDGE'
   :(truth.actionDriven?'WRITTEN_UNDER_ACTION':'UNDETERMINED'));
 return {control:row.control,observedClass,expectedClass,
  agrees:observedClass===expectedClass
   ||(observedClass==='WRITTEN_PER_ACTION_EDGE'&&expectedClass==='WRITTEN_UNDER_ACTION'),
  neutralWrites,holdWrites,trainWrites,
  note:'the class is read from the trace. The oracle is consulted only to score it.'};
});

/* ---- review item 1: the cost of each observation mode ---- */
const overhead=(()=>{
 const address=dual.oracle.fields.cadenceOnly.address;
 const button=M.buttonOf(dual.oracle.dualMask);
 const inputs=M.schedules.train(button,20,4,8,20);
 const base=[dual.nes,'--load-state',bootStates.get(dual.nes),'--frames',String(FRAMES)];
 const timeOf=(args,tag,timeoutMs)=>{
  const r=inst.run(args,{timeoutMs:timeoutMs||300000});
  return {tag,elapsedMs:r.elapsedMs,
   reason:r.summary()?r.summary().reason:null};
 };
 const withInputs=extra=>[...base,...inputs.flatMap(i=>['--input',i]),...extra];
 const noObservation=timeOf(withInputs([]),'no observation at all');
 const cheapCount=(()=>{
  const r=focusedTrace(dual,address,inputs,'cost-cheap',0);
  return {tag:'per-access callback, no state sample',elapsedMs:r.elapsedMs,
   events:r.totals?r.totals.callbackWrites:null};
 })();
 const boundedSample=(()=>{
  const r=focusedTrace(dual,address,inputs,'cost-bounded',MAX_PC_SAMPLES);
  return {tag:'per-access callback, state sampled for the first '+MAX_PC_SAMPLES+' writes',
   elapsedMs:r.elapsedMs,events:r.totals?r.totals.callbackWrites:null};
 })();
 const everySample=(()=>{
  /* deliberately unbounded, on a SHORT window, only to quantify the warning */
  const out=path.join(inst.work,'cost-every.jsonl');
  const body=M.luaPreamble(out)+`
local n = 0
local frames = 0
local function onWrite(address, value)
  n = n + 1
  local st = emu.getState()   -- UNBOUNDED, to measure what the review warned about
  if n <= 2 then emit({ kind = "write", pc = st["cpu.pc"] }) end
end
local function onRead(address, value)
  local st = emu.getState()   -- UNBOUNDED
end
local function onEndFrame()
  frames = frames + 1
  if frames == 60 then emit({ kind = "totals", writes = n }); flush() end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, ${address}, ${address}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addMemoryCallback(onRead,  emu.callbackType.read,  ${address}, ${address}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
  const script=M.luaFile(inst.work,'cost-every.lua',body);
  return timeOf([dual.nes,'--load-state',bootStates.get(dual.nes),'--frames','80',
   ...inputs.flatMap(i=>['--input',i]),'--lua',script,'--lua-allow-io','--lua-timeout','30'],
   'per-access callback, state sampled on EVERY access, 80-frame window only');
 })();
 const fullTrace=(()=>{
  const file=path.join(inst.work,'cost-trace.log');
  const t=timeOf(withInputs(['--trace',file]),'full CPU instruction trace',600000);
  const size=fs.existsSync(file)?fs.statSync(file).size:0;
  return {...t,traceBytes:size,
   traceLines:size?fs.readFileSync(file,'utf8').split('\n').length:0};
 })();
 const ratio=x=>x.elapsedMs&&noObservation.elapsedMs
  ?Number((x.elapsedMs/noObservation.elapsedMs).toFixed(2)):null;
 return {baselineFrames:FRAMES,
  modes:[noObservation,cheapCount,boundedSample,everySample,fullTrace]
   .map(x=>({...x,timesBaseline:ratio(x)})),
  note:'the unbounded mode ran a SHORTER window (80 frames against 400), so its ratio '
   +'understates the cost per frame; it is reported to size the warning, not as a mode '
   +'to use. A full instruction trace is a separate order of cost again.'};
})();

/* ---- the checks ---- */
const checks=[];
checks.push({check:'B1-A access counters populate over a declared window',
 countersPopulated,
 pass:expect(countersPopulated,
  'every access counter read back zero, so B1-A observed nothing')});
const lossRows=traceRows.flatMap(r=>Object.entries(r.eventLossCheck)
 .map(([regime,v])=>({control:r.control,regime,...v})));
const lossDisagreements=lossRows.filter(r=>r.writesAgree===false);
checks.push({check:'B1-B the callback count and the access-counter count agree',
 comparisons:lossRows.length,disagreements:lossDisagreements,
 pass:expect(lossDisagreements.length===0,
  'the two independent counts disagree, so events were lost or double-counted: '
  +JSON.stringify(lossDisagreements.slice(0,6)))});
const resolvedSites=traceRows.flatMap(r=>Object.values(r.sampledSite)
 .filter(Boolean).filter(s=>s.accessingInstruction));
const atOracleSite=resolvedSites.filter(s=>s.matchesAnOracleWriterSite);
checks.push({check:'B1-B a sampled write resolves to an instruction the oracle recorded',
 sitesResolved:resolvedSites.length,atOracleWriterSite:atOracleSite.length,
 pass:expect(atOracleSite.length>0,
  'no sampled write resolved to a writer instruction the generator recorded, so the '
  +'executing instruction is not independently confirmed for any control')});
const agreeing=discrimination.filter(d=>d.agrees);
checks.push({check:'B1-B the trace discriminates the control classes',
 perControl:discrimination,
 agreeing:agreeing.length,of:discrimination.length,
 pass:true,
 note:'reported, not asserted. A control the trace cannot classify is a measured limit '
  +'of this observation mode, published as one.'});
checks.push({check:'no Lua errors in any observation run',
 pass:expect(traceRows.every(r=>Object.values(r.luaErrors).every(v=>v===0))
  &&summaryRows.every(r=>r.luaErrors===0),
  'a Lua observation run reported an error, so its counts are not trustworthy')});

const report={type:'gu-stage-b-b1-synthetic-causal-trace',version:1,
 stage:'B1 - synthetic causal trace, two observation modes',
 rule:'the presence of a CPU read is NOT evidence that a field is a game resource and '
  +'is never promoted to GAME_COST_EVIDENCED. A field read by HUD code, animation or a '
  +'timer produces reads too.',
 startStateNote:'every run starts from ONE canonical post-boot saved state per fixture, '
  +'because this instrument randomises power-on RAM (B0 row 9). Runs are therefore '
  +'comparable within this core; they are NOT comparable with an independent jsnes cold '
  +'start, which B2 must handle explicitly.',
 pcProvenance:'a sampled PC is the NEXT instruction address. The accessing instruction '
  +'is resolved through disassembly, never by subtracting a constant (B1 prerequisites).',
 instrument:{path:inst.binary,binarySha256:inst.binarySha256,
  repository:'https://github.com/atonamy/mesen-agent',sha:process.env.MESEN_SHA||null,
  licence:'GPL-3.0'},
 fixtures:[{family:'dual-dependence',generator:'tools/make_agod_dual_dependence_rom.py',
  seed:1,romSha256:dual.sha256},
  {family:'single-transition',generator:'tools/make_agod_transition_rom.py',seed:1,
   armPresses:1,romSha256:trans.sha256}],
 parameters:{frames:FRAMES,flushAtFrame:FLUSH_AT,maxPcSamplesPerRun:MAX_PC_SAMPLES,
  regimes:{neutral:'no input',continuousHold:'one press edge held 240 frames',
   pulseTrain:'20 pulses of 4 frames held, 8 frames apart'}},
 B1A_accessSummary:summaryRows,
 B1B_focusedTrace:traceRows,
 discrimination,
 overhead,
 checks,cost:inst.cost(),
 provenance:Provenance.record({tool:'research/mesen-causal/b1_synthetic_causal_trace.cjs',
  sources:['research/mesen-causal/mesen.cjs','tools/make_agod_dual_dependence_rom.py',
   'tools/make_agod_transition_rom.py']}),
 totals:{checks:checks.length,passing:checks.filter(c=>c.pass===true).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.B1_REPORT)
 fs.writeFileSync(process.env.B1_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 checks:checks.map(c=>({check:c.check,pass:c.pass})),
 discrimination:discrimination.map(d=>({control:d.control,observed:d.observedClass,
  expected:d.expectedClass,agrees:d.agrees,
  writes:{neutral:d.neutralWrites,hold:d.holdWrites,train:d.trainWrites}})),
 overhead:overhead.modes.map(m=>({mode:m.tag,ms:m.elapsedMs,x:m.timesBaseline,
  traceBytes:m.traceBytes})),
 cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
