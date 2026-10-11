/* Wall-clock deadlines for actual core frames, independent of display refresh. */
'use strict';
class FlyEmulationClock {
 constructor(){this.running=false;this.next=0;this.interval=1000/60;this.rate=1;this.fps=60;this.droppedMs=0;}
 reset(now){this.next=now+this.interval;this.droppedMs=0;}
 configure(now,fps,rate,running){
  if(!Number.isFinite(now)||!Number.isFinite(fps)||fps<=0||!Number.isFinite(rate)||rate<1||rate>10)throw Error('Invalid emulator clock');
  const changed=this.fps!==fps||this.rate!==rate||this.running!==running;
  this.fps=fps;this.rate=rate;this.interval=1000/(fps*rate);this.running=running;
  if(changed||!running)this.reset(now);
  // A suspended tab must not replay minutes of unattended game time on resume.
  if(running&&now-this.next>250){this.droppedMs+=now-this.next-250;this.next=now-250;}
  return changed;
 }
 due(now){return this.running&&now+.001>=this.next;}
 step(){this.next+=this.interval;}
 delay(now){return this.running?Math.max(0,this.next-now):16;}
}
if(typeof module!=='undefined')module.exports=FlyEmulationClock;
