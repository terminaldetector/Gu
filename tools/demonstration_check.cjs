'use strict';
const assert=require('node:assert/strict'),L=require('../app/src/main/assets/lab/learner.js');
const l=new L(3);l.setActions([0,64,128]);
const left=l.features(Array.from({length:16},(_,i)=>i%4<2?1:0),new Array(8).fill(0));
const right=l.features(Array.from({length:16},(_,i)=>i%4>=2?1:0),new Array(8).fill(0));
const q=JSON.stringify(l.weights);
for(let i=0;i<200;i++){l.teach(left,64);l.teach(right,128);}
assert.equal(JSON.stringify(l.weights),q,'demonstrations do not invent reward values');
for(let i=0;i<100;i++){assert.equal(l.step(left,0,false,false),64);assert.equal(l.step(right,0,false,false),128);}
const before=JSON.stringify(l.demonstrationWeights);l.step(left,1,false,true);l.step(right,1,false,true);
assert.equal(JSON.stringify(l.demonstrationWeights),before,'reward learning keeps imitation weights separate');
assert(l.teach(left,2049),'new 12-bit combination is learned by identity');
assert(l.actions.includes(2049));l.setAllowedMask(243);
assert.equal(l.teach(left,8),false,'blocked system presses are excluded rather than labelled idle');
assert.equal(l.skippedDemonstrations,1);
const restored=new L();restored.load(JSON.parse(JSON.stringify(l.save())));
assert.deepEqual(restored.demonstrationWeights,l.demonstrationWeights);assert.equal(restored.demonstrations,l.demonstrations);
const old=l.save();old.version=2;delete old.demonstration;restored.load(old);
assert.equal(restored.demonstrations,0,'old policies migrate with no fabricated examples');
const invalid=l.save();invalid.demonstration.weights[0][0]=NaN;const backup=JSON.stringify(restored.save());
assert.throws(()=>restored.load(invalid));assert.equal(JSON.stringify(restored.save()),backup,'invalid imports leave live policy intact');
const full=new L();full.setActions(Array.from({length:64},(_,i)=>(i&15)|((i>>4)<<8)));
assert.equal(full.teach(left,2048),false);assert.equal(full.actions.length,64,'bounded vocabulary');
console.log('PASS: conditioned imitation, separate reward/teacher weights, combinations, system access, frozen evaluation, migration and atomic validation');
