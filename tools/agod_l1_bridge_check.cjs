'use strict';
// L1 / L-BRIDGE: a goal AGOD discovered pays a verified reward that changes the
// acquired weights of the PRODUCTION learner, and nothing else does.
//
// The chain under test, with no hand-written reward anywhere in it:
//
//   real NES core (isolated)  -> FlyAgodPipeline -> VERIFIED goal -> DTO
//   DTO + game identity       -> FlyAgodObjective.createProfile
//   real NES core (live)      -> production Engine -> FdbLearning.decide
//   executed interval + RAM   -> FlyAgodObjective live reward -> broker.claim
//   VERIFIED packet           -> FdbLearning.feedback  (real dW / Wexo)
//   UNKNOWN / INVALIDATED     -> FdbLearning.boundary  (no reward, no update)
//
// tools/fdb_game_check.cjs already drives the production learner from real
// frames, but its reward is a line of JavaScript that reads a known address.
// Here the reward source is whatever discovery proved, bound to the cartridge.
//
// WHAT IS MEASURED:
//   non-zero verified payouts and non-zero native weight changes;
//   an UNKNOWN source (a cartridge discovery REFUSED) producing zero reward
//   calls and byte-identical weights - not "reward 0";
//   a frozen evaluation mutating nothing: updates, RNG, edges, weights;
//   a checkpoint restored mid-training continuing to the same result;
//   behaviour, frozen, same starts and seeds: trained vs the untrained layer it
//   started from vs a seeded random policy;
//   one credit per event, across a simulated restart;
//   a profile refusing a different cartridge.
//
// The graph is the 30-neuron mechanism fixture unless FDB_GRAPH names a
// connectome; a fixture result is NOT a claim about the fly connectome.
// NO COMMERCIAL ROM. The NES oracle is never opened by this file.
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),
 crypto=require('crypto'),{spawn,execFileSync}=require('child_process'),readline=require('readline');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js','agod-evidence.js',
 'agod-candidates.js','agod-consumers.js','agod-platform-driver.js','agod-pipeline.js',
 'agod-goal-dto.js','agod-objective.js'])require(path.join(A,f));
const PD=globalThis.FlyAgodPlatformDriver,Pipeline=globalThis.FlyAgodPipeline,
 Dto=globalThis.FlyAgodGoalDto,Objective=globalThis.FlyAgodObjective;
const MODULES={Dto,Reward:globalThis.FlyAgodReward,Evidence:globalThis.FlyAgodEvidence,Ram:globalThis.FlyAgodRam};
const work=fs.mkdtempSync(path.join(os.tmpdir(),'l1-'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const SEEDS=(process.env.L1_SEEDS||'11,23,37').split(',').map(Number),
 /* THE UNTRAINED LAYER'S HABIT. A prior toward the costly action gives the
    untrained layer something to unlearn. Its strength was chosen by a sweep on
    seed 11 only (1,2,3,4,6): at 4 and above the softmax saturates (p~0.99) and
    NOTHING is unlearned in 240 steps - a real limit of this learner, reported
    and not hidden - and 3 is the strongest that does not. Seeds 23 and 37 were
    not used to choose it. */
 PRIOR=Number(process.env.L1_PRIOR||3),HOLD=4,RELEASE=8,TRAIN_STEPS=Number(process.env.L1_TRAIN_STEPS||240),EVAL_STEPS=60;

function bridge(){
 const child=spawn(process.env.JAVA||'java',['-Xmx2g','-cp',process.env.CODE_CLASSPATH,
  'org.node.flyconsole.FdbGameBridge',...(process.env.FDB_GRAPH?[process.env.FDB_GRAPH]:[])],
  {stdio:['pipe','pipe','ignore']});
 const pending=[];
 readline.createInterface({input:child.stdout}).on('line',line=>{const p=pending.shift();if(p)p.resolve(JSON.parse(line));});
 child.on('exit',code=>{while(pending.length)pending.shift().reject(Error('Java bridge exited '+code));});
 return {call:q=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(q)+'\n');}),
  close:()=>child.stdin.end()};
}
function cartridge(generator,tag,extra){
 const rom=path.join(work,tag+'.json');
 execFileSync('python3',['tools/'+generator,'--out',rom,...(extra||[])]);
 return Buffer.from(JSON.parse(fs.readFileSync(rom)).base64,'base64');
}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/* discovery on an ISOLATED core; the live core below is a different instance */
function discover(bytes){
 const built=PD.createNesSync({romBytes:bytes,jsnes,frameBudget:600000});
 for(let i=0;i<120;i++)built.core.frame();
 const romSha256=sha(bytes);
 const config={romHash:romSha256,coreRevision:'jsnes',profileRevision:'agod-l1',typeEvents:30};
 const result=Pipeline.run(built.driver,config);
 const dto=Dto.fromPipelineResult(result,{...config,contextKey:romSha256+'/jsnes',
  platform:'nes',driverRevision:built.driverRevision});
 const identity={romSha256,platform:'nes',coreRevision:'jsnes',
  detectorRevision:Pipeline.PIPELINE_REVISION,actionSpec:built.capabilities.actionSpec,
  padType:built.capabilities.padType,observedRamBytes:built.capabilities.observedRamBytes};
 const frames=built.framesRun();
 built.dispose();
 return {status:result.status,dto,identity,frames};
}

