'use strict';
// Structural discovery tests: expected counter locations belong to this checker,
// never to the production miner. Actual NES execution is checked separately.
const assert=require('node:assert/strict'),G=require('../app/src/main/assets/lab/goal-discovery.js');
const context=(length=64,platform='nes',base=0)=>({platform,romHash:'a'.repeat(64),coreRevision:'unit-core-v1',mapper:{id:0,submapper:null},schema:1,detectorRevision:G.DETECTOR_REVISION,ramLayout:{base,length,canonical:true}});
const generous={maxCandidates:512,maxSeedAddresses:64,maxDecodePerObservation:8192,maxReportedCandidates:256,maxWorkMsPerObservation:50,maxTotalWorkMs:30000,maxObservations:10000,maxElapsedMs:3600000};
function fixture(options={}){
 const ctx=options.context||context(),ram=new Uint8Array(ctx.ramLayout.length),miner=new G.CandidateMiner({context:ctx,limits:{...generous,...options.limits}});let tick=0;
 const observe=(overrides={})=>{
  const n=overrides.tick===undefined?tick++:overrides.tick;
  const frame=overrides.frame===undefined?n*12:overrides.frame,action={mask:0,humanMask:0,agentMask:0,manualOverride:false,...overrides.action};
  if(!Object.hasOwn(overrides.action||{},'interval'))action.interval={firstFrame:Math.max(0,frame-11),lastFrame:frame,frames:Math.min(12,frame+1),unionMask:action.mask,changes:0,manualOverrideSeen:action.manualOverride,complete:true,coverage:'executed-frames'};
  return miner.observe({version:1,context:ctx,generation:1,frame,atMs:n*200,ram,visual:{bins16:Array(16).fill(0),hash:'visual-fixture'},provenance:{runId:'run-1',originId:'origin-1',startId:'start-1',trajectoryId:'trajectory-1',partition:'discovery',independence:'unverified'},fingerprint:{hash:'partial-fixture',scope:'ram-visual-partial'},...overrides,action});
 };
 return {ctx,ram,miner,observe};
}
function put(ram,spec,value){
 if(spec.format==='signed'&&value<0)value+=2**(spec.width*8);
 for(let k=0;k<spec.width;k++){
  const address=spec.address+(spec.endian==='little'?k:spec.width-1-k);
  ram[address]=spec.format==='bcd'?((Math.floor(value/10)%10)<<4)|(value%10):value%256;
  value=Math.floor(value/(spec.format==='bcd'?100:256));
 }
}
function candidate(miner,spec){return miner.report().candidates.find(c=>Object.keys(spec).every(k=>c.spec[k]===spec[k]));}
let interpretations=0;
for(const format of ['unsigned','signed','bcd'])for(const width of [1,2,3,4])for(const endian of width===1?['little']:['little','big']){
 const f=fixture(),spec={address:23,width,format,endian},base=(format==='bcd'?100:256)**width;
 const values=format==='signed'?[base/2-5,base/2-1,-base/2,-base/2+1,-4,0]:[base-5,base-1,0,1,4,0];
 for(const value of values){put(f.ram,spec,value);assert(f.observe().accepted);}
 const row=candidate(f.miner,spec);assert(row,JSON.stringify(spec)+' discovered through changed bytes without an oracle');assert(row.statistics.changes>=4);assert(row.statistics.wraps>=1);assert(row.statistics.resets>=1);assert.equal(row.role,'unknown');assert.equal(row.polarity,'unknown');assert.equal(row.confidence,null);assert.equal(f.miner.report().rewardStatus,'UNKNOWN');interpretations++;
}
// Zero padding and format aliases remain explicit; discovering bytes is not
// enough evidence to pick a width, signedness, BCD interpretation or polarity.
{
 const f=fixture();f.observe();f.ram[20]=1;f.observe();f.ram[20]=2;f.observe();
 const one=candidate(f.miner,{address:20,width:1,format:'unsigned',endian:'little'}),padded=candidate(f.miner,{address:20,width:2,format:'unsigned',endian:'little'}),bcd=candidate(f.miner,{address:20,width:1,format:'bcd',endian:'little'});
 assert(one&&padded&&bcd);assert.equal(one.aliasGroup,padded.aliasGroup);assert.equal(one.aliasGroup,bcd.aliasGroup);assert.notEqual(one.id,padded.id);
 f.ram[20]=0xfa;f.observe();assert(candidate(f.miner,{address:20,width:1,format:'bcd',endian:'little'}).confounds.includes('invalid-bcd-observed'));
 const report=f.miner.report();assert(!JSON.stringify(report).includes('partial-fixture'),'partial state hashes do not become evidence of independent starts');assert(!('ram' in report));assert(!('lastValue' in report.candidates[0]));
}
{
 const f=fixture(),provenance={runId:'safe-run',originId:null,startId:null,trajectoryId:'safe-trajectory',partition:'discovery',independence:'unverified',unexpectedPrivateDump:'must-not-be-retained'};
 f.observe({provenance});f.ram[4]=1;f.observe({provenance});assert(!JSON.stringify(f.miner.report()).includes('must-not-be-retained'),'unknown provenance properties cannot smuggle raw memory into reports');
}
// Frame clocks, periodic timers, mask echo and noisy state remain diagnostics,
// not actionable game semantics. The rejection reasons are provisional confounds.
{
 const f=fixture({context:context(128)});let random=0x12345678,score=0;
 for(let n=0;n<90;n++){
  const mask=n%6<3?0:n%2?1:2;
  f.ram[8]=(n*12)&255;f.ram[16]=Math.floor(n*12/60);f.ram[24]=mask;
  random=(Math.imul(random,1664525)+1013904223)>>>0;f.ram[32]=random>>>24;
  if(mask&&n%7===0){score++;f.ram[48]=score;}
  f.observe({action:{mask,humanMask:0,agentMask:mask,manualOverride:false},visual:{bins16:Array(16).fill(n%7===0?.2:0),hash:'visual-'+n}});
 }
 const report=f.miner.report(),rows=[...report.candidates,...report.rejections];
 const clock=rows.find(c=>c.spec.address===8&&c.spec.width===1&&c.spec.format==='unsigned');assert(clock&&clock.confounds.includes('frame-linear-counter'));assert.equal(clock.status,'REJECTED');
 const timer=rows.find(c=>c.spec.address===16&&c.spec.width===1&&c.spec.format==='unsigned');assert(timer&&timer.confounds.includes('periodic-neutral-counter'));
 const echo=rows.find(c=>c.spec.address===24&&c.spec.width===1&&c.spec.format==='unsigned');assert(echo&&echo.confounds.includes('applied-mask-echo'));
 const noise=rows.find(c=>c.spec.address===32&&c.spec.width===1&&c.spec.format==='unsigned');assert(noise&&noise.confounds.includes('high-churn-variable'));
 const sparse=rows.find(c=>c.spec.address===48&&c.spec.width===1&&c.spec.format==='unsigned');assert(sparse&&sparse.status==='CANDIDATE');assert(sparse.rank>clock.rank);assert.equal(sparse.polarity,'unknown','action/visual correlation cannot assign good or bad');assert(sparse.statistics.actionLagChanges>0);assert(sparse.statistics.visualChanges>0);
 assert(rows.every(c=>c.provenance.independence==='unverified'));assert.equal(f.miner.report().stats.independentConfirmations,0);
}
// Released endpoint buttons do not prove a no-op interval: a short tap may
// have happened between the RAM snapshots. Mixed action intervals are explicit.
{
 const f=fixture();for(let n=0;n<20;n++){f.ram[8]=n*12&255;f.observe({action:{mask:0,humanMask:0,agentMask:0,manualOverride:false,interval:undefined}});}
 const rows=[...f.miner.report().candidates,...f.miner.report().rejections].filter(c=>c.spec.address===8&&c.spec.width===1);assert(rows.length);assert(rows.every(c=>c.statistics.neutralChanges===0&&c.statistics.frameFits===0));assert(rows.every(c=>!c.confounds.includes('frame-linear-counter')&&!c.confounds.includes('periodic-neutral-counter')));assert(rows.every(c=>c.coverage.actionCoverage==='endpoint-only-or-incomplete'));
 const g=fixture();g.observe();g.ram[6]=1;assert(g.observe({action:{mask:0,humanMask:0,agentMask:0,manualOverride:false,interval:{firstFrame:1,lastFrame:12,frames:12,unionMask:3,changes:2,manualOverrideSeen:false,complete:true,coverage:'executed-frames'}}}).accepted);assert(g.miner.report().candidates.every(c=>c.coverage.mixedActions));
 assert(g.observe({provenance:{runId:'legacy-run',originId:null,startId:null,trajectoryId:'legacy-trajectory',partition:'discovery',independence:'unverified'}}).accepted,'unknown lineage remains unverified, not rejected RAM');assert.equal(g.miner.report().stats.independentConfirmations,0);
}
// Canonical bounded observations, stale generations, partitions and boundaries.
{
 const f=fixture({context:context(2048),limits:{maxCandidates:64,maxReportedCandidates:64,maxSeedAddresses:16}});let state=0x346712;
 for(let n=0;n<65;n++){
  for(let i=0;i<64;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;f.ram[i]=state>>>24;}
  if(n===48)f.ram[1280]=1;
  f.observe({action:{mask:n%2?1:2,humanMask:0,agentMask:n%2?1:2,manualOverride:false}});
 }
 const report=f.miner.report(),late=report.candidates.find(c=>c.spec.address===1280&&c.spec.width===1&&c.spec.format==='unsigned');assert(late&&late.status==='CANDIDATE','many noisy early variables cannot erase a late rare byte event');assert(report.stats.retainedCandidates<=64);assert(report.rejections.length<=report.limits.maxRejectedCandidates);assert.equal(late.polarity,'unknown');
}
{
 const f=fixture();assert.equal(f.observe().reason,'baseline');f.ram[5]=7;assert(f.observe().accepted);const original=JSON.stringify(f.ctx);
 assert.equal(f.observe({tick:1,atMs:400}).reason,'non-increasing-frame');assert.equal(f.observe({generation:0,atMs:400}).reason,'stale-observation');
 assert.equal(f.observe({context:{...f.ctx,romHash:'b'.repeat(64)}}).accepted,false);
 assert.equal(f.observe({ram:new Uint8Array(65)}).accepted,false);
 assert.equal(f.observe({provenance:{runId:'other',originId:'other',startId:'other',trajectoryId:'other',partition:'holdout',independence:'unverified'}}).accepted,false);
 assert.equal(f.observe({provenance:{runId:'other',originId:'other',startId:'other',trajectoryId:'other',partition:'calibration',independence:'unverified'}}).accepted,false);
 assert.equal(f.observe({action:{mask:48,humanMask:0,agentMask:48,manualOverride:false}}).accepted,false);
 assert.equal(f.observe({fingerprint:{hash:'complete-state-claim',scope:'full-state'}}).accepted,false);
 const before=f.miner.report().candidates.find(c=>c.spec.address===5&&c.spec.width===1);const changes=before.statistics.changes;
 f.miner.boundary('load-state');f.ram[5]=199;assert.equal(f.observe({generation:2,frame:1}).reason,'baseline');
 const after=f.miner.report().candidates.find(c=>c.id===before.id);assert.equal(after.statistics.changes,changes,'a rewind does not manufacture a RAM event across the boundary');assert.equal(f.miner.report().stats.coverageComplete,false);assert.equal(JSON.stringify(f.ctx),original,'the caller context is not mutated');
 assert(f.observe({generation:2,frame:13,provenance:{runId:'run-2',originId:'new-id',startId:'same-partial-state',trajectoryId:'trajectory-2',partition:'discovery',independence:'unverified'}}).accepted);assert.equal(f.miner.report().stats.independentConfirmations,0,'new UUIDs remain unverified provenance');
}
{
 const f=fixture();f.observe();f.ram[9]=1;f.observe();const priorChanges=f.miner.report().candidates.find(c=>c.spec.address===9&&c.spec.width===1).statistics.changes;
 f.ram[9]=73;assert.equal(f.observe({provenance:{runId:'control',originId:'control',startId:'control',trajectoryId:'control',partition:'holdout',independence:'unverified'}}).accepted,false);
 assert.equal(f.observe().reason,'baseline','a rejected holdout observation breaks the discovery comparator');assert.equal(f.miner.report().candidates.find(c=>c.spec.address===9&&c.spec.width===1).statistics.changes,priorChanges,'heldout RAM changes never become discovery evidence');
}
{
 const f=fixture();f.observe();f.ram[1]=9;const skipped=f.observe({tick:1,atMs:100});assert.equal(skipped.reason,'sample-rate-limit');assert.equal(f.miner.report().stats.accepted,1);f.ram[1]=0;f.observe({tick:2,atMs:400});assert.equal(f.miner.report().candidates.length,0,'RAM snapshots are detached from later caller mutations');
 const compatible=G.validateContext(context(4096,'sega',0x10000));assert.equal(compatible.platform,'sega');assert.throws(()=>new G.CandidateMiner({context:compatible}),/budget/);const common=new G.CandidateMiner({context:compatible,limits:{maxRamBytes:4096}});assert.equal(common.report().context.ramLayout.base,0x10000);
 assert.equal(G.validateContext({...context(),mapper:{id:null,submapper:null}}).mapper.id,null);assert.throws(()=>G.validateContext({...context(),ramLayout:{base:0,length:2048,canonical:false}}));assert.throws(()=>G.validateContext({...context(),mapper:{id:5000,submapper:null}}));assert.throws(()=>new G.CandidateMiner({context:context(),limits:{maxCandidates:100000}}));assert.throws(()=>new G.CandidateMiner({context:context(),limits:{unbounded:true}}));
 assert.equal(G.contextKey(context()),G.contextKey(JSON.parse(JSON.stringify(context()))));
}
// Every workload dimension is capped. Truncation is visible, never confidence.
{
 const f=fixture({limits:{maxCandidates:4,maxSeedAddresses:2,maxDecodePerObservation:3,maxReportedCandidates:4,maxTransitions:3,maxObservations:8}});
 for(let n=0;n<8;n++){for(let i=0;i<f.ram.length;i++)f.ram[i]=(n+i)&255;f.observe();}
 const report=f.miner.report();assert(report.stats.retainedCandidates<=4);assert(report.stats.retainedTransitions<=3);assert(report.stats.decodeEvaluations<=3*7);assert(report.stats.budgetExceeded>0);assert(report.stats.seedAddressesOmitted>0);assert.equal(report.stats.coverageComplete,false);assert.equal(f.observe().status,'UNKNOWN');assert.equal(f.miner.report().stats.stoppedReason,'discovery-budget-exhausted');
 const ttl=fixture({limits:{maxElapsedMs:300}});ttl.observe();assert(ttl.observe().accepted);assert.equal(ttl.observe().status,'UNKNOWN');
 const groups=fixture({limits:{maxOrigins:1}});groups.observe();assert.equal(groups.observe({provenance:{runId:'second',originId:'second',startId:'second',trajectoryId:'second',partition:'discovery',independence:'unverified'}}).status,'UNKNOWN');
}
{
 let calls=0;const saved={weights:[1,2,3],rng:123,traces:[{id:'fixture',eligibility:.2}]},before=JSON.stringify(saved);
 globalThis.fdbFeedback=()=>{calls++;};globalThis.FlyBridge={fdbFeedback:()=>{calls++;},configure:()=>{calls++;}};
 const f=fixture();for(let n=0;n<10;n++){f.ram[5]=n;f.observe();}f.miner.boundary('frozen');f.miner.report();assert.equal(calls,0);assert.equal(JSON.stringify(saved),before);delete globalThis.fdbFeedback;delete globalThis.FlyBridge;
}
console.log('PASS: '+interpretations+' bounded 1–4-byte signed/unsigned/BCD LE/BE hypotheses, carry/wrap/reset and aliases; provisional clock/timer/echo/noise exclusion; immutable canonical observations, context/generation/partition fences, unverified provenance, bounded work/history and no FDB reward calls');
