'use strict';
// STAGE B / B1 prerequisites: what may an event record actually claim?
//
// Two review items, together because both decide what a B4 evidence record is
// entitled to say.
//
// ITEM 2 - PC PROVENANCE. A Lua memory callback receives (relativeAddress,
// value) and nothing else. PC, cycle and frame obtained by calling
// emu.getState() inside the callback are SAMPLES OF STATE AT CALLBACK TIME, not
// fields of the event. This file measures what that sample actually is, against
// two independent references: the writer PC the fixture generator recorded
// (which the instrument never sees) and the instrument's own disassembler
// (which gives each instruction's length).
//
// The answer, established on two addressing modes rather than asserted:
//   the sampled PC is the address of the NEXT instruction - the accessing
//   instruction's address plus ITS OWN LENGTH.
// Because that length varies by addressing mode, NO FIXED OFFSET can recover
// the accessing instruction. So the sample is recorded as nextInstructionPc and
// the accessing site comes from a breakpoint or from disassembly. It is not
// "corrected" by arithmetic.
//
// ITEM 2 also requires the callback to be purely observational: a Lua memory
// callback that RETURNS an integer overwrites the memory operation's value.
// None of the callbacks here return anything, and that is verified by running
// the same trajectory with and without the callback attached and comparing RAM.
//
// ITEM 3 - ADDRESS SEMANTICS. CPU-visible address, physical RAM address,
// mirrored address, the address the callback reports, the memory type, and the
// operation are six different things. They are measured apart, and the NES
// mirror mapping is checked rather than assumed.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),path=require('node:path');
const M=require('./mesen.cjs');
const Provenance=require('../../tools/agod_provenance.cjs');

const inst=M.instrument({});
const fixture=M.fixture(inst.work,'make_agod_dual_dependence_rom.py',1);
const F=fixture.oracle.fields;
const dualButton=M.buttonOf(fixture.oracle.dualMask);
const checks=[],failures=[];
const fail=m=>{failures.push(m);return false;};
const expect=(c,m)=>c?true:fail(m);

const target=F.cadenceOnly.address;                 /* zero page, 0x00D6 */
const oracleWriterPc=(fixture.oracle.writerSites.cadenceOnly||[])[0].pc;
const bootState=path.join(inst.work,'post-boot.mss');
inst.run([fixture.nes,'--frames','10','--save-state',bootState]);
const press=M.schedules.train(dualButton,6,4,16,20);

/* The instrument's own disassembly around the oracle's writer PC. This is the
   independent account of instruction boundaries and lengths. */
/* Two disassembly windows: around the press-driven writer site, and around the
   reset handler's initialisation write, so both instruction lengths are covered
   by an independent account of instruction boundaries. */
const aroundWriter=inst.disassemble(fixture.nes,oracleWriterPc-4,6);
const aroundReset=inst.disassemble(fixture.nes,0x8030,10);
const around=[...aroundWriter,...aroundReset];
const byAddress=new Map(around.map(d=>[d.address,d]));
const writerInstruction=byAddress.get(oracleWriterPc)||null;

/* ---- the observing script. Bounded on purpose: review item 1 warns that
   emu.getState() serialises the whole console, so it is called only for the
   first few events, and the cheap count runs for all of them. ---- */
