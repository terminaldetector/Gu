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
   specification rather than a guessed one.

   ALLOWED COMBINATIONS, not just a button count. A d-pad is one physical
   stick: up and down cannot be held at the same time, and neither can left and
   right. A mask that asks for both is not a hard action - it is a request the
   controller cannot express, and what the core does with it is undefined
   behaviour rather than an experiment. So the specification can judge a mask,
   and the pipeline refuses one the platform cannot produce instead of driving
   it and attributing whatever comes back. The group is derived from the button
   NAMES FlyPlatforms already uses, so a platform that lists no directions
   simply has no exclusive group. */
const OPPOSED_PAIRS=[['\u2191','\u2193'],['\u2190','\u2192']];
const popcount=value=>{let n=value,c=0;while(n){n&=n-1;c++;}return c;};
/* `availableButtons` is the number of buttons the HARDWARE ACTUALLY HAS in the
   configuration the core is in, which is not always the number the platform
   declares. Measured on Genesis Plus GX: after loadROM() the pad type the core
   reports is 3, not 6 - FlyPlatforms declares twelve Sega buttons, but on a
   three-button pad X, Y, Z and Mode (bits 8..11) do not exist on the wire, and
   SegaConsole.buttonDown accepts index 11 on such a pad without complaint. So
   a probe of mask 256..2048 there would drive nothing and attribute whatever
   the frames happened to produce. The declared count is kept and REPORTED
   beside the available one; the action set is the available buttons. */
function actionSpecFor(platform,platforms,availableButtons){
 const entry=platforms&&platforms[platform];
 if(!entry||!Array.isArray(entry.buttons)){
  const why='no action specification: FlyPlatforms does not describe '+platform;
  return {buttonCount:null,buttons:null,ports:null,singleButtonMasks:null,
   exclusiveGroups:null,maxMask:0,
   maskAllowed:()=>({allowed:false,reason:why}),
   note:why};
 }
 const declared=entry.buttons.map((name,index)=>({index,name,mask:1<<index}));
 const available=Number.isInteger(availableButtons)
  ?Math.max(0,Math.min(availableButtons,declared.length)):declared.length;
 const buttons=declared.slice(0,available);
 const withheld=declared.slice(available);
 const byName=new Map(buttons.map(button=>[button.name,button]));
 const exclusiveGroups=OPPOSED_PAIRS
  .filter(pair=>pair.every(name=>byName.has(name)))
  .map(pair=>Object.freeze({names:pair.slice(),
   mask:pair.reduce((mask,name)=>mask|byName.get(name).mask,0),
   reason:'a d-pad cannot hold '+pair[0]+' and '+pair[1]+' at once'}));
 const maxMask=(1<<buttons.length)-1;
 const maskAllowed=mask=>{
  if(!Number.isInteger(mask)||mask<0)
   return {allowed:false,reason:'a mask must be a non-negative integer'};
  const stray=mask&~maxMask;
  if(stray){
   const named=withheld.filter(button=>stray&button.mask);
   return {allowed:false,
    reason:named.length
     ?'mask '+mask+' asks for '+named.map(b=>b.name).join('/')+', which the '
      +platform+' pad the core is configured for does not have ('
      +buttons.length+' of '+declared.length+' declared buttons are present)'
     :'mask '+mask+' sets bit(s) 0x'+stray.toString(16)+', which occupy no '
      +platform+' button: this controller has '+buttons.length};
  }
  for(const group of exclusiveGroups)
   if(popcount(mask&group.mask)>1)return {allowed:false,reason:group.reason};
  return {allowed:true};
 };
 return {buttonCount:buttons.length,
  buttons,
  /* stated apart, so "this platform has twelve buttons" and "this pad can
     press eight of them right now" are never the same claim */
  declaredButtonCount:declared.length,
  availableButtonCount:buttons.length,
  withheldButtons:withheld.map(button=>({index:button.index,name:button.name,
   mask:button.mask,
   reason:'declared by the platform but not present on the pad the core is '
    +'configured for'})),
  ports:entry.ports||1,
  singleButtonMasks:buttons.map(button=>button.mask),
  exclusiveGroups,maxMask,maskAllowed,
  declaredRamBytes:entry.ram||null,
  note:withheld.length
   ?'button indices are bit positions in the mask the pipeline drives; '
    +withheld.length+' declared button(s) are NOT on the configured pad and are '
    +'excluded from the action set'
   :'button indices are bit positions in the mask the pipeline drives'};
}

