'use strict';
// Actual IndexedDB/WebCrypto; candidate profiles remain separate from learned state.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
let browser;
(async()=>{
 const assets=path.resolve('app/src/main/assets/lab');
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://profiles.local/**',route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  const body=name?fs.readFileSync(path.join(assets,name)):'<script src="game-tools.js"></script><script src="goal-discovery.js"></script><script src="objective-profiles.js"></script>';
  return route.fulfill({contentType:name.endsWith('.js')?'application/javascript':'text/html',body});
 });
 await page.goto('https://profiles.local/');
 const first=await page.evaluate(async()=>{
  const P=FlyObjectiveProfiles,context={platform:'nes',romHash:'a'.repeat(64),coreRevision:'profile-fixture-core',mapper:{id:0,submapper:0},schema:1,detectorRevision:'agod-foundation-1',ramLayout:{base:0,length:2048,canonical:true}};
  const now=1700000000000,store=new P.Store({indexedDB,crypto,name:'agod-profile-persistence-check',now:()=>now});
  const report={type:'gu-goal-discovery-report',version:1,detectorRevision:'agod-foundation-1',context,status:'DISCOVERING',rewardStatus:'UNKNOWN',phase:{value:'unknown',confidence:null,evidence:[]},candidates:[],stats:{accepted:1}};
  const profile=P.createProfile(context,report,{now});
  const saved=await store.put(profile,{expectedRevision:0}),loaded=await store.get(context);
  if(saved.revision!==1||loaded.revision!==1||JSON.stringify(loaded.profile)!==JSON.stringify(profile))throw Error('candidate profile was not atomically retained');
  for(const alternate of [{...context,romHash:'b'.repeat(64)},{...context,coreRevision:'other-core'},{...context,mapper:{id:2,submapper:0}},{...context,platform:'sega'}]){
   if(await store.get(alternate)!==null)throw Error('profile crossed ROM/core/mapper/platform identity');
  }
  for(const incompatible of [{...context,schema:2},{...context,detectorRevision:'other-detector'}]){
   let accepted=false;try{accepted=await store.get(incompatible)!==null;}catch(_){/* Unsupported schema/revision is a safe rejection. */}
   if(accepted)throw Error('profile crossed schema/detector identity');
  }
  const evidence=P.rewardEvidence(context,{generation:3,frame:42});
  if(evidence.status!=='UNKNOWN'||Object.hasOwn(evidence,'reward')||Object.hasOwn(evidence,'terminal'))throw Error('candidate cache fabricated reward or terminal');
  await store.close();return{revision:saved.revision,profile:JSON.stringify(profile)};
 });
 await page.reload();
 const second=await page.evaluate(async expected=>{
  const P=FlyObjectiveProfiles,context={platform:'nes',romHash:'a'.repeat(64),coreRevision:'profile-fixture-core',mapper:{id:0,submapper:0},schema:1,detectorRevision:'agod-foundation-1',ramLayout:{base:0,length:2048,canonical:true}};
  const now=1700000000000,options={indexedDB,crypto,name:'agod-profile-persistence-check',now:()=>now};
  const store=new P.Store(options),another=new P.Store(options),loaded=await store.get(context);
  if(loaded.revision!==expected.revision||JSON.stringify(loaded.profile)!==expected.profile)throw Error('candidate profile lost on actual page reopen');
  const updates=await Promise.allSettled([store.put(loaded.profile,{expectedRevision:1}),another.put(loaded.profile,{expectedRevision:1})]);
  if(updates.filter(result=>result.status==='fulfilled').length!==1||updates.filter(result=>result.status==='rejected').length!==1)throw Error('concurrent CAS did not select exactly one writer');
  const winner=await store.get(context);if(winner.revision!==2)throw Error('concurrent stale writer changed revision');
  const put=IDBObjectStore.prototype.put;let quotaRejected=false;
  IDBObjectStore.prototype.put=function(){throw new DOMException('profile fixture quota','QuotaExceededError');};
  try{await store.put(winner.profile,{expectedRevision:2});}catch(_){quotaRejected=true;}finally{IDBObjectStore.prototype.put=put;}
  if(!quotaRejected)throw Error('storage exception was reported as success');
  const afterQuota=await store.get(context);if(afterQuota.revision!==2||JSON.stringify(afterQuota.profile)!==JSON.stringify(winner.profile))throw Error('failed write damaged committed profile');
  await store.close();await another.close();return{casWinners:1,revision:afterQuota.revision};
 },first);
 const safeguards=await page.evaluate(async()=>{
  const P=FlyObjectiveProfiles,base={platform:'nes',romHash:'a'.repeat(64),coreRevision:'profile-fixture-core',mapper:{id:0,submapper:0},schema:1,detectorRevision:'agod-foundation-1',ramLayout:{base:0,length:2048,canonical:true}};
  let clock=1700000000000;
  const profile=context=>P.createProfile(context,{type:'gu-goal-discovery-report',version:1,detectorRevision:'agod-foundation-1',context,status:'DISCOVERING',rewardStatus:'UNKNOWN',phase:{value:'unknown',confidence:null,evidence:[]},candidates:[],stats:{accepted:1}},{now:clock});
  const limited=new P.Store({indexedDB,crypto,name:'agod-profile-capacity-check',maxProfiles:2,now:()=>clock});
  const b={...base,romHash:'b'.repeat(64)},c={...base,romHash:'c'.repeat(64)};
  await limited.put(profile(base),{expectedRevision:0});await limited.put(profile(b),{expectedRevision:0});
  let full=false;try{await limited.put(profile(c),{expectedRevision:0});}catch(_){full=true;}
  if(!full||!await limited.get(base)||!await limited.get(b)||await limited.get(c)!==null)throw Error('capacity refusal evicted or overwrote an existing context');
  await limited.close();
  const stale=new P.Store({indexedDB,crypto,name:'agod-profile-freshness-check',now:()=>clock});await stale.put(profile(base));
  clock+=48*60*60*1000+1;let expired=false;try{await stale.get(base);}catch(_){expired=true;}
  if(!expired)throw Error('expired evidence accepted as fresh');
  const refresh=await stale.getForRefresh(base);if(refresh.revision!==1||refresh.fresh!==false)throw Error('integrity-checked stale revision cannot be obtained for fresh CAS replacement');let stillExpired=false;try{await stale.get(base);}catch(_){stillExpired=true;}if(!stillExpired)throw Error('refresh lookup silently made stale evidence current');
  clock=1700000000000-1;let future=false;try{await stale.get(base);}catch(_){future=true;}
  if(!future)throw Error('future-dated evidence accepted after a clock rollback');
  let futureRefresh=false,futureOverwrite=false;try{await stale.getForRefresh(base);}catch(_){futureRefresh=true;}try{await stale.put(profile(base),{expectedRevision:1});futureOverwrite=true;}catch(_){}
  if(!futureRefresh||futureOverwrite)throw Error('clock rollback permitted future evidence refresh or replacement');
  clock=1700000000000;if((await stale.get(base))?.revision!==1)throw Error('freshness rejection deleted or replaced the retained profile');clock+=48*60*60*1000+1;await stale.put(profile(base),{expectedRevision:1});if((await stale.get(base)).revision!==2)throw Error('fresh discovery could not replace an intact expired candidate');await stale.close();
  const corrupt=new P.Store({indexedDB,crypto,name:'agod-profile-corruption-check',now:()=>clock});await corrupt.put(profile(base));
  const db=await corrupt.open(),key=FlyGoalDiscovery.contextKey(base);
  const read=()=>new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readonly'),q=tx.objectStore('profiles').get(key);let value;q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error);});
  const original=await read(),damagedPayload=original.payload.replace('profile-fixture-core','profile-fixturz-core');
  if(damagedPayload===original.payload||new TextEncoder().encode(damagedPayload).length!==original.bytes)throw Error('checksum fixture must preserve envelope payload size');
  await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),damaged={...original,payload:damagedPayload};store.keyPath?store.put(damaged):store.put(damaged,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  let rejected=false;try{await corrupt.get(base);}catch(error){rejected=/sha|checksum|digest|целост|контроль/i.test(error.message);}
  if(!rejected||(await read()).payload!==damagedPayload)throw Error('checksum-corrupt profile accepted, misdiagnosed or silently deleted');
  let replacedCorrupt=false;try{await corrupt.put(profile(base));replacedCorrupt=true;}catch(_){}if(replacedCorrupt||(await read()).payload!==damagedPayload)throw Error('fresh cache write silently replaced corrupt history');
  await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles');store.keyPath?store.put(original):store.put(original,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  if(!await corrupt.get(base))throw Error('original valid envelope could not be recovered');
  // A valid checksum is integrity evidence, not authority to claim verification.
  const forgedProfile=JSON.parse(original.payload);forgedProfile.status='verified';const payload=JSON.stringify(forgedProfile),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const forged={...original,payload,bytes:new TextEncoder().encode(payload).length,sha256:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')};
  await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles');store.keyPath?store.put(forged):store.put(forged,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  let verifiedRejected=false;try{await corrupt.get(base);}catch(error){verifiedRejected=/verified|causal|PR1/i.test(error.message);}
  if(!verifiedRejected||(await read()).payload!==payload)throw Error('a checksum-valid forged VERIFIED profile was accepted or silently deleted');
  await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles');store.keyPath?store.put(original):store.put(original,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  if(!await corrupt.get(base))throw Error('schema rejection damaged the original candidate');await corrupt.close();
  return{capacityRetained:2,expiredRejected:expired,futureRejected:future,corruptionRejected:rejected,verifiedRejected};
 });
 assert.deepEqual(errors,[]);assert.equal(second.casWinners,1);assert.equal(second.revision,2);assert.equal(safeguards.capacityRetained,2);assert(safeguards.expiredRejected&&safeguards.futureRejected&&safeguards.corruptionRejected&&safeguards.verifiedRejected);
 await browser.close();browser=null;
 console.log('PASS: real IndexedDB/WebCrypto candidate profile persistence/reopen, ROM/core/mapper/platform/schema/detector isolation, single-winner CAS, atomic quota failure, bounded capacity without eviction, TTL/clock rollback, checksum corruption retention, forged VERIFIED rejection and UNKNOWN-only reward contract');
})().catch(async error=>{console.error(error);if(browser)await browser.close();process.exitCode=1;});
