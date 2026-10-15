'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app/src/main/assets/lab/synthetic-import.js','utf8');
function fixture(){const calls=[];const state={TextEncoder,clearTimeout:()=>{},setTimeout:()=>1,status:(...v)=>calls.push(['status',...v]),window:{labState:{prepare:async()=>calls.push(['save']),settle:async()=>calls.push(['settle'])},FlyBridge:{installSyntheticGraph:s=>calls.push(['install',JSON.parse(s)])}}};vm.createContext(state);vm.runInContext(source,state);return{calls,state,run:d=>state.window.importSyntheticGraph(d)};}
(async()=>{
 const data={type:'fly-synthetic-graph',version:1};let f=fixture();await f.run(data);assert.equal(f.calls[0][0],'save');assert.equal(f.calls[2][0],'install');await f.run(data);assert.equal(f.calls.filter(x=>x[0]==='install').length,1);
 await f.state.window.labSyntheticImported({ok:true});assert(f.calls.some(x=>x[0]==='settle'));
 f=fixture();f.state.window.labState.prepare=async()=>{throw Error('disk full');};await f.run(data);assert(!f.calls.some(x=>x[0]==='install'));assert(f.calls.at(-1)[1].includes('disk full'));
 f=fixture();delete f.state.window.FlyBridge.installSyntheticGraph;await f.run(data);assert(!f.calls.some(x=>x[0]==='save'));assert(!f.calls.some(x=>x[0]==='install'));
 f=fixture();await f.run({type:'fly-layer-set',version:1});assert(!f.calls.some(x=>x[0]==='install'));
 f=fixture();await f.run(data);await f.state.window.labSyntheticImported({ok:false,error:'SHA mismatch'});assert(f.calls.at(-1)[1].includes('SHA mismatch'));
 console.log('PASS synthetic import: save-before-install, failed save, unsupported bridge, duplicate request, error/success');
})().catch(e=>{console.error(e);process.exit(1);});