function observeScript(outPath,addr,maxSamples){
 return M.luaPreamble(outPath)+`
local writes, reads = 0, 0
local sampledWrites, sampledReads = 0, 0
local frames = 0
local function sample(kind, address, value)
  -- emu.getState() serialises the entire console state, so it is called for a
  -- BOUNDED number of events only. The counts above are unbounded and cheap.
  local st = emu.getState()
  emit({ kind = kind, address = address, value = value,
         sampledPc = st["cpu.pc"], cycleCount = st["cpu.cycleCount"],
         frameCount = st["frameCount"],
         ppuCycle = st["ppu.cycle"], ppuScanline = st["ppu.scanline"] })
end
local function onWrite(address, value)
  writes = writes + 1
  if sampledWrites < ${maxSamples} then sampledWrites = sampledWrites + 1
    sample("write", address, value) end
  -- RETURNS NOTHING: a returned integer would overwrite the memory operation
end
local function onRead(address, value)
  reads = reads + 1
  if sampledReads < ${maxSamples} then sampledReads = sampledReads + 1
    sample("read", address, value) end
  -- RETURNS NOTHING
end
local function onEndFrame()
  frames = frames + 1
  -- Flush but DO NOT call emu.stop(): a Lua-directed stop ends the run before
  -- the CLI writes its --dump-memory artefact, which made the RAM comparison in
  -- item 2c read an empty file. The run ends on its own --frames boundary.
  if frames == 380 then
    emit({ kind = "totals", writes = writes, reads = reads,
           sampledWrites = sampledWrites, sampledReads = sampledReads })
    flush()
  end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, ${addr}, ${addr}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addMemoryCallback(onRead,  emu.callbackType.read,  ${addr}, ${addr}, emu.memType.nesMemory, emu.cpuType.nes)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
}
function observe(tag,addr,maxSamples,inputs,coldStart){
 const out=path.join(inst.work,'events-'+tag+'.jsonl');
 const script=M.luaFile(inst.work,'observe-'+tag+'.lua',observeScript(out,addr,maxSamples));
 /* A COLD start is needed to observe the reset handler's own initialisation
    write, which is a 3-byte absolute STA. From the post-boot state that write
    has already happened, so the only accesses left are the 2-byte zero-page
    ones in the press-driven routine - and a single instruction length cannot
    establish that the offset tracks the length. */
 const args=[fixture.nes,...(coldStart?[]:['--load-state',bootState]),'--frames','400',
  '--lua',script,'--lua-allow-io','--lua-timeout','30',
  '--dump-memory','NesInternalRam='+path.join(inst.work,'ram-'+tag+'.bin')];
 for(const i of inputs)args.push('--input',i);
 const r=inst.run(args,{timeoutMs:300000});
 const events=fs.existsSync(out)
  ?fs.readFileSync(out,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 const ramFile=path.join(inst.work,'ram-'+tag+'.bin');
 return {r,events,
  ramSha:fs.existsSync(ramFile)?M.sha256(fs.readFileSync(ramFile)):null,
  luaErrors:r.luaLog().filter(x=>x.event==='lua_error').length};
}

/* ---- item 2: what is the sampled PC? ---- */
{
 const observed=observe('pc',target,12,press);
 /* the same observation from a COLD start, which additionally catches the
    3-byte absolute STA in the reset handler */
 const cold=observe('pc-cold',target,12,press,true);
 const writes=[...observed.events,...cold.events].filter(e=>e.kind==='write');
 const reads=[...observed.events,...cold.events].filter(e=>e.kind==='read');
 const totals={postBoot:observed.events.find(e=>e.kind==='totals')||null,
  coldStart:cold.events.find(e=>e.kind==='totals')||null};
 /* For each sampled event, the accessing instruction is the one whose
    address + length equals the sampled PC. Looked up in the disassembly, not
    computed by subtracting a guessed constant. */
 const explain=e=>{
  const candidate=around.find(d=>d.address+d.length===e.sampledPc);
  return {kind:e.kind,address:e.address,value:e.value,
   sampledPc:e.sampledPc,sampledPcHex:'0x'+e.sampledPc.toString(16),
   frameCount:e.frameCount,cycleCount:e.cycleCount,
   accessingInstruction:candidate
    ?{address:candidate.address,addressHex:'0x'+candidate.address.toString(16),
      text:candidate.text,length:candidate.length}:null,
   offsetFromAccessingInstruction:candidate?e.sampledPc-candidate.address:null,
   isOracleWriterSite:!!candidate&&candidate.address===oracleWriterPc};
 };
 const explained=[...writes,...reads].map(explain);
 const resolved=explained.filter(e=>e.accessingInstruction);
 const offsets=[...new Set(resolved.map(e=>e.offsetFromAccessingInstruction))];
 const lengths=[...new Set(resolved.map(e=>e.accessingInstruction.length))];
 /* The decisive pair: a 2-byte zero-page access and a 3-byte absolute access.
    If the offset tracks the instruction length, a fixed correction is impossible. */
 const twoByte=resolved.find(e=>e.accessingInstruction.length===2);
 const threeByte=resolved.find(e=>e.accessingInstruction.length===3);
 checks.push({item:'2. PC provenance: what the sampled PC actually is',
  oracleWriterPc:'0x'+oracleWriterPc.toString(16),
  oracleWriterInstruction:writerInstruction
   ?{text:writerInstruction.text,bytes:writerInstruction.bytes,length:writerInstruction.length}
   :null,
  disassemblyAroundWriterSite:aroundWriter.map(d=>({address:'0x'+d.address.toString(16),
   text:d.text,bytes:d.bytes,length:d.length})),
  disassemblyAroundResetWrite:aroundReset.map(d=>({address:'0x'+d.address.toString(16),
   text:d.text,bytes:d.bytes,length:d.length})),
  sampledEvents:explained,
  totals,
  distinctOffsets:offsets,distinctInstructionLengths:lengths,
  offsetEqualsInstructionLength:resolved.length>0
   &&resolved.every(e=>e.offsetFromAccessingInstruction===e.accessingInstruction.length),
  twoByteCase:twoByte||null,threeByteCase:threeByte||null,
  establishedSemantics:'the sampled PC is the address of the NEXT instruction: the '
   +'accessing instruction address plus ITS OWN length. The offset therefore varies '
   +'with the addressing mode and NO FIXED OFFSET recovers the accessing site.',
  consequenceForB4:'the sample is recorded as nextInstructionPc. The accessing '
   +'instruction address is obtained from a breakpoint or from disassembly, never by '
   +'subtracting a constant from the sample.',
  pass:expect(resolved.length>0
   &&resolved.every(e=>e.offsetFromAccessingInstruction===e.accessingInstruction.length)
   &&!!twoByte&&!!threeByte,
   'the sampled-PC semantics are not established: resolved='+resolved.length
   +' offsets='+JSON.stringify(offsets)+' lengths='+JSON.stringify(lengths)
   +' haveTwoByteCase='+!!twoByte+' haveThreeByteCase='+!!threeByte)});

 /* the read site, required separately by the review */
 const readResolved=explained.filter(e=>e.kind==='read'&&e.accessingInstruction);
 checks.push({item:'2b. the read site is resolved too, not only the write site',
  readEvents:readResolved,
  readsAtOracleWriterSite:readResolved.filter(e=>e.isOracleWriterSite).length,
  note:'DEC is a read-modify-write, so the oracle writer instruction legitimately '
   +'produces BOTH a read and a write at the same site. A separate read arises from '
   +'the LDA that tests the field before the decrement.',
  distinctReadSites:[...new Set(readResolved.map(e=>e.accessingInstruction.addressHex))],
  pass:expect(readResolved.length>0
   &&readResolved.every(e=>e.offsetFromAccessingInstruction===e.accessingInstruction.length),
   'no read event resolved to an accessing instruction: '+readResolved.length)});

 /* the callback must be observational */
 const silent=observe('silent-control',target,0,press,false);
 const noCallback=(()=>{
  const ramFile=path.join(inst.work,'ram-nocb.bin');
  const args=[fixture.nes,'--load-state',bootState,'--frames','400',
   '--dump-memory','NesInternalRam='+ramFile];
  for(const i of press)args.push('--input',i);
  inst.run(args,{timeoutMs:300000});
  return fs.existsSync(ramFile)?M.sha256(fs.readFileSync(ramFile)):null;
 })();
 checks.push({item:'2c. the observing callback does not alter the run',
  method:'the same trajectory and input with the callback attached, with the callback '
   +'attached but sampling nothing, and with no callback at all. A Lua memory callback '
   +'that returned an integer would overwrite the memory operation value, so none of '
   +'these return anything.',
  ramSha256:{withCallbackAndSampling:observed.ramSha,
   withCallbackNoSampling:silent.ramSha,withoutCallback:noCallback},
  luaErrors:{sampling:observed.luaErrors,silent:silent.luaErrors},
  identical:observed.ramSha===noCallback&&silent.ramSha===noCallback,
  pass:expect(noCallback!==null&&observed.ramSha===noCallback&&silent.ramSha===noCallback
   &&observed.luaErrors===0,
   'attaching the observer changed the run: withSampling='+observed.ramSha
   +' silent='+silent.ramSha+' none='+noCallback+' luaErrors='+observed.luaErrors)});
}

/* ---- item 3: address semantics ---- */
{
 const spaces=inst.memorySpaces(fixture.nes);
 const internalRamSize=(spaces.find(s=>s.type==='NesInternalRam')||{}).size;
 /* The NES mirrors its 2 KiB of internal RAM four times across 0x0000-0x1FFF.
    Checked, not assumed: write through a mirror in the CPU-visible space and
    read the physical RAM back. */
 const mirrorProbe=(cpuAddress,value)=>{
  const file=path.join(inst.work,'mirror-'+cpuAddress.toString(16)+'.bin');
  inst.run([fixture.nes,'--load-state',bootState,'--frames','0',
   '--write-memory','NesMemory:0x'+cpuAddress.toString(16)+':'+value.toString(16).padStart(2,'0'),
   '--dump-memory','NesInternalRam='+file]);
  const bytes=fs.existsSync(file)?fs.readFileSync(file):null;
  return bytes?bytes[target]:null;
 };
 const marker=0x5A;
 const viaDirect=mirrorProbe(target,marker);
 const viaMirror1=mirrorProbe(target+0x0800,marker);
 const viaMirror2=mirrorProbe(target+0x1000,marker);
 const viaMirror3=mirrorProbe(target+0x1800,marker);
 const outsideMirror=mirrorProbe(target+0x2000,marker);   /* PPU registers, NOT RAM */

 /* what address does a callback registered on the PHYSICAL space report, versus
    one registered on the CPU-visible space? */
 const callbackAddressOn=memTypeName=>{
  const out=path.join(inst.work,'addr-'+memTypeName+'.jsonl');
  const body=M.luaPreamble(out)+`
local n = 0
local frames = 0
local function onWrite(address, value)
  n = n + 1
  if n <= 4 then emit({ reportedAddress = address, value = value, memType = ${JSON.stringify(memTypeName)} }) end
end
local function onEndFrame()
  frames = frames + 1
  if frames == 380 then emit({ kind = "totals", writes = n }); flush(); emu.stop(0) end
end
emu.addMemoryCallback(onWrite, emu.callbackType.write, ${target}, ${target}, emu.memType.${memTypeName}, emu.cpuType.nes)
emu.addEventCallback(onEndFrame, emu.eventType.endFrame)
`;
  const script=M.luaFile(inst.work,'addr-'+memTypeName+'.lua',body);
  const args=[fixture.nes,'--load-state',bootState,'--frames','400',
   '--lua',script,'--lua-allow-io','--lua-timeout','30'];
  for(const i of press)args.push('--input',i);
  inst.run(args,{timeoutMs:300000});
  return fs.existsSync(out)
   ?fs.readFileSync(out,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
 };
 const onCpuVisible=callbackAddressOn('nesMemory');
 const onPhysical=callbackAddressOn('nesInternalRam');

 const mirrorsAgree=[viaDirect,viaMirror1,viaMirror2,viaMirror3].every(v=>v===marker);
 checks.push({item:'3. address semantics, measured apart',
  memorySpaces:spaces,
  sixDistinctThings:{
   cpuVisibleAddress:'an address in NesMemory, the 64 KiB CPU bus: 0x'+target.toString(16),
   physicalRamAddress:'an offset into NesInternalRam, '+internalRamSize+' bytes: '+target,
   mirroredAddress:'0x'+target.toString(16)+' and its mirrors at +0x0800, +0x1000, +0x1800',
   callbackReportedAddress:'the relative address the Lua callback receives, which '
    +'depends on the memory type the callback was registered with',
   memoryType:'NesMemory and NesInternalRam are different spaces, not aliases',
   operation:'read, write and exec are separate callback types; a read-modify-write '
    +'instruction such as DEC raises BOTH a read and a write at the same site'},
  mirrorMapping:{marker:'0x'+marker.toString(16),
   writtenVia:{direct:'0x'+target.toString(16),
    mirror1:'0x'+(target+0x800).toString(16),
    mirror2:'0x'+(target+0x1000).toString(16),
    mirror3:'0x'+(target+0x1800).toString(16),
    outsideMirrorRegion:'0x'+(target+0x2000).toString(16)+' (PPU registers, not RAM)'},
   observedInPhysicalRam:{direct:viaDirect,mirror1:viaMirror1,mirror2:viaMirror2,
    mirror3:viaMirror3,outsideMirrorRegion:outsideMirror},
   mirrorsAgree,
   outsideMirrorDidNotLand:outsideMirror!==marker},
  callbackReportedAddresses:{
   registeredOnNesMemory:onCpuVisible.filter(e=>e.reportedAddress!==undefined)
    .map(e=>e.reportedAddress),
   registeredOnNesInternalRam:onPhysical.filter(e=>e.reportedAddress!==undefined)
    .map(e=>e.reportedAddress),
   totalsNesMemory:onCpuVisible.find(e=>e.kind==='totals')||null,
   totalsNesInternalRam:onPhysical.find(e=>e.kind==='totals')||null},
  /* MEASURED ASYMMETRY, and B1-B depends on it: a callback registered on the
     CPU-visible space (nesMemory) received every write to this address, while
     one registered on the PHYSICAL space (nesInternalRam) received none over the
     same trajectory. So a per-access watcher must be registered on the relative
     space; registering on the absolute space silently observes nothing, which
     would read as "the field is never written". */
  callbackMemoryTypeMatters:{
   nesMemoryWrites:(onCpuVisible.find(e=>e.kind==='totals')||{}).writes,
   nesInternalRamWrites:(onPhysical.find(e=>e.kind==='totals')||{}).writes,
   conclusion:'register per-access callbacks on nesMemory, the relative CPU-visible '
    +'space. A callback on nesInternalRam observed nothing here, and an unobserved '
    +'address is not an unwritten one.'},
  rule:'addresses are not merged without checking the mapping. A record states its '
   +'memory type and the address is read only in that space.',
  pass:expect(mirrorsAgree&&outsideMirror!==marker,
   'the mirror mapping was not confirmed: direct='+viaDirect+' mirrors='
   +[viaMirror1,viaMirror2,viaMirror3].join('/')+' outside='+outsideMirror
   +' (marker '+marker+')')});
}

const report={type:'gu-stage-b-b1-pc-and-address-semantics',version:1,
 stage:'B1 prerequisites - review items 2 and 3',
 instrument:{path:inst.binary,binarySha256:inst.binarySha256,
  repository:'https://github.com/atonamy/mesen-agent',
  sha:process.env.MESEN_SHA||null,licence:'GPL-3.0'},
 fixture:{generator:'tools/make_agod_dual_dependence_rom.py',seed:1,
  romSha256:fixture.sha256,targetField:'cadenceOnly',targetAddress:target},
 checks,cost:inst.cost(),
 provenance:Provenance.record({tool:'research/mesen-causal/b1_pc_and_address_semantics.cjs',
  sources:['research/mesen-causal/mesen.cjs','tools/make_agod_dual_dependence_rom.py']}),
 totals:{items:checks.length,passing:checks.filter(c=>c.pass===true).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.B1S_REPORT)
 fs.writeFileSync(process.env.B1S_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 items:checks.map(c=>({item:c.item,pass:c.pass})),cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
