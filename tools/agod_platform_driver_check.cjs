'use strict';
// G2: one platform-independent driver contract over the cores GU bundles.
//
// What this asserts, per platform, against the REAL core:
//   the pipeline surface (restore / run / readRam / snapshot / stateHash);
//   an independent core instance built from the ROM bytes;
//   exact snapshot and restore;
//   frames that change the observed state, and a button that does not;
//   the observed RAM width ASKED FROM THE CORE rather than assumed;
//   the declared button count per platform;
//   a frame budget enforced inside the arms;
//   dispose, after which the driver refuses;
//   and a capability surface that reports what a core cannot do.
//
// Two cores are present in this checkout and two are not: lab/gb and lab/snes
// are listed in .gitignore and hold no build, so those adapters must report
// CORE_UNAVAILABLE naming the missing factory. The test asserts that status
// rather than skipping, because a silently absent platform is how a gap
// becomes a false claim.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
const PD=require(path.join(A,'agod-platform-driver.js'));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'g2-'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok   ':'  FAIL ')+m);if(!c)fail.push(m);return c;};

console.log('=== describe() for all four, before building anything ===');
for(const p of PD.SUPPORTED){
 const d=PD.describe(p);
 console.log('  %s  core=%s buttons=%s ram=%s write=%s snapshot=%s',
  p.padEnd(5),String(d.coreName).padEnd(17),
  String(d.actionSpec.buttonCount).padEnd(3),
  String(d.observedRamBytesDefault),String(d.memoryWrite).padEnd(5),d.snapshotFormat);
}
ok(PD.describe('nes').actionSpec.buttonCount===8,'NES declares 8 buttons');
ok(PD.describe('sega').actionSpec.buttonCount===12,'Sega declares 12 buttons');
ok(PD.describe('snes').actionSpec.buttonCount===12,'SNES declares 12 buttons');
ok(PD.describe('gb').actionSpec.buttonCount===8,'GB declares 8 buttons');
ok(PD.describe('sega').observedRamBytesDefault===65536,'Sega declares a 64 KiB window');
ok(PD.describe('nes').memoryWrite===true&&PD.describe('sega').memoryWrite===false
 &&PD.describe('gb').memoryWrite===false&&PD.describe('snes').memoryWrite===false,
 'memory write is claimed for NES only');
ok(PD.describe('gameboyadvance').supported===false,'an unknown platform is not supported');

