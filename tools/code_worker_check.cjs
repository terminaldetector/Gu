'use strict';
const assert=require('node:assert/strict'),{Worker}=require('node:worker_threads'),{spawn}=require('node:child_process'),readline=require('node:readline');
const bootstrap=require('../app/src/main/assets/code/worker-source.js');
const java=spawn('java',['-cp',process.env.CODE_CLASSPATH,'org.node.flyconsole.CodeLabCheck','bridge']);const replies=[];
java.stderr.on('data',b=>process.stderr.write(b));readline.createInterface({input:java.stdout}).on('line',line=>replies.shift()(JSON.parse(line)));
const command=p=>new Promise(r=>{replies.push(r);java.stdin.write(JSON.stringify(p)+'\n');});
function execute(source,modules={}){return new Promise((resolve,reject)=>{const events=[];const worker=new Worker(`const {parentPort}=require('node:worker_threads');global.postMessage=x=>parentPort.postMessage(x);parentPort.on('message',data=>global.onmessage({data}));(${bootstrap.toString()})();`,{eval:true});const timeout=setTimeout(()=>{worker.terminate();reject(Error('timeout'));},10000);
worker.on('message',async d=>{if(d.kind==='request'){const reply=await command(d);worker.postMessage({kind:'reply',id:d.id,value:reply.data,error:reply.error});}else if(d.kind==='done'||d.kind==='error'){clearTimeout(timeout);await worker.terminate();resolve({events,error:d.kind==='error'?d.value:null});}else events.push(d);});worker.on('error',reject);worker.postMessage({kind:'start',source,modules});});}
(async()=>{try{
 const m={signal:{id:'signal',entry:'index.js',files:{'index.js':"exports.mean=require('./math').mean;",'math.js':'exports.mean=x=>x.reduce((a,b)=>a+b,0)/x.length;'}}};
 const r=await execute(`const info=await fly.info();const id=info.ids[0];const p={seed:1,steps:[{ms:20,inputs:[{id,hz:500}],outputs:[{id,label:'response'}]}]};const a=await fly.run(p),b=await fly.run(p);if(a.results[0].outputs.response.spikes!==b.results[0].outputs.response.spikes)throw Error('seed');fly.log(a);fly.plot('Hz',[a.results[0].outputs.response.hz]);fly.log(require('signal').mean([1,2,3]));`,m);
 assert.equal(r.error,null);assert(r.events[0].value.results[0].outputs.response.spikes>0);assert.equal(r.events[2].value,2);assert.equal((await execute("require('missing')")).error,'Модуль не установлен: missing');assert((await execute("await fly.run({steps:[]})")).error);console.log('PASS: JS Worker -> actual Java inference, seeded results, plots, CommonJS dependencies and error propagation');
 }finally{java.stdin.end();}})().catch(e=>{console.error(e);java.kill();process.exitCode=1;});
