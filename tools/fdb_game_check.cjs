'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline');
const assets=path.resolve(__dirname,'../app/src/main/assets/lab');
const cores=process.env.FDB_CORES||assets;
function bridge(){const child=spawn(process.env.JAVA||'java',['-Xmx2g','-cp',process.env.CODE_CLASSPATH,'org.node.flyconsole.FdbGameBridge',...(process.env.FDB_GRAPH?[process.env.FDB_GRAPH]:[])],{stdio:['pipe','pipe','inherit']});const pending=[];readline.createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(p)p.resolve(JSON.parse(line));});child.on('exit',code=>{while(pending.length)pending.shift().reject(Error('Java bridge exited '+code));});return {call:q=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(q)+'\n');}),close:()=>child.stdin.end()};}
(async()=>{
 const java=bridge(),report={kind:'actual-WASM-neural-FDB-comparison',seeds:[11,23,37],graph:process.env.FDB_GRAPH?'original connectome, explicitly configured technical ports':'30-neuron mechanism fixture; not the fly connectome',rows:[]};
 try{for(const system of process.env.FDB_GRAPH?['sega']:['sega','snes','gb']){
  let image=null,w=0,h=0;const callbacks={onFrame:(pixels,width,height)=>{image=pixels;w=width;h=height;}};let core;
  if(system==='sega'){const Sega=require(path.join(assets,'sega-core.js'));core=await Sega.create(callbacks,require(path.join(cores,'sega/genplus.js')),{wasmBinary:fs.readFileSync(path.join(cores,'sega/genplus.wasm'))});}
  else{const Retro=require(path.join(assets,'retro-core.js'));core=await Retro.create(system,callbacks,require(path.join(cores,system,'core.js')),{wasmBinary:fs.readFileSync(path.join(cores,system,'core.wasm'))});}
  core.loadROM(Uint8Array.from(Buffer.from(require(path.join(assets,'demo-'+system+'.json')).base64,'base64')));for(let i=0;i<30;i++)core.frame();const snapshot=core.toJSON();
  const observation=()=>{const values=new Array(16).fill(0),counts=new Array(16).fill(0);for(let y=0;y<h;y+=4)for(let x=0;x<w;x+=4){const c=image[y*w+x],i=Math.min(3,Math.floor(y*4/h))*4+Math.min(3,Math.floor(x*4/w));values[i]+=(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255))/255;counts[i]++;}return values.map((v,i)=>v/counts[i]);};
  const score=()=>{const n=(core.cpu.mem[0]<<8)|core.cpu.mem[1];return n&32768?n-65536:n;};
  const evalSteps=process.env.FDB_GRAPH?8:24,trainSteps=process.env.FDB_GRAPH?40:240;
  async function run(train,steps){let reward=0,success=0,wallMs=0,emulatorMs=0;for(let step=0;step<steps;step++){
    const d=await java.call({op:'decide',retina:observation(),train,windowMs:process.env.FDB_GRAPH?10:20});wallMs+=d.wallMs;const before=system==='sega'?score():0;
    for(let bit=0;bit<(system==='gb'?8:12);bit++)d.mask&(1<<bit)?core.buttonDown(1,bit):core.buttonUp(1,bit);
    const started=performance.now();for(let frame=0;frame<6;frame++)core.frame();emulatorMs+=performance.now()-started;
    const observed=system==='sega'?(score()-before)*.1:system==='gb'?((core.cpu.mem[1]&1)===0?1:-.1):(core.cpu.mem[0x17]===1?1:-.1);
    reward+=observed;success+=system==='sega'?Number(observed>0):Number(observed===1);
    if(train)await java.call({op:'reward',id:d.id,mask:d.mask,reward:Math.max(-20,Math.min(20,observed)),seconds:6/core.fps,frames:6});
  }return {reward,success,steps,wallMs,emulatorMs};}
  for(const seed of report.seeds)for(const mode of ['baseline','fixed','learned','resumed']){
   const metadata=await java.call({op:'init',seed,mode});report.graphSha=metadata.graphSha;report.neurons=metadata.neurons;report.baseEdges=metadata.baseEdges;
   core.fromJSON(snapshot);
   if(mode==='learned'||mode==='resumed'){await run(true,Math.floor(trainSteps/2));await java.call({op:mode==='resumed'?'checkpoint':'reset'});await run(true,Math.ceil(trainSteps/2));}
   await java.call({op:'reset'});core.fromJSON(snapshot);const before=await java.call({op:'state'}),result=await run(false,evalSteps),state=await java.call({op:'state'});assert.equal(state.updates,before.updates);assert.equal(state.rng,before.rng);assert.equal(state.edges,before.edges);report.rows.push({system,seed,mode,...result,...state});
  }
  if(!process.env.FDB_GRAPH){const sum=mode=>report.rows.filter(r=>r.system===system&&r.mode===mode).reduce((s,r)=>s+r.reward,0);assert(sum('learned')>sum('baseline'),'actual game outcome must improve on fixture '+system);const lr=report.rows.filter(r=>r.system===system&&r.mode==='learned'),rr=report.rows.filter(r=>r.system===system&&r.mode==='resumed');assert.deepEqual(lr.map(r=>[r.reward,r.edges,r.rng]),rr.map(r=>[r.reward,r.edges,r.rng]),'continued checkpoint parity '+system);}
  console.log('PASS: '+system+' actual observation → production CPU → neural action → hardware/RAM reward → Wexo; frozen evaluation and resumed checkpoint');
 }
 const output=process.env.FDB_REPORT||'fdb-comparison.json';fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log('FDB comparison saved: '+output);
 }finally{java.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
