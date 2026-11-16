'use strict';
// F0/F1 gate: FrameSource (newest-frame slot) and ActionSink (frame-bound decisions),
// as units and wired into the real lab.js on the real NES demo ROM. Host only: the
// latencies here are emulated-frame counts in Node, not Android measurements.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const LAB=path.join(__dirname,'../app/src/main/assets/lab');
const FS=require(path.join(LAB,'frame-source.js')),AS=require(path.join(LAB,'action-sink.js'));
const NES=require(path.join(LAB,'jsnes.min.js')).NES;
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};

/* ---------------- FrameSource ---------------- */
{
 let t=0;const src=FS.create({now:()=>t});
 ok(src.take()===null&&src.peek()===null,'an empty source has no frame');
 const a=new Uint32Array(16).fill(7);t=5;src.publish(a,4,4,{emuFrame:10,fps:60});
 a.fill(9);// the core reuses its buffer: the slot must hold its own copy
 t=8;const f=src.take();
 ok(f.frameIndex===0&&f.epoch===0&&f.emuFrame===10&&Math.abs(f.emuTimeMs-10*1000/60)<1e-9&&f.wallTimeMs===5&&f.ageMs===3,'a frame carries index, epoch, emulated frame/time, wall time and age');
 ok(f.width===4&&f.height===4&&f.stride===4&&f.format==='rgbx8888-u32le'&&f.data[0]===7,'and its geometry and format; the slot holds a copy, not the core buffer');
 for(let k=0;k<5;k++)src.publish(new Uint32Array(16).fill(k),4,4,{emuFrame:11+k});
 const g=src.take();
 ok(g.frameIndex===5&&g.data[0]===4,'take() gives the newest frame, never a backlog');
 ok(src.stats().dropped===4,'frames overwritten unread are counted as dropped (4)');
 ok(src.take().frameIndex===5,'taking again returns the same newest frame; the caller compares frameIndex');
 const c=src.takeCopy();src.publish(new Uint32Array(16).fill(99),4,4,{emuFrame:20});
 ok(c.data[0]===4&&c.buffer instanceof ArrayBuffer,'takeCopy() is owned: a later publish does not touch it');
 ok(src.stats().bytesCopied===7*64+64,'every copied byte is counted (7 publishes + 1 owned copy)');
 const e=src.boundary('load-state');
 ok(e===1&&src.take()===null&&src.peek()===null,'a boundary opens a new epoch and empties the slot');
 src.publish(new Uint32Array(16),4,4,{emuFrame:0});
 ok(src.take().frameIndex===0&&src.take().epoch===1,'frame indices restart in the new epoch');
 let threw=false;try{src.publish(new Uint32Array(3),4,4,{});}catch(_){threw=true;}
 ok(threw,'a frame that does not fit its buffer is refused');
}
/* ---------------- ActionSink ---------------- */
{
 let t=0;const sink=AS.create({buttons:8,ports:[1,2],maxStaleFrames:3,now:()=>t});
 const d=(x)=>({port:1,mask:128,sourceFrameIndex:0,epoch:sink.epoch(),holdFrames:2,createdAt:0,...x});
 ok(sink.submit(d({port:3})).code==='malformed'&&sink.submit(d({mask:256})).code==='malformed','an unknown port or a mask outside the pad is refused');
 ok(sink.submit(d({epoch:7})).code==='stale-epoch','a decision from another epoch is refused');
 sink.apply(0);
 ok(sink.submit(d({sourceFrameIndex:5})).code==='malformed','a decision about a frame not yet produced is refused');
 ok(sink.submit(d({sourceFrameIndex:0})).accepted,'a fresh decision is accepted');
 ok(sink.submit(d({sourceFrameIndex:0,mask:64})).accepted&&sink.stats().counts.superseded===1,'a newer decision for the same port supersedes the pending one (no queue)');
 t=12;let m=sink.apply(1);
 ok(m[1]===64&&m[2]===0,'apply() presses the newest decision on its port only');
 ok(sink.stats().latencyFrames.p50===1&&sink.stats().latencyMs.p50===12,'latency is measured at application: 1 frame, 12 ms');
 ok(sink.apply(2)[1]===64&&sink.apply(3)[1]===0&&sink.stats().counts.released===1,'the mask is held for holdFrames (2) and then released');
 for(let k=4;k<10;k++)sink.apply(k);
 ok(sink.submit(d({sourceFrameIndex:5})).code==='stale','a decision whose source frame is more than maxStaleFrames old is refused');
 sink.submit(d({sourceFrameIndex:9,holdFrames:30}));sink.apply(10);
 ok(sink.holding(1)&&sink.manualOverride(1)===1&&!sink.holding(1)&&sink.apply(11)[1]===0,'manualOverride() releases the controller on that port at once');
 sink.submit(d({sourceFrameIndex:11,port:2,mask:8,holdFrames:30}));sink.apply(12);
 const ep=sink.boundary('rom-loaded');
 ok(ep===1&&!sink.holding(2)&&sink.apply(0)[2]===0,'a boundary releases every port and opens a new epoch');
 ok(sink.submit(d({epoch:0})).code==='stale-epoch','decisions from before the boundary are refused after it');
 sink.setPaused(true);ok(sink.submit(d({})).code==='paused','nothing is accepted while paused');sink.setPaused(false);
 ok(AS.create({buttons:12}).submit({port:1,mask:4095,sourceFrameIndex:0,epoch:0}).accepted,'12-button pads take a 12-bit mask');
}
/* ---------------- integration: the real lab.js on the real NES ---------------- */
const code=fs.readFileSync(path.join(LAB,'lab.js'),'utf8');
const slice=(start,end)=>{const a=code.indexOf(start),b=code.indexOf(end,a);assert(a>=0&&b>a,'lab.js section '+start);return code.slice(a,b);};
const rom=Buffer.from(require(path.join(LAB,'demo-rom.json')).base64,'base64').toString('binary');
function fixture({withPorts=true}={}){
 const events=[],logged=[],before=[];let clock=0;
 const s={window:{},performance:{now:()=>clock+=0.5},$:()=>({}),labPlatform:'nes',loaded:true,romLoading:false,playing:true,generation:1,frame:0,
  manualMask:0,appliedMask:0,measuredCpuMs:0,measuredFrames:0,log(){},status(){},events,logged,before,
  screen:{width:256,height:240,style:{}},context:{createImageData:()=>({data:new Uint8ClampedArray(4)})},image:null,fitVideo(){},deferredVideo:true,videoDirty:false,latestVideo:null};
 s.window.guLogger={event:(name)=>logged.push(name),coreFrame(){}};
 s.window.gameObjectiveDiscovery={beforeFrame:m=>before.push(m.action),observeFrame(){},boundary(){}};
 if(withPorts){s.window.labFrameSource=FS.create({now:()=>clock});s.window.labActionSink=AS.create({buttons:8,ports:[1,2],maxStaleFrames:4,now:()=>clock});}
 const core=new NES({onFrame:b=>s.onVideoFrame(b,256,240),onAudioSample(){}});core.loadROM(rom);
 const up=core.buttonUp.bind(core),down=core.buttonDown.bind(core);
 core.buttonUp=(p,b)=>{events.push(['up',p,b]);up(p,b);};core.buttonDown=(p,b)=>{events.push(['down',p,b]);down(p,b);};
 s.nes=core;vm.createContext(s);
 vm.runInContext(slice('function emulatorBoundary','/* a session id'),s);
 vm.runInContext(slice('function normalizeMask','/* the latest frame is kept'),s);
 vm.runInContext(slice('function onVideoFrame','function presentVideo'),s);
 vm.runInContext(slice('window.labError=function','function emulationSpeedLabel'),s);
 return s;
}
const ram=s=>Array.from(s.nes.cpu.mem.slice(0,0x800));
{
 const plain=fixture({withPorts:false});for(let i=0;i<30;i++)plain.advanceFrame(i);
 const wired=fixture();for(let i=0;i<30;i++)wired.advanceFrame(i);
 ok(JSON.stringify(ram(plain))===JSON.stringify(ram(wired)),'installing the ports without a controller does not change the game');
 ok(wired.window.labFrameSource.stats().published===30&&wired.window.labFrameSource.take().emuFrame===30,'every core frame is published with its emulated frame number');
}
{
 const s=fixture(),src=s.window.labFrameSource,sink=s.window.labActionSink;
 for(let i=0;i<5;i++)s.advanceFrame(i);
 const f=src.take();s.events.length=0;
 ok(sink.submit({port:1,mask:128,sourceFrameIndex:f.frameIndex,epoch:sink.epoch(),holdFrames:3}).accepted&&sink.submit({port:2,mask:8,sourceFrameIndex:f.frameIndex,epoch:sink.epoch(),holdFrames:3}).accepted,'a controller decides on the newest frame for both ports');
 s.advanceFrame(5);
 ok(s.events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===7)&&s.events.some(e=>e[0]==='down'&&e[1]===2&&e[2]===3),'the next emulated frame runs with Right on port 1 and Start on port 2');
 ok(sink.stats().latencyFrames.p50===1,'frame -> applied action: 1 emulated frame');
 ok(s.before.at(-1).agentMask===128&&s.before.at(-1).humanMask===0&&s.before.at(-1).manualOverride===false,'AGOD sees the agent mask as agent input, not human');
 s.events.length=0;s.manualMask=1;s.updateButtons();s.advanceFrame(6);
 ok(s.events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===0)&&s.events.some(e=>e[0]==='up'&&e[1]===1&&e[2]===7),'a human press takes port 1 from the controller (A down, the agent Right released)');
 const human=s.before.at(-1);
 ok(human.humanMask===1&&human.agentMask===0&&human.mask===1,'AGOD sees the human press as the executed port-1 action');
 ok(!s.events.some(e=>e[1]===2&&e[0]==='up'),'and port 2 stays with the controller');
 const during=src.take();s.events.length=0;sink.submit({port:1,mask:128,sourceFrameIndex:during.frameIndex,epoch:sink.epoch(),holdFrames:3});s.advanceFrame(7);
 ok(!s.events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===7)&&vm.runInContext('appliedMask',s)===1,'while the human holds port 1, a new controller decision for it is not executed');
 s.manualMask=0;s.updateButtons();for(let i=8;i<12;i++)s.advanceFrame(i);
 ok(vm.runInContext('appliedMask2',s)===0,'port 2 is released when the hold ends and no new decision came');
 const late=src.take();for(let i=12;i<20;i++)s.advanceFrame(i);
 ok(sink.submit({port:1,mask:64,sourceFrameIndex:late.frameIndex,epoch:sink.epoch(),holdFrames:2}).code==='stale','a decision about a frame 8 frames old is refused, not executed late');
 const now=src.take();sink.submit({port:1,mask:64,sourceFrameIndex:now.frameIndex,epoch:sink.epoch(),holdFrames:30});s.advanceFrame(20);
 const held=s.appliedMask;s.emulatorBoundary('load-state');s.advanceFrame(21);
 ok(held===64&&s.appliedMask===0,'a savestate boundary releases the held controller input');
 ok(src.epoch()===1&&sink.epoch()===1&&src.peek().frameIndex===0,'the boundary moves both ports to the next epoch');
 ok(sink.submit({port:1,mask:64,sourceFrameIndex:0,epoch:0,holdFrames:2}).code==='stale-epoch','a decision made before the boundary is refused after it');
}
{
 const s=fixture(),src=s.window.labFrameSource;
 for(let i=0;i<60;i++){s.advanceFrame(i);if(i%3===2){const f=src.take();assert(f.frameIndex===i);}}
 const st=src.stats();
 ok(st.published===60&&st.taken===20&&st.dropped===40,'a controller reading every third frame drops the two in between (40/60) instead of queueing them');
 ok(st.bytesCopied===60*256*240*4,'the emulator side copies one frame per frame (60 x 240 KiB), nothing more');
}
{
 const s=fixture();s.window.labActionSink={apply(){throw Error('controller exploded');},holding:()=>false,pending:()=>false,manualOverride(){},boundary(){}};
 const ref=fixture({withPorts:false});
 s.window.labFrameSource={publish(){throw Error('frame port exploded');},frameIndex:()=>0,boundary(){}};
 for(let i=0;i<30;i++){s.advanceFrame(i);ref.advanceFrame(i);}
 ok(s.frame===30&&s.playing===true&&JSON.stringify(ram(s))===JSON.stringify(ram(ref)),'a failing controller and a failing frame port do not stop or alter the game');
 ok(s.logged.includes('agent.action-sink-error')&&s.logged.includes('agent.frame-source-error'),'both failures are logged');
 s.manualMask=128;s.events.length=0;s.advanceFrame(30);
 ok(s.events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===7),'human input keeps working beside a failed controller');
}
console.log(out.join('\n'));
console.log(fail.length?'FAIL - '+fail.length+' of '+out.length:'PASS - '+out.length+'/'+out.length+' F0/F1 port invariants (units + real lab.js on the real NES; host, not Android)');
process.exitCode=fail.length?1:0;
