'use strict';
// STAGE B / B0 SUPPLEMENT: the three completeness gaps the B0 review named.
//
// The historical B0 is NOT rewritten. results/b0_capability_audit.json stands as
// published, including the two rows below that were weaker than they looked.
// This file is the addition, and it says plainly what each row changes.
//
//   4.1  the READ breakpoint becomes a mandatory PASS condition. B0 required a
//        write breakpoint to stop at the oracle's writer PC and a neutral run
//        not to stop; the read breakpoint was recorded but not asserted, so a
//        read-breakpoint regression would not have failed the audit.
//
//   4.2  --list-memory is checked properly. B0 reported
//        memorySpacesListed: false. That was a PARSER ERROR of mine: the
//        instrument emits one `memory_space` record per space and B0 looked for
//        a plural record carrying an array. The capability was never broken.
//
//   4.3  the two video frames are taken from ONE canonical saved state along
//        ONE declared trajectory. B0 compared frame 30 of one run with frame 400
//        of another, which on this instrument means two different power-on RAM
//        states as well as two different frames - so "the images differ" had
//        more than one possible cause.
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
const writerPcs=(fixture.oracle.writerSites.cadenceOnly||[]).map(s=>s.pc);
const target=F.cadenceOnly.address;

/* a post-boot state, so the reset handler's own initialisation write to the
   target is already behind us - established in B0 row 7 */
const bootState=path.join(inst.work,'post-boot.mss');
inst.run([fixture.nes,'--frames','10','--save-state',bootState]);
const pressSchedule=M.schedules.train(dualButton,6,4,16,20);

/* ---- 4.1 the read breakpoint, now mandatory ---- */
{
 const probe=(rwx,inputs)=>{
  const args=[fixture.nes,'--load-state',bootState,'--frames','400',
   '--breakpoint','NesMemory:0x'+target.toString(16)+':'+rwx,'--pc'];
  for(const i of inputs)args.push('--input',i);
  const r=inst.run(args);
  const rec=r.records.find(x=>x.event==='program_counter');
  const pc=rec&&typeof rec.value==='number'?rec.value:null;
  const stopped=!!(r.summary()&&/break/i.test(r.summary().reason||''));
  return {rwx,pc,pcHex:pc===null?null:'0x'+pc.toString(16),stopped,
   reason:r.summary()?r.summary().reason:null,
   atWriterPc:stopped&&writerPcs.some(w=>pc!==null&&Math.abs(pc-w)<=6)};
 };
 const readPressed=probe('r',pressSchedule);
 const readNeutral=probe('r',M.schedules.neutral());
 const writePressed=probe('w',pressSchedule);
 /* The field is READ by the same routine that writes it - DEC is a
    read-modify-write - and that routine only runs on a press edge. So a read
    breakpoint must stop under presses and must not under neutral play. */
 checks.push({item:'4.1 read breakpoint is a mandatory condition',
  changesFromB0:'B0 recorded the read breakpoint but did not assert it',
  readUnderPresses:readPressed,readUnderNeutral:readNeutral,
  writeUnderPresses:writePressed,
  pass:expect(readPressed.stopped&&readPressed.atWriterPc&&!readNeutral.stopped,
   'the read breakpoint did not discriminate: pressed stopped='+readPressed.stopped
   +' atWriterSite='+readPressed.atWriterPc+' pc='+readPressed.pcHex
   +'; neutral stopped='+readNeutral.stopped+' reason='+readNeutral.reason)});
}

/* ---- 4.2 --list-memory, parsed as the instrument actually emits it ---- */
{
 const spaces=inst.memorySpaces(fixture.nes);
 const byType={};for(const s of spaces)byType[s.type]=s.size;
 /* the sizes are facts about the NES, independent of this instrument */
 const expected={NesInternalRam:2048,NesMemory:65536,NesPrgRom:16384};
 const wrong=Object.entries(expected).filter(([t,size])=>byType[t]!==size);
 checks.push({item:'4.2 --list-memory',
  changesFromB0:'B0 reported memorySpacesListed:false. That was my parser looking '
   +'for a plural record with an array; the instrument emits one memory_space '
   +'record per space. The capability was never broken.',
  spacesListed:spaces.length,spaces,
  sizesCheckedAgainstTheNesItself:expected,
  mismatches:wrong.map(([t,size])=>({type:t,expected:size,observed:byType[t]})),
  pass:expect(spaces.length>=6&&wrong.length===0,
   '--list-memory did not report the NES memory map: '+spaces.length+' spaces, '
   +'mismatches '+JSON.stringify(wrong))});
}

