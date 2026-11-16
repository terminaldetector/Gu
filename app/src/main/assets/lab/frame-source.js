/* F0 FrameSource: the newest emulator frame, straight from the core's frame buffer
   (not an Android screenshot, not the canvas), for a controller that runs beside
   the emulator.

   ONE SLOT, NEWEST WINS. publish() copies the core's reusable buffer into a
   preallocated slot. There is no queue: a frame nobody read before the next one
   arrives is counted as dropped, never delivered late. A consumer asks for the
   newest frame and gets its age; it can never fall behind on a backlog.

   EVERY FRAME SAYS WHAT IT IS: frameIndex (monotonic within an epoch), emuFrame
   (the core's frame counter) and emuTimeMs (emuFrame at the core's frame rate),
   wallTimeMs (performance.now() at publish), width, height, stride, format, epoch.
   Format 'rgbx8888-u32le': one little-endian uint32 per pixel, R in the low byte,
   as the four cores deliver it.

   EPOCHS. boundary() (ROM load, reset, savestate load, pause, platform switch)
   opens a new epoch and empties the slot, so a frame from before the boundary is
   never handed to a controller after it.

   COPIES ARE COUNTED. publish() copies once (the core reuses its buffer); take()
   is zero-copy and valid until the next publish; takeCopy() returns an
   ArrayBuffer the caller owns (for postMessage transfer to a worker or a native
   bridge). stats() reports every byte copied.

   The emulator never waits for a consumer: publish() is O(pixels), allocation-free
   after the first frame of a size, and does nothing else. */
(function(root){'use strict';
const FORMAT='rgbx8888-u32le';
function create(options){
 const o=options||{};
 const clock=typeof o.now==='function'?o.now:()=>(typeof performance!=='undefined'?performance.now():Date.now());
 let epoch=0,frameIndex=-1,slot=null,unread=false,fps=Number.isFinite(o.fps)&&o.fps>0?o.fps:60;
 const stats={published:0,taken:0,copiesTaken:0,dropped:0,bytesCopied:0,boundaries:0,epoch:0};
 function ensure(width,height){
  if(slot&&slot.width===width&&slot.height===height)return slot;
  slot={width,height,stride:width,data:new Uint32Array(width*height)};return slot;
 }
 function publish(buffer,width,height,meta){
  const m=meta||{};
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||!buffer||buffer.length<width*height)
   throw Error('FrameSource: frame '+width+'x'+height+' does not fit its buffer');
  const s=ensure(width,height);
  if(unread)stats.dropped++;
  if(buffer instanceof Uint32Array||buffer instanceof Int32Array)s.data.set(buffer.length===width*height?buffer:buffer.subarray(0,width*height));
  else for(let i=0;i<width*height;i++)s.data[i]=buffer[i]>>>0;
  stats.bytesCopied+=width*height*4;
  frameIndex++;stats.published++;unread=true;
  s.frameIndex=frameIndex;s.epoch=epoch;s.wallTimeMs=clock();
  s.emuFrame=Number.isInteger(m.emuFrame)?m.emuFrame:null;
  if(Number.isFinite(m.fps)&&m.fps>0)fps=m.fps;
  s.emuTimeMs=s.emuFrame===null?null:s.emuFrame*1000/fps;
  return frameIndex;
 }
 const describe=s=>({frameIndex:s.frameIndex,epoch:s.epoch,emuFrame:s.emuFrame,emuTimeMs:s.emuTimeMs,
  wallTimeMs:s.wallTimeMs,width:s.width,height:s.height,stride:s.stride,format:FORMAT});
 /* zero-copy: the view is overwritten by the next publish() */
 function take(){
  /* the newest frame of this epoch, even if already read: the caller compares
     frameIndex to skip a repeat */
  if(!slot||slot.frameIndex===undefined||slot.epoch!==epoch)return null;
  unread=false;stats.taken++;
  return {...describe(slot),ageMs:clock()-slot.wallTimeMs,data:slot.data};
 }
 /* an owned copy, transferable to a worker or a native bridge */
 function takeCopy(){
  const f=take();if(!f)return null;
  const copy=f.data.slice();stats.copiesTaken++;stats.bytesCopied+=copy.byteLength;
  return {...f,data:copy,buffer:copy.buffer};
 }
 function peek(){return slot&&slot.frameIndex!==undefined&&slot.epoch===epoch?describe(slot):null;}
 function boundary(reason){
  epoch++;stats.boundaries++;stats.epoch=epoch;frameIndex=-1;unread=false;
  if(slot)slot.frameIndex=undefined;
  return epoch;
 }
 return Object.freeze({FORMAT,publish,take,takeCopy,peek,boundary,
  epoch:()=>epoch,frameIndex:()=>frameIndex,stats:()=>({...stats})});
}
const api={FORMAT,create};
root.FlyFrameSource=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
