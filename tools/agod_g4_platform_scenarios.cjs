'use strict';
// G4: does the platform-independent pipeline actually DISCOVER a goal on each
// console, and does it REFUSE when there is nothing to discover?
//
// Per platform, two cartridges built by this repository's own generators:
//
//   POSITIVE  a resource one action depletes to a floor, an accumulator
//             another action raises, a reset arm that restores the resource and
//             destroys the gain, a second accumulator so "increasing" is not
//             unique to one button, and a time-driven counter no action causes.
//             The pipeline must reach VERIFIED.
//
//   NEGATIVE  the same header, the same screen setup, the same time-driven
//             counter, and no input handling at all. The pipeline must refuse.
//             Without this the positive result means nothing: a procedure that
//             verifies everything verifies nothing.
//
// THE ORACLE IS READ ONLY AFTER THE PIPELINE HAS COMMITTED ITS ANSWER, and only
// by this checker. It is written to a separate file by each generator, the
// analyser never imports it, and the comparison below happens strictly after
// FlyAgodPipeline.run has returned.
//
// A core that is not in this checkout is reported BLOCKED with the reason, not
// skipped and not substituted. lab/gb/ and lab/snes/ are gitignored, so that is
// the normal state of a fresh clone; tools/build_retro.py builds them.
//
// NO COMMERCIAL ROM IS USED OR EMITTED. Every cartridge here is generated.
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js',
 'agod-evidence.js','agod-candidates.js','agod-consumers.js',
 'agod-platform-driver.js','agod-pipeline.js'])require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'g4-'));
const out=[],fail=[],blocked=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const block=(p,why)=>{out.push('  BLOCK '+p+': '+why);blocked.push(p+': '+why);};

/* each platform: the generator, and how to build a core for it */
const PLATFORMS=[
 {platform:'nes',generator:'make_agod_test_rom.py',negativeArgs:null,
  // the NES fixture family predates G4 and has no "quiet" variant; its
  // negative control is the adversarial sacrifice cartridge, which has a
  // resource that must NOT be read as a cost. Asserted separately below.
  build:bytes=>PD.createNesSync({romBytes:bytes,jsnes,frameBudget:600000})},
 {platform:'sega',generator:'make_agod_sega_rom.py',negativeArgs:['--negative'],
  build:async bytes=>{
   let factory,SegaConsole;
   try{factory=require(path.join(A,'sega','genplus.js'));
    SegaConsole=require(path.join(A,'sega-core.js'));}
   catch(e){return {status:'CORE_UNAVAILABLE',reason:e.message};}
   return PD.create({platform:'sega',romBytes:bytes,SegaConsole,factory,
    moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:600000});}},
 {platform:'gb',generator:'make_agod_gb_rom.py',negativeArgs:['--negative'],
  build:async bytes=>retro('gb',bytes)},
 {platform:'snes',generator:'make_agod_snes_rom.py',negativeArgs:['--negative'],
  build:async bytes=>retro('snes',bytes)}];

function retro(platform,bytes){
 let factory;
 try{factory=require(path.join(A,platform,'core.js'));}
 catch(e){return {status:'CORE_UNAVAILABLE',
  reason:'lab/'+platform+'/core.js is absent (gitignored; build it with '
   +'tools/build_retro.py)'};}
 return PD.create({platform,romBytes:bytes,
  RetroConsole:require(path.join(A,'retro-core.js')),factory,
  moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,platform,'core.wasm')),
   locateFile:f=>path.join(A,platform,f)},frameBudget:600000});
}

/* TWO ORACLE SCHEMAS, ONE SET OF ASSERTIONS.
   The NES fixture family predates G4: it records fields as {address,...} with
   negativeMask / resetMask at the top level, while the three G4 generators use
   {offset,...} with costAction / resetAction. Read generically, the NES oracle
   yields nothing and its offset checks SKIP - which is how the
   best-established platform ended up the least checked in the first run of
   this harness. Both schemas are normalised here so every platform faces the
   same questions. */
function oracleView(oracle){
 const fields=oracle.fields||{};
 const offsetOf=field=>Number.isInteger(field&&field.offset)?field.offset
  :(Number.isInteger(field&&field.address)?field.address:null);
 if(oracle.resource!==undefined){
  const resource=oracle.resource?fields[oracle.resource]:null;
  return {schema:'g4',resourceName:oracle.resource,
   resourceOffset:resource?offsetOf(resource):null,
   costMask:oracle.costAction?oracle.costAction.mask:null,
   resetMask:oracle.resetAction?oracle.resetAction.mask:null,
   notPositive:(oracle.notPositive||[]).map(name=>({name,offset:offsetOf(fields[name])}))};
 }
 /* the NES schema */
 return {schema:'nes',resourceName:'lives',
  resourceOffset:offsetOf(fields.lives),
  costMask:Number.isInteger(oracle.negativeMask)?oracle.negativeMask:null,
  resetMask:Number.isInteger(oracle.resetMask)?oracle.resetMask:null,
  notPositive:Object.keys(fields).filter(name=>name!=='lives')
   .map(name=>({name,offset:offsetOf(fields[name])}))};
}

function cartridge(generator,tag,extra){
 const rom=path.join(work,tag+'.json'),oracle=path.join(work,tag+'-oracle.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,'--oracle-out',oracle,
  ...(extra||[])]);
 return {bytes:Buffer.from(JSON.parse(fs.readFileSync(rom)).base64,'base64'),
  oracle:JSON.parse(fs.readFileSync(oracle))};
}

