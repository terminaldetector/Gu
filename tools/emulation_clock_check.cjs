'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Clock=require('../app/src/main/assets/lab/emulation-clock.js');
const code=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
// Execute the actual production pump with virtual monotonic time and a measured
// cost for each real core frame. A 3 ms core exposes the old 4 ms-per-RAF ceiling.
function trial(rate,{cost=3,seconds=5,lockstep=false,pending=true,fps=60}={}){
 const queue=[],s={now:0,frames:0,presents:0,emulationMeasureState:'',emulationRate:rate,emulationClock:new Clock(),acceleratedFrames:0,deferredVideo:false,liveFps:0,fpsFrames:0,fpsAt:0,measuredFrames:0,
  labPlatform:'sega',nes:{fps},playing:true,loaded:true,romLoading:false,configuring:false,connected:true,pendingToken:pending?1:null,document:{hidden:false},window:{},$:()=>({value:lockstep?'lockstep':'realtime'}),
  performance:{now:()=>s.now},setTimeout(fn,delay){queue.push({at:s.now+delay,fn});},
  MessageChannel:class {constructor(){this.port1={};this.port2={postMessage:()=>queue.push({at:s.now,fn:()=>this.port1.onmessage()})};}},
  advanceFrame(){s.frames++;s.measuredFrames++;s.now+=cost;}
 };
 vm.createContext(s);vm.runInContext(code.slice(code.indexOf('const emulationChannel='),code.indexOf('window.labPause=function')),s);
 while(queue.length){queue.sort((a,b)=>a.at-b.at);const task=queue.shift();if(task.at>seconds*1000||s.now>seconds*1000)break;s.now=Math.max(s.now,task.at);task.fn();}
 return s;
}
for(const rate of [1,2,3]){const s=trial(rate);assert(Math.abs(s.frames-rate*60*5)<=2,'actual '+rate+'× deadlines: '+s.frames);}
for(const fps of [50,59.7275,60])for(const rate of [1,2,3,5,10]){const s=trial(rate,{cost:.25,fps});assert(Math.abs(s.frames-rate*fps*5)<=2,'PAL/GB/NTSC rate '+fps+' ×'+rate+': '+s.frames);}
assert.equal(trial(3,{lockstep:true}).frames,0,'lockstep deliberately waits');
const stalled=trial(10);assert(stalled.frames<10*60*5&&stalled.frames>1600,'overloaded core executes capacity, never fabricates frames');assert(stalled.emulationClock.droppedMs>0,'bounded lag is accounted');
const clock=new Clock();clock.configure(0,60,3,true);clock.configure(3600000,60,3,true);let n=0;while(clock.due(3600000)){clock.step();n++;}assert(n<=46,'tab suspension cannot replay an hour');clock.configure(3600000,60,3,false);clock.configure(3600000,60,3,true);assert(!clock.due(3600000),'resume starts a fresh deadline');
const ui={labPlatform:'nes',nes:{},liveFps:60,emulationRate:3,playing:true};vm.createContext(ui);vm.runInContext(code.slice(code.indexOf('function emulationSpeedLabel'),code.indexOf('function loop(now)')),ui);assert.equal(ui.emulationSpeedLabel(),'1.00× / 3×','a slow device cannot display a false ×3');ui.liveFps=180;assert.equal(ui.emulationSpeedLabel(),'×3');
console.log('PASS: production pump ×1/×2/×3 exact at 3 ms/core frame independent of RAF; ×1–×10 PAL/GB/NTSC, pending GPU, overload accounting, suspension, and truthful speed label');
