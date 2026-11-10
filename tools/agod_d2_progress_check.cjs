'use strict';
// D2: is the progress target found on EVERY console, and is it absent where
// the game has nothing to take away?
//
// Per platform, on the real core: the G4 positive cartridge must yield a
// profile whose progress field is the oracle's accumulator and nothing else -
// in particular not the second accumulator, which an action raises but the
// reversal arm does not destroy - and the G4 negative cartridge must yield no
// profile at all. The oracle is opened only after the profile exists.
// A core that is not built is BLOCKED, not skipped.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js','agod-evidence.js',
 'agod-candidates.js','agod-consumers.js','agod-platform-driver.js','agod-pipeline.js',
 'agod-goal-dto.js','agod-objective.js'])require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline,Dto=globalThis.FlyAgodGoalDto,
 Objective=globalThis.FlyAgodObjective;
const MODULES={Dto,Reward:globalThis.FlyAgodReward,Evidence:globalThis.FlyAgodEvidence,Ram:globalThis.FlyAgodRam};
const work=fs.mkdtempSync(path.join(os.tmpdir(),'d2-'));
const out=[],fail=[],blocked=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
function retro(platform,bytes){
 let factory;try{factory=require(path.join(A,platform,'core.js'));}
 catch(e){return {status:'CORE_UNAVAILABLE',reason:'lab/'+platform+'/core.js is absent'};}
 return PD.create({platform,romBytes:bytes,RetroConsole:require(path.join(A,'retro-core.js')),factory,
  moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,platform,'core.wasm')),locateFile:f=>path.join(A,platform,f)},frameBudget:600000});
}
const BUILD={
 nes:bytes=>PD.createNesSync({romBytes:bytes,jsnes,frameBudget:600000}),
 sega:async bytes=>{let factory;try{factory=require(path.join(A,'sega','genplus.js'));}
  catch(e){return {status:'CORE_UNAVAILABLE',reason:e.message};}
  return PD.create({platform:'sega',romBytes:bytes,SegaConsole:require(path.join(A,'sega-core.js')),factory,
   moduleOptions:{locateFile:f=>path.join(A,'sega',f)},frameBudget:600000});},
 gb:bytes=>retro('gb',bytes),snes:bytes=>retro('snes',bytes)};
const GEN={nes:['make_agod_test_rom.py',['--seed','0'],null],sega:['make_agod_sega_rom.py',[],['--negative']],
 gb:['make_agod_gb_rom.py',[],['--negative']],snes:['make_agod_snes_rom.py',[],['--negative']]};
