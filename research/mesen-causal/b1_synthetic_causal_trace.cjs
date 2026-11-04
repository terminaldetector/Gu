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
/* The expected class of each control, DECLARED HERE from the mechanism its
   generator documents - not inferred from oracle label fields, because the two
   fixture families use different label schemas and the first run of this file
   silently produced "UNDETERMINED" for all three transition-family controls
   where my mapping read fields that family does not have.

   The five classes:
     NEVER_WRITTEN_IN_WINDOW        no writes under any regime
     WRITTEN_REGARDLESS_OF_ACTION   written in neutral play, and the train does
                                    not add materially
     WRITTEN_BY_TIME_AND_ACTION     written in neutral play AND materially more
                                    under the train
     WRITTEN_PER_ACTION_EDGE        not written in neutral, and the train writes
                                    it many times more than a single-edge hold
     WRITTEN_ONLY_UNDER_ACTION      not written in neutral, but a bounded number
                                    of times however many edges arrive */
const controls=[
 {name:'cadenceOnly',   fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.cadenceOnly,
  expectedClass:'WRITTEN_PER_ACTION_EDGE',
  because:'steps once every K press edges and nothing else moves it'},
 {name:'timeAndAction', fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.timeAndAction,
  expectedClass:'WRITTEN_BY_TIME_AND_ACTION',
  because:'rises on its own timer AND falls on every press edge'},
 {name:'pureTime',      fixture:dual, mask:dual.oracle.dualMask,
  truth:dual.oracle.dependenceLabels.pureTime,
  expectedClass:'WRITTEN_REGARDLESS_OF_ACTION',
  because:'advances on its own timer only'},
 {name:'pureAction',    fixture:dual, mask:dual.oracle.soloMask,
  truth:dual.oracle.dependenceLabels.pureAction,
  expectedClass:'WRITTEN_PER_ACTION_EDGE',
  because:'decrements once per press edge for as long as the resource lasts'},
 {name:'singleUnit',    fixture:trans, mask:trans.oracle.spendMask,
  truth:trans.oracle.transitionLabels.singleUnit,
  expectedClass:'WRITTEN_ONLY_UNDER_ACTION',
  because:'a genuine resource of exactly ONE unit: it can be written once and no '
   +'number of further edges can write it again'},
 {name:'oneShotSwitch', fixture:trans, mask:trans.oracle.latchMask,
  truth:trans.oracle.transitionLabels.oneShotSwitch,
  expectedClass:'WRITTEN_ONLY_UNDER_ACTION',
  because:'a latch: it flips once on a press edge and never moves again'},
 {name:'firstThenLater',fixture:trans, mask:trans.oracle.latchMask,
  truth:trans.oracle.transitionLabels.firstThenLater,
  expectedClass:'WRITTEN_ONLY_UNDER_ACTION',
  because:'steps on press edge 1 and again on edge 5, so a bounded two writes'}];

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
local readsSampled = 0
local function onRead(address, value)
  reads = reads + 1
  -- Reads are sampled too, and BOUNDED for the same reason as writes. Read
  -- SITES are what might separate a one-unit resource from a latch where read
  -- COUNTS do not: the same number of reads can come from different consumers.
  if readsSampled < ${pcSamples} then
    readsSampled = readsSampled + 1
    local st = emu.getState()
    emit({ kind = "read", address = address, value = value,
           nextInstructionPc = st["cpu.pc"], frameCount = st["frameCount"],
           atFrameInWindow = frames })
  end
end
local function onEndFrame()
  frames = frames + 1
  if frames == ${FLUSH_AT} then
    local wc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.writeCount)
    local rc = emu.getAccessCounters(emu.memType.nesInternalRam, emu.counterType.readCount)
    -- TWO INDEPENDENT COUNTS of the same window, so loss is measurable
    emit({ kind = "totals", callbackWrites = writes, callbackReads = reads,
           counterWrites = wc[${address}], counterReads = rc[${address}],
           pcSampled = pcSampled, readsSampled = readsSampled,
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
  reads:events.filter(e=>e.kind==='read'),
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
 /* The DISTINCT instructions that read this field, resolved through
    disassembly. A set of reader sites is a different quantity from a read
    count, and it is the candidate discriminator where counts coincide. */
 const readerSitesOf=regime=>{
  const seen=new Map();
  for(const e of perRegime[regime].reads){
   const accessing=resolve(e.nextInstructionPc);
   if(!accessing)continue;
   if(!seen.has(accessing.address))
    seen.set(accessing.address,{address:accessing.address,
     addressHex:accessing.addressHex,text:accessing.text,length:accessing.length,
     isAlsoAWriterSite:writerPcs.includes(accessing.address)});
  }
  return [...seen.values()].sort((a,b)=>a.address-b.address);
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
  readerSites:{neutral:readerSitesOf('neutral'),
   continuousHold:readerSitesOf('continuousHold'),pulseTrain:readerSitesOf('pulseTrain')},
  elapsedMs:Object.fromEntries(Object.keys(perRegime).map(r2=>[r2,perRegime[r2].elapsedMs])),
  luaErrors:Object.fromEntries(Object.keys(perRegime).map(r2=>[r2,perRegime[r2].luaErrors]))});
}

