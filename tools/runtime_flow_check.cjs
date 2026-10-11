'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
const Learner=require('../app/src/main/assets/lab/learner.js'),Tools=require('../app/src/main/assets/lab/game-tools.js');
const nodes={clock:{value:'realtime'},mode:{value:'closed'},learnMode:{value:'train'},rewardMode:{value:'manual'},rewardAddress:{value:'0'},rewardScale:{value:'.1'},episodeLength:{value:'10'},epsilon:{value:'.1'},alpha:{value:'.04'},winReward:{value:'2'},deathReward:{value:'-1'},autoEpisode:{checked:true},runMode:{value:'continuous'},actionMasks:{value:'0,1,2,16,32,64,128'},seed:{value:'1'},gmode:{value:'off'},gmodeStatus:{},gmodeBoost:{checked:false}};
const state={$:id=>nodes[id]||(nodes[id]={value:'',checked:false}),window:{},performance:{now:()=>0},requestAnimationFrame(){},labPlatform:'nes',nes:{cpu:{mem:new Uint8Array(2048)}},agentIntervened:false,manualMask:0,gmodeMode:'off',gmodeBoost:false,gmodeBoostBackup:null,learner:new Learner(1),FlyGameTools:Tools,romHash:'fixture',diagnosticHash:'own',ramLimit:2048,sampledRetina:new Array(16).fill(.25),previousRetina:null,lastDecisionFeatures:null,lastDecisionAction:0,sampledRam:null,demoElapsed:0,demoPrevious:null,queueFdbExperience(){},sampledControllerMask:0,terminalLatch:{success:false,death:false},learnReward:0,rewardPending:0,finishPending:false,lastRewardValue:null,episodeSteps:0,episodeReward:0,trials:[],transitions:[],benchmark:null,playing:true,connected:true,frame:77,log(){},learningStats(){},updateButtons(){},updateGmodeHud(){},releaseBrain(){},nativeCall(){state.nativeCalls++},nativeCalls:0,restarts:0,reconnects:0,restartEpisode(){state.restarts++},connectBrain(){state.reconnects++},status(){}};
state.window.labPause=()=>{state.playing=false;state.connected=false;};
vm.createContext(state);
for(const [a,b] of [['function learningBoundary','function keysEqual'],['function learnedButtons','function setGMode'],['function setGmodeBoost','function log']])vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),state);
state.learner.setActions(Tools.actions(nodes.actionMasks.value));
for(let i=0;i<20;i++)state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});
assert.equal(state.restarts,0,'continuous mode must ignore an old autoEpisode=true profile');assert.equal(state.frame,77);assert.equal(state.playing,true);assert.equal(state.connected,true);assert(state.learner.updates>=18,'training continues across episode boundaries');
nodes.episodeLength.value='2000';nodes.winEnabled={checked:true};nodes.winAddress={value:'4'};nodes.winValue={value:'1'};state.learningBoundary();
state.nes.cpu.mem[4]=1;const episodesBefore=state.learner.episodes;for(let i=0;i<20;i++)state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});assert.equal(state.learner.episodes,episodesBefore+1,'a held RAM result must not repeatedly terminate/reward');
state.nes.cpu.mem[4]=0;state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});state.nes.cpu.mem[4]=1;state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});assert.equal(state.learner.episodes,episodesBefore+2,'new round transition is recognized');nodes.winEnabled.checked=false;nodes.episodeLength.value='10';state.learningBoundary();
// A human intervention cancels only reward credit, not the accumulated model.
nodes.episodeLength.value='2000';state.learningBoundary();state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});
const creditBefore=state.learner.updates;state.agentIntervened=true;state.rewardPending=1;state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});
assert.equal(state.learner.updates,creditBefore);state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});assert.equal(state.learner.updates,creditBefore+1);
nodes.episodeLength.value='10';state.learningBoundary();
nodes.runMode.value='episodic';for(let i=0;i<10;i++)state.learnedButtons({buttons:0,outputs:new Array(8).fill(5)});assert.equal(state.restarts,1,'explicit episodic mode retains intentional restart');
state.playing=false;state.connected=false;state.setGmodeBoost(true);assert.equal(state.gmodeMode,'off','solo boost must retain P1 routing');assert.equal(nodes.gmode.value,'off');assert.equal(nodes.clock.value,'realtime');assert.equal(nodes.autoEpisode.checked,false,'boost cannot arm console restarts');
state.setGmodeBoost(false);state.gmodeMode='coop-reverse';state.setGmodeBoost(true);assert.equal(state.gmodeMode,'coop-reverse','boost must also retain swapped P1/P2 routing');
// Wall-clock pacing, slow backends and display independence are exercised by emulation_clock_check.cjs.
const java=fs.readFileSync('app/src/main/java/org/node/flyconsole/NesLabActivity.java','utf8');assert(java.includes('if(reset)gpuEngine.reset(next.seed)')&&java.includes('if(reset)engine.reset(next.seed)'),'native reset must be explicit');
console.log('PASS: continuous SARSA without ROM restart, opt-in episodes, solo/swapped boost and native reset guards');