function cart(generator,tag,extra){
 const rom=path.join(work,tag+'.json'),oracle=path.join(work,tag+'-o.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,'--oracle-out',oracle,...extra]);
 return {bytes:Buffer.from(JSON.parse(fs.readFileSync(rom)).base64,'base64'),oracle:JSON.parse(fs.readFileSync(oracle))};
}
async function profileOf(platform,bytes){
 const built=await BUILD[platform](bytes);
 if(built.status!=='READY')return {blocked:built.reason||built.status};
 for(let i=0;i<120;i++)built.core.frame();
 /* the state the live intervals below start from: after boot, BEFORE the
    pipeline has driven the cartridge to its floor and back */
 const booted=built.driver.snapshot();
 const romSha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const config={romHash:romSha256,coreRevision:platform,profileRevision:'agod-d2',typeEvents:30};
 const result=Pipeline.run(built.driver,config);
 const dto=Dto.fromPipelineResult(result,{...config,contextKey:romSha256+'/'+platform,platform,driverRevision:built.driverRevision});
 const identity={romSha256,platform,coreRevision:platform,detectorRevision:Pipeline.PIPELINE_REVISION,
  actionSpec:built.capabilities.actionSpec,padType:built.capabilities.padType,observedRamBytes:built.capabilities.observedRamBytes};
 const profile=Objective.createProfile(dto,identity,MODULES);
 /* one live interval through the adapter on this very core */
 let packets=null;
 if(profile.status==='PROFILE'&&profile.progress.length){
  const live=Objective.createLiveReward(profile,MODULES,{identity,sessionId:'d2',policy:'aggressive'});
  const d=built.driver;d.restore(booted);d.run(0,30);
  const step=(mask,endFrame)=>{const before=d.readRam();d.run(mask,4);d.run(0,8);
   return live.observe({ramBefore:before,ramAfter:d.readRam(),endFrame,requestedMask:mask,
    executed:{mask,frames:12,complete:true,manualOverride:false},phase:'PLAYING'});};
  packets={gain:step(profile.progress[0].mask,12),idle:step(0,24),loss:step(profile.actions.cost,36)};
 }
 built.dispose();
 return {status:result.status,profile,packets};
}
(async()=>{
 for(const platform of ['nes','sega','gb','snes']){
  const [generator,args,negativeArgs]=GEN[platform];
  const positive=cart(generator,platform+'-pos',args);
  const found=await profileOf(platform,positive.bytes);
  if(found.blocked){out.push('  BLOCK '+platform+': '+found.blocked);blocked.push(platform);continue;}
  const o=positive.oracle,F=o.fields;
  const offset=f=>Number.isInteger(f.offset)?f.offset:f.address;
  /* a multi-byte accumulator is typed at the byte that moves: the Sega score
     is a big-endian word at 4..5 and its low byte is 5. The oracle span, not
     its first byte, is what a progress field has to fall inside. */
  const score=offset(F.score),scoreEnd=score+(F.score.width||1),decoys=Object.keys(F).filter(n=>n!=='score'&&n!=='lives').map(n=>({n,a:offset(F[n])}));
  const progress=found.profile.status==='PROFILE'?found.profile.progress.map(f=>f.address):null;
  console.log('%s: pipeline=%s profile=%s progress=%j  oracle accumulator@%d',platform.toUpperCase(),found.status,
   found.profile.status,progress,score);
  if(!ok(found.profile.status==='PROFILE',platform+': a profile exists'))continue;
  ok(progress.length===1&&progress[0]>=score&&progress[0]<scoreEnd,platform+': the one progress field lies in the oracle accumulator ['+score+','+scoreEnd+'), got '+JSON.stringify(progress));
  for(const d of decoys)ok(progress.indexOf(d.a)<0,platform+': '+d.n+' ('+d.a+') is not progress');
  if(ok(!!found.packets,platform+': the live adapter ran on this core')){
   const p=found.packets;
   console.log('     gain=%s %s (%s) | idle=%s | loss=%s %s (%s)',p.gain.status,p.gain.value,p.gain.reason,p.idle.status,p.loss.status,p.loss.value,p.loss.reason);
   ok(p.gain.status==='PROVISIONAL'&&p.gain.value>0&&p.gain.value<1,platform+': a gain pays PROVISIONAL below a verified loss');
   ok(p.idle.status==='UNKNOWN'&&!('value' in p.idle),platform+': an idle interval is UNKNOWN with no value');
   ok(p.loss.status==='VERIFIED'&&p.loss.value===-1,platform+': a loss pays VERIFIED -1');
  }
  if(negativeArgs){
   const negative=cart(generator,platform+'-neg',negativeArgs);
   const none=await profileOf(platform,negative.bytes);
   console.log('     negative cartridge: pipeline=%s profile=%s',none.status,none.profile&&none.profile.status);
   ok(none.profile.status==='REFUSED',platform+': the dead cartridge yields no profile and so no reward of either tier');
  }
 }
 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d assertions, %d blocked platform(s)',fail.length?'FAIL ('+fail.length+')':'PASS',
  out.length-fail.length-blocked.length,out.length-blocked.length,blocked.length);
 if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);process.exitCode=1;}
})().catch(e=>{console.log('FAILED '+e.message+'\n'+e.stack);process.exitCode=1;});
