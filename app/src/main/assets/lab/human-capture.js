/* Input events and actually executed actions have separate clocks and provenance. */
(function(root){'use strict';
const copy=x=>JSON.parse(JSON.stringify(x));
class Capture {
 constructor(emit){this.emit=emit;this.gameMs=0;this.block=null;this.lastInput=null;this.sequence=0;}
 record(event){this.emit({...event,sequence:this.sequence++,human:true});}
 input(mask,state){
  if(mask===this.lastInput)return;
  this.flush();this.lastInput=mask;
  this.record({kind:'input',mask,frame:state.frame,at:state.at,wallMs:state.wallMs,gameMs:this.gameMs});
 }
 // Call only AFTER a successful emulator frame, with the state from BEFORE it.
 commit(seconds,state){
  if(!Number.isFinite(seconds)||seconds<=0||seconds>1)throw Error('Invalid human frame duration');
  if(this.block&&this.block.mask!==state.mask)this.flush();
  if(!this.block)this.block={...copy(state),kind:'sample',seconds:0,frames:0,gameMs:this.gameMs};
  this.block.seconds+=seconds;this.block.frames++;this.gameMs+=seconds*1000;
  this.block.endFrame=state.frame+1;this.block.endGameMs=this.gameMs;
  if(this.block.seconds+1e-9>=.1)this.flush();
 }
 flush(){if(!this.block)return;const event=this.block;this.block=null;this.record(event);}
 stop(){this.flush();}
}
root.FlyHumanCapture=Capture;if(typeof module!=='undefined')module.exports=Capture;
})(typeof window==='undefined'?globalThis:window);
