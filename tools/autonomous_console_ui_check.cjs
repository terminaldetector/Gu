'use strict';
// Real NES + actual production page. Native neural backend is deliberately absent.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');
let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{
  const f=path.join(assets,new URL(r.request().url()).pathname.slice(1));
  return r.fulfill(fs.existsSync(f)?{contentType:f.endsWith('.js')?'application/javascript':f.endsWith('.css')?'text/css':f.endsWith('.json')?'application/json':'text/html',body:fs.readFileSync(f)}:{status:404,body:''});
 });
 const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
 demo.sha256=crypto.createHash('sha256').update(Buffer.from(demo.base64,'base64')).digest('hex');demo.name='NES diagnostic';
 await page.exposeFunction('fixtureDemo',()=>page.evaluate(d=>labLoadRom(d),demo));
 await page.addInitScript(()=>{window.FlyBridge={demo:()=>window.fixtureDemo(),acceptRom(){},orientation(){},stop(){},resume(){}};});
 await page.goto('https://flyconsole.local/lab/index.html');await page.waitForFunction(()=>loaded&&!romLoading);
 assert.equal(await page.evaluate(()=>ready),false,'console does not require a graph');
 const before=await page.evaluate(async()=>{window.labPause();learner.weights[0][0]=123;$('fdbJson').value='retained learned layer';const s=await labGameStates.save('quick');return {frame:s.frame,ram:Array.from(nes.cpu.mem),preview:s.preview};});
 assert(before.preview?.startsWith('data:image/jpeg;base64,'));
 await page.evaluate(()=>{nes.buttonDown(1,7);for(let i=0;i<30;i++)nes.frame();nes.buttonUp(1,7);learner.weights[0][0]=456;});
 await page.evaluate(()=>labGameStates.load('quick'));
 assert.deepEqual(await page.evaluate(()=>Array.from(nes.cpu.mem)),before.ram);
 assert.equal(await page.evaluate(()=>learner.weights[0][0]),456,'game restore preserves learned weights');
 assert.equal(await page.inputValue('#fdbJson'),'retained learned layer');
 await page.evaluate(()=>{playing=true;labError({message:'fixture neural failure'});});
 assert.equal(await page.evaluate(()=>playing),true);
 assert.equal(await page.evaluate(()=>labAgentStatus().failure.message),'fixture neural failure');
 await page.evaluate(()=>labQuickMenu());assert(await page.locator('#quickMenu').isVisible());
 assert((await page.textContent('#quickSaveStatus')).includes('fixture neural failure'));
 await page.click('#quickSave');await page.waitForFunction(()=>$('quickSaveStatus').textContent.includes('Быстрый снимок игры сохранён'));
 await page.click('#quickLoad');await page.waitForFunction(()=>$('quickSaveStatus').textContent.includes('Игра восстановлена'));
 // A real NES snapshot is ~1.3 MiB: the advertised catalogue must fit more
 // than localStorage's small origin quota, including previous generations.
 const populated=await page.evaluate(async()=>{
  for(const slot of FlySaveStates.slots)if(slot!=='quick'){
   await labGameStates.save(slot,{automatic:true});
   await labGameStates.save(slot,{automatic:true});
  }
  return (await labGameStates.list()).filter(s=>!s.error).length;
 });assert.equal(populated,8,'all advertised slots retain real snapshots and recovery');
 const transactions=await page.evaluate(async()=>{
  const S=FlySaveStates,c={system:'nes',hash:'c'.repeat(64),core:'transaction-fixture'},snapshot={...c,frame:1,state:{ram:[1]}};
  const old=new S.Store(localStorage),legacy=await old.save(c,'quick',snapshot),k=S.key(c,'quick'),legacyRaw=localStorage.getItem(k);
  const storage=new S.IndexedStorage(localStorage),one=new S.Store(storage),two=new S.Store(new S.IndexedStorage(localStorage));
  const migrated=await one.save(c,'quick',{...snapshot,frame:2},{expectedRevision:legacy.revision});
  const primary=await storage.getItem(k),backup=await storage.getItem(k+':recovery');
  // Force a real IndexedDB transaction abort after its backup put was queued.
  const put=IDBObjectStore.prototype.put;let rejected=false;
  try{
   IDBObjectStore.prototype.put=function(value,key){if(key===k)throw new DOMException('fixture quota','QuotaExceededError');return put.apply(this,arguments);};
   await one.save(c,'quick',{...snapshot,frame:3},{expectedRevision:migrated.revision});
  }catch(e){rejected=e.name==='QuotaExceededError';}finally{IDBObjectStore.prototype.put=put;}
  const rollback=rejected&&await storage.getItem(k)===primary&&await storage.getItem(k+':recovery')===backup;
  const races=await Promise.allSettled([one.save(c,'quick',{...snapshot,frame:4},{expectedRevision:migrated.revision}),two.save(c,'quick',{...snapshot,frame:5},{expectedRevision:migrated.revision})]);
  const actual=await storage.getItem(k);await storage.commit(k,actual,'corrupted',null);
  const recovered=await two.read(c,'quick');
  return {legacyPreserved:localStorage.getItem(k)===legacyRaw,rollback,winners:races.filter(r=>r.status==='fulfilled').length,recovered:recovered.recovered,recoveryFrame:recovered.frame};
 });
 assert.deepEqual(transactions,{legacyPreserved:true,rollback:true,winners:1,recovered:true,recoveryFrame:2});
 await page.reload();await page.waitForFunction(()=>loaded&&!romLoading);
 await page.waitForFunction(()=>$('gameStateSlot').textContent.includes(new Date().getFullYear().toString()));
 assert((await page.locator('#gameStateSlot').textContent()).includes(new Date().getFullYear().toString()),'dated catalogue survives reload');
 await page.evaluate(()=>labGameStates.load('quick'));
 assert.equal(await page.evaluate(()=>frame),before.frame);
 // Exercise the production Current handshake with a deliberately delayed native ACK.
 // The bridge is a protocol fixture; this does not claim native learning in Chromium.
 await page.evaluate(async()=>{
  window.fixtureSamples=[];window.fixtureBind=null;
  FlyBridge.configure=raw=>{const q=JSON.parse(raw);labConfigured({generation:q.generation,reset:q.reset,mode:q.mode,backend:q.backend,configVersion:1});};
  FlyBridge.sample=raw=>fixtureSamples.push(JSON.parse(raw));
  FlyBridge.fdbFeedback=raw=>{const q=JSON.parse(raw);if(q.op==='bind')window.fixtureBind=q;else labFdbFeedback({token:q.token,data:null});};
  labReady({kind:'Current protocol fixture',neurons:32,edges:64,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:8},(_,i)=>String(i+17)),backend:'cpu'});
  await labState.settle();$('autosavePolicy').checked=false;$('layerAutosave').checked=false;
  connectBrain();sampleFrame(performance.now(),true);
 });
 await page.waitForFunction(()=>fixtureBind!==null);
 const binding=await page.evaluate(()=>({samples:fixtureSamples.length,id:fixtureBind.layerId,record:JSON.parse(localStorage.getItem('fly-layer-set-'+fixtureBind.layerId)),marker:localStorage.getItem('fly-resume-v1-'+labPlatform+'-'+romHash+'-'+graphIdentity.sha256)}));
 assert.equal(binding.samples,0,'no inference before durable bind ACK');assert.equal(binding.record.id,binding.id);assert.equal(binding.marker,binding.id);
 await page.evaluate(()=>{const q=fixtureBind;labFdbFeedback({token:q.token,data:{bound:true,layerId:q.layerId,configVersion:q.configVersion}});});
 await page.waitForFunction(()=>{sampleFrame(performance.now(),true);return fixtureSamples.length>0;});
 assert.equal(await page.evaluate(()=>fixtureSamples[0].layerId),binding.id,'first sample uses the acknowledged durable Current');
 assert.deepEqual(errors,[]);
 console.log('PASS: real NES without graph, eight IndexedDB slots/preview, migration/atomic rollback/concurrent CAS/recovery, independent weights, neural fault/manual continuity, async quick menu and durable Current before first sample');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();});
