/* GoalEvidenceDTO: the goal's PROOF, separated from the machinery that pays it.
 *
 * WHY THIS EXISTS - a confirmed defect, not a precaution.
 * FlyAgodPipeline.run() returns, on VERIFIED, an object carrying
 * readResource (a function) and broker and registry (objects with methods).
 * structuredClone() on that result throws a DOMException, so a worker that
 * posted the result verbatim would fail on the POSITIVE branch only - the path
 * that had never been exercised. Minimal repro: run the pipeline on the
 * make_agod_test_rom fixture, which verifies, and call structuredClone on the
 * result.
 *
 * THE SEPARATION THIS FILE DRAWS.
 *   - A DTO is EVIDENCE: who the goal is, which address it lives at, what
 *     proved it, what the verification concluded, and against which ROM, core
 *     and profile. All plain data, structured-clone safe.
 *   - A broker, a registry and a readResource closure are MECHANISM. They stay
 *     in the context that owns the emulator and are rebuilt, by rebuild()
 *     below, in whatever context needs to act.
 *
 * A DTO therefore cannot grant anything. It records that a verification
 * happened and carries the registry state that supports it; it does not carry
 * the authority to verify. A registry rebuilt from exportState() marks its
 * records restored, and restored records cannot promote - that property of
 * agod-evidence.js is relied on here deliberately, so a DTO replayed into a
 * fresh context cannot manufacture a verification.
 *
 * validate() refuses a DTO that claims VERIFIED without the evidence that
 * would support it. That is the check standing between a transport format and
 * a forged reward. */
