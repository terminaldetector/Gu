/* Experimental Double DQN learner (TZ v2.0, NN-01, E5).

   The forbidden shortcut this file exists to avoid is "demonstrating a network
   without weight updates" (1.3). So the gradients here are computed by hand and
   are checkable: `loss` and `gradients` take the same batch, so a finite
   difference test can confirm every parameter's derivative, and the check that
   accompanies this module does exactly that.

   E1 established that Stable-Baselines3's DQN.train computes a vanilla target,
   so the Double DQN target NN-01 asks for had to be written rather than ported.
   Both targets live here, `double` being the default, so a test can show they
   actually differ instead of taking the name on trust.

   Everything is seeded and explicit: the same seed and the same transitions
   reproduce the same weights, and a checkpoint round-trip continues the same
   trajectory. Not wired into any production screen, and it does not touch
   Engine/FdbLearning/FdbGrowth or any Layer Set format. */
(function(root){'use strict';
const SCHEMA_VERSION=1,LEARNER_REVISION='agod-dqn-e5-1';
const frozen=Object.freeze.bind(Object);

/* Small, explicit PRNG so a run is reproducible from an integer. */
function createRng(seed){
 let state=(seed>>>0)||1;
 const next=()=>{state=(state+0x6d2b79f5)>>>0;let t=state;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
 return {next,uniform:(lo,hi)=>lo+(hi-lo)*next(),int:n=>Math.floor(next()*n),
  normal(){const u=Math.max(next(),1e-12),v=next();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);},
  state(){return state;},restore(value){state=value>>>0;}};
}

function createNetwork(options){
 const inputs=options.inputs,hidden=options.hidden,actions=options.actions;
 const rng=options.rng||createRng(1);
 const alloc=n=>new Float64Array(n);
 const net={inputs,hidden,actions,
  w1:alloc(hidden*inputs),b1:alloc(hidden),w2:alloc(actions*hidden),b2:alloc(actions)};
 /* He initialisation for the ReLU layer, Xavier-ish for the linear head. */
 const s1=Math.sqrt(2/inputs),s2=Math.sqrt(1/hidden);
 for(let i=0;i<net.w1.length;i++)net.w1[i]=rng.normal()*s1;
 for(let i=0;i<net.w2.length;i++)net.w2[i]=rng.normal()*s2;
 return net;
}
const parameterArrays=net=>[net.w1,net.b1,net.w2,net.b2];
const parameterCount=net=>parameterArrays(net).reduce((sum,a)=>sum+a.length,0);
function getParameters(net){
 const out=new Float64Array(parameterCount(net));let offset=0;
 for(const array of parameterArrays(net)){out.set(array,offset);offset+=array.length;}
 return out;
}
function setParameters(net,values){
 let offset=0;
 for(const array of parameterArrays(net)){array.set(values.subarray(offset,offset+array.length));offset+=array.length;}
}
function copyInto(destination,source){
 const d=parameterArrays(destination),s=parameterArrays(source);
 for(let i=0;i<d.length;i++)d[i].set(s[i]);
}

function forward(net,state){
 const pre=new Float64Array(net.hidden),act=new Float64Array(net.hidden),q=new Float64Array(net.actions);
 for(let h=0;h<net.hidden;h++){
  let sum=net.b1[h];const base=h*net.inputs;
  for(let i=0;i<net.inputs;i++)sum+=net.w1[base+i]*state[i];
  pre[h]=sum;act[h]=sum>0?sum:0;
 }
 for(let a=0;a<net.actions;a++){
  let sum=net.b2[a];const base=a*net.hidden;
  for(let h=0;h<net.hidden;h++)sum+=net.w2[base+h]*act[h];
  q[a]=sum;
 }
 return {pre,act,q};
}
const qValues=(net,state)=>forward(net,state).q;
function argmax(values){let best=0;for(let i=1;i<values.length;i++)if(values[i]>values[best])best=i;return best;}

/* Mean squared error over the batch's chosen actions. Plain MSE, because the
   finite difference check must compare against an exactly differentiable
   objective; clipping would hide a wrong derivative inside a kink. */
function loss(net,batch){
 let total=0;
 for(const item of batch){const q=forward(net,item.state).q,error=q[item.action]-item.target;total+=error*error;}
 return total/(2*batch.length);
}
function gradients(net,batch){
 const g={w1:new Float64Array(net.w1.length),b1:new Float64Array(net.b1.length),
          w2:new Float64Array(net.w2.length),b2:new Float64Array(net.b2.length)};
 const scale=1/batch.length;
 for(const item of batch){
  const {pre,act,q}=forward(net,item.state);
  const error=(q[item.action]-item.target)*scale;
  const base2=item.action*net.hidden;
  for(let h=0;h<net.hidden;h++)g.w2[base2+h]+=error*act[h];
  g.b2[item.action]+=error;
  for(let h=0;h<net.hidden;h++){
   if(pre[h]<=0)continue;                       /* ReLU gate */
   const delta=error*net.w2[base2+h],base1=h*net.inputs;
   for(let i=0;i<net.inputs;i++)g.w1[base1+i]+=delta*item.state[i];
   g.b1[h]+=delta;
  }
 }
 const out=new Float64Array(parameterCount(net));let offset=0;
 for(const array of [g.w1,g.b1,g.w2,g.b2]){out.set(array,offset);offset+=array.length;}
 return out;
}

/* Adam, so that a small number of updates is enough to move a policy. */
function createOptimizer(net,options){
 const config=options||{};
 const size=parameterCount(net);
 return {lr:config.lr===undefined?0.002:config.lr,beta1:0.9,beta2:0.999,eps:1e-8,
  m:new Float64Array(size),v:new Float64Array(size),t:0,
  apply(network,grad){
   this.t++;
   const parameters=getParameters(network);
   const correction1=1-Math.pow(this.beta1,this.t),correction2=1-Math.pow(this.beta2,this.t);
   for(let i=0;i<parameters.length;i++){
    this.m[i]=this.beta1*this.m[i]+(1-this.beta1)*grad[i];
    this.v[i]=this.beta2*this.v[i]+(1-this.beta2)*grad[i]*grad[i];
    parameters[i]-=this.lr*(this.m[i]/correction1)/(Math.sqrt(this.v[i]/correction2)+this.eps);
   }
   setParameters(network,parameters);
  }};
}

/* The two targets, side by side, so the difference is testable.
   double:  a* = argmax online(s'),  y = r + gamma * target(s')[a*]
   vanilla: y = r + gamma * max target(s') */
function targetValue(mode,online,targetNet,transition,gamma){
 if(transition.done)return transition.reward;
 const next=qValues(targetNet,transition.nextState);
 if(mode==='vanilla')return transition.reward+gamma*next[argmax(next)];
 const selected=argmax(qValues(online,transition.nextState));
 return transition.reward+gamma*next[selected];
}

function createReplay(capacity,rng){
 const items=[];let cursor=0;
 return {push(transition){if(items.length<capacity)items.push(transition);else{items[cursor]=transition;cursor=(cursor+1)%capacity;}},
  size(){return items.length;},
  sample(count){const out=[];for(let i=0;i<count;i++)out.push(items[rng.int(items.length)]);return out;},
  all(){return items.slice();}};
}

function createAgent(options){
 const config=options||{};
 const rng=createRng(config.seed===undefined?1:config.seed);
 const inputs=config.inputs,actions=config.actions;
 const hidden=config.hidden===undefined?24:config.hidden;
 const gamma=config.gamma===undefined?0.95:config.gamma;
 const batchSize=config.batchSize===undefined?32:config.batchSize;
 const warmup=config.warmup===undefined?64:config.warmup;
 const syncEvery=config.syncEvery===undefined?50:config.syncEvery;
 const mode=config.targetMode==='vanilla'?'vanilla':'double';
 const online=createNetwork({inputs,hidden,actions,rng});
 const targetNet=createNetwork({inputs,hidden,actions,rng});copyInto(targetNet,online);
 const optimizer=createOptimizer(online,{lr:config.lr});
 const replay=createReplay(config.capacity===undefined?5000:config.capacity,rng);
 const stats={updates:0,syncs:0,transitions:0,lastLoss:null,parameterMovement:0};

 function act(state,epsilon){
  if(epsilon>0&&rng.next()<epsilon)return {action:rng.int(actions),greedy:false};
  return {action:argmax(qValues(online,state)),greedy:true};
 }
 function observe(transition){replay.push(transition);stats.transitions++;}
 function train(){
  if(replay.size()<Math.max(warmup,batchSize))return {updated:false,reason:'replay below warmup'};
  const batch=replay.sample(batchSize).map(transition=>({
   state:transition.state,action:transition.action,
   target:targetValue(mode,online,targetNet,transition,gamma)}));
  const before=getParameters(online);
  stats.lastLoss=loss(online,batch);
  optimizer.apply(online,gradients(online,batch));
  const after=getParameters(online);
  let movement=0;for(let i=0;i<after.length;i++)movement+=Math.abs(after[i]-before[i]);
  stats.parameterMovement+=movement;stats.updates++;
  if(stats.updates%syncEvery===0){copyInto(targetNet,online);stats.syncs++;}
  return {updated:true,loss:stats.lastLoss,movement};
 }
 return {act,observe,train,
  qValues:state=>Array.from(qValues(online,state)),
  targetMode:()=>mode,
  stats:()=>({...stats,replay:replay.size()}),
  /* A checkpoint carries weights, optimizer moments, the PRNG and the replay:
     restoring one continues the same run, which the check verifies. */
  checkpoint(){return {schemaVersion:SCHEMA_VERSION,learnerRevision:LEARNER_REVISION,
   shape:{inputs,hidden,actions},targetMode:mode,gamma,
   online:Array.from(getParameters(online)),target:Array.from(getParameters(targetNet)),
   optimizer:{t:optimizer.t,lr:optimizer.lr,m:Array.from(optimizer.m),v:Array.from(optimizer.v)},
   rngState:rng.state(),stats:{...stats},replay:replay.all()};},
  restore(checkpoint){
   if(!checkpoint||checkpoint.schemaVersion!==SCHEMA_VERSION)throw new Error('unsupported checkpoint');
   if(checkpoint.shape.inputs!==inputs||checkpoint.shape.hidden!==hidden||checkpoint.shape.actions!==actions)
    throw new Error('checkpoint shape does not match this agent');
   if(checkpoint.targetMode!==mode)throw new Error('checkpoint was produced by a different target mode');
   setParameters(online,Float64Array.from(checkpoint.online));
   setParameters(targetNet,Float64Array.from(checkpoint.target));
   optimizer.t=checkpoint.optimizer.t;optimizer.m.set(checkpoint.optimizer.m);optimizer.v.set(checkpoint.optimizer.v);
   rng.restore(checkpoint.rngState);
   Object.assign(stats,checkpoint.stats);
   for(const transition of checkpoint.replay)replay.push(transition);
   return {restored:true,replay:replay.size()};},
  parameters:()=>getParameters(online)};
}

const api={SCHEMA_VERSION,LEARNER_REVISION,createRng,createNetwork,createOptimizer,createReplay,
 forward,qValues,argmax,loss,gradients,getParameters,setParameters,copyInto,targetValue,createAgent};
root.FlyAgodDqn=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
