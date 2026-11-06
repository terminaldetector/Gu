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
/* describe() has no core, so these are DECLARATIONS. What a pad can actually
   press is asserted against the built core further down, because on Sega the
   two differ. */
ok(PD.describe('nes').actionSpec.buttonCount===8,'NES declares 8 buttons');
ok(PD.describe('sega').actionSpec.buttonCount===12,
 'Sega declares 12 buttons (a declaration, not an availability claim)');
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
  /* THE PAD, MEASURED. FlyPlatforms declares twelve Sega buttons; the pad the
     core is configured for after loadROM() is a THREE-button one, on which
     X/Y/Z/Mode do not exist on the wire - and SegaConsole.buttonDown accepts
     index 11 there without complaint, so nothing downstream would have noticed.
     The action set must follow the pad, not the declaration. */
  const sc=sega.capabilities,ss2=sc.actionSpec;
  console.log('  pad: reported=%s requested=%s  available=%d of declared=%d  set=%j',
   sc.padType,sc.padTypeRequested,ss2.availableButtonCount,ss2.declaredButtonCount,
   ss2.singleButtonMasks);
  ok(sc.padType===3,'the pad the core reports after loadROM is 3-button, got '+sc.padType);
  ok(ss2.declaredButtonCount===12&&ss2.availableButtonCount===8,
   'the Sega spec states 12 declared and 8 available, got '
   +ss2.declaredButtonCount+'/'+ss2.availableButtonCount);
  ok(ss2.singleButtonMasks.join(',')==='1,2,4,8,16,32,64,128',
   'the default Sega action set is the eight buttons the 3-button pad has');
  ok(sc.supports.allDeclaredButtons===false,
   'and the capability surface says not all declared buttons are reachable');
  ok(ss2.withheldButtons.map(b=>b.name).join(',')==='X,Y,Z,Mode',
   'the four withheld buttons are named: '+ss2.withheldButtons.map(b=>b.name).join(','));
  const verdict=sega.driver.actionSpec.maskAllowed(2048);
  ok(verdict.allowed===false&&/Mode/.test(verdict.reason),
   'mask 2048 is refused with a reason naming the missing button: '+verdict.reason);
  /* and asking for the six-button pad really gets it - measured, so the
     withholding above is a fact about the configuration and not a ceiling */
  const six=await PD.create({platform:'sega',romBytes:segaRom,SegaConsole,factory,
   moduleOptions:{locateFile:f=>path.join(A,'sega',f)},padType:6});
  if(ok(six.status==='READY','a 6-button Sega driver builds')){
   const s6=six.capabilities.actionSpec;
   console.log('  padType:6 -> reported=%s available=%d set=%j',
    six.capabilities.padType,s6.availableButtonCount,s6.singleButtonMasks);
   ok(six.capabilities.padType===6&&s6.availableButtonCount===12,
    'padType:6 yields a 6-button pad with all twelve buttons');
   ok(s6.singleButtonMasks.join(',')==='1,2,4,8,16,32,64,128,256,512,1024,2048',
    'and the action set is all twelve masks');
   ok(six.driver.actionSpec.maskAllowed(2048).allowed===true,
    'mask 2048 is allowed on a 6-button pad');
   ok(six.capabilities.supports.allDeclaredButtons===true,
    'and the capability surface says every declared button is reachable');
   six.dispose();
  }
  let segaBudget=false;
  const small=await PD.create({platform:'sega',romBytes:segaRom,SegaConsole,factory,
   moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:20});
  if(small.status==='READY'){try{small.driver.run(0,50);}catch(e){segaBudget=/FRAME_BUDGET_EXCEEDED/.test(e.message);}
   small.dispose();}
  ok(segaBudget,'the frame budget is enforced on Sega too');
  sega.dispose();
 }

 /* ---- GB / GBC / SNES ----
    lab/gb/ and lab/snes/ are gitignored, so whether a core is here depends on
    whether tools/build_retro.py has been run in this checkout. BOTH outcomes
    are asserted, never skipped: with a core present the adapter is exercised
    against it, and with none the adapter must say CORE_UNAVAILABLE and name
    what is missing. A silently absent platform is how a gap becomes a false
    claim, and a silently present one is how an untested platform gets called
    verified. */
 const RetroConsole=require(path.join(A,'retro-core.js'));
 for(const [p,file] of [['gb','demo-gb.json'],['gb','demo-gbc.json'],
  ['snes','demo-snes.json']]){
  let factory=null,why=null;
  try{factory=require(path.join(A,p,'core.js'));}catch(error){why=error.message;}
  if(!factory){
   console.log('\n=== %s: no core in this checkout ===',p);
   const r=await PD.create({platform:p,romBytes:bytes,RetroConsole});
   console.log('  %s -> %s | %s | missing: %s',p,r.status,r.reason,r.missing||'');
   ok(r.status==='CORE_UNAVAILABLE',p+' reports CORE_UNAVAILABLE');
   ok(r.driver===null,p+' produced no driver');
   ok(/gitignore/.test(r.repositoryNote||''),p+' names the repository reason');
   continue;
  }
  console.log('\n=== %s / %s, against the built core ===',p,file);
  const meta=JSON.parse(fs.readFileSync(path.join(A,p,'source.json')));
  console.log('  core=%s revision=%s transport=%s emscripten=%s',
   meta.core,meta.revision.slice(0,7),meta.source_transport,
   String(meta.emscripten_version).replace(/^emcc[^)]*\) /,'').slice(0,40)||meta.emscripten_version);
  ok(meta.revision.length===40&&/^[0-9a-f]+$/.test(meta.revision),
   p+' records the exact upstream revision it was built from');
  const rom=Buffer.from(JSON.parse(fs.readFileSync(path.join(A,file))).base64,'base64');
  /* the wasm bytes are handed over directly: the Emscripten loader resolves
     locateFile through fetch() under Node, which cannot take a filesystem path */
  const r=await PD.create({platform:p,romBytes:rom,RetroConsole,factory,
   moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,p,'core.wasm')),
    locateFile:f=>path.join(A,p,f)},frameBudget:100000});
  if(!ok(r.status==='READY',p+' ('+file+') driver is READY, got '+r.status+' '+(r.reason||'')))
   continue;
  const d=r.driver,c=r.capabilities,spec=c.actionSpec;
  const declaredRam=globalThis.FlyPlatforms[p].ram;
  console.log('  observedRamBytes=%d (FlyPlatforms declares %d)  buttons=%d/%d  write=%s  via=%s',
   c.observedRamBytes,declaredRam,spec.availableButtonCount,spec.declaredButtonCount,
   c.supports.memoryWrite,c.bulkReadVia);
  ok(d.readRam().length===c.observedRamBytes&&c.observedRamBytes>0,
   p+' reads '+c.observedRamBytes+' bytes, the width the core itself reports');
  ok(c.supports.memoryWrite===false&&typeof d.poke!=='function',
   p+' reports no memory write and offers no poke');
  ok(spec.availableButtonCount===(p==='snes'?12:8),
   p+' drives '+spec.availableButtonCount+' buttons');
  for(let i=0;i<60;i++)r.core.frame();
  const snap=d.snapshot(),h0=d.stateHash();
  d.run(0,90);
  d.restore(snap);
  ok(d.stateHash()===h0,p+' snapshot/restore is exact');
  d.restore(snap);d.run(0,90);
  const idle=d.stateHash();
  ok(idle!==h0,p+' 90 frames of idle advance the observed state');
  /* A SMOKE TEST, not causal evidence: the idle trajectory moves too, so
     "differs from idle" only shows the button reaches the core. Attribution is
     agod-causal.js's job and needs the neutral-trajectory control. */
  let drivable=0;
  for(const mask of spec.singleButtonMasks){
   d.restore(snap);d.run(mask,90);
   if(d.stateHash()!==idle)drivable++;
  }
  console.log('  masks whose hold differs from the idle trajectory: %d of %d'
   +' (reachability, NOT attribution)',drivable,spec.singleButtonMasks.length);
  ok(drivable>0,p+' has at least one mask the core responds to');
  let budget=false;
  const small=await PD.create({platform:p,romBytes:rom,RetroConsole,factory,
   moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,p,'core.wasm')),
    locateFile:f=>path.join(A,p,f)},frameBudget:20});
  if(small.status==='READY'){
   try{small.driver.run(0,50);}catch(e){budget=/FRAME_BUDGET_EXCEEDED/.test(e.message);}
   small.dispose();
  }
  ok(budget,'the frame budget is enforced on '+p);
  r.dispose();
  let refused=false;
  try{d.readRam();}catch(e){refused=true;}
  ok(refused,p+' refuses after dispose');
 }

 /* G3. The driver publishes its action specification and its observed width, so
    agod-pipeline.js can ask instead of assuming a NES pad and 2 KiB. The
    specification can also judge a mask, and that judgement is a FUNCTION - so
    it must be on the driver and NOT on the capabilities object, which
    agod-worker.js posts across a postMessage boundary. A function there is a
    DataCloneError that kills the whole `started` message. */
 console.log('\n=== the action specification, on the driver and in the report ===');
 {
  const nes2=PD.createNesSync({romBytes:bytes,jsnes});
  const d=nes2.driver,spec=d.actionSpec;
  console.log('  driver.actionSpec: buttons=%s maxMask=%s groups=%j',
   spec&&spec.buttonCount,spec&&spec.maxMask,
   spec&&spec.exclusiveGroups?spec.exclusiveGroups.map(g=>g.names.join('+')):null);
  ok(!!spec&&spec.buttonCount===8&&spec.maxMask===255,
   'the driver publishes the NES action specification');
  ok(d.observedRamBytes===0x800,'the driver publishes its observed RAM width');
  ok(typeof spec.maskAllowed==='function','the driver can judge a mask');
  ok(spec.maskAllowed(48).allowed===false&&spec.maskAllowed(3).allowed===true,
   'and judges opposed directions apart from two face buttons');
  let capsClone=null;
  try{structuredClone(nes2.capabilities);}catch(e){capsClone=e.constructor.name;}
  console.log('  structuredClone(capabilities): %s',capsClone||'OK');
  ok(capsClone===null,
   'capabilities survive postMessage: no function reaches the reported copy');
  ok(typeof nes2.capabilities.actionSpec.maskAllowed==='undefined'
   &&nes2.capabilities.actionSpec.combinationRuleAvailable===true,
   'the report says the combination rule exists without carrying the function');
  ok(nes2.capabilities.actionSpec.singleButtonMasks.join(',')==='1,2,4,8,16,32,64,128',
   'the reported single-button masks are the eight NES ones');
  nes2.dispose();
 }

 console.log('\n'+out.join('\n'));
 console.log('\n'+(fail.length?'FAIL ('+fail.length+')':'PASS')+' — '
  +(out.length-fail.length)+'/'+out.length);
 if(fail.length)process.exitCode=1;
})();