/* ---- does the trace discriminate resource / latch / time-driven? ----

   The class is read out of the TRACE first. The declared expectation is
   compared afterwards, so the classification cannot borrow the answer.

   THE TOLERANCE IS NOT ARBITRARY, and the first version of this file got it
   wrong. It required the train and neutral write counts to differ by at most
   ONE, which is meaningless for a field written ~74 times in a window: pureTime
   came back 74 neutral against 72 under the train and was misclassified as
   action-driven. The bound is now RELATIVE and grounded in a quantity measured
   earlier in this programme: holding a button costs the game loop about 6 per
   cent of its iterations (161 per frame neutral against 151 held, measured on
   this fixture family in S11B-R), so a purely time-driven field's count moves by
   a few per cent between regimes. The bound is 25 per cent - four times that
   drift - and it is a property of the fixture's loop, not a value chosen
   because it makes a control pass. */
const NEUTRAL_DRIFT_TOLERANCE=0.25;
const PER_EDGE_RATIO=3;
const discrimination=traceRows.map(row=>{
 const control=controls.find(c=>c.name===row.control);
 const neutral=row.writesObserved.neutral||0;
 const hold=row.writesObserved.continuousHold||0;
 const train=row.writesObserved.pulseTrain||0;
 let observedClass='UNDETERMINED';
 if(neutral===0&&hold===0&&train===0)observedClass='NEVER_WRITTEN_IN_WINDOW';
 else if(neutral>0){
  const ratio=train/neutral;
  observedClass=Math.abs(ratio-1)<=NEUTRAL_DRIFT_TOLERANCE
   ?'WRITTEN_REGARDLESS_OF_ACTION':'WRITTEN_BY_TIME_AND_ACTION';
 }else{
  observedClass=train>=PER_EDGE_RATIO*Math.max(hold,1)
   ?'WRITTEN_PER_ACTION_EDGE':'WRITTEN_ONLY_UNDER_ACTION';
 }
 const reads=row.readsObserved||{};
 return {control:row.control,
  observedClass,expectedClass:control.expectedClass,
  expectationBasis:control.because,
  agrees:observedClass===control.expectedClass,
  writes:{neutral,continuousHold:hold,pulseTrain:train},
  trainOverNeutral:neutral>0?Number((train/neutral).toFixed(2)):null,
  trainOverHold:hold>0?Number((train/hold).toFixed(2)):null,
  reads:{neutral:reads.neutral,continuousHold:reads.continuousHold,
   pulseTrain:reads.pulseTrain},
  note:'the class is read from the trace; the declared expectation is compared afterwards'};
});
/* The S11A question, asked again at the CPU level: a one-unit resource and a
   one-shot latch are both written exactly once under action. Does anything in
   the trace separate them? Read counts are reported because they are the
   obvious candidate - and NOT promoted: a field read by HUD code, animation or
   a timer produces reads too, so a read count is a lead, never a cost. */
const latchVersusResource=(()=>{
 const unit=traceRows.find(r=>r.control==='singleUnit');
 const latch=traceRows.find(r=>r.control==='oneShotSwitch');
 if(!unit||!latch)return null;
 const sameWriteSignature=JSON.stringify(unit.writesObserved)===JSON.stringify(latch.writesObserved);
 const siteSet=row=>[...new Set(Object.values(row.readerSites).flat()
  .map(s=>s.addressHex))].sort();
 const unitSites=siteSet(unit),latchSites=siteSet(latch);
 return {question:'does the trace separate a genuine one-unit resource from a latch?',
  singleUnit:{writes:unit.writesObserved,reads:unit.readsObserved,
   distinctReaderSites:unitSites,readerSiteDetail:unit.readerSites},
  oneShotSwitch:{writes:latch.writesObserved,reads:latch.readsObserved,
   distinctReaderSites:latchSites,readerSiteDetail:latch.readerSites},
  writeSignaturesIdentical:sameWriteSignature,
  readCountsDiffer:JSON.stringify(unit.readsObserved)!==JSON.stringify(latch.readsObserved),
  /* the quantity read counts cannot express */
  readerSiteCounts:{singleUnit:unitSites.length,oneShotSwitch:latchSites.length},
  readerSiteCountsDiffer:unitSites.length!==latchSites.length,
  verdict:sameWriteSignature
   ?'NOT SEPARATED BY WRITE BEHAVIOUR. Both are written once under action and no '
    +'number of further edges changes that, which is the S11A limitation reappearing at '
    +'the CPU level rather than a new one.'
   :'the write signatures differ, which would be a new discrimination and needs '
    +'explaining before it is believed',
  readsAreNotEvidence:'a difference in read counts or reader sites is a LEAD about '
   +'consumers, not evidence of a game cost. It is never promoted to '
   +'GAME_COST_EVIDENCED: HUD code, animation and timers read fields too.'};
})();

