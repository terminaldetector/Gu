/* One platform-independent driver contract for AGOD, over the cores GU already
 * bundles. No new emulator is written here.
 *
 * WHY. agod-nes-driver.js solved the problem for NES by assuming NES: 2 KiB of
 * RAM, eight buttons, jsnes savestate JSON, a writable cpu.mem. None of those
 * hold across GU's four platforms, and three of them are wrong on at least one:
 *
 *   NES    jsnes               2 KiB RAM        8 buttons   cpu.mem writable
 *   Sega   Genesis Plus GX     64 KiB view     12 buttons   cpu.mem READ-ONLY
 *   GB/GBC Gambatte           RAM from core     8 buttons   cpu.mem READ-ONLY
 *   SNES   Snes9x             RAM from core    12 buttons   cpu.mem READ-ONLY
 *
 * So the driver surface the pipeline needs - restore, run, readRam, snapshot,
 * stateHash - is kept identical on every platform, and everything that is NOT
 * universal is reported as a CAPABILITY rather than assumed. A core that cannot
 * do something says so; nothing here simulates a success.
 *
 * The read-only cpu.mem on the three WASM cores is the clearest case: poke()
 * exists only where the core really allows a write, and agod-pipeline.js already
 * degrades to NOT-SUPPORTED for its consumer stage without it.
 *
 * RAM SIZE IS ASKED FOR, NEVER ASSUMED. Sega exposes a 64 KiB window and the
 * retro cores report _lab_ram_size() at runtime, so the observed width comes
 * from the core and the 2048 default applies to NES alone.
 *
 * Each driver owns its OWN core instance built from the ROM bytes, exactly as
 * the NES one did, so research never touches the instance the player is using. */