(function(root){'use strict';
const DTO_REVISION='agod-goal-dto-1';
const DTO_SCHEMA=1;
const DECLARED_STATUSES=Object.freeze(['VERIFIED','INDUCED','REFUSED','INCONCLUSIVE','NOT-SUPPORTED']);
const VERIFIED_LIFECYCLES=Object.freeze(['VERIFIED']);
const frozen=Object.freeze.bind(Object);

/* Plain-data projection. Anything that is not a number, string, boolean, null,
   array or plain object is dropped rather than carried, so the result is
   structured-clone safe by construction and not by hope. */
function plain(value,depth){
 const limit=depth===undefined?8:depth;
 if(value===null||value===undefined)return null;
 const type=typeof value;
 if(type==='number')return Number.isFinite(value)?value:null;
 if(type==='string'||type==='boolean')return value;
 if(type==='function')return undefined;
 if(type!=='object')return undefined;
 if(limit<=0)return undefined;
 if(Array.isArray(value)){
  const out=[];
  for(const entry of value){const kept=plain(entry,limit-1);if(kept!==undefined)out.push(kept);}
  return out;
 }
 if(value instanceof Uint8Array||value instanceof Int8Array
  ||value instanceof Uint16Array||value instanceof Int32Array)
  return Array.from(value);
 const out={};
 for(const key of Object.keys(value)){
  const kept=plain(value[key],limit-1);
  if(kept!==undefined)out[key]=kept;
 }
 return out;
}

/* The address specification, kept as a SPEC rather than a decoded number: a
   logical address plus how to read it. Platform work (G2/G3) extends this with
   the memory region and bank; the field is named so that is additive. */
function addressSpec(resource){
 if(!resource||typeof resource!=='object')return null;
 /* The DECODING spec, carried exactly as agod-ram.js decode() reads it.
    The first version of this file carried an invented `format` field and
    dropped `encoding` and `encodingDetermined`, so a BCD-encoded resource
    would have been rebuilt as binary and read the wrong number - a silent
    wrong answer, which is worse than a refusal. agod-pipeline.js normalises
    'n/a' endianness to little and falls back to binary when the encoding was
    not determined; decodeSpecFor() below applies the same two rules so the
    rebuilt reader cannot disagree with the pipeline's own. */
 return frozen({address:resource.address,width:resource.width,
  endian:resource.endian||null,
  encoding:resource.encoding||null,
  encodingDetermined:resource.encodingDetermined===undefined
   ?null:resource.encodingDetermined===true,
  mask:resource.mask===undefined?null:resource.mask,
  /* only a producer that saw the field cross zero says so; absent is unsigned */
  signed:resource.signed===true,
  /* G2 forward slots. null means "this producer did not say", which is
     different from a value, and consumers must treat it as unknown. */
  memoryRegion:resource.memoryRegion||null,
  bank:resource.bank===undefined?null:resource.bank,
  physicalAddress:resource.physicalAddress===undefined?null:resource.physicalAddress});
}

/* options: {platform, driverRevision, contextKey, producedAtMs, romHash,
             coreRevision, profileRevision} - the run's own identity, which the
   pipeline result does not carry in full. */
function fromPipelineResult(result,options){
 const context=options||{};
 if(!result||typeof result!=='object')
  return frozen({dtoRevision:DTO_REVISION,dtoSchema:DTO_SCHEMA,
   status:'REFUSED',stage:'dto',reason:'there was no pipeline result to describe',
   goal:null,resource:null,actions:null,evidence:null,provenance:null,
   brokerSpec:null,discovered:null,trace:[],refusals:[],
   rewardMechanismExcluded:true});

 const registry=result.registry&&typeof result.registry.exportState==='function'
  ?result.registry:null;
 const goalId=result.goal&&result.goal.id?result.goal.id:null;
 let registryState=null,validityContext=null,verificationStatus=null,revocationLedger=null;
 if(registry){
  try{registryState=plain(registry.exportState());}catch(_){registryState=null;}
  try{validityContext=plain(registry.validityContext());}catch(_){validityContext=null;}
  try{verificationStatus=goalId&&typeof registry.verificationStatus==='function'
   ?plain(registry.verificationStatus(goalId)):null;}catch(_){verificationStatus=null;}
  try{revocationLedger=typeof registry.revocationLedger==='function'
   ?plain(registry.revocationLedger()):null;}catch(_){revocationLedger=null;}
 }

 return frozen({dtoRevision:DTO_REVISION,dtoSchema:DTO_SCHEMA,
  schemaVersion:result.schemaVersion===undefined?null:result.schemaVersion,
  pipelineRevision:result.pipelineRevision||null,
  status:result.status||null,stage:result.stage||null,
  reason:result.reason===undefined?null:result.reason,
  goal:plain(result.goal)||null,
  resource:addressSpec(result.resource),
  actions:plain(result.actions)||null,
  judgement:plain(result.judgement)||null,
  depletionFact:plain(result.depletionFact)||null,
  discovered:plain(result.discovered)||null,
  /* WHAT PROVED IT. The registry state is the source of evidence and travels
     as data; the registry object does not. */
  evidence:frozen({registryState,validityContext,verificationStatus,revocationLedger,
   evidenceRefs:result.goal&&Array.isArray(result.goal.evidenceRefs)
    ?result.goal.evidenceRefs.slice():[]}),
  /* HOW TO REBUILD THE MECHANISM, which is not the mechanism itself. */
  brokerSpec:frozen({profileRevision:context.profileRevision
    ||(validityContext&&validityContext.profileRevision)||null,
   contextKey:context.contextKey===undefined?null:context.contextKey,
   allowedSources:['verified-goal'],
   requiresGoalId:goalId}),
  provenance:frozen({romHash:context.romHash
    ||(validityContext&&validityContext.romHash)||null,
   coreRevision:context.coreRevision
    ||(validityContext&&validityContext.coreRevision)||null,
   profileRevision:context.profileRevision
    ||(validityContext&&validityContext.profileRevision)||null,
   detectorRevision:(validityContext&&validityContext.detectorRevision)||null,
   platform:context.platform||null,
   driverRevision:context.driverRevision||null,
   pipelineRevision:result.pipelineRevision||null,
   dtoRevision:DTO_REVISION,
   producedAtMs:Number.isInteger(context.producedAtMs)?context.producedAtMs:null}),
  trace:plain(result.trace)||[],
  refusals:plain(result.refusals)||[],
  /* Said out loud in the payload: the executable part was deliberately left
     behind, so a consumer cannot mistake its absence for a loss. */
  rewardMechanismExcluded:true,
  excludedKeys:['readResource','broker','registry']});
}

/* Does this DTO support what it claims? Structural completeness, provenance
   agreement with the context it is about to be used in, and - for VERIFIED -
   the evidence that a verification actually happened. */
function validate(dto,expected){
 const want=expected||{};
 const problems=[];
 const add=problem=>problems.push(problem);
 if(!dto||typeof dto!=='object')return frozen({valid:false,problems:['no DTO']});
 if(dto.dtoSchema!==DTO_SCHEMA)add('unsupported DTO schema: '+dto.dtoSchema);
 if(!DECLARED_STATUSES.includes(dto.status))
  add('status is not one of the declared outcomes: '+dto.status);
 if(!dto.pipelineRevision||!/^agod-pipeline-/.test(dto.pipelineRevision))
  add('the DTO does not name a real pipeline revision');
 /* a DTO must be plain data: a function anywhere is a transport bug */
 const scan=(value,path,depth)=>{
  if(depth>8||value===null||typeof value!=='object')return;
  for(const key of Object.keys(value)){
   const entry=value[key];
   if(typeof entry==='function')add('the DTO carries a function at '+path+'.'+key);
   else scan(entry,path+'.'+key,depth+1);
  }
 };
 scan(dto,'dto',0);

 if(want.romHash&&dto.provenance&&dto.provenance.romHash
  &&dto.provenance.romHash!==want.romHash)
  add('this goal was proved against another ROM: '+dto.provenance.romHash
   +' != '+want.romHash);
 if(want.coreRevision&&dto.provenance&&dto.provenance.coreRevision
  &&dto.provenance.coreRevision!==want.coreRevision)
  add('this goal was proved against another core: '+dto.provenance.coreRevision
   +' != '+want.coreRevision);
 if(want.profileRevision&&dto.provenance&&dto.provenance.profileRevision
  &&dto.provenance.profileRevision!==want.profileRevision)
  add('this goal was proved under another profile revision');

 if(dto.status==='VERIFIED'){
  if(!dto.goal||!dto.goal.id)add('VERIFIED without a goal identity');
  if(!dto.goal||!VERIFIED_LIFECYCLES.includes(dto.goal.lifecycle))
   add('VERIFIED without a verified lifecycle: '
    +(dto.goal?dto.goal.lifecycle:'no goal'));
  if(!dto.goal||!['POSITIVE','NEGATIVE'].includes(dto.goal.polarity))
   add('VERIFIED without a polarity usable for reward');
  if(!dto.resource||!Number.isInteger(dto.resource.address))
   add('VERIFIED without an address specification');
  else if(!Number.isInteger(dto.resource.width)||dto.resource.width<1)
   add('VERIFIED without a usable field width: '+dto.resource.width);
  else if(dto.resource.encodingDetermined===null)
   add('VERIFIED without saying whether the field encoding was determined, '
    +'so a rebuilt reader could decode it wrongly');
  if(!dto.actions)add('VERIFIED without an action specification');
  const refs=dto.evidence&&Array.isArray(dto.evidence.evidenceRefs)
   ?dto.evidence.evidenceRefs:[];
  if(!refs.length)add('VERIFIED with no evidence references');
  const records=dto.evidence&&dto.evidence.registryState
   &&Array.isArray(dto.evidence.registryState.records)
   ?dto.evidence.registryState.records:[];
  if(!records.length)add('VERIFIED with no registry records to support it');
  else{
   const known=new Set(records.map(r=>r.id));
   const missing=refs.filter(ref=>!known.has(ref));
   if(missing.length)
    add('VERIFIED citing '+missing.length+' evidence records the registry state does not contain');
   const forGoal=records.filter(r=>r.goalId===dto.goal.id);
   if(!forGoal.length)add('the registry state holds no record for this goal');
   else{
    const groups=new Set(forGoal.map(r=>r.group));
    if(!groups.has('HOLDOUT'))
     add('VERIFIED without any HOLDOUT evidence in the registry state');
   }
  }
 }
 return frozen({valid:problems.length===0,problems,
  dtoRevision:dto.dtoRevision||null,status:dto.status||null,
  goalId:dto.goal&&dto.goal.id?dto.goal.id:null,
  checkedAgainst:frozen({romHash:want.romHash||null,
   coreRevision:want.coreRevision||null,profileRevision:want.profileRevision||null})});
}

/* Rebuild the MECHANISM in the caller's context, from a DTO that validates.
   modules: {Reward, Evidence, Ram} - passed in so this file depends on nothing
   it does not receive. driver is optional and only needed for readResource. */
function rebuild(dto,modules,options){
 const parts=modules||{},settings=options||{};
 const verdict=validate(dto,settings.expected||{});
 if(!verdict.valid)
  return frozen({status:'REFUSED',reason:'the DTO did not validate',
   problems:verdict.problems,readResource:null,broker:null,registry:null});
 if(dto.status!=='VERIFIED')
  return frozen({status:'NO-MECHANISM',
   reason:'only a VERIFIED goal has a reward mechanism to rebuild; this DTO is '
    +dto.status,
   readResource:null,broker:null,registry:null,dtoStatus:dto.status});

 let registry=null,imported=null;
 if(parts.Evidence&&typeof parts.Evidence.createRegistry==='function'
  &&dto.evidence&&dto.evidence.registryState){
  const state=dto.evidence.registryState;
  registry=parts.Evidence.createRegistry({romHash:state.romHash,
   coreRevision:state.coreRevision,profileRevision:state.profileRevision,
   detectorRevision:dto.provenance?dto.provenance.detectorRevision:undefined});
  imported=registry.importState(state);
 }
 let broker=null;
 if(parts.Reward&&typeof parts.Reward.createBroker==='function'
  &&dto.brokerSpec&&dto.brokerSpec.profileRevision){
  broker=parts.Reward.createBroker({profileRevision:dto.brokerSpec.profileRevision,
   contextKey:dto.brokerSpec.contextKey||undefined,
   allowedSources:dto.brokerSpec.allowedSources||['verified-goal']});
 }
 let readResource=null;
 if(parts.Ram&&typeof parts.Ram.decode==='function'&&settings.driver
  &&typeof settings.driver.readRam==='function'&&dto.resource){
  const spec=decodeSpecFor(dto.resource);
  if(spec)readResource=memory=>parts.Ram.decode(
   memory||settings.driver.readRam(),spec);
 }
 return frozen({status:'REBUILT',
  readResource,broker,registry,
  importedRecords:imported?imported.imported:0,
  restoredOnly:imported?imported.restoredOnly===true:null,
  /* The one thing a rebuilt registry must NOT be able to do. */
  cannotPromoteFromRestoredEvidence:
   'records imported from a DTO are marked restored, and agod-evidence.js '
   +'refuses to promote on restored evidence. A DTO records that a verification '
   +'happened; it does not carry the authority to verify.',
  goalId:dto.goal.id,polarity:dto.goal.polarity,
  provenance:dto.provenance});
}

/* The two normalisation rules agod-pipeline.js applies when it builds its own
   readResource, in one place so a rebuilt reader agrees with it by
   construction rather than by resemblance. */
function decodeSpecFor(resource){
 if(!resource||!Number.isInteger(resource.address)||!Number.isInteger(resource.width))
  return null;
 return {address:resource.address,width:resource.width,
  endian:resource.endian==='n/a'||!resource.endian?'little':resource.endian,
  encoding:resource.encodingDetermined===true&&resource.encoding
   ?resource.encoding:'binary',
  ...(resource.signed===true?{signed:true}:{})};
}

const api={DTO_REVISION,DTO_SCHEMA,DECLARED_STATUSES,
 fromPipelineResult,validate,rebuild,plain,addressSpec,decodeSpecFor};
root.FlyAgodGoalDto=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
