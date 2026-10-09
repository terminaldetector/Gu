'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
const block=source.slice(source.indexOf('function agentAllowedMask'),source.indexOf('function rgbaAndRetina'));
for(const system of ['nes','sega','snes']){
 const events=[],du={active:true,route:[128,64],port:2,commits:[]};
 const s={loaded:true,romLoading:false,labPlatform:system,manualMask:0,brainMask:2,agentIntervened:false,gmodeMode:'off',appliedMask:0,appliedHumanMask:0,appliedAgentMask:0,appliedDualMasks:[0,0],dualOverrides:[false,false],$:()=>({value:'auto'}),nes:{fps:50,buttonDown:(p,b)=>events.push(['down',p,b]),buttonUp:(p,b)=>events.push(['up',p,b]),frame:()=>s.emuFrames++},window:{dualAgents:{active:()=>du.active,route:()=>du.route,manualPort:()=>du.port,frame:c=>du.commits.push(c)}},emuFrames:0,performance:{now:()=>1},measuredCpuMs:0,measuredFrames:0,benchmark:null,frame:10,samples:0,sampleFrame:()=>s.samples++};
 vm.createContext(s);vm.runInContext(block,s);s.updateButtons();assert.deepEqual(events,[['down',1,7],['down',2,6]],system+' uses independent hardware ports');
 events.length=0;s.manualMask=128;s.updateButtons();assert.deepEqual(Array.from(s.appliedDualMasks),[128,128],'manual P2 right wins over model left');assert.deepEqual(Array.from(s.dualOverrides),[false,true],'manual credit invalidates only P2');assert.deepEqual(events,[['up',2,6],['down',2,7]]);
 vm.runInContext(source.slice(source.indexOf('function advanceFrame'),source.indexOf('function loop')),s);s.advanceFrame(30);assert.equal(s.emuFrames,1);assert.equal(s.frame,11);assert.equal(s.samples,1);assert.equal(du.commits.length,1);assert.deepEqual(Array.from(du.commits[0].masks),[128,128]);assert.equal(du.commits[0].dt,1/(system==='nes'?60:50));assert.deepEqual(Array.from(du.commits[0].overrides),[false,true]);
 s.releasePorts();assert.deepEqual(Array.from(s.appliedDualMasks),[0,0]);assert.deepEqual(Array.from(s.dualOverrides),[false,false]);events.length=0;du.active=false;s.manualMask=1;s.brainMask=2;s.updateButtons();assert.deepEqual(events,[['down',1,0],['down',1,1]],'single legacy human/model routing preserved');
}
console.log('PASS: production dual P1/P2 routing, manual priority, isolated intervention credit, one emulator frame, actual masks and legacy single control');
