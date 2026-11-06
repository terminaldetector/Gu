/* An INDEPENDENT NES driver for AGOD, in the browser.

   WHY THIS FILE EXISTS. agod-experimental.js exposes session(driver, options)
   and FlyAgodPipeline.run() needs a driver with restore / run / readRam /
   snapshot / stateHash. Nothing in the running lab produced one, so the
   research contour was reachable only from Node check scripts. This is that
   missing driver.

   IT NEVER TOUCHES THE LIVE GAME. AGOD restores states and runs thousands of
   frames; doing that on the instance the player is using would corrupt the
   session. So create() builds its OWN jsnes core from the SAME ROM bytes, and
   optionally adopts the live core's state by value through a serialised
   snapshot. The live core is never read after that and never written at all.
   The accompanying end-to-end test hashes the live state before and after a
   research run and requires it unchanged.

   The mechanism is the one already used in lab.js for the core probe and in
   tools/agod_real_game_check.cjs and tools/agod_s11b_host.cjs for the research
   hosts; this is the browser-side form of it, with no Node dependencies.

   stateHash is NOT cryptographic. agod-causal.js uses it only to tell declared
   start states apart and to reject duplicates, so a fast synchronous 53-bit
   FNV-1a over the observed RAM is what the contract needs. crypto.subtle is
   asynchronous and cannot be called from a synchronous driver method. */
(function(root){'use strict';
const DRIVER_REVISION='agod-nes-driver-1';
const DEFAULT_RAM_BYTES=0x800;

/* FNV-1a over the observed bytes, carried in two 32-bit halves so the result
   stays an exact integer in a double. Identity only - see the note above. */
function ramHash(bytes){
 let high=0x811c9dc5,low=0x811c9dc5;
 for(let i=0;i<bytes.length;i++){
  const byte=bytes[i];
  low=(low^byte)>>>0;low=Math.imul(low,0x01000193)>>>0;
  if((i&1)===0){high=(high^byte)>>>0;high=Math.imul(high,0x01000193)>>>0;}
 }
 return (high.toString(16).padStart(8,'0')+low.toString(16).padStart(8,'0'));
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

/* jsnes loadROM wants a binary string, which is how lab.js feeds it too. */
function toBinaryString(bytes){
 let out='';
 for(let i=0;i<bytes.length;i+=0x8000)
  out+=String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+0x8000,bytes.length)));
 return out;
}

/* options:
     romBase64 | romBinaryString | romBytes   the cartridge, by value
     jsnes                                    the jsnes module (default root.jsnes)
     ramBytes                                 observed RAM width, default 0x800
     frameBudget                              hard ceiling, enforced inside run()
     startSnapshot                            a serialised state to adopt, by value
     entry                                    {bootFrames,startPulses,gapFrames,
                                               settleFrames,startMask,hold}
     onFrames(count)                          metering callback
*/
function create(options){
 const opts=options||{};
 const jsnes=opts.jsnes||root.jsnes;
 if(!jsnes||typeof jsnes.NES!=='function')
  throw new Error('jsnes is not available in this context');
 const ramBytes=Number.isInteger(opts.ramBytes)?opts.ramBytes:DEFAULT_RAM_BYTES;
 const frameBudget=Number.isInteger(opts.frameBudget)?opts.frameBudget:null;

 const romBinary=opts.romBinaryString
  ||(opts.romBase64?toBinaryString(decodeBase64(opts.romBase64))
   :(opts.romBytes?toBinaryString(opts.romBytes instanceof Uint8Array
     ?opts.romBytes:new Uint8Array(opts.romBytes)):null));
 if(!romBinary)throw new Error('create() needs romBase64, romBinaryString or romBytes');

 /* No video, no audio: the research core renders nothing and is never shown. */
 const core=new jsnes.NES({onFrame(){},onAudioSample(){}});
 core.loadROM(romBinary);

 let framesRun=0,disposed=false;
 const guard=()=>{if(disposed)throw new Error('this research driver has been disposed');};
 const press=(mask,count)=>{
  guard();
  if(frameBudget!==null&&framesRun+count>frameBudget)
   throw new Error('FRAME_BUDGET_EXCEEDED: this arm would bring the research run to '
    +(framesRun+count)+' emulated frames, over the declared budget of '+frameBudget);
  for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<count;i++)core.frame();
  framesRun+=count;
  if(opts.onFrames)opts.onFrames(count);
 };

 /* Adopt the live core's state BY VALUE, or boot this core independently.
    Either way nothing is held that refers back to the live instance. */
 if(opts.startSnapshot){
  core.fromJSON(typeof opts.startSnapshot==='string'
   ?JSON.parse(opts.startSnapshot):opts.startSnapshot);
 }else{
  const entry=opts.entry||{};
  const hold=Number.isInteger(entry.hold)?entry.hold:4;
  press(0,Number.isInteger(entry.bootFrames)?entry.bootFrames:60);
  for(let i=0;i<(entry.startPulses||0);i++){
   press(Number.isInteger(entry.startMask)?entry.startMask:8,hold);
   press(0,entry.gapFrames||0);
  }
  if(entry.settleFrames)press(0,entry.settleFrames);
 }

 const readRam=()=>{guard();return core.cpu.mem.slice(0,ramBytes);};
 const driver={
  restore(snapshot){guard();core.fromJSON(JSON.parse(snapshot));},
  run(mask,frames){press(mask,frames);},
  readRam,
  snapshot(){guard();return JSON.stringify(core.toJSON());},
  stateHash(){return ramHash(readRam());},
  /* The pipeline's consumer stage asks for poke and declares NOT-SUPPORTED
     without it, so the NES driver provides it. */
  poke(address,value){guard();core.cpu.mem[address]=value&255;}};

 return {DRIVER_REVISION,driver,
  framesRun(){return framesRun;},
  frameBudget,
  budgetRemaining(){return frameBudget===null?null:frameBudget-framesRun;},
  ramBytes,
  /* Drops the reference to the core so the emulator can be collected. The
     driver refuses every call afterwards rather than acting on a dead core. */
  dispose(){disposed=true;}};
}

const api={DRIVER_REVISION,DEFAULT_RAM_BYTES,create,ramHash};
root.FlyAgodNesDriver=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
