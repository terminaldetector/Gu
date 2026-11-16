'use strict';
// Gate of the minimal core (replaces neural_isolation_check and console_reset_check,
// archived on branch archive/gu-2be2dae-male-cns-fdb). "The game runs independently
// of the agent" - checked on the production code, not on a mock of it:
//   1. the real lab.js frame step and human input path run the real NES demo ROM with
//      no agent object anywhere in the page;
//   2. a failing AGOD hook (beforeFrame / observeFrame / boundary) never stops or
//      skips a frame; a failing core does stop, and is reported as an emulator error;
//   3. the page calls only emulator-host bridge methods, each declared by the Android
//      activity, and exposes no agent entry points (risk R6 of the reset audit).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const NES=require('../app/src/main/assets/lab/jsnes.min.js').NES;
const LAB=path.join(__dirname,'../app/src/main/assets/lab');
const code=fs.readFileSync(path.join(LAB,'lab.js'),'utf8');
const slice=(start,end)=>{const a=code.indexOf(start),b=code.indexOf(end,a);assert(a>=0&&b>a,'lab.js section '+start);return code.slice(a,b);};
const rom=Buffer.from(require('../app/src/main/assets/lab/demo-rom.json').base64,'base64').toString('binary');

function fixture(){
 const events=[],logged=[],errors=[];
 const core=new NES({onFrame(){},onAudioSample(){}});core.loadROM(rom);
 const up=core.buttonUp.bind(core),down=core.buttonDown.bind(core);
 core.buttonUp=(p,b)=>{events.push(['up',p,b]);up(p,b);};core.buttonDown=(p,b)=>{events.push(['down',p,b]);down(p,b);};
 let clock=0;
 const s={window:{},performance:{now:()=>clock+=1},$:()=>({}),nes:core,labPlatform:'nes',loaded:true,romLoading:false,playing:true,generation:3,frame:0,
  manualMask:0,appliedMask:0,measuredCpuMs:0,measuredFrames:0,log(){},status(){},events,logged,errors};
 s.window.guLogger={event:(name,data,level)=>logged.push([name,level]),coreFrame(){}};
 vm.createContext(s);
 vm.runInContext(slice('function normalizeMask','/* the latest frame is kept'),s);
 vm.runInContext(slice('window.labError=function','function emulationSpeedLabel'),s);
 s.window.labError=(base=>data=>{errors.push(data.message);base(data);})(s.window.labError);
 return s;
}
const ram=s=>Array.from(s.nes.cpu.mem.slice(0,0x800));

