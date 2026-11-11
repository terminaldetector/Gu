'use strict';
// AGOD IN THE APP ON EVERY PLATFORM, in a real browser worker.
//
// The phone reported "AGOD остановлен с ошибкой · the SegaConsole wrapper is not
// available (фаза driver)": the discovery worker only ever loaded the NES core.
// Node checks never saw it, because in Node every core is require()d into one
// process. This check runs the REAL page in Chromium, per platform:
//
//   index.html?system=<p>, the platform's own AGOD fixture loaded the way a
//   person loads a ROM, «Запустить AGOD» pressed, and then:
//     - the worker started the run on THIS platform's core, from a snapshot of
//       the live game (so the per-platform snapshot path is exercised);
//     - the pipeline returned VERIFIED and the live objective adopted it, with
//       the resource and the progress field the oracle names - opened only
//       after the result;
//     - on the page's own live core, through the functions lab.js calls on
//       every decision, the cost action pays VERIFIED -1 and the gain action
//       pays PROVISIONAL;
//     - the platform's dead cartridge leaves the game with NO objective.
// No commercial ROM. A core missing from this checkout is BLOCKED, not skipped.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),
 {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');
const work=fs.mkdtempSync(path.join(os.tmpdir(),'agod-worker-'));
const out=[],fail=[],blocked=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const PLATFORMS=[
 {platform:'nes',generator:'make_agod_test_rom.py',args:['--seed','0','--backdrop','0x30'],negative:null,core:null},
 {platform:'sega',generator:'make_agod_sega_rom.py',args:[],negative:['--negative'],core:'lab/sega/genplus.wasm'},
 {platform:'gb',generator:'make_agod_gb_rom.py',args:[],negative:['--negative'],core:'lab/gb/core.wasm'},
 {platform:'snes',generator:'make_agod_snes_rom.py',args:[],negative:['--negative'],core:'lab/snes/core.wasm'}];
function cart(generator,tag,extra){
 const rom=path.join(work,tag+'.json'),oracle=path.join(work,tag+'-o.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,'--oracle-out',oracle,...extra]);
 return {base64:JSON.parse(fs.readFileSync(rom)).base64,oracle:JSON.parse(fs.readFileSync(oracle))};
}
(async()=>{
 const browser=await chromium.launch({headless:true,
  executablePath:process.env.CHROMIUM_EXECUTABLE||'/opt/pw-browsers/chromium',args:['--no-sandbox']});
 const pageErrors=[];
 async function open(platform){
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  page.on('pageerror',error=>pageErrors.push(platform+': '+error.message));
  await page.route('https://flyconsole.local/**',async route=>{
   const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type=file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json'
    :file.endsWith('.wasm')?'application/wasm':file.endsWith('.css')?'text/css':'text/html';
   return route.fulfill({status:200,contentType:type,body:fs.readFileSync(file)});
  });
  await page.goto('https://flyconsole.local/lab/index.html?system='+platform);
  await page.waitForFunction(()=>typeof window.labLoadRom==='function',null,{timeout:60000});
  return page;
 }
 async function run(page,c,label){
  const sha=crypto.createHash('sha256').update(Buffer.from(c.base64,'base64')).digest('hex');
  await page.evaluate(data=>window.labLoadRom(data),{base64:c.base64,name:label,sha256:sha});
  await page.waitForFunction(()=>loaded===true,null,{timeout:120000});
  /* let the live game run a little, as a player would, before discovery */
  await page.evaluate(()=>{for(let i=0;i<120;i++){nes.frame();frame++;}});
  await page.evaluate(()=>{
   window.consoleNavigation.go('legacy-learning');
   const section=document.getElementById('trainingResearch');if(section&&!section.open)section.open=true;
   window.__agodEvents=[];
   const original=window.FlyAgodExperimental.runInWorker;
   window.FlyAgodExperimental.runInWorker=request=>original({...request,
    onEvent(message){window.__agodEvents.push(message);if(typeof request.onEvent==='function')request.onEvent(message);}});
  });
  await page.waitForSelector('#agodRunButton',{state:'visible',timeout:30000});
  const t0=Date.now();
  await page.click('#agodRunButton');
  await page.waitForFunction(()=>window.__agodEvents.some(e=>e.type==='result'||e.type==='error'),null,{timeout:900000});
  const events=await page.evaluate(()=>window.__agodEvents.map(e=>({type:e.type,phase:e.phase||null,
   platform:e.platform||null,coreName:e.coreName||null,startedFrom:e.startedFrom||null,
   ram:e.capabilities?e.capabilities.observedRamBytes:null,
   buttons:e.capabilities&&e.capabilities.actionSpec?e.capabilities.actionSpec.availableButtonCount:null,
   error:e.error?e.error.message:null,status:e.dto?e.dto.status:null,stage:e.dto?e.dto.stage:null,
   reason:e.dto?e.dto.reason:null})));
  return {events,ms:Date.now()-t0,status:await page.evaluate(()=>document.getElementById('agodRunStatus').textContent),
   objective:await page.evaluate(()=>window.agodObjective.status())};
 }
 try{
  for(const entry of PLATFORMS){
   const p=entry.platform;
   if(entry.core&&!fs.existsSync(path.join(assets,entry.core))){
    out.push('  BLOCK '+p+': '+entry.core+' is not built in this checkout');blocked.push(p);continue;}
   const positive=cart(entry.generator,p+'-pos',entry.args);
   const page=await open(p);
   const r=await run(page,positive,'AGOD '+p+' fixture (MIT, generated locally)');
   const started=r.events.find(e=>e.type==='started')||{};
   const result=r.events.find(e=>e.type==='result')||{};
   const error=r.events.find(e=>e.type==='error');
   console.log('%s: started core=%s ram=%s buttons=%s from=%s | result=%s %s | %ss | status: %s',
    p.toUpperCase(),started.coreName,started.ram,started.buttons,(started.startedFrom||'').slice(0,40),
    result.status||'-',error?('ERROR '+error.phase+': '+error.error):(result.reason||''),(r.ms/1000).toFixed(1),r.status);
   ok(!error,p+': the worker ran without an error'+(error?' ('+error.phase+': '+error.error+')':''));
   ok(started.platform===p,p+': the run started on this platform, got '+started.platform);
   ok(/snapshot of the live game/.test(started.startedFrom||''),p+': it started from a snapshot of the live game, not from its own boot');
   ok(result.status==='VERIFIED',p+': the pipeline returned VERIFIED in the worker, got '+result.status+' '+(result.reason||''));
   ok(r.objective.state==='VERIFIED',p+': the live objective adopted the result: '+r.objective.state+' '+(r.objective.reason||''));
   ok(/Подтверждено/.test(r.status),p+': the status line says Подтверждено: '+r.status);
   /* ---- the oracle, now ---- */
   const F=positive.oracle.fields,off=f=>Number.isInteger(f.offset)?f.offset:f.address;
   ok(r.objective.resourceAddress===off(F.lives),p+': the resource is the oracle lives at '+off(F.lives)+', got '+r.objective.resourceAddress);
   ok(r.objective.policy==='aggressive'&&r.objective.progressFields===1,p+': aggressive policy with one progress field: '
    +r.objective.policy+'/'+r.objective.progressFields);
   /* ---- the reward path on the page's own live core ---- */
   const masks=positive.oracle.costAction?{cost:positive.oracle.costAction.mask,gain:positive.oracle.gainAction.mask}
    :{cost:positive.oracle.negativeMask,gain:positive.oracle.positiveMask};
   const paid=await page.evaluate(m=>{
    const count=labPlatform==='sega'||labPlatform==='snes'?12:8;
    const press=mask=>{for(let b=0;b<count;b++)(mask&(1<<b)?nes.buttonDown:nes.buttonUp).call(nes,1,b);
     for(let i=0;i<4;i++)nes.frame();for(let b=0;b<count;b++)nes.buttonUp(1,b);for(let i=0;i<8;i++)nes.frame();};
    const snap=()=>fdbRewardSnapshot(sampleRewardMemory());
    const interval=mask=>{const rewardStart=snap();press(mask);frame+=12;return {rewardStart,rewardEnd:snap(),mask,frames:12,valid:true};};
    for(let i=0;i<30;i++){nes.frame();frame++;}
    const gain=fdbOutcomeReward(interval(m.gain),0);
    const idle=fdbOutcomeReward(interval(0),0);
    const loss=fdbOutcomeReward(interval(m.cost),0);
    return {gain,idle,loss};
   },masks);
   console.log('     live core: gain %j | idle %j | loss %j',paid.gain,paid.idle,paid.loss);
   ok(paid.gain.valid&&paid.gain.tier==='PROVISIONAL'&&paid.gain.reward>0&&paid.gain.reward<1,p+': the gain action pays PROVISIONAL on the live core');
   ok(!paid.idle.valid,p+': an idle interval pays nothing');
   ok(paid.loss.valid&&paid.loss.tier==='VERIFIED'&&paid.loss.reward===-1,p+': the cost action pays VERIFIED -1 on the live core');
   await page.close();
   if(entry.negative){
    const dead=cart(entry.generator,p+'-neg',entry.negative);
    const page2=await open(p);
    const n=await run(page2,dead,'AGOD '+p+' dead fixture (MIT)');
    const nerr=n.events.find(e=>e.type==='error'),nres=n.events.find(e=>e.type==='result')||{};
    console.log('     dead cartridge: result=%s %s | objective %s',nres.status,nerr?('ERROR '+nerr.error):'',n.objective.state);
    ok(!nerr&&nres.status==='REFUSED',p+': the dead cartridge runs and is REFUSED, got '+(nres.status||(nerr&&nerr.error)));
    ok(n.objective.state!=='VERIFIED',p+': and the game gets no objective');
    await page2.close();
   }
  }
  ok(pageErrors.length===0,'no page errors: '+pageErrors.slice(0,3).join(' | '));
 }finally{await browser.close();}
 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d assertions, %d blocked platform(s)',fail.length?'FAIL ('+fail.length+')':'PASS',
  out.length-fail.length-blocked.length,out.length-blocked.length,blocked.length);
 if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);process.exitCode=1;}
})().catch(e=>{console.log('FAILED '+e.message+'\n'+e.stack);process.exitCode=1;});
