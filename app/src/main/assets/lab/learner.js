/* Seeded linear SARSA(lambda) readout. Learns controller weights, not connectome anatomy. */
(function(root){
'use strict';
class Learner {
 constructor(seed=1){this.reset(seed);}
 reset(seed=1){this.rng=seed>>>0||1;this.weights=Array.from({length:9},()=>new Array(29).fill(0));this.traces=this.weights.map(w=>w.slice());this.previous=null;this.updates=0;this.episodes=0;this.totalReward=0;this.epsilon=.2;this.alpha=.04;this.gamma=.95;this.lambda=.7;}
 random(){let x=this.rng;x^=x<<13;x^=x>>>17;x^=x<<5;this.rng=x>>>0;return this.rng/4294967296;}
 features(retina,outputs,position=null){return [1,...retina.map(x=>Math.max(0,Math.min(1,x))),...outputs.map(x=>Math.tanh(x/100)),...(position||[0,0,0,0])];}
 q(f,a){return f.reduce((v,x,i)=>v+x*this.weights[a][i],0);}
 choose(f,train){if(train&&this.random()<this.epsilon)return Math.floor(this.random()*9);const q=this.weights.map((_,a)=>this.q(f,a));const max=Math.max(...q);const ties=q.map((x,i)=>Math.abs(x-max)<1e-9?i:-1).filter(i=>i>=0);return ties[Math.floor(this.random()*ties.length)];}
 step(f,reward,terminal,train){
  if(f.length!==29||f.some(x=>!Number.isFinite(x))||!Number.isFinite(reward))throw Error('Invalid learning features/reward');
  const a=this.choose(f,train);
  if(train&&this.previous){const p=this.previous;const delta=Math.max(-10,Math.min(10,reward+(terminal?0:this.gamma*this.q(f,a))-this.q(p.f,p.a)));const norm=p.f.reduce((s,x)=>s+x*x,1);
   for(let j=0;j<9;j++)for(let i=0;i<29;i++){this.traces[j][i]*=this.gamma*this.lambda;if(j===p.a)this.traces[j][i]+=p.f[i];this.weights[j][i]=Math.max(-20,Math.min(20,this.weights[j][i]+this.alpha*delta*this.traces[j][i]/norm));}
   this.updates++;this.totalReward+=reward;
  }
  if(terminal){this.episodes++;this.boundary();return 0;}
  this.previous=train?{f:f.slice(),a}:null;return [0,1,2,16,32,64,128,129,17][a];
 }
 boundary(){this.previous=null;this.traces=this.weights.map(w=>new Array(w.length).fill(0));}
 save(){return {version:1,algorithm:'linear SARSA(lambda)',weights:this.weights,updates:this.updates,episodes:this.episodes,totalReward:this.totalReward,rng:this.rng};}
 load(data){if(data.version!==1||data.algorithm!=='linear SARSA(lambda)'||!Array.isArray(data.weights)||data.weights.length!==9||data.weights.some(w=>!Array.isArray(w)||w.length!==29||w.some(x=>!Number.isFinite(x)||Math.abs(x)>20)))throw Error('Invalid policy');this.reset(data.rng);this.weights=data.weights.map(w=>w.slice());this.updates=Number(data.updates)||0;this.episodes=Number(data.episodes)||0;this.totalReward=Number(data.totalReward)||0;this.boundary();}
}
root.FlyLearner=Learner;if(typeof module!=='undefined')module.exports=Learner;
})(typeof window==='undefined'?globalThis:window);