/* ---- RAW RESEARCH SNAPSHOTS for the WASM cores ----
   SegaConsole and RetroConsole serialise a state for a SAVE FILE: the core's
   state bytes base64-encoded, plus a base64 copy of the last video frame. A
   research run restores hundreds of times, and measured on Snes9x that format
   cost 40 ms per snapshot and 129 ms per restore against 0.8 ms per emulated
   frame - most of a 74 s SNES run was spent encoding text, not emulating.

   The cores already expose the state itself: save_state() fills a buffer in
   WASM memory and returns its size, load_state() reads it back. A research
   snapshot is a copy of those bytes, tagged so that restore() can tell it from
   a live save-format snapshot, which is still accepted (the start state comes
   from the player's game in that format). Nothing here leaves the worker. */
function rawSnapshotter(platform,core,stateRef,load,fallbackRestore){
 const kind='raw-'+platform;
 return {
  snapshot(){
   const g=core.g,size=g._lab_save_state();
   if(!size)throw new Error(platform+' core produced no state');
   const at=stateRef();
   return {kind,size,bytes:g.HEAPU8.slice(at,at+size)};
  },
  restore(state){
   if(!state||state.kind!==kind)return fallbackRestore(state);
   const g=core.g;
   /* A CORE THAT HAS NEVER SAVED HAS NO STATE BUFFER: Snes9x allocates it on
      the first save, and until then the pointer is 0 - a raw snapshot made by
      one core and restored into a fresh one was written to address 0 and
      rejected (seen on a private SNES cartridge, a snapshot cached on disk and
      restored in a new process). One save allocates the buffer. */
   if(!stateRef())g._lab_save_state();
   g.HEAPU8.set(state.bytes,stateRef());     /* HEAPU8 re-read: memory may have grown */
   if(!load(state.size))throw new Error(platform+' core rejected a research snapshot');
  }};
}

/* ---- the shared wrapper ----
   Every adapter hands this the few platform-specific operations; the frame
   budget, the metering, the dispose guard and the driver surface are common. */
