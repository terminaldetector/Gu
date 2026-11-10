'use strict';
// D3 Level B: AGOD on a homebrew ROM it has never seen and whose structure
// nobody has told it.
//
// The ROM is NOT in this repository and is not written to any artefact. It is
// named by AGOD_BLIND_ROM, built separately from a pinned upstream revision.
// This tool reads no source code, no address list and no rule of the game. It
// boots the cartridge, runs the single-action pipeline and the frontier search
// from wherever boot leaves the machine, and writes what they found - with the
// ROM's SHA-256 and a timestamp - so the record exists BEFORE anyone studies
// the game. Checking the record against the game is a separate, later step.
//
// A blind result is not a controlled result: there is no oracle here, so
// nothing below is precision or recall. It is yield, refusals, depth and cost.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROM=process.env.AGOD_BLIND_ROM;
if(!ROM){console.error('set AGOD_BLIND_ROM to a locally built homebrew ROM; this tool never looks inside the repository');process.exit(2);}
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js','agod-evidence.js',
 'agod-candidates.js','agod-consumers.js','agod-platform-driver.js','agod-pipeline.js',
 'agod-sequences.js','agod-graph.js'])require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline,
 Seq=globalThis.FlyAgodSequences,Graph=globalThis.FlyAgodGraph;
const bytes=fs.readFileSync(ROM),romSha256=crypto.createHash('sha256').update(bytes).digest('hex');
const boot=()=>{const b=PD.createNesSync({romBytes:bytes,jsnes,frameBudget:3000000});
 for(let i=0;i<180;i++)b.core.frame();return b;};
const report={type:'gu-agod-blind-homebrew',version:1,recordedAtUtc:new Date().toISOString(),
 romSha256,romBytes:bytes.length,label:process.env.AGOD_BLIND_LABEL||null,
 discipline:'no source, address or rule of this game was available to the search; '
  +'this record was written before any inspection of the game',
 entry:'180 frames from power-on, no input',results:{}};

{const b=boot(),t=Date.now();
 const r=Pipeline.run(b.driver,{romHash:romSha256,coreRevision:'jsnes',profileRevision:'agod-blind',typeEvents:30});
 report.results.pipeline={status:r.status,stage:r.stage||null,reason:r.reason||null,
  goal:r.goal?{id:r.goal.id,polarity:r.goal.polarity}:null,
  discoveredResource:r.discovered&&r.discovered.resource?{address:r.discovered.resource.address,
   width:r.discovered.resource.width,step:r.discovered.resource.step,direction:r.discovered.resource.direction}:null,
  frames:b.framesRun(),wallMs:Date.now()-t};
 console.log('pipeline: %s stage=%s reason=%s frames=%d',r.status,r.stage||'-',r.reason||'-',b.framesRun());
 b.dispose();}

{const b=boot();
 const r=Seq.frontier(b.driver,{maxDepth:3,frameBudget:600000,experimentBudget:2500,restoreBudget:6000});
 const graph=Graph.fromFrontier(r,{romHash:romSha256,coreRevision:'jsnes',platform:'nes'});
 report.results.frontier={status:r.status,completeness:r.completeness,outcomes:r.outcomes,
  search:r.search,deepestConfirmed:r.deepestConfirmed,multiStepConfirmed:r.multiStepConfirmed,
  timeDrivenAddressCount:r.timeDrivenAddressCount,
  confirmed:r.confirmed.map(c=>({steps:c.experiment.steps,orderSensitive:c.orderSensitive,
   startsAgreeing:c.startsAgreeing,startsTried:c.startsTried,
   effects:c.attributed.map(e=>({address:e.address,from:e.from,to:e.to,delta:e.delta,
    transient:e.transient,firstHorizon:e.firstHorizon,delayInterval:e.delayInterval||null})),
   windows:(c.windows||[]).map(w=>w.reading)})),
  fields:r.resources.map(x=>({address:x.address,role:x.role,
   depletion:x.depletion?{track:x.depletion.track,floor:x.depletion.floor}:null,restoredBy:x.restoredBy||null})),
  cost:{frames:r.budget.framesSpent,experiments:r.budget.experiments,restores:r.budget.restores,
   wallMs:r.budget.wallMs,heapPeakBytes:r.budget.heapPeakBytes,exhausted:r.budget.exhausted}};
 report.results.graph={digest:graph.digest,nodes:graph.nodes.length,edges:graph.edges.length,proofs:graph.proofs.length};
 console.log('frontier: %s  confirmed=%d (multi-step %d, deepest %d)  outcomes=%j',r.status,r.confirmed.length,
  r.multiStepConfirmed,r.deepestConfirmed,r.outcomes);
 console.log('  %s',r.completeness);
 console.log('  cost: frames=%d experiments=%d wall=%ss heap=%dMB',r.budget.framesSpent,r.budget.experiments,
  (r.budget.wallMs/1000).toFixed(1),Math.round(r.budget.heapPeakBytes/1048576));
 for(const c of r.confirmed)console.log('  %s  -> %s',c.described,
  c.attributed.map(e=>e.address+':'+(e.delta>0?'+':'')+e.delta+(e.transient?'t':'')).join(' '));
 for(const x of r.resources)console.log('  field %d %s',x.address,x.role);
 /* replay on a fresh core: a claim that does not reproduce is not kept quiet */
 const fresh=boot();const replay=Graph.replay(fresh.driver,graph);
 report.results.replay={proofs:replay.proofs,reproduced:replay.reproduced};
 console.log('  replay on a fresh core: %d of %d proofs',replay.reproduced,replay.proofs);
 fresh.dispose();b.dispose();}

const out=process.env.AGOD_BLIND_REPORT||'agod-blind-homebrew.json';
fs.writeFileSync(out,JSON.stringify(report,null,1)+'\n');
console.log('record written: %s (ROM bytes are not in it)',out);
