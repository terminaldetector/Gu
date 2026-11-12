'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
const block=source.slice(source.indexOf('let physicalPortMasks'),source.indexOf('function rgbaAndRetina'));
const events=[],state={loaded:true,playing:true,agentIntervened:false,manualMask:0,brainMask:0,gmodeMode:'off',appliedMask:0,appliedHumanMask:0,appliedAgentMask:0,labPlatform:'nes',controlMode:'auto',$:()=>({value:state.controlMode}),nes:{buttonDown:(p,b)=>events.push(['down',p,b]),buttonUp:(p,b)=>events.push(['up',p,b])}};
vm.createContext(state);vm.runInContext(block,state);
state.gmodeMode='coop';state.manualMask=1;state.brainMask=2;state.updateButtons();
assert.deepStrictEqual(events,[['down',1,0],['down',2,1]]);
events.length=0;state.manualMask=0;state.updateButtons();assert.deepStrictEqual(events,[['up',1,0]]);
state.releasePorts();events.length=0;
state.gmodeMode='coop-reverse';state.manualMask=16;state.brainMask=32;state.updateButtons();
assert.deepStrictEqual(events,[['down',2,4],['down',1,5]]);
state.releasePorts();events.length=0;
state.gmodeMode='off';state.manualMask=32;state.brainMask=16;state.updateButtons();
assert.deepStrictEqual(events,[['down',1,5]],'manual direction must win in single player');
assert.equal(state.agentIntervened,true,'manual intervention invalidates reward credit');
console.log('PASS: production GMode port isolation, release, swapped ports and manual override');
// A real SNES 2P join needs a human-origin START edge on port 2. The default
// system-button filter must continue to prohibit *model* Start/Select.
state.releasePorts();events.length=0;
state.window={};state.labPlatform='snes';state.gmodeMode='coop';state.controlMode='blocked';state.playing=true;state.manualMask=0;state.brainMask=2;
state.learningBoundary=()=>{};
assert.equal(state.filterAgentMask(8),0,'model Start remains forbidden');
assert.equal(state.filterAgentMask(4),0,'SNES Select must be blocked');
assert.equal(state.filterAgentMask(2048),2048,'SNES R shoulder must remain available');
assert.equal(state.requestPort2Start(),true,'explicit P2 START accepted');
assert.equal(state.requestPort2Start(),false,'duplicate during pulse is ignored');
assert(events.some(e=>e[0]==='down'&&e[1]===2&&e[2]===3),'P2 Start physically pressed');
assert(!events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===3),'P1 Start untouched');
events.length=0;
state.consumePort2StartFrame();assert.equal(events.length,0,'pulse lasts two game frames');
state.consumePort2StartFrame();
assert.deepStrictEqual(events,[['up',2,3]],'P2 Start released after precisely two frames');
events.length=0;state.manualMask=1;state.manualOnlyButtons();
assert(events.some(e=>e[0]==='up'&&e[1]===2&&e[2]===1),'manual-only failsafe releases previous P2 agent buttons');
assert(events.some(e=>e[0]==='down'&&e[1]===1&&e[2]===0),'human P1 control remains available');
console.log('PASS: Secret of Mana P2 START pulse, blocked neural Start, physical release and manual fallback');


const keys=source.slice(source.indexOf('function keysEqual'),source.indexOf('function learningKey'));
vm.runInContext(keys,state);
assert(state.keysEqual(JSON.stringify({configuration:{backend:'cpu'},gmode:'off'}),JSON.stringify({configuration:{}})));
assert(!state.keysEqual(JSON.stringify({configuration:{fdb:{edges:[{source:'1',target:'2',weight:1}]}}}),JSON.stringify({configuration:{}})));
console.log('PASS: profile key migration and FDB identity separation');


const growth=source.slice(source.indexOf('function validateGrowth'),source.indexOf('function configuration'));
vm.runInContext(growth,state);
const good={enabled:true,interval:10,perWindow:2,maxEdges:256,initialWeight:8,explore:true,rewardGate:false};
assert.doesNotThrow(()=>state.validateGrowth(good));
for(const bad of [{...good,interval:1.5},{...good,maxEdges:1025},{...good,initialWeight:0},{...good,explore:1}])assert.throws(()=>state.validateGrowth(bad));
assert(source.indexOf('if(data.fdbState)',source.indexOf('window.labResult='))<source.indexOf('learnedButtons(data)',source.indexOf('window.labResult=')),'grown layer must be saved before terminal autosave/reapply');
console.log('PASS: production FDB growth validation and terminal checkpoint ordering');

assert(state.keysEqual(JSON.stringify({configuration:{systemButtons:'auto'}}),JSON.stringify({configuration:{}})));
assert(!state.keysEqual(JSON.stringify({configuration:{systemButtons:'blocked'}}),JSON.stringify({configuration:{}})));