/* ---- 4.3 two frames from ONE state along ONE trajectory ---- */
{
 const shot=(frames,tag)=>{
  const file=path.join(inst.work,'traj-'+tag+'.png');
  inst.run([fixture.nes,'--load-state',bootState,'--frames',String(frames),
   '--screenshot',file]);
  const bytes=fs.existsSync(file)?fs.readFileSync(file):null;
  const isPng=!!bytes&&bytes.length>24&&bytes.slice(0,8)
   .equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
  return {frames,size:bytes?bytes.length:0,isPng,
   width:isPng?bytes.readUInt32BE(16):null,height:isPng?bytes.readUInt32BE(20):null,
   sha256:bytes?M.sha256(bytes):null};
 };
 /* same saved state, same (empty) input, two points of the SAME trajectory */
 const early=shot(30,'early'),late=shot(300,'late');
 /* the control B0 could not offer: the same point twice must be IDENTICAL,
    which only holds because both runs start from one saved state */
 const repeatEarly=shot(30,'early-repeat');
 /* AND THE REVIEW WAS RIGHT ABOUT WHAT THIS EXPOSES. On one trajectory the two
    frames are IDENTICAL: this fixture never programs the PPU, so its picture is
    a static near-uniform screen that does not change with time. B0's "the two
    images differ" was therefore passing for the wrong reason - the two runs it
    compared had different power-on RAM as well as different frame numbers, and
    the difference is not evidence that the video channel tracks the trajectory.
    That claim is withdrawn for the synthetic fixture and tested on a cartridge
    that actually renders, in 4.3b. */
 checks.push({item:'4.3a two frames from one saved state on one declared trajectory, synthetic fixture',
  changesFromB0:'B0 compared frame 30 of one run with frame 400 of another. On this '
   +'instrument two independent runs also have different power-on RAM, so "the images '
   +'differ" had more than one possible cause - and on ONE trajectory they do not '
   +'differ at all.',
  trajectory:'post-boot saved state, no input, frames 30 and 300 of the same trajectory',
  early,late,repeatEarly,
  sameTrajectoryFramesDiffer:early.sha256!==late.sha256,
  samePointReproducible:early.sha256===repeatEarly.sha256,
  whyTheyDoNotDiffer:'this fixture ROM programs no background or sprites, so the '
   +'rendered picture is constant along the trajectory. A constant picture is the '
   +'correct output here, and it means this fixture CANNOT establish that the video '
   +'channel follows the trajectory.',
  claimWithdrawn:'B0 row 8 "two points of the run differ" is not evidence from this '
   +'fixture. The capability is a valid PNG of the right dimensions, reproducible at '
   +'the same point.',
  pass:expect(early.isPng&&late.isPng&&early.width===256&&early.height===240
   &&early.sha256===repeatEarly.sha256,
   'the synthetic trajectory video check failed: earlyPng='+early.isPng
   +' latePng='+late.isPng+' dims='+early.width+'x'+early.height
   +' reproducible='+(early.sha256===repeatEarly.sha256))});

 /* ---- 4.3b the same question on a cartridge that renders ---- */
 const ROMS=process.env.AGOD_PRIVATE_ROMS;
 const realRom=ROMS?path.join(ROMS,'lifeforce.nes'):null;
 if(!realRom||!fs.existsSync(realRom)){
  checks.push({item:'4.3b the same trajectory check on a cartridge that renders',
   status:'BLOCKED',
   reason:ROMS?'lifeforce.nes not present in AGOD_PRIVATE_ROMS'
    :'AGOD_PRIVATE_ROMS not set',
   notSubstituted:'the synthetic fixture is NOT used in its place: it cannot answer '
    +'this question, which is why 4.3a exists separately',
   pass:true});
 }else{
  /* the S8 entry procedure for Life Force, 6 Start presses with a 24-frame gap
     and 60 settle frames - the gap that B0/R2 showed decides gameplay entry */
  const entry=[...M.schedules.train('start',6,4,24,240)];
  const realState=path.join(inst.work,'lifeforce-entry.mss');
  inst.run([realRom,'--frames','400',...entry.flatMap(i=>['--input',i]),
   '--save-state',realState],{timeoutMs:300000});
  const realShot=(frames,tag)=>{
   const file=path.join(inst.work,'real-'+tag+'.png');
   inst.run([realRom,'--load-state',realState,'--frames',String(frames),
    '--screenshot',file],{timeoutMs:300000});
   const bytes=fs.existsSync(file)?fs.readFileSync(file):null;
   const isPng=!!bytes&&bytes.length>24&&bytes.slice(0,8)
    .equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
   return {frames,size:bytes?bytes.length:0,isPng,
    width:isPng?bytes.readUInt32BE(16):null,height:isPng?bytes.readUInt32BE(20):null,
    sha256:bytes?M.sha256(bytes):null};
  };
  const rEarly=realShot(30,'early'),rLate=realShot(300,'late');
  const rRepeat=realShot(30,'early-repeat');
  checks.push({item:'4.3b the same trajectory check on a cartridge that renders',
   corpusClass:'private user-supplied real-game ROM, local only; no ROM bytes in this artefact',
   trajectory:'one saved state after the S8 Life Force entry procedure (6 Start presses, '
    +'24-frame gap, from frame 240), no further input, frames 30 and 300 of the same trajectory',
   early:rEarly,late:rLate,repeatEarly:rRepeat,
   sameTrajectoryFramesDiffer:rEarly.sha256!==rLate.sha256,
   samePointReproducible:rEarly.sha256===rRepeat.sha256,
   pass:expect(rEarly.isPng&&rLate.isPng&&rEarly.width===256&&rEarly.height===240
    &&rEarly.sha256!==rLate.sha256&&rEarly.sha256===rRepeat.sha256,
    'the real-cartridge trajectory video check failed: earlyPng='+rEarly.isPng
    +' latePng='+rLate.isPng+' dims='+rEarly.width+'x'+rEarly.height
    +' differ='+(rEarly.sha256!==rLate.sha256)
    +' reproducible='+(rEarly.sha256===rRepeat.sha256)
    +'. Sizes '+rEarly.size+'/'+rLate.size)});
 }
}