async function runOn(entry,tag,extra){
 const {bytes,oracle}=cartridge(entry.generator,entry.platform+'-'+tag,extra);
 const built=await entry.build(bytes);
 if(built.status!=='READY')return {built,oracle,result:null};
 /* boot the cartridge before the research run, exactly as the app does */
 for(let i=0;i<120;i++)built.core.frame();
 const started=Date.now();
 const result=Pipeline.run(built.driver,
  {romHash:'g4-'+entry.platform+'-'+tag,coreRevision:entry.platform,
   profileRevision:'agod-g4',typeEvents:30});
 return {built,oracle,result,ms:Date.now()-started,frames:built.framesRun()};
}

(async()=>{
 for(const entry of PLATFORMS){
  const p=entry.platform;
  console.log('\n=== %s ===',p.toUpperCase());

  /* ---- POSITIVE ---- */
  const positive=await runOn(entry,'positive',p==='nes'?['--seed','0']:[]);
  if(positive.built.status!=='READY'){
   block(p,'no core: '+(positive.built.reason||positive.built.status));
   continue;
  }
  const r=positive.result;
  console.log('  positive: status=%s stage=%s  frames=%d  wall=%s s',
   r.status,r.stage||'-',positive.frames,(positive.ms/1000).toFixed(1));
  ok(r.status==='VERIFIED',
   p+' positive cartridge reaches VERIFIED (got '+r.status
    +(r.reason?': '+r.reason:'')+')');
  if(r.status==='VERIFIED'){
   ok(!!(r.goal&&r.goal.id&&r.actions),p+' VERIFIED carries a goal identity and actions');
   ok(r.goal.polarity==='NEGATIVE',
    p+' the verified polarity is NEGATIVE, got '+r.goal.polarity);
   /* ---- the oracle is opened HERE, after the answer ---- */
   const o=oracleView(positive.oracle);
   const found=r.discovered&&r.discovered.resource?r.discovered.resource:null;
   ok(o.resourceOffset!==null&&o.costMask!==null&&o.resetMask!==null,
    p+' the oracle states a resource offset, a cost mask and a reset mask ('
     +o.schema+' schema): '+JSON.stringify([o.resourceOffset,o.costMask,o.resetMask]));
   if(ok(!!found,p+' reports the resource it discovered')&&o.resourceOffset!==null){
    const cost=r.actions&&(r.actions.cost!==undefined?r.actions.cost:r.actions.costMask);
    console.log('    discovered offset %d (oracle %s at %d)  step %s  cost mask %s'
     +' (oracle %s)',found.address,o.resourceName,o.resourceOffset,found.step,
     cost,o.costMask);
    ok(found.address===o.resourceOffset,
     p+' found the resource at the oracle offset '+o.resourceOffset+', got '+found.address);
    ok(found.direction==='decreasing'&&found.step<0,
     p+' the resource decreases, step '+found.step);
    ok(cost===o.costMask,
     p+' named the oracle cost action mask '+o.costMask+', got '+cost);
   }
   const reverse=r.trace.filter(t=>t.stage==='reverse').pop();
   if(ok(!!reverse,p+' exercised the reversal arm')&&o.resetMask!==null){
    ok(reverse.mask===o.resetMask,
     p+' the reversal arm is the oracle reset action '+o.resetMask
      +', got '+reverse.mask);
    ok(reverse.retained===false,
     p+' the gain does NOT survive the reversal, which is what separates '
      +'depletion from a sacrifice');
   }
   /* every field the oracle marks as not a reward must not be the goal */
   for(const {name,offset} of o.notPositive){
    if(!found||offset===null||name===o.resourceName)continue;
    ok(found.address!==offset,
     p+' did not mistake '+name+' (offset '+offset+') for the resource');
   }
  }
  positive.built.dispose();

  /* ---- NEGATIVE ---- */
  if(entry.negativeArgs){
   const negative=await runOn(entry,'negative',entry.negativeArgs);
   if(negative.built.status!=='READY'){block(p,'negative control could not build a core');continue;}
   const n=negative.result;
   console.log('  negative: status=%s stage=%s  frames=%d  wall=%s s  reason=%s',
    n.status,n.stage||'-',negative.frames,(negative.ms/1000).toFixed(1),
    (n.reason||'').slice(0,70));
   ok(n.status==='REFUSED',
    p+' negative control is REFUSED, not VERIFIED (got '+n.status+')');
   ok(n.goal===null&&n.actions===null,
    p+' a refusal carries no goal and no actions');
   negative.built.dispose();
  }else{
   /* NES: the adversarial sacrifice cartridge is the standing control - a
      resource whose loss BUYS a retained gain, which must not be read as a
      cost. It is a harder negative than an inert cartridge. */
   const sac=cartridge('make_agod_sacrifice_rom.py',p+'-sacrifice',[]);
   const built=PD.createNesSync({romBytes:sac.bytes,jsnes,frameBudget:600000});
   for(let i=0;i<120;i++)built.core.frame();
   const n=Pipeline.run(built.driver,{romHash:'g4-nes-sacrifice',
    coreRevision:'nes',profileRevision:'agod-g4',typeEvents:30});
   console.log('  negative (sacrifice): status=%s stage=%s reason=%s',
    n.status,n.stage||'-',(n.reason||'').slice(0,70));
   ok(n.status==='REFUSED',
    'nes sacrifice cartridge is REFUSED: a gain-buying loss is not a cost (got '
     +n.status+')');
   built.dispose();
  }
 }

 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d assertions, %d blocked platform(s)%s',
  fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length-blocked.length,
  out.length-blocked.length,blocked.length,
  blocked.length?': '+blocked.join('; '):'');
 if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);
  process.exitCode=1;}
})().catch(e=>{console.log('FAILED '+e.message+'\n'+e.stack);process.exitCode=1;});
