'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
const NES=require('../app/src/main/assets/lab/jsnes.min.js').NES;
function fixture(platform='nes'){
 const nodes={learnMode:{value:'train'},liveHints:{checked:false},systemButtons:{value:'auto'},outputs:{children:[]}},events=[];
 const core=platform==='nes'?new NES({onFrame(){},onAudioSample(){}}):{fps:60,frame(){},buttonDown(){},buttonUp(){}};
 if(platform==='nes')core.loadROM(Buffer.from(require('../app/src/main/assets/lab/demo-rom.json').base64,'base64').toString('binary'));
 const up=core.buttonUp.bind(core),down=core.buttonDown.bind(core);
 core.buttonUp=(p,b)=>{events.push(['up',p,b]);up(p,b);};core.buttonDown=(p,b)=>{events.push(['down',p,b]);down(p,b);};
 const s={window:{},Date,performance:{now:()=>100},$:id=>nodes[id]||(nodes[id]={}),nes:core,labPlatform:platform,loaded:true,romLoading:false,playing:true,connected:true,configuring:false,generation:7,pendingToken:42,frame:0,brainMask:128,manualMask:0,gmodeMode:'off',appliedMask:0,appliedHumanMask:0,appliedAgentMask:0,appliedDualMasks:[0,0],dualOverrides:[false,false],sampledFdbOutcome:{},fdbExperience:[{}],pendingFdbReplay:[{}],benchmark:null,measuredCpuMs:0,measuredFrames:0,brainGameAge:0,logs:[],learningBoundary(){s.window.fdbAgent?.boundary();},log:text=>s.logs.push(text),status:text=>s.lastStatus=text,updateGmodeHud(){},sampleFrame(){},checkBrainHold(){},learnedButtons(){return 128;},learningStats(){s.statsCalls++;},statsCalls:0,acceleratedFrames:0,brainExpired:false,lastResponse:0,lastWindowWall:0,measuredWindows:0,measuredNetworkMs:0,requestedConfiguration:null};
 vm.createContext(s);
 for(const [start,end] of [['function releaseBrain','function updateActionHoldInfo'],['function agentAllowedMask','function rgbaAndRetina'],['window.labError=function','function ids'],['window.labResult=function','window.labDualTelemetry='],['function advanceFrame','function emulationSpeedLabel']])vm.runInContext(code.slice(code.indexOf(start),code.indexOf(end,code.indexOf(start))),s);
 s.updateButtons();events.length=0;
 return {s,nodes,events,core};
}
for(const platform of ['nes','sega','gb','snes'])for(const cause of ['inference','plasticity','observation']){
 const {s,events,core}=fixture(platform),identity=core;
 s.window.fdbAgent={boundary(){},frame(){if(cause==='plasticity')throw Error('plasticity exploded');}};
 s.window.humanTeaching={beforeFrame(){if(cause==='observation')throw Error('observation exploded');return {};},commit(){},stop(){}};
 s.sampleFrame=()=>{if(cause==='inference')throw Error('inference exploded');};
 s.advanceFrame(100);
 assert.equal(s.playing,true,platform+' must continue after '+cause);assert.equal(s.connected,false);assert.equal(s.nes,identity);assert.equal(s.frame,1);assert.equal(s.pendingToken,null);assert.equal(s.brainMask,0);assert(s.generation>7);
 assert.match(s.window.labAgentFailure.message,new RegExp(cause));assert(events.some(x=>x[0]==='up'&&x[1]===1&&x[2]===7),'stale direction released');assert.equal(s.fdbExperience.length,0);assert.equal(s.pendingFdbReplay,null);
 s.manualMask=16;s.updateButtons();assert.equal(s.appliedMask,16,'manual input restored despite train/no-hints mode');
 s.advanceFrame(200);assert.equal(s.frame,2,'same game continues without reconnect');assert.equal(s.window.labAgentStatus().failure.message,s.window.labAgentFailure.message);
 s.window.labResult({generation:7,token:42,error:'late error'});assert.match(s.window.labAgentFailure.message,new RegExp(cause),'stale callbacks cannot replace failure or act');
}
{
 const {s}=fixture();s.coreFailure=true;s.nes.frame=()=>{throw Error('real core failure');};s.advanceFrame(100);assert.equal(s.playing,false);assert.equal(s.frame,0);assert.match(s.lastStatus,/Эмуляция остановлена/);
}
{
 const {s}=fixture();s.window.fdbAgent={boundary(){throw Error('boundary failure');}};s.window.labError({message:'backend failure'});assert.equal(s.connected,false);assert.equal(s.playing,true);assert.equal(s.brainMask,0);assert.equal(s.window.labAgentFailure.cleanupErrors.length,1,'cleanup failure is retained explicitly');
}
for(const malformed of [true,false]){
 const {s}=fixture();s.learnedButtons=()=>{throw Error('readout failure');};
 s.window.labResult({generation:7,token:42,wallMs:1,...(malformed?{}:{outputs:Array(8).fill(0)})});
 assert.equal(s.playing,true);assert.equal(s.connected,false);assert.equal(s.statsCalls,0,'failed result must not be processed as successful');assert(s.window.labAgentFailure);
}
console.log('PASS: neural observation/plasticity/inference failure isolation on four platform frontends, real NES continuity, manual fallback, stale results, core error distinction and cleanup diagnostics');