(function(root){'use strict';
const PLATFORM_DRIVER_REVISION='agod-platform-driver-1';

/* FNV-1a over the observed bytes, in two 32-bit halves. Identity only: used to
   tell declared start states apart, which is all agod-causal.js needs, and not
   a cryptographic digest. */
function ramHash(bytes){
 let high=0x811c9dc5,low=0x811c9dc5;
 for(let i=0;i<bytes.length;i++){
  const byte=bytes[i];
  low=(low^byte)>>>0;low=Math.imul(low,0x01000193)>>>0;
  if((i&1)===0){high=(high^byte)>>>0;high=Math.imul(high,0x01000193)>>>0;}
 }
 return high.toString(16).padStart(8,'0')+low.toString(16).padStart(8,'0');
}
function decodeBase64(text){
 if(typeof root.atob==='function'){
  const raw=root.atob(text),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
 }
 if(typeof Buffer!=='undefined')return new Uint8Array(Buffer.from(text,'base64'));
 throw new Error('no base64 decoder available in this context');
}
function toBinaryString(bytes){
 let out='';
 for(let i=0;i<bytes.length;i+=0x8000)
  out+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
 return out;
}
/* The cartridge, however the caller happens to hold it.
   `romData` on the live jsnes core of this app is a Uint8Array, not a binary
   string, so a romBinaryString argument is NOT guaranteed to be a string - the
   first version of this function assumed it was and died on charCodeAt. Each
   input is normalised by what it IS rather than by the name it arrived under. */
const asBytes=value=>{
 if(value===null||value===undefined)return null;
 if(value instanceof Uint8Array)return value;
 if(typeof value==='string'){
  const out=new Uint8Array(value.length);
  for(let i=0;i<value.length;i++)out[i]=value.charCodeAt(i)&255;
  return out;
 }
 if(typeof ArrayBuffer!=='undefined'&&value instanceof ArrayBuffer)
  return new Uint8Array(value);
 if(value&&typeof value.length==='number')return new Uint8Array(value);
 if(value&&value.buffer&&typeof value.byteLength==='number')
  return new Uint8Array(value.buffer,value.byteOffset||0,value.byteLength);
 return null;
};
const romBytesOf=options=>{
 if(options.romBytes!==undefined&&options.romBytes!==null)
  return asBytes(options.romBytes);
 if(options.romBase64)return decodeBase64(options.romBase64);
 if(options.romBinaryString!==undefined&&options.romBinaryString!==null)
  return asBytes(options.romBinaryString);
 return null;
};

/* The button list per platform comes from FlyPlatforms, which is the one place
   GU already states it. Falling back to a NES layout would be exactly the
   assumption this file exists to remove, so an unknown platform has no action
   specification rather than a guessed one. */
function actionSpecFor(platform,platforms){
 const entry=platforms&&platforms[platform];
 if(!entry||!Array.isArray(entry.buttons))
  return {buttonCount:null,buttons:null,ports:null,
   note:'no action specification: FlyPlatforms does not describe '+platform};
 return {buttonCount:entry.buttons.length,
  buttons:entry.buttons.map((name,index)=>({index,name,mask:1<<index})),
  ports:entry.ports||1,
  singleButtonMasks:entry.buttons.map((_,index)=>1<<index),
  declaredRamBytes:entry.ram||null,
  note:'button indices are bit positions in the mask the pipeline drives'};
}

/* ---- the shared wrapper ----
   Every adapter hands this the few platform-specific operations; the frame
   budget, the metering, the dispose guard and the driver surface are common. */
function wrap(spec){
 const {platform,core,coreName,coreRevision,readRam,snapshot,restore,press,
  poke,memoryRegions,snapshotFormat,actionSpec,ramBytes,frameBudget,notes}=spec;
 let framesRun=0,disposed=false;
 const guard=()=>{if(disposed)throw new Error('this research driver has been disposed');};
 const run=(mask,frames)=>{
  guard();
  if(frameBudget!==null&&framesRun+frames>frameBudget)
   throw new Error('FRAME_BUDGET_EXCEEDED: this arm would bring the research run to '
    +(framesRun+frames)+' emulated frames, over the declared budget of '+frameBudget);
  press(mask,frames);
  framesRun+=frames;
  if(spec.onFrames)spec.onFrames(frames);
 };
 const driver={
  restore(state){guard();restore(state);},
  run,
  readRam(){guard();return readRam();},
  snapshot(){guard();return snapshot();},
  stateHash(){guard();return ramHash(readRam());}};
 /* poke exists ONLY where the core really accepts a write. Its absence is a
    reported capability, and agod-pipeline.js answers NOT-SUPPORTED for its
    consumer stage rather than guessing. */
 if(typeof poke==='function')driver.poke=(address,value)=>{guard();poke(address,value);};
 return Object.freeze({status:'READY',
  platform,core,coreName,coreRevision,
  driverRevision:PLATFORM_DRIVER_REVISION,
  driver,
  capabilities:Object.freeze({
   platform,coreName,coreRevision,
   observedRamBytes:ramBytes,
   memoryRegions:Object.freeze(memoryRegions.map(Object.freeze)),
   snapshotFormat,
   actionSpec:Object.freeze(actionSpec),
   supports:Object.freeze({
    snapshot:true,restore:true,readRam:true,stateHash:true,
    frameBudget:frameBudget!==null,
    memoryWrite:typeof poke==='function',
    /* said explicitly: the pipeline's consumer counterfactual needs a write */
    consumerCounterfactual:typeof poke==='function'}),
   notes:Object.freeze(notes||[])}),
  framesRun(){return framesRun;},
  frameBudget,
  budgetRemaining(){return frameBudget===null?null:frameBudget-framesRun;},
  dispose(){disposed=true;}});
}

const unavailable=(platform,reason,detail)=>Object.freeze({status:'CORE_UNAVAILABLE',
 platform,driverRevision:PLATFORM_DRIVER_REVISION,reason,
 ...(detail||{}),
 driver:null,capabilities:null,
 note:'no driver was produced. Nothing here simulates a core that is not present.'});

/* ---- NES, jsnes ---- */
function createNes(options){
 const jsnes=options.jsnes||root.jsnes;
 if(!jsnes||typeof jsnes.NES!=='function')
  return unavailable('nes','the jsnes core is not available in this context',
   {missing:'window.jsnes (lab/jsnes.min.js)'});
 const bytes=romBytesOf(options);
 if(!bytes)return unavailable('nes','no cartridge bytes were supplied');
 const ramBytes=Number.isInteger(options.ramBytes)?options.ramBytes:0x800;
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(toBinaryString(bytes));
 return wrap({platform:'nes',core,coreName:'JSNES',
  coreRevision:options.coreRevision||'jsnes',
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'jsnes-json-string',
  memoryRegions:[{name:'NesInternalRam',size:ramBytes,base:0,readable:true,writable:true}],
  actionSpec:actionSpecFor('nes',options.platforms||root.FlyPlatforms),
  readRam:()=>core.cpu.mem.slice(0,ramBytes),
  snapshot:()=>JSON.stringify(core.toJSON()),
  restore:state=>core.fromJSON(typeof state==='string'?JSON.parse(state):state),
  press:(mask,frames)=>{
   for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
   for(let i=0;i<frames;i++)core.frame();
  },
  poke:(address,value)=>{core.cpu.mem[address]=value&255;},
  notes:['jsnes exposes cpu.mem as a writable array, so the consumer '
   +'counterfactual is available on this platform only']});
}

/* ---- Sega Mega Drive, Genesis Plus GX ---- */
async function createSega(options){
 const SegaConsole=options.SegaConsole||root.SegaConsole;
 const factory=options.factory||root.GenPlusFactory;
 if(!SegaConsole||typeof SegaConsole.create!=='function')
  return unavailable('sega','the SegaConsole wrapper is not available',
   {missing:'window.SegaConsole (lab/sega-core.js)'});
 if(typeof factory!=='function')
  return unavailable('sega','the Genesis Plus GX WASM factory is not available',
   {missing:'window.GenPlusFactory (lab/sega/genplus.js + genplus.wasm)'});
 const bytes=romBytesOf(options);
 if(!bytes)return unavailable('sega','no cartridge bytes were supplied');
 const core=await SegaConsole.create({onFrame(){},onAudioSample(){}},factory,
  options.moduleOptions||{locateFile:file=>'sega/'+file});
 core.loadROM(bytes);
 /* The Sega wrapper exposes a 64 KiB read window over work RAM through a Proxy
    with a getter and NO setter, so a write is impossible and poke is omitted. */
 const ramBytes=Number.isInteger(options.ramBytes)?options.ramBytes:0x10000;
 const readRam=()=>{
  const out=new Uint8Array(ramBytes);
  for(let i=0;i<ramBytes;i++)out[i]=core.cpu.mem[i]||0;
  return out;
 };
 return wrap({platform:'sega',core,coreName:'Genesis Plus GX',
  coreRevision:options.coreRevision||'genplus',
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'sega-state-object',
  memoryRegions:[{name:'SegaWorkRam',size:ramBytes,base:0,readable:true,writable:false}],
  actionSpec:actionSpecFor('sega',options.platforms||root.FlyPlatforms),
  readRam,
  snapshot:()=>core.toJSON(),
  restore:state=>core.fromJSON(state),
  press:(mask,frames)=>{
   for(let b=0;b<12;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
   for(let i=0;i<frames;i++)core.frame();
  },
  notes:['cpu.mem is a read-only Proxy on this core, so there is no memory '
   +'write and the pipeline consumer counterfactual reports NOT-SUPPORTED',
   'twelve button indices, and 3/6-button pad selection is a core setting '
   +'(configurePads) rather than part of the driver surface',
   'the snapshot is an object carrying base64 state, not a JSON string']});
}

/* ---- Game Boy / Game Boy Color (Gambatte) and SNES (Snes9x), both through
   RetroConsole. The two WASM cores live under lab/gb/ and lab/snes/, which are
   listed in .gitignore and are not in the repository, so create() reports
   CORE_UNAVAILABLE naming the missing factory. The adapter itself is complete
   and takes the factory as an argument, so it works the moment a build is
   provisioned - nothing here pretends otherwise. ---- */
async function createRetro(platform,options){
 const RetroConsole=options.RetroConsole||root.RetroConsole;
 const factory=options.factory
  ||(platform==='gb'?root.GambatteFactory:root.Snes9xFactory);
 if(!RetroConsole||typeof RetroConsole.create!=='function')
  return unavailable(platform,'the RetroConsole wrapper is not available',
   {missing:'window.RetroConsole (lab/retro-core.js)'});
 if(typeof factory!=='function')
  return unavailable(platform,
   'the '+(platform==='gb'?'Gambatte':'Snes9x')+' WASM factory is not available',
   {missing:platform==='gb'?'window.GambatteFactory (lab/gb/core.js)'
     :'window.Snes9xFactory (lab/snes/core.js)',
    repositoryNote:'lab/gb/ and lab/snes/ are listed in .gitignore and hold no '
     +'core in this checkout; the adapter is implemented and needs only the build'});
 const bytes=romBytesOf(options);
 if(!bytes)return unavailable(platform,'no cartridge bytes were supplied');
 const core=await RetroConsole.create(platform,{onFrame(){},onAudioSample(){}},
  factory,options.moduleOptions||{locateFile:file=>platform+'/'+file});
 core.loadROM(bytes);
 /* ASKED FOR, not assumed: the core reports its own RAM width, which differs
    between Game Boy, Game Boy Color and SNES cartridges. */
 const ramBytes=Number.isInteger(options.ramBytes)?options.ramBytes:core.ramSize;
 const buttonCount=platform==='snes'?12:8;
 const readRam=()=>{
  const out=new Uint8Array(ramBytes);
  for(let i=0;i<ramBytes;i++)out[i]=core.cpu.mem[i]||0;
  return out;
 };
 return wrap({platform,core,
  coreName:platform==='gb'?'Gambatte':'Snes9x',
  coreRevision:options.coreRevision||platform,
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'retro-state-object',
  memoryRegions:[{name:platform==='gb'?'GbWorkRam':'SnesWorkRam',
   size:ramBytes,base:0,readable:true,writable:false,
   note:'a flat read window reported by the core. Bank structure is NOT '
    +'described by this interface, so a logical address here is not a bank '
    +'address and must not be treated as one'}],
  actionSpec:actionSpecFor(platform,options.platforms||root.FlyPlatforms),
  readRam,
  snapshot:()=>core.toJSON(),
  restore:state=>core.fromJSON(state),
  press:(mask,frames)=>{
   for(let b=0;b<buttonCount;b++)
    (mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
   for(let i=0;i<frames;i++)core.frame();
  },
  notes:['cpu.mem is a read-only Proxy on this core, so there is no memory write',
   'the observed RAM width comes from the core at runtime, not from a constant',
   platform==='gb'
    ?'Game Boy and Game Boy Color differ in RAM size and banking; the window '
     +'this interface reports is flat and says nothing about banks'
    :'SNES exposes up to 128 KiB, so a full sweep per action is expensive and '
     +'selective scanning is the caller responsibility']});
}

const SUPPORTED=Object.freeze(['nes','sega','gb','snes']);

/* The one entry point. Always a promise, because two of the four cores load
   asynchronously, and always a status rather than a throw for an absent core. */
async function create(options){
 const settings=options||{};
 const platform=settings.platform;
 if(!SUPPORTED.includes(platform))
  return unavailable(platform||'(none)','unsupported platform',
   {supported:SUPPORTED.slice()});
 try{
  if(platform==='nes')return createNes(settings);
  if(platform==='sega')return await createSega(settings);
  return await createRetro(platform,settings);
 }catch(error){
  return Object.freeze({status:'FAILED',platform,
   driverRevision:PLATFORM_DRIVER_REVISION,
   reason:error&&error.message?error.message:String(error),
   driver:null,capabilities:null});
 }
}

/* What a platform would offer, without building a core. Lets a caller see the
   capability surface before committing frames to it. */
function describe(platform,platforms){
 if(!SUPPORTED.includes(platform))
  return Object.freeze({platform,supported:false,supportedPlatforms:SUPPORTED.slice()});
 const spec=actionSpecFor(platform,platforms||root.FlyPlatforms);
 const writable=platform==='nes';
 return Object.freeze({platform,supported:true,
  coreName:{nes:'JSNES',sega:'Genesis Plus GX',gb:'Gambatte',snes:'Snes9x'}[platform],
  actionSpec:spec,
  memoryWrite:writable,
  observedRamBytesDefault:{nes:0x800,sega:0x10000,gb:null,snes:null}[platform],
  observedRamBytesNote:platform==='gb'||platform==='snes'
   ?'reported by the core at runtime through _lab_ram_size()'
   :'fixed for this core',
  snapshotFormat:{nes:'jsnes-json-string',sega:'sega-state-object',
   gb:'retro-state-object',snes:'retro-state-object'}[platform]});
}

const api={PLATFORM_DRIVER_REVISION,SUPPORTED,create,describe,
 actionSpecFor,ramHash,asBytes,
 /* jsnes loads synchronously, so the NES path is also offered without a
    promise for callers that cannot await - the compatibility shim in
    agod-nes-driver.js, and nothing else. */
 createNesSync:createNes};
root.FlyAgodPlatformDriver=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
