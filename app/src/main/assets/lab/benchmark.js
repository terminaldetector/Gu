/* Pure summary of explicitly configured evaluation trials; no claim of game completion. */
(function(root){'use strict';
function summary(trials){
 const completed=trials.filter(t=>['success','death','timeout'].includes(t.outcome));
 const n=completed.length,wins=completed.filter(t=>t.outcome==='success').length,z=1.96;
 const rate=n?wins/n:0,den=1+z*z/Math.max(1,n),center=(rate+z*z/(2*Math.max(1,n)))/den;
 const half=z*Math.sqrt(rate*(1-rate)/Math.max(1,n)+z*z/(4*Math.max(1,n)**2))/den;
 const frames=trials.reduce((s,t)=>s+t.frames,0),wallMs=trials.reduce((s,t)=>s+t.wall_ms,0);
 return {completed:n,successes:wins,deaths:completed.filter(t=>t.outcome==='death').length,timeouts:completed.filter(t=>t.outcome==='timeout').length,interrupted:trials.length-n,success_rate:n?rate:null,wilson95:n?[Math.max(0,center-half),Math.min(1,center+half)]:null,frames,wall_ms:wallMs,measured_fps:wallMs>0?frames*1000/wallMs:0};
}
root.FlyBenchmark={summary};if(typeof module!=='undefined')module.exports=root.FlyBenchmark;
})(typeof window==='undefined'?globalThis:window);
