/* F1 ActionSink: how a controller's decision reaches the emulated pad, and when.

   A controller submits {port, mask, sourceFrameIndex, epoch, holdFrames,
   modelRevision, createdAt}. The emulator calls apply(frameIndex) once at the
   start of every emulated frame and gets the agent mask per port for that frame.

   NOTHING STALE IS EXECUTED BLINDLY. A decision made in another epoch (before a
   ROM load, reset, savestate load, pause or platform switch) is refused; so is one
   whose source frame is more than maxStaleFrames behind the frame it would be
   applied on. Both are counted.
   NO QUEUE. One pending decision per port: a newer one supersedes it (counted).
   HOLDING IS EXPLICIT. An applied mask is held for holdFrames and then released,
   so a 30 Hz controller presses buttons for a defined time instead of flickering
   them every frame, and a controller that goes silent does not leave a button
   held forever.
   THE HUMAN WINS. manualOverride(port) drops that port's pending and held agent
   input; the page calls it whenever a human presses a button on that port.
   LATENCY IS MEASURED AT APPLICATION: frames from the source frame to the frame
   the mask is applied on, and wall milliseconds from createdAt (if given) or
   from submission to application - the decision's real age when it takes effect.

   The sink never blocks the emulator: apply() is O(ports) and allocation-free. */
(function(root){'use strict';
function create(options){
 const o=options||{};
 const buttons=o.buttons===12?12:8,full=(1<<buttons)-1;
 const ports=Array.isArray(o.ports)&&o.ports.length?o.ports.slice():[1,2];
 const maxStale=Number.isInteger(o.maxStaleFrames)&&o.maxStaleFrames>=0?o.maxStaleFrames:6;
 const maxHold=Number.isInteger(o.maxHoldFrames)&&o.maxHoldFrames>0?o.maxHoldFrames:60;
 const clock=typeof o.now==='function'?o.now:()=>(typeof performance!=='undefined'?performance.now():Date.now());
 let epoch=0,paused=false,lastFrame=-1;
 const pending=new Map(),active=new Map();
 const counts={submitted:0,accepted:0,applied:0,superseded:0,cancelled:0,released:0,rejected:{}};
 const latencyFrames=[],latencyMs=[];const LIMIT=4096;
 const reject=(code,reason)=>{counts.rejected[code]=(counts.rejected[code]||0)+1;return {accepted:false,code,reason};};
 function submit(decision){
  counts.submitted++;
  const d=decision||{};
  if(!ports.includes(d.port))return reject('malformed','unknown port '+d.port);
  if(!Number.isInteger(d.mask)||d.mask<0||(d.mask&~full))return reject('malformed','mask outside '+buttons+' buttons');
  if(!Number.isInteger(d.sourceFrameIndex)||d.sourceFrameIndex<0)return reject('malformed','sourceFrameIndex is required');
  if(d.epoch!==epoch)return reject('stale-epoch','decided in epoch '+d.epoch+', the emulator is in epoch '+epoch);
  if(paused)return reject('paused','the emulator is paused');
  if(lastFrame>=0&&d.sourceFrameIndex>lastFrame+1)return reject('malformed','source frame '+d.sourceFrameIndex+' is in the future');
  if(lastFrame>=0&&lastFrame+1-d.sourceFrameIndex>maxStale)return reject('stale','source frame '+d.sourceFrameIndex+' is '+(lastFrame+1-d.sourceFrameIndex)+' frames old');
  const hold=Number.isInteger(d.holdFrames)&&d.holdFrames>0?Math.min(maxHold,d.holdFrames):1;
  if(pending.has(d.port))counts.superseded++;
  pending.set(d.port,{port:d.port,mask:d.mask,hold,sourceFrameIndex:d.sourceFrameIndex,modelRevision:d.modelRevision||null,
   createdAt:Number.isFinite(d.createdAt)?d.createdAt:clock()});
  counts.accepted++;return {accepted:true,code:'pending'};
 }
 /* called once per emulated frame, before the core runs it */
 function apply(frameIndex){
  lastFrame=frameIndex;const out={};
  for(const port of ports){
   const p=pending.get(port);
   if(p){
    pending.delete(port);
    if(frameIndex-p.sourceFrameIndex>maxStale){counts.rejected.stale=(counts.rejected.stale||0)+1;}
    else{
     active.set(port,{mask:p.mask,until:frameIndex+p.hold,sourceFrameIndex:p.sourceFrameIndex,modelRevision:p.modelRevision});
     counts.applied++;
     if(latencyFrames.length<LIMIT){latencyFrames.push(frameIndex-p.sourceFrameIndex);latencyMs.push(clock()-p.createdAt);}
    }
   }
   const a=active.get(port);
   if(a&&frameIndex<a.until)out[port]=a.mask;
   else{if(a){active.delete(port);counts.released++;}out[port]=0;}
  }
  return out;
 }
 function cancelPort(port){let n=0;if(pending.delete(port))n++;if(active.delete(port))n++;counts.cancelled+=n;return n;}
 function manualOverride(port){return cancelPort(port);}
 function cancel(reason){let n=0;for(const port of ports)n+=cancelPort(port);return n;}
 function boundary(reason){epoch++;cancel(reason);lastFrame=-1;return epoch;}
 function setPaused(value){paused=!!value;if(paused)cancel('pause');}
 const pct=(xs,q)=>{if(!xs.length)return null;const s=xs.slice().sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*(s.length-1)+0.5))];};
 function stats(){return {epoch,paused,buttons,ports:ports.slice(),maxStaleFrames:maxStale,counts:JSON.parse(JSON.stringify(counts)),
  latencyFrames:{n:latencyFrames.length,p50:pct(latencyFrames,.5),p95:pct(latencyFrames,.95),max:latencyFrames.length?Math.max(...latencyFrames):null},
  latencyMs:{n:latencyMs.length,p50:pct(latencyMs,.5),p95:pct(latencyMs,.95),max:latencyMs.length?Math.max(...latencyMs):null}};}
 return Object.freeze({submit,apply,manualOverride,cancel,boundary,setPaused,stats,epoch:()=>epoch,lastFrame:()=>lastFrame,
  holding:port=>active.has(port),pending:port=>pending.has(port)});
}
const api={create};
root.FlyActionSink=api;
if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