/* 1. the game runs with no agent: frames advance, the human holds port 1 */
{
 const s=fixture();const before=ram(s);
 for(let i=0;i<120;i++)s.advanceFrame(i);
 assert.equal(s.frame,120,'120 frames of the real core with no agent');
 assert.notDeepEqual(ram(s),before,'the game state evolves');
 s.manualMask=128;s.advanceFrame(200);
 assert(s.events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===7),'manual Right reaches port 1 of the core');
 assert(!s.events.some(e=>e[1]===2),'nothing is pressed on port 2');
 s.manualMask=0;s.advanceFrame(201);
 assert(s.events.some(e=>e[0]==='up'&&e[1]===1&&e[2]===7),'release reaches the core');
 for(const name of ['labResult','labReady','labConfigured','labSystemButtons','labDualTelemetry','labAgentStatus','labNeuralSuspended','fdbAgent','dualAgents'])
  assert.equal(s.window[name],undefined,'no agent entry point: '+name);
}
/* the same input on two fresh runs gives the same game: the core is the only state */
{
 const run=()=>{const s=fixture();for(let i=0;i<90;i++){s.manualMask=i>30&&i<60?128:0;s.advanceFrame(i);}return ram(s);};
 assert.deepEqual(run(),run(),'deterministic without an agent');
}
/* 2. AGOD hook failures are isolated; the frame sequence is the one without hooks */
{
 const reference=fixture();for(let i=0;i<60;i++)reference.advanceFrame(i);
 for(const hook of ['beforeFrame','observeFrame']){
  const s=fixture();s.window.gameObjectiveDiscovery={beforeFrame(){if(hook==='beforeFrame')throw Error('agod '+hook);},observeFrame(){if(hook==='observeFrame')throw Error('agod '+hook);},boundary(){}};
  for(let i=0;i<60;i++)s.advanceFrame(i);
  assert.equal(s.frame,60,hook+' failure does not stop the emulator');assert.equal(s.playing,true);
  assert.deepEqual(ram(s),ram(reference),hook+' failure does not alter the game');
  assert.equal(s.logged.filter(x=>x[0]==='goal.discovery-error').length,60,'each '+hook+' failure is logged');
  assert.equal(s.errors.length,0,'a hook failure is not an emulator error');
 }
 const s=fixture();const seen=[];s.window.gameObjectiveDiscovery={beforeFrame(m){seen.push(['before',m.frame,m.action.agentMask,m.action.manualOverride]);},observeFrame(m){seen.push(['after',m.frame]);}};
 s.manualMask=1;s.advanceFrame(0);
 assert.deepEqual(seen,[['before',1,0,false],['after',1]],'AGOD sees each frame before and after, and no agent action');
}
/* a failing core stops and is reported as such */
{
 const s=fixture();s.nes.frame=()=>{throw Error('core exploded');};let boundary=null;s.window.gameObjectiveDiscovery={boundary(r){boundary=r;}};
 s.advanceFrame(0);
 assert.equal(s.playing,false,'a core failure stops the emulator');assert.equal(s.frame,0,'no frame is counted');
 assert.equal(boundary,'emulator-frame-error','AGOD is told the session ended');assert(s.errors.some(m=>/Ошибка эмулятора: core exploded/.test(m)),'reported as an emulator error');
}
/* 3. the bridge surface (R6): page -> Android methods, and Android -> page hooks */
{
 const html=fs.readFileSync(path.join(LAB,'index.html'),'utf8');
 const scripts=[...html.matchAll(/src="([^"]+)"/g)].map(m=>m[1]).filter(f=>fs.existsSync(path.join(LAB,f)));
 const java=fs.readFileSync(path.join(__dirname,'../app/src/main/java/org/node/flyconsole/NesLabActivity.java'),'utf8');
 const declared=new Set([...java.matchAll(/@JavascriptInterface public \S+ (\w+)\(/g)].map(m=>m[1]));
 const host=new Set(['acceptRom','controls','demo','diagnostics','finishExit','finishSystemSwitch','gameDisplay','lifecyclePending','lifecycleSaved','orientation','pickRom','recognizeScore','resume','romLibrary','stop','switchSystem']);
 const used=new Map();
 for(const f of scripts){
  const t=fs.readFileSync(path.join(LAB,f),'utf8');
  for(const m of t.matchAll(/FlyBridge\??\.(\w+)|nativeCall\('(\w+)'/g)){const name=m[1]||m[2];if(!used.has(name))used.set(name,new Set());used.get(name).add(f);}
  for(const banned of ['learner.','fdbAgent','dualAgents','connectBrain','labNeuralSuspended','graphIdentity','trainingView','learningUI'])
   assert(!t.includes(banned),f+' references the removed agent: '+banned);
 }
 for(const [name,files]of used){
  if(['events','export','status'].includes(name)&&[...files].every(f=>f==='session-logger.js'))continue;// logger rpc op names, carried by diagnostics()
  assert(host.has(name),'bridge call outside the emulator host: '+name+' in '+[...files].join(', '));
  assert(declared.has(name),'bridge call '+name+' has no @JavascriptInterface method in NesLabActivity');
 }
 const hooks=new Set(scripts.flatMap(f=>[...fs.readFileSync(path.join(LAB,f),'utf8').matchAll(/window\.(lab[A-Za-z]+)\s*=/g)].map(m=>m[1])));
 for(const h of ['labResult','labReady','labConfigured','labSystemButtons','labDualTelemetry','labAgentStatus','labImportModel','labRecording','labLayerSets','labEpisodeHistory','labEvaluationSeries'])
  assert(!hooks.has(h),'the page still defines the agent hook '+h);
}
console.log('PASS: the real NES runs and takes human input with no agent, deterministically; AGOD hook failures are isolated and logged, a core failure stops and is reported; the page calls only declared emulator-host bridge methods and defines no agent hooks');
