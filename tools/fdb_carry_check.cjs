'use strict';
// FdbLearning.carry, through the production learner (tools/FdbGameBridge):
//   - carrying UNKNOWN intervals changes NO weight, update count or baseline:
//     UNKNOWN stays non-numeric;
//   - a verified reward after carries reaches the earlier decisions: more
//     native changes than the same reward after boundary(), which cleared them;
//   - an invalid carry (mask mismatch) breaks the link and is counted rejected.
// The graph is the 30-neuron mechanism fixture; nothing here is a gameplay claim.
const {spawn}=require('child_process'),readline=require('readline');
if(!process.env.CODE_CLASSPATH){console.log('BLOCKED - CODE_CLASSPATH is not set');process.exit(0);}
const out=[],fail=[];const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
function bridge(){
 const child=spawn(process.env.JAVA||'java',['-cp',process.env.CODE_CLASSPATH,'org.node.flyconsole.FdbGameBridge'],{stdio:['pipe','pipe','ignore']});
 const pending=[];readline.createInterface({input:child.stdout}).on('line',l=>{const p=pending.shift();if(p)p.resolve(JSON.parse(l));});
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error('bridge exited '+code));});
 return {call:q=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(q)+'\n');}),close:()=>child.stdin.end()};
}
const retina=k=>Array.from({length:16},(_,i)=>((i*7+k*3)%16)/16*.9+.05);
const ACTIONS=[0,64,128,1,65,129];
(async()=>{
 const java=bridge();
 try{
  async function episode(mode){
   await java.call({op:'init',seed:5,mode:'base'});
   await java.call({op:'prior',output:6,weight:3});
   const before=await java.call({op:'state'});
   for(let k=0;k<12;k++){
    const d=await java.call({op:'decide',retina:retina(k),train:true,actions:ACTIONS,epsilon:.2,windowMs:20});
    if(k<11){
     if(mode==='carry')await java.call({op:'carry',id:d.id,mask:d.mask,seconds:8/60,frames:8});
     else await java.call({op:'boundary'});
    }else{
     const mid=await java.call({op:'state'});
     const r=await java.call({op:'reward',id:d.id,mask:d.mask,reward:-1,seconds:8/60,frames:8});
     return {before,mid,changed:r.changed,after:await java.call({op:'state'})};
    }
   }
  }
  const c=await episode('carry'),b=await episode('boundary');
  ok(c.mid.updates===c.before.updates&&c.mid.weights===c.before.weights,
   'eleven carries change no weight and no update count (updates '+c.before.updates+' -> '+c.mid.updates+')');
  ok(c.mid.carried===11,'the learner counts eleven carried intervals (got '+c.mid.carried+')');
  ok(c.after.updates===c.mid.updates+1,'the verified reward is the only update');
  console.log('native changes on the verified reward: after carries %d, after boundaries %d',c.changed,b.changed);
  ok(c.changed>b.changed,'after carries the reward reaches earlier decisions: '+c.changed+' native changes against '+b.changed+' after boundary()');
  /* an invalid carry breaks the link */
  await java.call({op:'init',seed:5,mode:'base'});
  const d=await java.call({op:'decide',retina:retina(1),train:true,actions:ACTIONS,epsilon:.2,windowMs:20});
  const bad=await java.call({op:'carry',id:d.id,mask:d.mask^64,seconds:8/60,frames:8});
  ok(bad.accepted===false,'a carry whose executed mask differs from the decision is refused');
  const missing=await java.call({op:'carry',id:'no-such-decision',mask:0,seconds:8/60,frames:8});
  ok(missing.accepted===false,'a carry for an unknown decision is refused');
  /* paused carry (control authority lost): traces only decay, nothing is
     added, nothing is paid, nothing is cleared */
  async function paused(profile){
   await java.call({op:'init',seed:5,mode:'base'});
   if(profile)await java.call({op:'credit',profile});
   await java.call({op:'prior',output:6,weight:3});
   const before=await java.call({op:'state'});
   for(let k=0;k<12;k++){
    const d=await java.call({op:'decide',retina:retina(k),train:true,actions:ACTIONS,epsilon:.2,windowMs:20});
    if(k<11)await java.call({op:'carry',id:d.id,mask:d.mask,seconds:8/60,frames:8,accumulate:k<5});
    else{
     const mid=await java.call({op:'state'});
     const r=await java.call({op:'reward',id:d.id,mask:d.mask,reward:-1,seconds:8/60,frames:8});
     return {before,mid,changed:r.changed};
    }
   }
  }
  const p=await paused(null);
  ok(p.mid.updates===p.before.updates&&p.mid.weights===p.before.weights&&p.mid.paused===6&&p.mid.carried===5,
   'six paused carries change no weight or update and are counted apart (carried '+p.mid.carried+', paused '+p.mid.paused+')');
  ok(p.changed>b.changed&&p.changed<=c.changed,
   'a reward after a pause still reaches the decisions before it, never more than without the pause ('+b.changed+' <= '+p.changed+' <= '+c.changed+')');
  const t=await paused('dual-time-v1');
  ok(t.mid.creditProfile==='dual-time-v1'&&t.mid.updates===t.before.updates&&t.mid.weights===t.before.weights,
   'dual-time-v1 (fast 15 + slow 90 frames by game time): carries and pauses stay unpaid');
  ok(t.changed>=p.changed,'the 90-frame trace keeps at least as many earlier decisions in reach ('+t.changed+' against '+p.changed+')');
  /* frozen SAMPLED evaluation: the draw comes from the caller, the learner
     takes no RNG step and keeps no pending decision */
  await java.call({op:'init',seed:5,mode:'base'});await java.call({op:'prior',output:6,weight:3});
  for(let k=0;k<4;k++){const d=await java.call({op:'decide',retina:retina(k),train:true,actions:ACTIONS,epsilon:.2,windowMs:20});
   await java.call({op:'reward',id:d.id,mask:d.mask,reward:k%2?1:-1,seconds:8/60,frames:8});}
  await java.call({op:'boundary'});
  const digest=st=>JSON.stringify([st.weights,st.learningState,st.rng,st.updates,st.pending]);
  const frozenBefore=await java.call({op:'state'});const masks=new Set();
  for(let k=0;k<24;k++){const d=await java.call({op:'decide',retina:retina(k),train:false,actions:ACTIONS,epsilon:0,windowMs:20,sample:(k*0.137)%1});masks.add(d.mask);}
  const frozenAfter=await java.call({op:'state'});
  ok(digest(frozenBefore)===digest(frozenAfter)&&frozenAfter.pending===0,
   'frozen sampled decisions change nothing in the learner: weights, traces, RNG, updates, pending ('+frozenAfter.pending+')');
  ok(masks.size>1,'and they do sample: '+masks.size+' different actions over 24 draws');
  const trainPath=await java.call({op:'decide',retina:retina(1),train:true,actions:ACTIONS,epsilon:0,windowMs:20});
  const moved=await java.call({op:'state'});
  ok(trainPath.id&&moved.rng!==frozenAfter.rng&&moved.pending===1,
   'the old way to sample (train:true) steps the RNG and leaves a pending decision - why evaluation no longer uses it');
 }finally{java.close();}
 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
 if(fail.length)process.exitCode=1;
})().catch(e=>{console.log('FAILED '+e.stack);process.exitCode=1;});
