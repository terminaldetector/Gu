'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Hold=require('../app/src/main/assets/lab/action-hold.js'),source=fs.readFileSync('app/src/main/assets/lab/lab.js','utf8');
assert.deepEqual(Hold.settings(),{mode:'model',limitMs:250,timeoutMs:5000});
for(const bad of [null,{},[],{...Hold.defaults,mode:'auto'},{...Hold.defaults,limitMs:49},{...Hold.defaults,limitMs:5001},{...Hold.defaults,timeoutMs:999},{...Hold.defaults,timeoutMs:30001},{...Hold.defaults,timeoutMs:'5000'}])assert.throws(()=>Hold.settings(bad));
for(const rate of [1,2,3,5,10]){
 assert.equal(Hold.expiry(Hold.defaults,rate*.8,800),null,'same 800 ms real response delay at every speed');
 assert.equal(Hold.expiry(Hold.defaults,rate*5,5000),'timeout','watchdog uses real time');
 assert.equal(Hold.expiry({...Hold.defaults,mode:'limited'},.25,250/rate),'limit','explicit limit uses game time');
}
const nodes={actionHoldMode:{value:'model'},actionHoldLimit:{value:'250'},actionHoldTimeout:{value:'5'},outputs:{children:[]}},route=[];
const state={$:id=>nodes[id],FlyActionHold:Hold,connected:true,configuring:false,brainMask:2,brainGameAge:0,brainExpired:false,agentIntervened:false,pendingToken:null,pendingSince:0,lastResponse:0,
 updateButtons(){route.push(state.brainMask);},labError(d){state.error=d.message;state.connected=false;state.pendingToken=null;state.releaseBrain();}};
state.window=state;vm.createContext(state);
vm.runInContext(source.slice(source.indexOf('function releaseBrain()'),source.indexOf('function agentAllowedMask(')),state);
state.brainGameAge=8;state.checkBrainHold(800);assert.equal(state.brainMask,2,'no 250 ms game or 500 ms wall cutoff in model mode');assert.equal(state.agentIntervened,false);
state.pendingToken=1;state.pendingSince=100;state.checkBrainHold(900);assert.equal(state.brainMask,2,'keep B throughout a pending calculation');
nodes.actionHoldMode.value='limited';state.brainGameAge=.25;state.checkBrainHold(100);assert.equal(state.brainMask,0);assert.equal(state.agentIntervened,true,'forced cutoff cannot claim successful execution');
nodes.actionHoldMode.value='model';state.brainMask=2;state.checkBrainHold(5100);assert.equal(state.brainMask,0);assert.equal(state.connected,false,'timed-out calculations stop the link');
// The actuator options survive export without splitting/mismatching old learned keys.
const keyState={window:{},configuration(){return{};}};vm.createContext(keyState);
vm.runInContext(source.slice(source.indexOf('function keysEqual('),source.indexOf('function learningKey(')),keyState);
vm.runInContext(source.slice(source.indexOf('function policyConfiguration('),source.indexOf('function queueFdbExperience(')),keyState);
const old={configuration:{backend:'cpu',controllerSource:'exo',fdb:null}},next=JSON.parse(JSON.stringify(old));next.configuration.actionHold={mode:'limited',limitMs:1000,timeoutMs:9000};
assert(keyState.keysEqual(JSON.stringify(old),JSON.stringify(next)),'legacy keys remain compatible');
assert.equal('actionHold' in keyState.policyConfiguration(next.configuration),false,'actuation options do not identify different learned weights');
console.log('PASS: model-owned holding, opt-in game-time cap, real-time response timeout at ×1–×10, pending execution and legacy learned-key compatibility');