// Faults in routing and status accessors must never reach the emulator boundary.
for(const stage of ['active','running','route','telemetry','manualPort']){
 const {s,events}=fixture();let failingCalls=0;
 const fail=()=>{failingCalls++;throw Error(stage+' accessor failed');};
 s.window.dualAgents={active:stage==='active'?fail:()=>true,running:stage==='running'?fail:()=>true,route:stage==='route'?fail:()=>[128,64],manualPort:stage==='manualPort'?fail:()=>2,pause(){},frame(){}};
 if(stage==='telemetry')s.window.userInterface={telemetry:fail};
 s.manualMask=16;s.advanceFrame(100);
 assert.equal(s.playing,true,stage+' fault must not stop core');assert.equal(s.frame,1);assert.equal(s.window.labNeuralSuspended,true);assert.match(s.window.labAgentFailure.message,new RegExp(stage));
 const accesses=failingCalls,generation=s.generation;s.manualMask=128;s.advanceFrame(200);s.advanceFrame(300);
 assert.equal(s.frame,3);assert.equal(failingCalls,accesses,'quarantined '+stage+' backend is not queried again');assert.equal(s.generation,generation,'manual play does not repeatedly invalidate generation');
 const port=s.window.labAgentFailure.manualPort||1;
 assert.equal(s.appliedDualMasks[port-1],128,'manual input reaches surviving port');assert(events.some(e=>e[0]==='down'&&e[1]===port&&e[2]===7));
}
{
 const {s}=fixture();s.updateGmodeHud=()=>{throw Error('broken HUD');};s.log=()=>{throw Error('broken log');};s.status=()=>{throw Error('broken toast');};
 assert.doesNotThrow(()=>s.window.labError({message:'original backend failure'}));
 assert.equal(s.window.labAgentFailure.message,'original backend failure');assert(s.window.labAgentFailure.cleanupErrors.includes('broken HUD'));assert(s.window.labAgentFailure.cleanupErrors.includes('broken log'));assert(s.window.labAgentFailure.cleanupErrors.includes('broken toast'));
 s.manualMask=1;s.advanceFrame(100);assert.equal(s.frame,1);assert.equal(s.appliedMask,1,'failure reporting cannot prevent manual play');
}
{
 const {s}=fixture();s.window.labError({generation:6,token:42,message:'old native sample'});assert.equal(s.connected,true);assert.equal(s.generation,7);assert.equal(s.window.labAgentFailure,undefined);
 s.window.labError({generation:7,token:41,message:'old same-generation sample'});assert.equal(s.connected,true);
 s.window.labError({generation:7,token:42,message:'correlated current failure'});assert.equal(s.connected,false);assert.equal(s.window.labAgentFailure.message,'correlated current failure');
}
{
 const {s}=fixture();let queries=0;
 s.window.fdbDiagnostics={record(){throw Error('stale telemetry should be ignored');}};
 s.window.labResult({generation:6,token:42,error:'obsolete'});assert.equal(s.window.labAgentFailure,undefined,'stale callback rejected before touching diagnostics');
 s.window.dualAgents={active(){queries++;throw Error('pump backend failed');}};
 s.emulationClock=new (require('../app/src/main/assets/lab/emulation-clock.js'))();s.now=0;s.performance.now=()=>s.now;
 s.emulationRate=1;s.emulationMeasureState='';s.acceleratedFrames=0;s.fpsFrames=0;s.fpsAt=0;s.liveFps=0;s.deferredVideo=false;s.document={hidden:false};const scheduled=[];
 s.setTimeout=(fn,delay)=>scheduled.push({fn,delay});s.MessageChannel=class{constructor(){this.port1={};this.port2={postMessage:()=>scheduled.push({fn:()=>this.port1.onmessage(),delay:0})};}};
 vm.runInContext(code.slice(code.indexOf('const emulationChannel='),code.indexOf('window.labPause=function')),s);
 s.emulationPump();const queried=queries;s.now=20;s.emulationPump();assert.equal(s.playing,true);assert(s.frame>=1,'actual pump continues after dual accessor throws');assert.equal(queries,queried,'actual pump bypasses failed accessor');assert(scheduled.length>1,'pump reschedules itself after failure');
 s.requestAnimationFrame=()=>{s.rafScheduled=true;};s.presentVideo=()=>{};s.pendingSince=0;s.now=40;
 vm.runInContext(code.slice(code.indexOf('function loop(now)'),code.indexOf('// Computation is paced')),s);s.loop(40);
 assert.equal(s.rafScheduled,true,'render loop schedules next frame');assert.equal(queries,queried,'render watchdog never polls quarantined backend');
}
{
 const {s,nodes}=fixture();let stopped=0;
 s.holding=new Map([['held',128]]);s.controllerMasks=new Map([['pad',128]]);s.audioRead=0;s.audioWrite=50;s.controlsEnabled=()=>{};s.nativeCall=()=>{stopped++;};s.manualMask=128;
 s.window.dualAgents={active(){assert.equal(s.playing,false,'core pauses before failing backend cleanup');throw Error('pause backend failed');}};
 s.window.fdbAgent={boundary(){throw Error('pause boundary failed');}};
 vm.runInContext(code.slice(code.indexOf('window.labPause=function'),code.indexOf("$('console').onclick=")),s);
 assert.doesNotThrow(()=>s.window.labPause());assert.equal(s.playing,false);assert.equal(s.pendingToken,null);assert.equal(s.holding.size,0);assert.equal(s.controllerMasks.size,0);assert.equal(s.audioRead,50);assert(stopped>0,'native stop still attempted despite failed callbacks');
 s.manualMask=16;nodes.play.onclick();assert.equal(s.playing,true,'manual resume remains available with broken backend');s.advanceFrame(100);assert.equal(s.frame,1);assert.equal(s.appliedMask,16);
}
(async()=>{
 const {s}=fixture();s.window.humanTeaching={stop:()=>Promise.reject(Error('async archive cleanup failure'))};
 s.window.labError({message:'network failure'});await new Promise(resolve=>setImmediate(resolve));assert(s.window.labAgentFailure.cleanupErrors.includes('async archive cleanup failure'),'async cleanup rejection retained without escaping');
 const source=fs.readFileSync('app/src/main/java/org/node/flyconsole/NesLabActivity.java','utf8');
 for(const op of ['sample','configure','systemButtons'])assert(source.includes('emitRequestFailure(json,"'+op+'",'),'native '+op+' failure retains request correlation');
 assert(!source.includes('error(ex.getMessage()); emitFailedSample(json)'),'old unscoped sample cancellation removed');
 const deferred=fixture().s;let rejectOld;
 const oldJob=new Promise((resolve,reject)=>{rejectOld=reject;});deferred.neuralStep(()=>oldJob);deferred.generation++;deferred.connected=true;rejectOld(Error('old async inference failure'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(deferred.connected,true,'late previous-generation async error cannot stop a new connection');assert.equal(deferred.window.labAgentFailure,undefined);assert(deferred.logs.some(text=>text.includes('old async inference failure')),'stale async errors remain logged');
 console.log('PASS: accessor/route/HUD failure quarantine, correlated native errors, actual pump/RAF continuity, safe pause/manual resume and async cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
{
 const {s,nodes}=fixture();const requests=[];
 nodes.learnMode.value='off';s.ready=true;s.lastSample=0;s.window.labNeuralSuspended=true;
 s.requestedConfiguration={systemButtons:'blocked',gmode:'off'};s.configuration=()=>({systemButtons:'auto',gmode:'off'});s.configurationApplied=true;s.validateConfiguration=()=>{};s.keysEqual=()=>true;s.neuralConfiguration=x=>x;
 s.learner={setActions(){},setAllowedMask(){}};s.FlyGameTools={actions:()=>[0]};s.nativeCall=(op,arg)=>requests.push({op,arg:arg&&JSON.parse(arg)});
 vm.runInContext(code.slice(code.indexOf('function connectBrain'),code.indexOf('window.labConfigured=')),s);s.connectBrain();
 assert.equal(s.connected,true);assert.equal(s.window.labNeuralSuspended,false,'intentional valid reconnect clears quarantine');assert.equal(requests.find(x=>x.op==='systemButtons').arg.generation,s.generation,'system-buttons request belongs to newly connected generation');
 s.updateGmodeHud=()=>{throw Error('reconnect HUD failed');};s.connectBrain();assert.equal(s.connected,false,'failed reconnect cannot remain falsely active');assert.equal(s.window.labNeuralSuspended,true);
}

{
 const {s}=fixture();s.holding=new Map();s.controllerMasks=new Map();s.emulatorRestarts=0;s.frozen=null;s.audioRead=0;s.audioWrite=10;
 s.window.humanTeaching={stop(){throw Error('archive restart failure');}};
 vm.runInContext(code.slice(code.indexOf('function restartEpisodeFromRom'),code.indexOf('function policyPackage')),s);
 s.restartEpisodeFromRom();assert.equal(s.frame,5,'real NES reset finishes despite broken neural archive cleanup');assert.equal(s.window.labNeuralSuspended,true);assert.equal(s.audioRead,s.audioWrite);s.manualMask=1;s.advanceFrame(200);assert.equal(s.frame,6,'manual game continues from reset core');
}