/* the live game: its own core, a 16-cell luminance retina, a frame counter that
   never rewinds with the game */
function live(bytes){
 let pixels=null;
 const core=new jsnes.NES({onFrame(buffer){pixels=buffer;},onAudioSample(){}});
 core.loadROM(bytes.toString('latin1'));
 for(let i=0;i<120;i++)core.frame();
 const start=JSON.stringify(core.toJSON());
 let frame=0;
 return {core,
  restore(){core.fromJSON(JSON.parse(start));},
  ram:()=>core.cpu.mem.slice(0,0x800),
  step(mask){for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp).call(core,1,b);
   for(let i=0;i<HOLD;i++)core.frame();
   for(let b=0;b<8;b++)core.buttonUp(1,b);
   for(let i=0;i<RELEASE;i++)core.frame();
   frame+=HOLD+RELEASE;return frame;},
  frame:()=>frame,
  retina(){const v=new Array(16).fill(0),n=new Array(16).fill(0);
   if(pixels)for(let y=0;y<240;y+=4)for(let x=0;x<256;x+=4){const c=pixels[y*256+x],i=Math.min(3,y>>6<4?Math.floor(y*4/240):3)*4+Math.floor(x*4/256);
    v[i]+=(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255))/255;n[i]++;}
   return v.map((s,i)=>n[i]?s/n[i]:0);}};
}
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}

