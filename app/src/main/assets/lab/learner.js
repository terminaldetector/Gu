/* Seeded linear SARSA(lambda) readout. Learns controller weights, not connectome anatomy. */
(function(root){
'use strict';
class Learner {
 constructor(seed=1){this.reset(seed);}
 reset(seed=1){this.allowedMask=255;this.actions=[0,1,2,16,32,64,128,129,17];this.rng=seed>>>0||1;this.weights=Array.from({length:9},()=>new Array(45).fill(0));this.traces=this.weights.map(w=>w.slice());this.previous=null;this.updates=0;this.episodes=0;this.totalReward=0;this.epsilon=.2;this.alpha=.04;this.gamma=.95;this.lambda=.7;}
 random(){let x=this.rng;x^=x<<13;x^=x>>>17;x^=x<<5;this.rng=x>>>0;return this.rng/4294967296;}
 features(retina,outputs,position=null,previous=null){const current=retina.map(x=>Math.max(0,Math.min(1,x)));const motion=current.map((x,i)=>previous?x-previous[i]:0);return [1,...current,...motion,...outputs.map(x=>Math.tanh(x/100)),...(position||[0,0,0,0])];}
 setActions(actions){if(!Array.isArray(actions)||actions.length<2||actions.length>64||new Set(actions).size!==actions.length||actions.some(x=>!Number.isInteger(x)||x<0||x>255||(x&48)===48||(x&192)===192))throw Error('Invalid action set');const old=this.actions,weights=this.weights;this.weights=actions.map(mask=>old.includes(mask)?weights[old.indexOf(mask)].slice():new Array(45).fill(0));this.actions=actions.slice();this.boundary();}
 preset(seed=1){
  if(this.updates>0||this.weights.some(row=>row.some(weight=>Math.abs(weight)>1e-9)))return false;
  let x=(seed>>>0)||1;const rnd=()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};
  this.weights=this.actions.map(mask=>{
   const w=new Array(45).fill(0);w[0]=(rnd()-.5)*.08;
   for(let i=0;i<16;i++){const col=i%4,row=(i/4)|0;let v=0;
    if(mask&128)v+=(col-1.5)*.018;if(mask&64)v+=(1.5-col)*.018;
    if(mask&16)v+=(1.5-row)*.018;if(mask&32)v+=(row-1.5)*.018;
    if(mask&1||mask&2)v+=(.5-rnd())*.006;w[1+i]=v;w[17+i]=v*.7;
   }
   if(mask&1||mask&2)w[33]=.012;if(mask===0)w[0]+=.01;return w;
  });this.boundary();return true;
 }

 setAllowedMask(mask){if(!Number.isInteger(mask)||mask<0||mask>255||!this.actions.some(a=>(a&~mask)===0))throw Error('Нет разрешённых действий: добавьте нейтральную маску 0 или игровые кнопки');if(mask!==this.allowedMask){this.allowedMask=mask;this.boundary();}}
 eligible(){return this.actions.map((mask,i)=>(mask&~this.allowedMask)===0?i:-1).filter(i=>i>=0);}
 q(f,a){return f.reduce((v,x,i)=>v+x*this.weights[a][i],0);}
 choose(f,train){const eligible=this.eligible();if(!eligible.length)throw Error("Нет разрешённых действий");if(train&&this.random()<this.epsilon)return eligible[Math.floor(this.random()*eligible.length)];const max=Math.max(...eligible.map(a=>this.q(f,a)));const ties=eligible.filter(a=>Math.abs(this.q(f,a)-max)<1e-9);return ties[Math.floor(this.random()*ties.length)];}
 step(f,reward,terminal,train){
  if(f.length!==45||f.some(x=>!Number.isFinite(x))||!Number.isFinite(reward))throw Error('Invalid learning features/reward');
  const a=this.choose(f,train);
  if(train&&this.previous){const p=this.previous;const delta=Math.max(-10,Math.min(10,reward+(terminal?0:this.gamma*this.q(f,a))-this.q(p.f,p.a)));const norm=p.f.reduce((s,x)=>s+x*x,1);
   for(let j=0;j<this.actions.length;j++)for(let i=0;i<45;i++){this.traces[j][i]*=this.gamma*this.lambda;if(j===p.a)this.traces[j][i]+=p.f[i];this.weights[j][i]=Math.max(-20,Math.min(20,this.weights[j][i]+this.alpha*delta*this.traces[j][i]/norm));}
   this.updates++;this.totalReward+=reward;
  }
  if(terminal){this.episodes++;this.boundary();return 0;}
  this.previous=train?{f:f.slice(),a}:null;return this.actions[a];
 }
 boundary(){this.previous=null;this.traces=this.weights.map(w=>new Array(w.length).fill(0));}
 save(){return {version:2,actions:this.actions.slice(),algorithm:'linear SARSA(lambda)',weights:this.weights,updates:this.updates,episodes:this.episodes,totalReward:this.totalReward,rng:this.rng};}
 load(data){
  if(!data||![1,2].includes(data.version)||data.algorithm!=='linear SARSA(lambda)')throw Error('Invalid policy version');
  const actions=data.version===1?[0,1,2,16,32,64,128,129,17]:data.actions;
  const size=data.version===1?29:45;
  if(!Array.isArray(data.weights)||!Array.isArray(actions)||data.weights.length!==actions.length||data.weights.some(w=>!Array.isArray(w)||w.length!==size||w.some(x=>!Number.isFinite(x)||Math.abs(x)>20)))throw Error('Invalid weights');
  for(const key of ['updates','episodes','totalReward','rng'])if(!Number.isFinite(data[key]))throw Error('Invalid policy counters');
  this.reset(data.rng);this.setActions(actions);this.weights=data.weights.map(w=>data.version===1?[...w.slice(0,17),...new Array(16).fill(0),...w.slice(17)]:w.slice());this.updates=data.updates;this.episodes=data.episodes;this.totalReward=data.totalReward;this.boundary();
 }

}
root.FlyLearner=Learner;if(typeof module!=='undefined')module.exports=Learner;
})(typeof window==='undefined'?globalThis:window);