function wrap(spec){
 const {platform,core,coreName,coreRevision,readRam,readRamSparse,snapshot,
  restore,press,poke,memoryRegions,snapshotFormat,actionSpec,ramBytes,
  frameBudget,notes,bulkReadVia,padType,padTypeRequested}=spec;
 let framesRun=0,disposed=false;
 const guard=()=>{if(disposed)throw new Error('this research driver has been disposed');};
 /* SECOND PORT (real-ROM 2P track). `mask2` drives controller 2 for the same
    frames; omitted, controller 2 is released, which is what every caller
    before this saw. A platform with one port refuses a non-zero mask2 rather
    than dropping it. */
 const ports=Number.isInteger(spec.ports)?spec.ports:1;
 const run=(mask,frames,mask2)=>{
  guard();
  if(frameBudget!==null&&framesRun+frames>frameBudget)
   throw new Error('FRAME_BUDGET_EXCEEDED: this arm would bring the research run to '
    +(framesRun+frames)+' emulated frames, over the declared budget of '+frameBudget);
  if(mask2&&ports<2)throw new Error('this platform has one controller port; mask2 cannot be driven');
  press(mask,frames,mask2||0);
  framesRun+=frames;
  if(spec.onFrames)spec.onFrames(frames);
 };
 /* THE PIPELINE ASKS THE DRIVER. agod-pipeline.js used to carry its own frozen
    action set - [1,2,4,8,16,32,64,128], eight buttons, which is NES - so the
    four extra buttons on Sega and SNES were never probed and the comparison
    was truncated at the NES RAM width. Both facts belong to the platform, so
    both are published on the driver surface itself rather than guessed by the
    stage that uses them. */
 const driver={
  restore(state){guard();restore(state);},
  run,
  readRam(){guard();return readRam();},
  snapshot(){guard();return snapshot();},
  stateHash(){guard();return ramHash(readRam());},
  ports,
  actionSpec:Object.freeze(actionSpec),
  observedRamBytes:ramBytes};
 /* SELECTIVE SCANNING, for a caller that has an independent reason to narrow -
    a region hint, or a candidate set already confirmed by the causality stage.
    It is offered, never imposed: the pipeline's own full-width scan stays
    lossless, and narrowing it from a coarse pass would drop a field that only
    moves late in a long play. */
 if(typeof readRamSparse==='function')
  driver.readRamSparse=addresses=>{guard();return readRamSparse(addresses);};
 /* A LOGICAL offset is not a PHYSICAL address. The region declares its base, so
    the two can be reported apart instead of being silently conflated. */
 driver.physicalAddressOf=(logical,regionName)=>{
  const region=memoryRegions.find(entry=>!regionName||entry.name===regionName)
   ||memoryRegions[0];
  if(!region||!Number.isInteger(logical))return null;
  return {logicalAddress:logical,memoryRegion:region.name,
   regionBase:region.base,
   physicalAddress:Number.isInteger(region.base)?region.base+logical:null,
   withinRegion:logical>=0&&logical<region.size};
 };
 /* poke exists ONLY where the core really accepts a write. Its absence is a
    reported capability, and agod-pipeline.js answers NOT-SUPPORTED for its
    consumer stage rather than guessing. */
 if(typeof poke==='function')driver.poke=(address,value)=>{guard();poke(address,value);};
 const reportableActionSpec={};
 for(const key of Object.keys(actionSpec))
  if(typeof actionSpec[key]!=='function')reportableActionSpec[key]=actionSpec[key];
 reportableActionSpec.combinationRuleAvailable=typeof actionSpec.maskAllowed==='function';
 return Object.freeze({status:'READY',
  platform,core,coreName,coreRevision,
  driverRevision:PLATFORM_DRIVER_REVISION,
  driver,
  capabilities:Object.freeze({
   platform,coreName,coreRevision,
   observedRamBytes:ramBytes,
   memoryRegions:Object.freeze(memoryRegions.map(Object.freeze)),
   snapshotFormat,
   bulkReadVia:bulkReadVia||null,
   /* the controller the core is really configured for, where that is a choice;
      null on a platform with one pad layout */
   padType:padType===undefined?null:padType,
   padTypeRequested:padTypeRequested===undefined?null:padTypeRequested,
   /* CAPABILITIES CROSS postMessage; THE DRIVER DOES NOT. The action
      specification carries maskAllowed, a function, and a function cannot be
      structured-cloned: agod-worker.js posts this object to the page, so a
      function on it would turn the whole `started` message into a
      DataCloneError - the same defect G1 fixed on the result path. The
      reported copy is therefore the data only, and the judgement stays on the
      driver, which never leaves the context that built it. */
   actionSpec:Object.freeze(reportableActionSpec),
   supports:Object.freeze({
    snapshot:true,restore:true,readRam:true,stateHash:true,
    frameBudget:frameBudget!==null,
    selectiveRead:typeof readRamSparse==='function',
    /* false when the pad the core is configured for has fewer buttons than the
       platform declares - said as a capability, not discovered by a probe that
       drives a button the wire does not carry */
    allDeclaredButtons:actionSpec.declaredButtonCount===undefined
     ?true:actionSpec.availableButtonCount===actionSpec.declaredButtonCount,
    physicalAddressMapping:memoryRegions.some(r=>Number.isInteger(r.base)),
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
 const actionSpec=actionSpecFor('nes',options.platforms||root.FlyPlatforms);
 return wrap({platform:'nes',core,coreName:'JSNES',
  coreRevision:options.coreRevision||'jsnes',
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'jsnes-state-object (accepts a JSON string)',
  memoryRegions:[{name:'NesInternalRam',size:ramBytes,base:0,readable:true,writable:true}],
  actionSpec,
  readRam:()=>core.cpu.mem.slice(0,ramBytes),
  readRamSparse:addresses=>{
   const out=new Uint8Array(addresses.length);
   for(let i=0;i<addresses.length;i++)out[i]=core.cpu.mem[addresses[i]]||0;
   return out;
  },
  bulkReadVia:'cpu.mem typed array slice',
  /* an OBJECT, not a JSON string: measured on jsnes, restoring from the
     object costs 1.05 ms against 7.49 ms for parse-then-restore, and a
     research run restores far more often than it snapshots. A string (the
     live game's snapshot arrives as one) is still accepted. */
  snapshot:()=>core.toJSON(),
  restore:state=>core.fromJSON(typeof state==='string'?JSON.parse(state):state),
  ports:2,
  press:(mask,frames,mask2)=>{
   for(let b=0;b<actionSpec.buttonCount;b++){
    (mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
    (mask2&(1<<b)?core.buttonDown:core.buttonUp).call(core,2,b);}
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
 /* the region the live core was set to, so its snapshot can be restored here */
 if(Number.isInteger(options.region)&&typeof core.configureRegion==='function')
  core.configureRegion(options.region);
 core.loadROM(bytes);
 /* The Sega wrapper exposes a 64 KiB read window over work RAM through a Proxy
    with a getter and NO setter, so a write is impossible and poke is omitted.

    THE PROXY IS NOT THE WAY TO READ IT IN BULK. Going through cpu.mem costs
    12.40 ms for the 64 KiB window - 17.7 times a whole emulated frame - and
    that is the Proxy's get trap, not the core: calling the core's own
    _lab_read_ram directly gives byte-identical results in 0.35 ms, a 97 per
    cent saving and half a frame. The first version of this adapter used the
    Proxy because cpu.mem is the documented surface, and it turned every
    typing pass into seconds of overhead. Measured, not guessed. */
 const ramBytes=Number.isInteger(options.ramBytes)?options.ramBytes:0x10000;
 /* THE PAD TYPE IS ASKED FOR, NOT ASSUMED. loadROM() has already run
    configurePads(padTypes), and padTypes defaults to [0,0] - "auto", which
    Genesis Plus GX resolves to a THREE-button pad, not a detected one. So the
    core reports controllerTypes [3,3] and bits 8..11 (X/Y/Z/Mode) are absent
    from the wire even though FlyPlatforms declares twelve buttons.

    `padType` lets a caller ask for the six-button pad and really get it
    (measured: configurePads([6,6]) moves the raw type from 0 to 1 and
    controllerTypes to [6,6]). It is NOT the default, because changing the pad
    type changes the input environment the game sees, and a research driver
    should start in the configuration the player's core would be in. Whatever
    the pad turns out to be, the action set follows it. */
 const requestedPad=[3,6].includes(Number(options.padType))?Number(options.padType):null;
 if(requestedPad!==null){
  core.configurePads([requestedPad,requestedPad]);
  core.loadROM(bytes);   /* configurePads zeroes the masks; re-seat the cartridge */
 }
 let padTypeObserved=null;
 try{padTypeObserved=core.controllerTypes[0];}catch(error){padTypeObserved=null;}
 const availableButtons=padTypeObserved===6?12:(padTypeObserved===3?8:null);
 const segaActions=actionSpecFor('sega',options.platforms||root.FlyPlatforms,
  availableButtons);
 const read=core.g&&typeof core.g._lab_read_ram==='function'
  ?core.g._lab_read_ram.bind(core.g):null;
 const readRam=read
  ?()=>{const out=new Uint8Array(ramBytes);
    for(let i=0;i<ramBytes;i++)out[i]=read(i);return out;}
  :()=>{const out=new Uint8Array(ramBytes);
    for(let i=0;i<ramBytes;i++)out[i]=core.cpu.mem[i]||0;return out;};
 const readRamSparse=read
  ?addresses=>{const out=new Uint8Array(addresses.length);
    for(let i=0;i<addresses.length;i++)out[i]=read(addresses[i]);return out;}
  :addresses=>{const out=new Uint8Array(addresses.length);
    for(let i=0;i<addresses.length;i++)out[i]=core.cpu.mem[addresses[i]]||0;return out;};
 return wrap({platform:'sega',core,coreName:'Genesis Plus GX',
  coreRevision:options.coreRevision||'genplus',
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'raw-sega-state-bytes (accepts a sega save-format object)',
  memoryRegions:[{name:'SegaWorkRam',size:ramBytes,base:0xff0000,readable:true,
   writable:false,
   note:'logical offset 0 is physical $FF0000, the start of Mega Drive work RAM. '
    +'A logical offset is NOT a physical address and the two are reported apart'}],
  actionSpec:segaActions,
  readRam,readRamSparse,
  bulkReadVia:read?'core _lab_read_ram':'cpu.mem Proxy (slow fallback)',
  /* RESEARCH SNAPSHOTS CARRY NO PICTURE. A Sega state optionally embeds the
     last video frame, and fromJSON checks it against the frame size the core
     reports. A worker core adopting the LIVE game's snapshot takes the live
     picture with it, renders at its own size afterwards, and the next restore
     of its own snapshot fails "Неверный видео-снимок" - which stopped every
     Sega run in a real browser worker (Node runs never render, so never saw it).
     The picture is derived output; the machine state is in `data`. */
  /* raw state bytes for research; a live save-format snapshot is still
     accepted, without its picture - a worker core adopting the live picture
     renders at its own size and its next save-format restore fails
     "Неверный видео-снимок", which stopped every Sega run in a real browser */
  ...(()=>{const raw=rawSnapshotter('sega',core,()=>core.g._lab_state_ref(),
    ()=>core.g._lab_load_state(),
    state=>core.fromJSON(state&&typeof state==='object'&&state.video?{...state,video:null}:state));
   return {snapshot:raw.snapshot,restore:raw.restore};})(),
  ports:2,
  press:(mask,frames,mask2)=>{
   for(let b=0;b<segaActions.buttonCount;b++){
    (mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
    (mask2&(1<<b)?core.buttonDown:core.buttonUp).call(core,2,b);}
   for(let i=0;i<frames;i++)core.frame();
  },
  padType:padTypeObserved,padTypeRequested:requestedPad,
  notes:['cpu.mem is a read-only Proxy on this core, so there is no memory '
   +'write and the pipeline consumer counterfactual reports NOT-SUPPORTED',
   'the window is read through the core _lab_read_ram, not through the cpu.mem '
   +'Proxy: identical bytes at 0.35 ms instead of 12.40 ms for 64 KiB',
   'the pad the core reports is '+(padTypeObserved===null?'unknown':padTypeObserved
    +'-button')+', so the action set has '
    +(availableButtons===null?'the declared':String(availableButtons))
    +' of the 12 buttons FlyPlatforms declares'
    +(padTypeObserved===3?'; pass padType:6 to reach X/Y/Z/Mode, which changes '
     +'the input environment the game sees and is therefore not the default':''),
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
 /* The button count is the action specification's, not a second copy of it:
    the 12-versus-8 constant that used to live here was a third place where a
    controller layout was written down. */
 const retroActions=actionSpecFor(platform,options.platforms||root.FlyPlatforms);
 const buttonCount=retroActions.buttonCount;
 /* The same Proxy cost applies here, so the core's own reader is used; see the
    note in the Sega adapter for the measurement. */
 const read=core.g&&typeof core.g._lab_read_ram==='function'
  ?core.g._lab_read_ram.bind(core.g):null;
 const readRam=read
  ?()=>{const out=new Uint8Array(ramBytes);
    for(let i=0;i<ramBytes;i++)out[i]=read(i);return out;}
  :()=>{const out=new Uint8Array(ramBytes);
    for(let i=0;i<ramBytes;i++)out[i]=core.cpu.mem[i]||0;return out;};
 const readRamSparse=read
  ?addresses=>{const out=new Uint8Array(addresses.length);
    for(let i=0;i<addresses.length;i++)out[i]=read(addresses[i]);return out;}
  :addresses=>{const out=new Uint8Array(addresses.length);
    for(let i=0;i<addresses.length;i++)out[i]=core.cpu.mem[addresses[i]]||0;return out;};
 return wrap({platform,core,
  coreName:platform==='gb'?'Gambatte':'Snes9x',
  coreRevision:options.coreRevision||platform,
  ramBytes,frameBudget:Number.isInteger(options.frameBudget)?options.frameBudget:null,
  onFrames:options.onFrames,
  snapshotFormat:'raw-retro-state-bytes (accepts a retro save-format object)',
  memoryRegions:[{name:platform==='gb'?'GbWorkRam':'SnesWorkRam',
   size:ramBytes,base:0,readable:true,writable:false,
   note:'a flat read window reported by the core. Bank structure is NOT '
    +'described by this interface, so a logical address here is not a bank '
    +'address and must not be treated as one'}],
  actionSpec:retroActions,
  readRam,readRamSparse,
  bulkReadVia:read?'core _lab_read_ram':'cpu.mem Proxy (slow fallback)',
  /* raw state bytes for research; a live save-format snapshot still restores */
  ...(()=>{const raw=rawSnapshotter(platform,core,()=>core.g._lab_state(),
    size=>core.g._lab_load_state(size),state=>core.fromJSON(state));
   return {snapshot:raw.snapshot,restore:raw.restore};})(),
  ports:platform==='snes'?2:1,
  press:(mask,frames,mask2)=>{
   for(let b=0;b<buttonCount;b++){
    (mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
    if(platform==='snes')(mask2&(1<<b)?core.buttonDown:core.buttonUp).call(core,2,b);}
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
  snapshotFormat:{nes:'jsnes-state-object',sega:'sega-state-object',
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
