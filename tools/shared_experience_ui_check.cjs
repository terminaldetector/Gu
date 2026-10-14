'use strict';
const A=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),S=require('../app/src/main/assets/lab/shared-experience.js'),Tools=require('../app/src/main/assets/lab/game-tools.js');
const nodes={},node=id=>nodes[id]||(nodes[id]={value:'',checked:false,replaceChildren(){},add(){}}),mem=new Map();
const state={$:node,FlySharedExperience:S,FlyActionHold:require('../app/src/main/assets/lab/action-hold.js'),FlyGameTools:Tools,localStorage:{getItem:k=>mem.get(k),setItem:(k,v)=>mem.set(k,v)},Option:function(t,v){this.text=t;this.value=v},window:{},ready:true,loaded:true,romHash:'a'.repeat(64),graphIdentity:{sha256:'b'.repeat(64)},labPlatform:'nes',ids:id=>node(id).value.split(',').filter(Boolean),agentAllowedMask:()=>255,status(){},trainingView(){},nativeCall(){},apply(){},learner:{reset(){}},pendingFdbReplay:null,humanExamples:[],fdbExperience:[],requestedConfiguration:{},configurationApplied:true,restoreGrowthStatePending:false};
for(const [k,v]of Object.entries({inputIds:Array.from({length:16},(_,i)=>i+1).join(','),outputIds:Array.from({length:8},(_,i)=>i+17).join(','),actionHoldMode:'model',actionHoldLimit:'250',actionHoldTimeout:'5',actionMasks:'0,1',maxHz:'100',gain:'1',windowMs:'20',thresholdHz:'40',backend:'cpu',seed:'1'}))node(k).value=v;
let reject=false,detach=0;state.window.labState={prepare:async()=>{if(reject)throw Error('save failed')}};state.window.layerExperience={detach:()=>detach++};
vm.createContext(state);vm.runInContext(fs.readFileSync('app/src/main/assets/lab/shared-experience-ui.js','utf8'),state);
const api=state.window.sharedExperience,contract={version:1,sham:false,actionHold:{mode:'model',limitMs:250,timeoutMs:5000},observation:'retina4x4-row-major-v1',dynamics:'lif-f32-threshold-v1',inputs:state.ids('inputIds'),outputs:state.ids('outputIds'),actions:node('sharedActions').value.split(','),actionMasks:[0,1],allowedMask:255,maxHz:100,gain:1,windowMs:20,thresholdHz:40,backend:'cpu',scramble:false,disableInhibition:false,lesions:false};
const layer=S.candidate({name:'ROOT',scope:'root',graphSha:state.graphIdentity.sha256,romHash:state.romHash,contract,effective:S.empty()}),binding={version:1,layers:[layer],experimental:true},config={...contract,systemButtons:'auto',lesions:[]};
(async()=>{
 await api.importLayer(layer);node('sharedRoot').value=layer.digest;node('sharedExperimental').checked=true;
 reject=true;await node('sharedApply').onclick();A.equal(api.snapshot(),null);A.equal(detach,0,'failed save cannot detach old Layer Set');
 reject=false;await node('sharedApply').onclick();A.equal(api.snapshot().layers[0].digest,layer.digest);A.equal(detach,1);A.equal(state.restoreGrowthStatePending,true);A.equal(node('learnerController').value,'exo');
 api.validate(binding,config);node('actionMasks').value='0,2';A.throws(()=>api.validate(binding,config));api.validate(binding,config,{actionMasks:'0,1'});
 node('actionMasks').value='0,1';node('sharedActions').value='wrong';A.throws(()=>api.validate(binding,config));api.validate(binding,config,{actionMasks:'0,1'});api.restore(binding);api.validate(binding,config);
 state.romHash='c'.repeat(64);api.contextChanged();A.equal(api.snapshot(),null,'new ROM detaches old binding');A.equal(new S.Store(state.localStorage).list().length,1,'shared catalog survives ROM switch');
 console.log('PASS: shared UI save-before-apply, failed-save retention, detached game copies, saved-profile validation, edited action rejection and ROM isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