(async()=>{
 console.log('\n=== NES, real jsnes core ===');
 const romJson=path.join(work,'r.json');
 execFileSync('python3',['tools/make_agod_test_rom.py','--seed','0','--out',romJson]);
 const bytes=Buffer.from(JSON.parse(fs.readFileSync(romJson)).base64,'base64');
 const nes=await PD.create({platform:'nes',romBytes:bytes,jsnes,frameBudget:100000});
 ok(nes.status==='READY','NES driver is READY (got '+nes.status+' '+(nes.reason||'')+')');
 if(nes.status==='READY'){
  const d=nes.driver;
  ok(['restore','run','readRam','snapshot','stateHash'].every(k=>typeof d[k]==='function'),
   'the pipeline contract is complete');
  ok(typeof d.poke==='function','NES exposes poke');
  ok(nes.capabilities.supports.memoryWrite===true,'NES reports memoryWrite true');
  ok(nes.capabilities.observedRamBytes===2048,'NES observed RAM is 2048');
  ok(d.readRam().length===2048,'readRam returns 2048 bytes');
  const s=d.snapshot(),h0=d.stateHash();
  d.run(8,60);const h1=d.stateHash();d.restore(s);
  ok(h0===d.stateHash()&&h0!==h1,'snapshot/restore is exact and frames change state');
  ok(nes.capabilities.memoryRegions[0].writable===true,'the NES region is writable');
  nes.dispose();
  let refused=false;try{d.readRam();}catch(_){refused=true;}
  ok(refused,'a disposed NES driver refuses');
 }

 console.log('\n=== Sega, real Genesis Plus GX core ===');
 let factory=null;
 try{factory=require(path.join(A,'sega','genplus.js'));}catch(e){
  console.log('  (genplus.js require failed: '+e.message.slice(0,80)+')');}
 const SegaConsole=require(path.join(A,'sega-core.js'));
 ok(!!SegaConsole&&typeof SegaConsole.create==='function','SegaConsole wrapper loads');
 ok(typeof factory==='function','GenPlusFactory is callable from this checkout');
 /* a Mega Drive core needs a Mega Drive cartridge: the first version of this
    probe fed it the NES fixture and got a correct rejection */
 const segaRom=Buffer.from(JSON.parse(fs.readFileSync(path.join(A,'demo-sega.json'))).base64,'base64');
 const sega=await PD.create({platform:'sega',romBytes:segaRom,
  SegaConsole,factory,moduleOptions:{locateFile:f=>path.join(A,'sega',f)},
  frameBudget:100000});
 console.log('  sega status:',sega.status,sega.reason||'',JSON.stringify(sega.missing||''));
 ok(sega.status==='READY','Sega driver is READY (got '+sega.status+' '+(sega.reason||'')+')');
 if(sega.status==='READY'){
  const sd=sega.driver;
  ok(['restore','run','readRam','snapshot','stateHash'].every(k=>typeof sd[k]==='function'),
   'the pipeline contract is complete on Sega');
  ok(sega.capabilities.supports.memoryWrite===false,'Sega reports NO memory write');
  ok(typeof sd.poke!=='function','Sega exposes no poke');
  ok(sega.capabilities.observedRamBytes===65536,'Sega observed RAM is 65536');
  ok(sd.readRam().length===65536,'Sega readRam returns 65536 bytes');
  ok(sega.capabilities.memoryRegions[0].writable===false,'the Sega region is not writable');
  const ss=sd.snapshot(),sh0=sd.stateHash();
  ok(ss&&typeof ss==='object'&&ss.kind==='sega','the Sega snapshot is a state object');
  /* THE BUTTON MATTERS, and the first version of this probe got it wrong.
     It pressed mask 1 (A) and asserted the observed state would change. This
     diagnostic cartridge only writes work RAM for Left and Right, so nothing
     moved and I briefly concluded _lab_read_ram was broken. It is not: the
     counter at $FF0001 tracks exactly - 10 Right pulses of 4 frames give 40,
     4 Left pulses take it to 24, Right held 180 frames gives 204. Right is
     button index 7 on this platform, so mask 128. */
  const RIGHT=1<<7;
  sd.run(RIGHT,60);const sh1=sd.stateHash();
  const movedByte=Array.from(sd.readRam()).findIndex(v=>v!==0);
  sd.restore(ss);
  ok(sh0===sd.stateHash(),'Sega snapshot/restore is exact');
  ok(sh0!==sh1,'Sega frames under Right change the observed state');
  ok(movedByte===1,'the moving byte is at work-RAM offset 1 ($FF0001), observed at '+movedByte);
  /* and the button this cartridge ignores must NOT move it - the control that
     would have caught my mistake immediately */
  sd.restore(ss);sd.run(1,60);
  ok(sd.stateHash()===sh0,'a button this cartridge ignores (A) moves nothing');
  /* counted AFTER a run that does move it. The first version counted after a
     restore, so RAM was back to zero and the assertion passed without
     measuring anything - a check that passes without exercising the thing. */
  sd.restore(ss);sd.run(RIGHT,60);
  const nonzero=Array.from(sd.readRam()).filter(v=>v!==0).length;
  ok(nonzero>=1&&nonzero<=4,
   'this cartridge writes '+nonzero+' byte(s) of its 64 KiB window under Right');
  ok(sd.readRam().length===65536&&sega.framesRun()>=60,'Sega metered '+sega.framesRun()+' frames');
  let segaBudget=false;
  const small=await PD.create({platform:'sega',romBytes:segaRom,SegaConsole,factory,
   moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:20});
  if(small.status==='READY'){try{small.driver.run(0,50);}catch(e){segaBudget=/FRAME_BUDGET_EXCEEDED/.test(e.message);}
   small.dispose();}
  ok(segaBudget,'the frame budget is enforced on Sega too');
  sega.dispose();
 }

 console.log('\n=== GB and SNES: the cores are not in this checkout ===');
 for(const p of ['gb','snes']){
  const r=await PD.create({platform:p,romBytes:bytes,
   RetroConsole:require(path.join(A,'retro-core.js'))});
  console.log('  %s -> %s | %s | missing: %s',p,r.status,r.reason,r.missing||'');
  ok(r.status==='CORE_UNAVAILABLE','%s reports CORE_UNAVAILABLE'.replace('%s',p));
  ok(r.driver===null,p+' produced no driver');
  ok(/gitignore/.test(r.repositoryNote||''),p+' names the repository reason');
 }

 console.log('\n'+out.join('\n'));
 console.log('\n'+(fail.length?'FAIL ('+fail.length+')':'PASS')+' — '
  +(out.length-fail.length)+'/'+out.length);
 if(fail.length)process.exitCode=1;
})();