/* ---- review item 1: the cost of each observation mode ----

   MEASURED IN CPU TIME, and the first version of this file could not see the
   cost at all. Every run is paced at about 17 ms per frame (~59 fps) and
   --no-max-speed makes no difference, although AgentCli.cpp sets
   EmulationFlags::MaximumSpeed by default. So wall clock is a PACING FLOOR: a
   58 MB instruction trace appeared to cost exactly as much as no observation,
   ratio 1.00. CPU time shows the work the floor was hiding. */
const overhead=(()=>{
 const address=dual.oracle.fields.cadenceOnly.address;
 const button=M.buttonOf(dual.oracle.dualMask);
 const inputs=M.schedules.train(button,20,4,8,20);
 const state=bootStates.get(dual.nes);
 /* --timeout is raised explicitly. The first run of this series passed
    --lua-timeout 60 with the DEFAULT --timeout of 30, and the instrument
    rejected the invocation outright: {"event":"error","kind":"usage",
    "message":"Lua timeout cannot exceed the overall timeout"}, exit 2. The mode
    reported null, which must not be read as "too expensive to measure" - it
    never ran. The README does state the constraint; I did not honour it. */
 const base=[dual.nes,'--load-state',state,'--frames',String(FRAMES),
  '--timeout','300',...inputs.flatMap(i=>['--input',i])];
 /* a Lua script that observes but never stops the run, so every mode covers
    the SAME window; the earlier cost rows were not comparable because one
    script called emu.stop() at frame 100 */
 const costScript=(tag,pcSamples,everyAccess,fromAddr,toAddr)=>{
  const lo=fromAddr===undefined?address:fromAddr;
  const hi=toAddr===undefined?address:toAddr;
  const out=path.join(inst.work,'cost-'+tag+'.jsonl');
  const body=M.luaPreamble(out)+`
local writes, reads, sampled = 0, 0, 0
local frames = 0
local function onWrite(address, value)
  writes = writes + 1
  ${everyAccess
   ?'local st = emu.getState()   -- UNBOUNDED, to measure the warning'
   :'if sampled < '+pcSamples+' then sampled = sampled + 1; local st = emu.getState() end'}
end
local function onRead(address, value)
  reads = reads + 1
  ${everyAccess?'local st = emu.getState()   -- UNBOUNDED':''}
end
local function onEndFrame()
  frames = frames + 1
  if frames == ${FLUSH_AT} then
    emit({ kind = "totals", writes = writes, reads = reads, sampled = sampled }); flush()
  end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, ${lo}, ${hi}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addMemoryCallback(onRead,  emu.callbackType.read,  ${lo}, ${hi}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
  return M.luaFile(inst.work,'cost-'+tag+'.lua',body);
 };
 const traceFile=path.join(inst.work,'cost-trace.log');
 const modes=[
  {tag:'no observation at all',args:[]},
  {tag:'per-access callback, no state sample',
   args:['--lua',costScript('cheap',0,false),'--lua-allow-io','--lua-timeout','30']},
  {tag:'per-access callback, state sampled for the first '+MAX_PC_SAMPLES+' writes',
   args:['--lua',costScript('bounded',MAX_PC_SAMPLES,false),'--lua-allow-io','--lua-timeout','30']},
  {tag:'per-access callback, state sampled on EVERY access',
   args:['--lua',costScript('every',0,true),'--lua-allow-io','--lua-timeout','120']},
  {tag:'full CPU instruction trace',args:['--trace',traceFile]},
  /* THE RANGE EXPANSION the review asked for. Everything above watches ONE
     sparse byte - 12 writes and 20 reads in a whole window - so it cannot
     exercise a warning about calling emu.getState() per access. These two
     watch the ENTIRE zero page, which this fixture's main loop touches on
     every iteration, roughly 161 iterations per frame. */
  {tag:'callback over the whole zero page (0x00-0xFF), no state sample',
   args:['--lua',costScript('wide-cheap',0,false,0,255),'--lua-allow-io',
    '--lua-timeout','120']},
  {tag:'callback over the whole zero page (0x00-0xFF), state sampled on EVERY access',
   args:['--lua',costScript('wide-every',0,true,0,255),'--lua-allow-io',
    '--lua-timeout','120']}];
 const measured=modes.map(m=>{
  const t=inst.runTimed([...base,...m.args],{timeoutMs:900000});
  return {mode:m.tag,wallSeconds:t.realSeconds,
   userSeconds:t.userSeconds,sysSeconds:t.sysSeconds,cpuSeconds:t.cpuSeconds,
   measured:t.cpuSeconds!==null,
   note:t.cpuSeconds===null?'NOT MEASURED: the invocation did not report timing. '
    +'A null here means the run did not happen, never that it was too slow to time.':null};
 });
 const baseline=measured[0];
 const withRatios=measured.map(m=>({...m,
  cpuTimesBaseline:m.cpuSeconds&&baseline.cpuSeconds
   ?Number((m.cpuSeconds/baseline.cpuSeconds).toFixed(2)):null,
  wallTimesBaseline:m.wallSeconds&&baseline.wallSeconds
   ?Number((m.wallSeconds/baseline.wallSeconds).toFixed(2)):null}));
 const traceBytes=fs.existsSync(traceFile)?fs.statSync(traceFile).size:0;
 /* how many events each scope actually saw, so a cost has a denominator */
 const volumeOf=tag=>{
  const file=path.join(inst.work,'cost-'+tag+'.jsonl');
  if(!fs.existsSync(file))return null;
  const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean)
   .map(l=>{try{return JSON.parse(l);}catch(_){return null;}}).filter(Boolean);
  const totals=lines.find(x=>x.kind==='totals');
  return totals?{writes:totals.writes,reads:totals.reads}:null;
 };
 return {frames:FRAMES,modes:withRatios,
  eventVolume:{singleByteScope:volumeOf('cheap'),
   wholeZeroPageScope:volumeOf('wide-cheap'),
   note:'the single-byte scope sees a handful of events per window and the '
    +'zero-page scope sees them on every loop iteration. A per-access cost is '
    +'meaningless without this denominator, and the single-byte rows do NOT '
    +'establish that unbounded state sampling is affordable.'},
  traceBytes,traceBytesPerFrame:traceBytes?Math.round(traceBytes/FRAMES):null,
  pacingFloor:{observedMsPerFrame:baseline.wallSeconds
    ?Number(((baseline.wallSeconds*1000)/FRAMES).toFixed(2)):null,
   impliedFramesPerSecond:baseline.wallSeconds
    ?Number((FRAMES/baseline.wallSeconds).toFixed(1)):null,
   note:'every mode sits on this floor, so WALL CLOCK RATIOS ARE NOT A COST '
    +'MEASUREMENT here. --no-max-speed changed nothing when measured directly '
    +'(6776 ms against 6787 ms over 400 frames), although AgentCli.cpp line 699 '
    +'sets EmulationFlags::MaximumSpeed by default. Reported as an instrument '
    +'property, not worked around.'},
  throughputConsequence:'at this floor a 2.5 million frame campaign - the size of the '
   +'S11B corpus - would take roughly 12 hours of wall clock against 47 minutes in '
   +'jsnes. That bounds what stage B can ask of this instrument and belongs in B5.'};
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
 latchVersusResource,
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
  expected:d.expectedClass,agrees:d.agrees,writes:d.writes,
  trainOverNeutral:d.trainOverNeutral})),
 latchVersusResource:latchVersusResource?{
  writeSignaturesIdentical:latchVersusResource.writeSignaturesIdentical,
  readCountsDiffer:latchVersusResource.readCountsDiffer,
  verdict:latchVersusResource.verdict.slice(0,120)}:null,
 overhead:{pacingFloor:overhead.pacingFloor.observedMsPerFrame+' ms/frame, '
   +overhead.pacingFloor.impliedFramesPerSecond+' fps',
  traceBytes:overhead.traceBytes,
  modes:overhead.modes.map(m=>({mode:m.mode,cpuSeconds:m.cpuSeconds,
   cpuTimesBaseline:m.cpuTimesBaseline,wallTimesBaseline:m.wallTimesBaseline}))},
 cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
