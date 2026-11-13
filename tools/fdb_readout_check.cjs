'use strict';
/* The action readout (FdbLearning readoutProfile "action-v1", research P2),
   through the production learner (tools/FdbGameBridge):
   - without it, a layer whose outputs are quiet picks "press nothing" in every
     frozen decision: its score is 0, every button costs -1;
   - with it, the preference between standing and acting is LEARNED from
     verified outcomes, per context: in context A standing is paid -1 and
     acting +1, in context B the opposite, and the frozen layer stands in B
     and acts in A - nothing is removed from the action set;
   - UNKNOWN intervals (carry) and frozen decisions move nothing;
   - a checkpoint roundtrip keeps every score;
   - "none" leaves the old decision rule exactly as it was.
   The graph is the 30-neuron mechanism fixture and the rewards are the test's
   own verified signals: nothing here is a gameplay claim. */
const {spawn}=require('child_process'),readline=require('readline');
if(!process.env.CODE_CLASSPATH){console.log('BLOCKED - CODE_CLASSPATH is not set');process.exit(0);}
const out=[],fail=[];const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
function bridge(){
 const child=spawn(process.env.JAVA||'java',['-cp',process.env.CODE_CLASSPATH,'org.node.flyconsole.FdbGameBridge'],{stdio:['pipe','pipe','ignore']});
 const pending=[];readline.createInterface({input:child.stdout}).on('line',l=>{const p=pending.shift();if(p)p.resolve(JSON.parse(l));});
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error('bridge exited '+code));});
 return {call:q=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(q)+'\n');}),close:()=>child.stdin.end()};
}
const ACTIONS=[0,64,128,1,65,129];
/* two contexts the input layer can tell apart */
const A=Array.from({length:16},(_,i)=>i<8?.9:.05),B=Array.from({length:16},(_,i)=>i<8?.05:.9);
(async()=>{
 const java=bridge();
 try{
  const frozen=async retina=>await java.call({op:'decide',retina,train:false,actions:ACTIONS,epsilon:0,windowMs:20});
  /* 1. no readout: the quiet layer stands */
  await java.call({op:'init',seed:7,mode:'base'});
  const plainA=await frozen(A),plainB=await frozen(B);
  console.log('no readout: A picks %d scores %j | B picks %d',plainA.mask,plainA.scores.map(x=>+x.toFixed(2)),plainB.mask);
  ok(plainA.mask===0&&plainB.mask===0,'without the readout the quiet layer picks "press nothing" in both contexts');
  /* 2. readout: learn stand-in-B / act-in-A from verified outcomes */
  await java.call({op:'init',seed:7,mode:'base'});await java.call({op:'readout',profile:'action-v1'});
  const before=await java.call({op:'state'});
  let paid=0;
  for(let k=0;k<400;k++){
   const ctx=k%2?A:B;
   const d=await java.call({op:'decide',retina:ctx,train:true,actions:ACTIONS,epsilon:.3,windowMs:20});
   const stood=d.mask===0,reward=ctx===A?(stood?-1:1):(stood?1:-1);
   await java.call({op:'reward',id:d.id,mask:d.mask,reward,seconds:8/60,frames:8});paid++;
   await java.call({op:'boundary'});
  }
  const trained=await java.call({op:'state'});
  const fa=await frozen(A),fb=await frozen(B);
  console.log('readout after %d verified outcomes (%d readout updates): A picks %d scores %j | B picks %d scores %j',paid,trained.readoutUpdates,
   fa.mask,fa.scores.map(x=>+x.toFixed(2)),fb.mask,fb.scores.map(x=>+x.toFixed(2)));
  ok(trained.readoutUpdates>0&&before.readoutUpdates===0,'verified outcomes train the readout ('+trained.readoutUpdates+' updates)');
  ok(fa.mask!==0,'in context A, where standing was paid -1, the frozen layer acts (picks '+fa.mask+')');
  ok(fb.mask===0,'in context B, where standing was paid +1, the frozen layer stands - "press nothing" stays a choice, not a removal');
  ok(fa.scores[0]<Math.max(...fa.scores.slice(1))&&fb.scores[0]>Math.max(...fb.scores.slice(1)),
   'the empty action has a learned score of its own: below the best action in A, above it in B');
  /* 3. frozen decisions move nothing */
  const s0=await java.call({op:'state'});
  for(let k=0;k<20;k++)await frozen(k%2?A:B);
  const s1=await java.call({op:'state'});
  ok(JSON.stringify(s0.learningState)===JSON.stringify(s1.learningState)&&s0.rng===s1.rng&&s1.pending===0,'frozen decisions change nothing, readout included');
  /* 4. UNKNOWN (carry) moves nothing */
  for(let k=0;k<12;k++){const d=await java.call({op:'decide',retina:k%2?A:B,train:true,actions:ACTIONS,epsilon:.3,windowMs:20});
   await java.call({op:'carry',id:d.id,mask:d.mask,seconds:8/60,frames:8});}
  const s2=await java.call({op:'state'});
  const weightsOf=st=>JSON.stringify(st.learningState.readout&&st.learningState.readout.weights);
  ok(s2.readoutUpdates===s1.readoutUpdates&&weightsOf(s2)===weightsOf(s1),'twelve UNKNOWN intervals carried: no readout weight moves, no update counted');
  await java.call({op:'boundary'});
  /* 5. checkpoint roundtrip */
  /* the checkpoint op also resets the spiking engine, so both measurements
     start from a reset engine */
  await java.call({op:'reset'});
  const pre=[await frozen(A),await frozen(B)].map(x=>JSON.stringify(x.scores));
  const cp=await java.call({op:'checkpoint'});
  const post=[await frozen(A),await frozen(B)].map(x=>JSON.stringify(x.scores));
  const after=await java.call({op:'state'});
  console.log('checkpoint: format %s, scores before %s / after %s, updates %d -> %d',cp.format,pre.join(' '),post.join(' '),s2.readoutUpdates,after.readoutUpdates);
  ok(cp.format===4&&pre[0]===post[0]&&pre[1]===post[1]&&after.readoutProfile==='action-v1'&&after.readoutUpdates===s2.readoutUpdates,
   'a checkpoint roundtrip keeps every action score in both contexts and the update count');
  ok(after.learningState.readout&&after.learningState.readout.weights.length>0,'the checkpoint carries the readout block');
  /* 6. none: the checkpoint has no readout block at all */
  await java.call({op:'init',seed:7,mode:'base'});
  const none=await java.call({op:'state'});
  ok(!('readout' in none.learningState)&&none.readoutProfile==='none','with the readout off the checkpoint is what it was: no readout block');
 }finally{java.close();}
 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
 if(fail.length)process.exitCode=1;
})().catch(e=>{console.log('FAILED '+e.stack);process.exitCode=1;});
