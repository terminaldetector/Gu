'use strict';
// G3: is the pipeline platform-independent, or is it a NES pipeline that
// happens to accept other drivers?
//
// Two assumptions are measured here rather than argued about:
//
//   1. the ACTION SET. agod-pipeline.js declares masks [1,2,4,8,16,32,64,128]
//      as a frozen default: eight buttons, which is NES and Game Boy. Sega
//      declares twelve (A B C Start + four directions + X Y Z Mode) and SNES
//      twelve (A B Y Start + four directions + X L R Select). The four extra
//      buttons are bits 8..11, so masks 256, 512, 1024 and 2048 - and
//      agod-causal.js rejects any mask above 255 outright.
//
//   2. the ADDRESS SPACE. agod-causal.js truncates every RAM comparison at
//      limits.maxRamBytes, which defaults to 2048: the NES internal RAM width.
//      Sega's work-RAM window is 65536 bytes and the declared RAM of GB and
//      SNES is 32768 and 131072. An effect above offset 2047 is therefore
//      invisible to the causal detector, and the pipeline reads that as
//      "no action was shown to cause any RAM change".
//
// Both are reproduced on a synthetic driver whose effects are known by
// construction, BEFORE anything is changed, so the fix has something to fix.
// The driver is deliberately not an emulator: it is a known answer. The real
// cores are exercised by tools/agod_platform_driver_check.cjs.
//
// What must NOT change: the defaults. Every historical run passed no masks and
// no limits, so the eight-button set and the 2048-byte comparison have to stay
// the behaviour a caller gets when it declares nothing.
const path=require('path');
const A=path.resolve('app/src/main/assets/lab');
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
const Causal=require(path.join(A,'agod-causal.js'));
require(path.join(A,'agod-ram.js'));require(path.join(A,'agod-goals.js'));
require(path.join(A,'agod-evidence.js'));require(path.join(A,'agod-reward.js'));
require(path.join(A,'agod-candidates.js'));require(path.join(A,'agod-consumers.js'));
const Pipeline=require(path.join(A,'agod-pipeline.js'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok   ':'  FAIL ')+m);if(!c)fail.push(m);return c;};
const throws=fn=>{try{fn();return null;}catch(e){return e.message;}};

/* ---- a driver whose causal structure is known by construction ----
   ramBytes wide. Bit `bit` of the mask increments the byte at `address` once
   per frame, saturating. Nothing moves on its own: no time drift, so a neutral
   arm changes nothing and a phase shift cannot explain anything away. */
function known(opts){
 const ramBytes=opts.ramBytes,effects=opts.effects;
 let ram=new Uint8Array(ramBytes);
 const d={
  restore(state){ram=Uint8Array.from(state);},
  snapshot(){return Array.from(ram);},
  readRam(){return ram.slice(0);},
  stateHash(){let h=2166136261;for(let i=0;i<ram.length;i++){h=(h^ram[i])>>>0;h=Math.imul(h,16777619)>>>0;}
   return h.toString(16);},
  run(mask,frames){
   for(let f=0;f<frames;f++)
    for(const e of effects)
     if(mask&(1<<e.bit))ram[e.address]=Math.min(255,ram[e.address]+(e.step||1));
  }};
 if(opts.actionSpec)d.actionSpec=opts.actionSpec;
 if(opts.observedRamBytes!==false)d.observedRamBytes=ramBytes;
 return d;
}
const startsOf=d=>{
 const s=[];
 for(let i=0;i<2;i++){d.run(1,3+i);s.push({id:'s'+i,stateHash:d.stateHash(),snapshot:d.snapshot(),independent:true});}
 return s;
};

console.log('=== 1. agod-causal: an effect above offset 2047 ===');
{
 /* one byte at 3000 moves under bit 0 and nothing else moves at all */
 const d=known({ramBytes:4096,effects:[{bit:0,address:3000}]});
 const starts=startsOf(d);
 const dflt=Causal.probeAction(d,{starts,mask:1,neutralMask:0,frames:12,shiftTolerance:3});
 console.log('  default limits  maxRamBytes=%d  status=%s  confirmed=%j',
  dflt.limits.maxRamBytes,dflt.causalStatus,dflt.confirmed.map(e=>e.address));
 ok(dflt.limits.maxRamBytes===2048,'the DEFAULT comparison width is still 2048 (historical runs unchanged)');
 ok(dflt.causalStatus==='NO-EFFECT',
  'DEFECT REPRODUCED: with the default width the effect at 3000 is invisible');

 const wide=throws(()=>Causal.probeAction(d,{starts,mask:1,neutralMask:0,frames:12,
  shiftTolerance:3,limits:{maxRamBytes:4096}}));
 if(typeof wide==='string'){
  console.log('  asking for 4096 bytes: %s',wide);
  ok(false,'a caller can ask agod-causal to compare the whole observed RAM width');
 }else{
  const r=Causal.probeAction(d,{starts,mask:1,neutralMask:0,frames:12,shiftTolerance:3,
   limits:{maxRamBytes:4096}});
  console.log('  maxRamBytes=4096  status=%s  confirmed=%j',r.causalStatus,r.confirmed.map(e=>e.address));
  ok(r.causalStatus==='CAUSAL-EVIDENCE'&&r.confirmed.some(e=>e.address===3000),
   'a caller can ask agod-causal to compare the whole observed RAM width');
 }
 const snes=throws(()=>Causal.probeAction(d,{starts,mask:1,neutralMask:0,frames:12,
  shiftTolerance:3,limits:{maxRamBytes:131072}}));
 console.log('  maxRamBytes=131072 (SNES declared RAM): %s',snes===null?'accepted':snes);
 ok(snes===null,'the hard cap reaches the widest RAM GU declares (SNES, 131072)');
}

console.log('=== 2. agod-causal: a mask above 255 ===');
{
 const d=known({ramBytes:4096,effects:[{bit:11,address:1500}]});
 const starts=startsOf(d);
 /* the DEFAULT action width is eight buttons, and a caller that declares
    nothing still gets the check every historical run got */
 const undeclared=throws(()=>Causal.probeAction(d,{starts,mask:2048,neutralMask:0,
  frames:12,shiftTolerance:3,limits:{maxRamBytes:4096}}));
 console.log('  mask 2048, action width NOT declared: %s',
  undeclared===null?'accepted':undeclared);
 ok(undeclared!==null&&/0\.\.255/.test(undeclared),
  'an undeclared action width is still eight buttons wide');
 /* declaring the platform's own width is what the pipeline now does */
 const e=throws(()=>Causal.probeAction(d,{starts,mask:2048,neutralMask:0,frames:12,
  shiftTolerance:3,limits:{maxRamBytes:4096,maxMask:4095}}));
 console.log('  mask 2048 (Sega "Mode", SNES "Select"), width declared: %s',
  e===null?'accepted':e);
 if(e!==null)ok(false,'mask 2048 is probed, not rejected (12-button platforms)');
 else{
  const r=Causal.probeAction(d,{starts,mask:2048,neutralMask:0,frames:12,shiftTolerance:3,
   limits:{maxRamBytes:4096,maxMask:4095}});
  console.log('  status=%s confirmed=%j',r.causalStatus,r.confirmed.map(x=>x.address));
  ok(r.causalStatus==='CAUSAL-EVIDENCE'&&r.confirmed.some(x=>x.address===1500),
   'mask 2048 is probed, not rejected (12-button platforms)');
 }
 const over=throws(()=>Causal.probeAction(d,{starts,mask:65536,neutralMask:0,frames:12,
  shiftTolerance:3,limits:{maxRamBytes:4096,maxMask:4095}}));
 console.log('  mask 65536 (no platform declares a 17th button): %s',over===null?'ACCEPTED':over);
 ok(over!==null,'a mask wider than any declared controller is still refused');
 const cap=throws(()=>Causal.probeAction(d,{starts,mask:1,neutralMask:0,frames:12,
  shiftTolerance:3,limits:{maxRamBytes:4096,maxMask:65535}}));
 console.log('  asking for a 16-bit action width: %s',cap===null?'ACCEPTED':cap);
 ok(cap!==null&&/hard cap/.test(cap),
  'and the action width itself cannot be raised past the widest declared pad');
}

console.log('=== 3. the pipeline asks the driver for the action set ===');
{
 /* twelve buttons, and the ONLY causal byte is reachable by bit 11 alone and
    sits above 2047: a NES-shaped pipeline cannot see it for two independent
    reasons, so this one driver tests both at the pipeline level. */
 const spec={buttonCount:12,
  buttons:Array.from({length:12},(_,i)=>({index:i,name:'b'+i,mask:1<<i})),
  singleButtonMasks:Array.from({length:12},(_,i)=>1<<i),ports:1};
 const d=known({ramBytes:65536,effects:[{bit:11,address:40000}],actionSpec:spec});
 const r=Pipeline.run(d,{typeEvents:8,starts:2});
 const probed=r.trace.filter(t=>t.stage==='actions');
 console.log('  status=%s stage=%s reason=%s',r.status,r.stage||'-',r.reason||'-');
 console.log('  action trace: %j',probed);
 const masksSeen=probed.length?probed[0].masks:null;
 ok(Array.isArray(masksSeen)&&masksSeen.length===12,
  'the pipeline probed the 12 masks the driver declares, not 8');
 ok(r.stage!=='attribute',
  'the 12th button\'s effect at offset 40000 is attributed, so the run gets past stage 1');
}

console.log('=== 4. a driver that declares nothing keeps the historical set ===');
{
 const d=known({ramBytes:2048,effects:[{bit:0,address:16}],observedRamBytes:false});
 const r=Pipeline.run(d,{typeEvents:8,starts:2});
 const probed=r.trace.filter(t=>t.stage==='actions');
 const masksSeen=probed.length?probed[0].masks:null;
 console.log('  status=%s stage=%s  masks=%j  source=%s',r.status,r.stage||'-',
  masksSeen,probed.length?probed[0].source:'-');
 ok(Array.isArray(masksSeen)&&masksSeen.join(',')==='1,2,4,8,16,32,64,128',
  'no action specification: the declared eight-button default is used, unchanged');
 ok(probed.length&&probed[0].source==='pipeline-default',
  'and the trace says the set came from the default, not from a platform');
}

console.log('=== 5. explicit masks from the caller still win ===');
{
 const spec={buttonCount:12,buttons:null,singleButtonMasks:[1,2,4,8,16,32,64,128,256,512,1024,2048],ports:1};
 const d=known({ramBytes:4096,effects:[{bit:1,address:40}],actionSpec:spec});
 const r=Pipeline.run(d,{typeEvents:8,starts:2,masks:[1,2]});
 const probed=r.trace.filter(t=>t.stage==='actions');
 console.log('  masks=%j source=%s',probed.length?probed[0].masks:null,probed.length?probed[0].source:'-');
 ok(probed.length&&probed[0].masks.join(',')==='1,2'&&probed[0].source==='caller',
  'a caller-supplied action set is used verbatim and recorded as the caller\'s');
}

console.log('=== 6. an unknown platform is refused, not guessed ===');
{
 /* this is what agod-platform-driver.js produces for a platform FlyPlatforms
    does not describe: a spec object that declares no buttons. Falling back to
    eight would be the exact assumption G3 removes. */
 const d=known({ramBytes:4096,effects:[{bit:0,address:40}],
  actionSpec:{buttonCount:null,buttons:null,singleButtonMasks:null,
   note:'no action specification: FlyPlatforms does not describe zx'}});
 const r=Pipeline.run(d,{typeEvents:8,starts:2});
 console.log('  status=%s stage=%s reason=%s',r.status,r.stage||'-',r.reason||'-');
 ok(r.status==='REFUSED'&&r.stage==='actions',
  'a driver that declares no action specification is refused at a named stage');
 ok(/no action specification|declares no/.test(String(r.reason)),
  'and the refusal says so rather than naming something else');
}

console.log('=== 7. the comparison width follows the driver ===');
{
 const spec={buttonCount:8,buttons:null,singleButtonMasks:[1,2,4,8,16,32,64,128],ports:1};
 const d=known({ramBytes:65536,effects:[{bit:0,address:60000}],actionSpec:spec});
 const r=Pipeline.run(d,{typeEvents:8,starts:2});
 const widths=r.trace.filter(t=>t.stage==='actions').map(t=>t.comparisonWidth);
 console.log('  status=%s stage=%s  comparisonWidth=%j',r.status,r.stage||'-',widths);
 ok(widths[0]===65536,'the causal comparison width is the driver\'s observed RAM width');
 ok(r.stage!=='attribute','an effect at offset 60000 is attributed');
}

console.log('=== 8. combinations the hardware cannot produce ===');
{
 const PD=require(path.join(A,'agod-platform-driver.js'));
 const nes=PD.describe('nes').actionSpec;
 console.log('  NES buttons: %j',nes.buttons.map(b=>b.name));
 if(!ok(typeof nes.maskAllowed==='function','the action specification can judge a mask'))
  nes.maskAllowed=()=>({allowed:null,reason:'maskAllowed is absent'});
 const up=nes.buttons.find(b=>b.name==='↑'),down=nes.buttons.find(b=>b.name==='↓'),
  left=nes.buttons.find(b=>b.name==='←'),right=nes.buttons.find(b=>b.name==='→'),
  a=nes.buttons.find(b=>b.name==='A'),b1=nes.buttons.find(b=>b.name==='B');
 if(ok(!!(up&&down&&left&&right&&a&&b1),'the four directions and A/B are located by name')){
  const opp=nes.maskAllowed(up.mask|down.mask);
  console.log('  up|down   -> %j',opp);
  ok(opp.allowed===false,'two opposed directions at once are not an allowed combination');
  const ab=nes.maskAllowed(a.mask|b1.mask);
  console.log('  A|B       -> %j',ab);
  ok(ab.allowed===true,'two face buttons at once are allowed');
  const diag=nes.maskAllowed(up.mask|left.mask);
  ok(diag.allowed===true,'a diagonal is allowed');
  const ghost=nes.maskAllowed(1<<9);
  console.log('  bit 9 on NES -> %j',ghost);
  ok(ghost.allowed===false,'a bit no NES button occupies is not an allowed combination');
  ok(nes.maskAllowed(0).allowed===true,'the neutral mask is allowed');
 }
 const sega=PD.describe('sega').actionSpec;
 const mode=sega.buttons.find(x=>x.name==='Mode');
 const segaOk=typeof sega.maskAllowed==='function'?sega.maskAllowed(mode.mask):{allowed:null};
 console.log('  Sega "Mode" mask=%d allowed=%j',mode.mask,segaOk);
 ok(mode.mask===2048&&segaOk.allowed===true,
  'Sega bit 11 ("Mode") is a declared button, mask 2048');
 const zx=PD.actionSpecFor('zx80',globalThis.FlyPlatforms);
 ok(typeof zx.maskAllowed==='function'&&zx.maskAllowed(1).allowed===false,
  'an undescribed platform allows no mask at all');
}

console.log('=== 9. the pipeline refuses an action set the platform cannot produce ===');
{
 const spec={buttonCount:8,buttons:null,singleButtonMasks:[1,2,4,8,16,32,64,128],ports:1,
  maskAllowed:m=>m===48?{allowed:false,reason:'opposed directions'}:{allowed:true}};
 const d=known({ramBytes:2048,effects:[{bit:0,address:40}],actionSpec:spec});
 const r=Pipeline.run(d,{typeEvents:8,starts:2,masks:[1,48]});
 console.log('  status=%s stage=%s reason=%s',r.status,r.stage||'-',r.reason||'-');
 ok(r.status==='REFUSED'&&r.stage==='actions'&&/48/.test(String(r.reason)),
  'a caller-supplied mask the platform rejects stops the run and is named');
}

console.log('');
for(const line of out)console.log(line);
console.log('\n%d/%d assertions passed',out.length-fail.length,out.length);
if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);process.exitCode=1;}