(async()=>{
 /* the published NES cartridge with a LIT background (--backdrop). The default
    one renders black, and a retina that reads zero gives a spiking learner no
    presynaptic activity: the first run of this check paid ~40 verified rewards
    per seed into a layer with nothing eligible to change. The game logic, and
    what discovery has to find, are identical. */
 const positive=cartridge('make_agod_test_rom.py','positive',['--seed','0','--backdrop','0x30']);
 console.log('=== 1. discovery -> profile ===');
 const found=discover(positive);
 console.log('  pipeline=%s frames=%d  goal=%s polarity=%s',found.status,found.frames,
  found.dto.goal&&found.dto.goal.id,found.dto.goal&&found.dto.goal.polarity);
 ok(found.status==='VERIFIED','discovery reaches VERIFIED on the isolated core');
 const profile=Objective.createProfile(found.dto,found.identity,MODULES);
 ok(profile.status==='PROFILE','a VERIFIED goal becomes an objective profile ('+(profile.reason||'')+')');
 const actions=[0,profile.actions.effect,profile.actions.cost];
 const costOutput=Math.log2(profile.actions.cost);
 console.log('  profile identityKey=%s resource@%d actions=%j (neutral, effect, cost) - all from discovery',
  profile.identityKey,profile.resource.address,actions);
 ok(Objective.matches(profile,found.identity).ok,'the profile matches the game it was proved on');
 const other=Objective.matches(profile,{...found.identity,romSha256:sha(Buffer.from('another cartridge'))});
 ok(!other.ok&&/romSha256/.test(other.problems.join()),'and refuses a different cartridge: '+other.problems[0].slice(0,60));
 ok(Objective.createLiveReward(profile,MODULES,{identity:{...found.identity,padType:6}}).status==='REFUSED',
  'a live reward is not created when the pad layout differs from the proof');

 const quiet=cartridge('make_agod_sequence_rom.py','refused',[]);
 const none=discover(quiet);
 const noProfile=Objective.createProfile(none.dto,none.identity,MODULES);
 console.log('  second cartridge: pipeline=%s -> profile %s (%s)',none.status,noProfile.status,noProfile.reason);
 ok(none.status==='REFUSED'&&noProfile.status==='REFUSED','a cartridge discovery refuses yields NO profile');

 const java=bridge();
 const rows=[],ab=[];
 try{
  /* one run: optional training through the live reward, then a frozen evaluation */
  async function run(seed,mode,romBytes,reward,options){
   const settings=options||{};
   await java.call({op:'init',seed,mode:'base'});
   await java.call({op:'prior',output:costOutput,weight:PRIOR});
   const initial=await java.call({op:'state'});
   const game=live(romBytes);
   const stats={verified:0,unknown:0,invalidated:0,rewardCalls:0,changed:0,valueKeysOutsideVerified:0};
   async function play(steps,train){
    let cost=0,lost=0;
    for(let step=0;step<steps;step++){
     const d=await java.call({op:'decide',retina:game.retina(),train,actions,epsilon:train?.1:0,windowMs:20});
     const before=game.ram();
     const endFrame=game.step(d.mask);
     const after=game.ram();
     if(d.mask===profile.actions.cost)cost++;
     const lives=after[profile.resource.address],previous=before[profile.resource.address];
     if(lives<previous)lost+=previous-lives;
     if(train){
      const packet=reward?reward.observe({ramBefore:before,ramAfter:after,endFrame,
       executed:{mask:d.mask,frames:HOLD+RELEASE,complete:true,manualOverride:false},
       requestedMask:d.mask,phase:'PLAYING'}):{status:'UNKNOWN',reason:'no objective profile'};
      if(packet.status!=='VERIFIED'&&'value' in packet)stats.valueKeysOutsideVerified++;
      if(packet.status==='VERIFIED'){
       stats.verified++;stats.rewardCalls++;
       const r=await java.call({op:'reward',id:d.id,mask:d.mask,reward:packet.value,
        seconds:(HOLD+RELEASE)/60,frames:HOLD+RELEASE});
       stats.changed+=r.changed;
      }else{
       stats[packet.status==='INVALIDATED'?'invalidated':'unknown']++;
       await java.call({op:'boundary'});
      }
     }
     if(lives===0){game.restore();if(train)await java.call({op:'boundary'});}
    }
    return {cost,lost};
   }
   if(settings.trainSteps){
    if(settings.checkpointAt){
     await play(settings.checkpointAt,true);
     await java.call({op:'checkpoint'});
     await play(settings.trainSteps-settings.checkpointAt,true);
    }else{
     /* the uninterrupted run takes the same engine reset at the midpoint that
        a checkpoint restore implies, as tools/fdb_game_check.cjs does, so the
        two differ ONLY in whether the learner was serialised and rebuilt */
     await play(settings.trainSteps/2,true);
     await java.call({op:'reset'});
     await play(settings.trainSteps/2,true);
    }
   }
   await java.call({op:'reset'});game.restore();
   const before=await java.call({op:'state'});
   const evaluation=await play(EVAL_STEPS,false);
   const after=await java.call({op:'state'});
   const row={seed,mode,...stats,evalCost:evaluation.cost,evalLost:evaluation.lost,
    updates:after.updates,deltas:after.deltas,edges:after.edges,
    weightsChanged:after.weights!==initial.weights,
    frozenClean:after.updates===before.updates&&after.rng===before.rng
     &&after.edges===before.edges&&after.weights===before.weights,
    weights:after.weights,rng:after.rng,stateText:JSON.stringify(after.learningState)};
   rows.push(row);return row;
  }
  const liveReward=()=>Objective.createLiveReward(profile,MODULES,
   {identity:found.identity,sessionId:'l1-'+crypto.randomBytes(4).toString('hex')});

  console.log('=== 2. training through the verified reward ===');
  for(const seed of SEEDS){
   const untrained=await run(seed,'untrained',positive,null,{});
   const trained=await run(seed,'trained',positive,liveReward(),{trainSteps:TRAIN_STEPS});
   const resumed=await run(seed,'resumed',positive,liveReward(),{trainSteps:TRAIN_STEPS,checkpointAt:TRAIN_STEPS/2});
   const unknown=await run(seed,'unknown-source',positive,null,{trainSteps:TRAIN_STEPS});
   const random=rng(seed);const g=live(positive);let rc=0,rl=0;
   for(let s=0;s<EVAL_STEPS;s++){const m=actions[Math.floor(random()*3)];const b=g.ram();g.step(m);const a=g.ram();
    if(m===profile.actions.cost)rc++;if(a[profile.resource.address]<b[profile.resource.address])rl++;
    if(a[profile.resource.address]===0)g.restore();}
   rows.push({seed,mode:'random',evalCost:rc,evalLost:rl});
   console.log('  seed %d  untrained cost %d/%d lost %d | trained cost %d lost %d (verified %d, unknown %d, native changes %d) | unknown-source cost %d (reward calls %d, updates %d) | random cost %d lost %d',
    seed,untrained.evalCost,EVAL_STEPS,untrained.evalLost,trained.evalCost,trained.evalLost,trained.verified,
    trained.unknown,trained.changed,unknown.evalCost,unknown.rewardCalls,unknown.updates,rc,rl);
   ok(trained.verified>0&&trained.rewardCalls===trained.verified,'seed '+seed+': '+trained.verified+' verified payouts, each exactly one reward call');
   ok(trained.changed>0&&trained.weightsChanged,'seed '+seed+': the acquired weights really changed ('+trained.changed+' native changes)');
   ok(trained.valueKeysOutsideVerified===0,'seed '+seed+': no UNKNOWN or INVALIDATED packet carried a value');
   ok(unknown.rewardCalls===0&&unknown.updates===0&&!unknown.weightsChanged,
    'seed '+seed+': with no verified source there are zero reward calls, zero updates and identical weights');
   ok(unknown.evalCost===untrained.evalCost,'seed '+seed+': and behaviour is exactly the untrained layer');
   for(const row of [untrained,trained,resumed,unknown])
    ok(row.frozenClean,'seed '+seed+' '+row.mode+': the frozen evaluation mutated nothing (updates, RNG, edges, weights)');
   ok(resumed.weights===trained.weights&&resumed.evalCost===trained.evalCost&&resumed.rng===trained.rng,
    'seed '+seed+': a checkpoint restored mid-training continues to the same weights and behaviour');
   ok(trained.evalCost<untrained.evalCost,'seed '+seed+': trained takes the verified-cost action less than the layer it started from ('
    +trained.evalCost+' < '+untrained.evalCost+')');
   ok(trained.evalLost<rl,'seed '+seed+': and loses less of the resource than a seeded random policy ('+trained.evalLost+' < '+rl+')');
   ab.push({seed,untrained:untrained.evalLost,trained:trained.evalLost,random:rl});
  }

  console.log('=== 3. one credit per event, across a restart ===');
  {
   const reward=liveReward(),game=live(positive);
   const before=game.ram();const endFrame=game.step(profile.actions.cost);const after=game.ram();
   const sample={ramBefore:before,ramAfter:after,endFrame,
    executed:{mask:profile.actions.cost,frames:HOLD+RELEASE,complete:true,manualOverride:false},
    requestedMask:profile.actions.cost,phase:'PLAYING'};
   const first=reward.observe(sample),second=reward.observe(sample);
   console.log('  first=%s value=%s  repeat=%s (%s)',first.status,first.value,second.status,second.reason);
   ok(first.status==='VERIFIED'&&first.value<0,'the event pays once, negative');
   ok(second.status==='INVALIDATED'&&!('value' in second),'the same event again pays nothing');
   const restarted=Objective.createLiveReward(profile,MODULES,
    {identity:found.identity,sessionId:first.eventId.split(':')[0],ledger:reward.exportLedger()});
   const third=restarted.observe(sample);
   ok(third.status==='INVALIDATED'&&/ledger/.test(third.reason),'nor after a restart that restored the ledger: '+third.reason);
   const manual=liveReward().observe({...sample,executed:{...sample.executed,manualOverride:true}});
   ok(manual.status==='INVALIDATED'&&!('value' in manual),'a human override in the interval pays nothing');
   const mismatch=liveReward().observe({...sample,requestedMask:0});
   ok(mismatch.status==='INVALIDATED','an executed mask that differs from the requested one pays nothing');
   const revoked=liveReward();revoked.revoke('contradicted by re-verification');
   const late=revoked.observe(sample);
   ok(late.status==='INVALIDATED'&&!('value' in late)&&/revoked/.test(late.reason),'after revocation new payouts stop: '+late.reason);
  }
 }finally{java.close();}

 console.log('=== A/B, frozen evaluation, resource lost in %d steps ===',EVAL_STEPS);
 for(const r of ab)console.log('  seed %d  untrained %d | trained %d | random %d',r.seed,r.untrained,r.trained,r.random);
 const summary={kind:'agod-l1-bridge',ab,graph:process.env.FDB_GRAPH?'configured connectome':'30-neuron mechanism fixture; not the fly connectome',
  trainSteps:TRAIN_STEPS,evalSteps:EVAL_STEPS,
  rows:rows.map(({weights,stateText,...rest})=>rest)};
 if(process.env.AGOD_L1_REPORT)fs.writeFileSync(process.env.AGOD_L1_REPORT,JSON.stringify(summary,null,1)+'\n');
 console.log('\n'+out.join('\n'));
 console.log('\n%s — %d/%d assertions',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
 if(fail.length){console.log('\nFAILED:');for(const f of fail)console.log('  - '+f);process.exitCode=1;}
})().catch(e=>{console.log('FAILED '+e.message+'\n'+e.stack);process.exitCode=1;});
