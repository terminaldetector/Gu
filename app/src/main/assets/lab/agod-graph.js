/* Experimental AGOD causal state graph (D1).

   A compact, exportable account of what a frontier search established:

     NODE  a class of prefixes that left the machine in the same place (same
           savestate signature against a neutral run). It carries how it was
           reached, how unusual it was, and a phase hypothesis that is allowed
           to be UNKNOWN.
     EDGE  one executed action from one class to another.
     PROOF a confirmed dependency: the exact steps, the effect in the observed
           window, the controls that failed to explain it, the starts that
           agreed, the measured window and the measured delay INTERVAL.
     FIELD what each affected address turned out to be, from behaviour alone.

   It grows with the number of state CLASSES the beam kept, never with frames.
   It holds no ROM bytes, no savestates and no RAM dumps - hashes, addresses,
   deltas and step lists only - so it can leave the device in a diagnostic
   export.

   Phase is deliberately modest. From the root, "some action has a specific,
   reproducible effect" is evidence the machine is taking input; nothing here
   can tell a title screen from play, and it does not pretend to. */
(function(root){'use strict';
const SCHEMA_VERSION=1,GRAPH_REVISION='agod-graph-d1-1';

function fnv(text){
 let a=0x811c9dc5,b=0x1b873593;
 for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);
  a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^(c+i),0x85ebca6b)>>>0;}
 return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
}
/* stable serialisation: keys sorted, so the digest is of content, not order */
function canonical(value){
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return JSON.stringify(value===undefined?null:value);
}

function fromFrontier(result,identity){
 if(!result||result.mode!=='frontier'||!result.graph)
  return {schemaVersion:SCHEMA_VERSION,revision:GRAPH_REVISION,status:'REFUSED',
   reason:'a frontier search result is required'};
 const specific=result.confirmed.filter(record=>
  record.attributed.some(effect=>{
   const field=result.resources.find(r=>r.address===effect.address);
   return field&&field.role!=='INPUT_ECHO';
  }));
 const proofs=result.confirmed.map((record,index)=>({
  id:'proof-'+index,steps:record.experiment.steps,stepCount:record.stepCount,
  spanFrames:record.spanFrames,orderSensitive:record.orderSensitive,
  effects:record.attributed.map(e=>({address:e.address,delta:e.delta,
   transient:e.transient,firstHorizon:e.firstHorizon,
   delayInterval:e.delayInterval||null})),
  controls:record.controls,
  startsAgreeing:record.startsAgreeing,startsTried:record.startsTried,
  windows:(record.windows||[]).map(w=>({afterStep:w.afterStep,
   windowFrames:w.windowFrames})),
  experiment:record.experiment}));
 const body={
  identity:{romHash:identity&&identity.romHash||null,
   coreRevision:identity&&identity.coreRevision||null,
   platform:identity&&identity.platform||null,
   detectorRevision:result.revision,
   actions:result.actions,observedRamBytes:result.observedRamBytes},
  nodes:result.graph.nodes.map(node=>({...node,
   phase:node.depth===0
    ?(specific.length?{value:'RESPONSIVE',basis:specific.length
       +' action sequence(s) from here have a specific reproducible effect'}
      :{value:'UNKNOWN',basis:'no specific effect was confirmed from here'})
    :{value:'UNKNOWN',basis:'not probed as a start state'}})),
  edges:result.graph.edges,
  proofs,
  fields:result.resources.map(r=>({address:r.address,role:r.role,why:r.why,
   depletion:r.depletion?{floor:r.depletion.floor,reachedFloor:r.depletion.reachedFloor,
    track:r.depletion.track,spentBy:r.depletion.spentBy}:null,
   restoredBy:r.restoredBy||null})),
  search:result.search,completeness:result.completeness};
 return {schemaVersion:SCHEMA_VERSION,revision:GRAPH_REVISION,status:'BUILT',
  ...body,digest:fnv(canonical(body)),
  /* cost is reported beside the graph, not inside its digest: two runs that
     find the same thing in different wall time found the same thing */
  cost:{frames:result.budget.framesSpent,experiments:result.budget.experiments,
   restores:result.budget.restores,wallMs:result.budget.wallMs,
   heapPeakBytes:result.budget.heapPeakBytes}};
}

/* Re-run every proof on a driver and say which effects came back. */
function replay(driver,graph){
 const outcomes=[];
 const snapshot=driver.snapshot();
 for(const proof of graph.proofs||[]){
  driver.restore(snapshot);
  const before=driver.readRam();
  for(const text of proof.experiment.steps){
   const m=/^(PRESS|HOLD|WAIT)\((\d+)(?:,(\d+))?\)$/.exec(text);
   if(!m)continue;
   if(m[1]==='PRESS'){driver.run(Number(m[2]),proof.experiment.hold);
    driver.run(0,proof.experiment.release);}
   else if(m[1]==='HOLD')driver.run(Number(m[2]),Number(m[3]));
   else driver.run(0,Number(m[2]));
  }
  const seen=new Map();let elapsed=0;
  for(const horizon of proof.experiment.horizons){
   if(horizon>elapsed){driver.run(0,horizon-elapsed);elapsed=horizon;}
   const now=driver.readRam();
   for(const effect of proof.effects)
    if(!seen.has(effect.address)&&now[effect.address]!==before[effect.address])
     seen.set(effect.address,now[effect.address]-before[effect.address]);
  }
  const reproduced=proof.effects.filter(effect=>
   seen.has(effect.address)&&Math.sign(seen.get(effect.address))===Math.sign(effect.delta));
  outcomes.push({id:proof.id,steps:proof.experiment.steps,
   effects:proof.effects.length,reproduced:reproduced.length,
   ok:reproduced.length===proof.effects.length});
 }
 driver.restore(snapshot);
 return {proofs:outcomes.length,reproduced:outcomes.filter(o=>o.ok).length,outcomes};
}

const api={SCHEMA_VERSION,GRAPH_REVISION,fromFrontier,replay,canonical,digestOf:value=>fnv(canonical(value))};
root.FlyAgodGraph=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