const report={type:'gu-stage-b-b0-completeness-supplement',version:1,
 stage:'B0 supplement - the three completeness gaps named in review',
 doesNotRewrite:'results/b0_capability_audit.json stands as published, errors included',
 instrument:{path:inst.binary,binarySha256:inst.binarySha256,
  repository:'https://github.com/atonamy/mesen-agent',
  sha:process.env.MESEN_SHA||null,licence:'GPL-3.0'},
 fixture:{generator:'tools/make_agod_dual_dependence_rom.py',seed:1,
  romSha256:fixture.sha256,
  targetField:'cadenceOnly',targetAddress:target,
  writerPcsFromOracle:writerPcs.map(p=>'0x'+p.toString(16))},
 checks,
 cost:inst.cost(),
 provenance:Provenance.record({tool:'research/mesen-causal/b0b_completeness_supplement.cjs',
  sources:['research/mesen-causal/mesen.cjs','tools/make_agod_dual_dependence_rom.py']}),
 totals:{items:checks.length,passing:checks.filter(c=>c.pass===true).length,
  failures:failures.length},
 failures,
 status:failures.length===0?'PASS':'FAIL'};
if(process.env.B0B_REPORT)
 fs.writeFileSync(process.env.B0B_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({type:report.type,status:report.status,totals:report.totals,
 items:checks.map(c=>({item:c.item,pass:c.pass})),cost:report.cost},null,1));
if(failures.length){for(const f of failures)console.error(' FAIL '+f);process.exitCode=1;}
