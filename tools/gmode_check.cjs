'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
const block=source.slice(source.indexOf('function agentAllowedMask'),source.indexOf('function rgbaAndRetina'));
const events=[],state={loaded:true,manualMask:0,brainMask:0,gmodeMode:'off',appliedMask:0,appliedHumanMask:0,appliedAgentMask:0,labPlatform:'nes',controlMode:'auto',$:()=>({value:state.controlMode}),nes:{buttonDown:(p,b)=>events.push(['down',p,b]),buttonUp:(p,b)=>events.push(['up',p,b])}};
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
assert(source.includes("if(manualMask&&gmodeMode==='off')"));
console.log('PASS: production GMode port isolation, release, swapped ports and manual override');

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
