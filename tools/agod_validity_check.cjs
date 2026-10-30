'use strict';
// S5: an evidence record, a verification and a cache horizon are three things.
//
// Before this, time alone could make evidence unusable and an incompatible
// detector could not revoke anything. Sol's decision separates them:
//
//   evidence record  immutable, with its provenance. It is an observation and
//                    observations do not expire.
//   verification     valid or not for reasons that have nothing to do with
//                    elapsed time: ROM, core revision, detector revision,
//                    profile revision, contradiction.
//   cache horizon    after which a verification must be REVALIDATED, which is
//                    not the same as being wrong.
//
// The load-bearing case is the detector revision. S3 bumped agod-goals from
// -e4-1 to -s3-2 precisely because a revision that does not move when the code
// does would hollow this out; here that bump has to revoke a verification
// outright, however recently it was granted.
const assert=require('node:assert/strict'),fs=require('node:fs');
const Evidence=require('../app/src/main/assets/lab/agod-evidence.js');

const cases=[];
const result={type:'gu-agod-validity-check',version:1,
 scope:'in-memory registry; no emulator',
 claim:'A verification is revoked by an incompatible core or detector revision and by contradiction, regardless of time. Time alone only makes it stale, and a stale verification is revalidated rather than discarded. An evidence record is immutable.',
 status:'RUNNING',cases};
const save=()=>{if(process.env.AGOD_VALIDITY_REPORT)fs.writeFileSync(process.env.AGOD_VALIDITY_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const note=(name,expectation,observed)=>{cases.push({name,expectation,observed});save();};

const CONTEXT={romHash:'rom-a',coreRevision:'core-1',detectorRevision:'det-1',profileRevision:'prof-1'};
const build=overrides=>{
 const registry=Evidence.createRegistry({...CONTEXT,cacheTtlMs:1000,...(overrides||{})});
 for(const group of ['DISCOVERY','CALIBRATION','HOLDOUT'])
  registry.register({id:group,goalId:'g',group,parentStateHash:'p-'+group,restorePath:['boot'],
   episodeOrigin:'live',outcome:'confirmed',restored:false,atMs:1000});
 const promotion=registry.promote('g',{polarity:'NEGATIVE',polarityEvidenced:true,
  profileRevision:'prof-1',nowMs:1000});
 return {registry,promotion};
};
const live=()=>({nowMs:1200,coreRevision:'core-1',detectorRevision:'det-1',profileRevision:'prof-1',romHash:'rom-a'});

try{
 {const {registry,promotion}=build();
  note('a verification records what it was issued against','ROM, core, detector and profile revision',
   JSON.stringify(promotion.validityContext));
  assert.equal(promotion.verified,true);
  assert.deepEqual(promotion.validityContext,{romHash:'rom-a',coreRevision:'core-1',
   detectorRevision:'det-1',profileRevision:'prof-1'});
  assert.equal(promotion.issuedAtMs,1000);
  const status=registry.verificationStatus('g',live());
  note('fresh and in context','VALID',status.state);
  assert.equal(status.state,'VALID');}

 {// The case S3's revision bump exists for.
  const {registry}=build();
  const status=registry.verificationStatus('g',{...live(),detectorRevision:'det-2'});
  note('detector revision changed','REVOKED immediately, however fresh the verification is',
   status.state+': '+status.reasons.join('; '));
  assert.equal(status.state,'REVOKED');
  assert.equal(status.requiresRevalidation,false);
  assert(/detector revision changed/.test(status.reasons[0]));
  const again=registry.verificationStatus('g',live());
  note('and it stays revoked','REVOKED with its cause, not downgraded to NONE',
   again.state+' by '+again.revokedBy);
  assert.equal(again.state,'REVOKED');
  assert.equal(again.revokedBy,'incompatible-context');
  assert.deepEqual(registry.verifiedGoals(),[]);
  assert.equal(registry.revocationLedger().length,1);}

 {const {registry}=build();
  const status=registry.verificationStatus('g',{...live(),coreRevision:'core-2'});
  note('core revision changed','REVOKED',status.state+': '+status.reasons.join('; '));
  assert.equal(status.state,'REVOKED');
  assert(/core revision changed/.test(status.reasons[0]));}

 {const {registry}=build();
  const status=registry.verificationStatus('g',{...live(),romHash:'rom-b'});
  note('another ROM','REVOKED',status.state);
  assert.equal(status.state,'REVOKED');}

 {const {registry}=build();
  const status=registry.verificationStatus('g',{...live(),profileRevision:'prof-0'});
  note('profile revision changed','REVOKED',status.state);
  assert.equal(status.state,'REVOKED');}

 {// Time is the one reason that does not make a verification wrong.
  const {registry}=build();
  const stale=registry.verificationStatus('g',{...live(),nowMs:1000+5000});
  note('older than the cache horizon','STALE and revalidatable, not revoked',
   stale.state+', requiresRevalidation '+stale.requiresRevalidation+', age '+stale.ageMs+' ms');
  assert.equal(stale.state,'STALE');
  assert.equal(stale.requiresRevalidation,true);
  assert.equal(registry.verifiedGoals().length,1,'a stale verification is still held');
  const refreshed=registry.revalidate('g',{...live(),nowMs:6000});
  note('revalidating a stale verification','moves the horizon only',
   'revalidated '+refreshed.revalidated+', state '+refreshed.state+', count '+refreshed.revalidations);
  assert.equal(refreshed.revalidated,true);
  assert.equal(registry.verificationStatus('g',{...live(),nowMs:6500}).state,'VALID');}

 {// Revalidation cannot repair what was revoked.
  const {registry}=build();
  registry.verificationStatus('g',{...live(),detectorRevision:'det-2'});
  const attempt=registry.revalidate('g',{...live(),nowMs:6000});
  note('revalidating a revoked verification','refused',
   'revalidated '+attempt.revalidated+', state '+attempt.state+' - '+attempt.reason);
  assert.equal(attempt.revalidated,false);
  assert.equal(attempt.state,'REVOKED');}

 {const {registry}=build();
  const out=registry.contradict('g','the game outcome disagreed with RAM');
  const status=registry.verificationStatus('g',live());
  note('contradiction','REVOKED regardless of time, with the reason kept',
   status.state+' by '+status.revokedBy+': '+status.reasons.join('; '));
  assert.equal(out.revokedPriorVerification,true);
  assert.equal(status.state,'REVOKED');
  assert.equal(status.revokedBy,'contradiction');
  const attempt=registry.revalidate('g',live());
  assert.equal(attempt.revalidated,false);}

 {const {registry}=build();
  const status=registry.verificationStatus('absent',live());
  note('a goal that was never verified','NONE, not REVOKED and not VALID',status.state);
  assert.equal(status.state,'NONE');}

 {// An evidence record is an observation, and observations are immutable.
  const registry=Evidence.createRegistry({...CONTEXT,cacheTtlMs:1000});
  const record=registry.register({id:'e1',goalId:'g',group:'DISCOVERY',parentStateHash:'p1',
   restorePath:['boot'],episodeOrigin:'live',outcome:'confirmed',restored:false,atMs:1000});
  let threw=null;
  try{record.outcome='contradicted';}catch(error){threw=error.message;}
  const unchanged=registry.records().find(row=>row.id==='e1').outcome;
  note('mutating an evidence record','throws, and the stored record is unchanged',
   (threw||'did not throw')+'; stored outcome still '+unchanged);
  assert(threw,'a frozen record must refuse mutation in strict mode');
  assert.equal(unchanged,'confirmed');
  let threwProvenance=null;
  try{record.provenance;record.restorePath.push('tamper');}catch(error){threwProvenance=error.message;}
  note('mutating a record provenance list','throws',threwProvenance||'did not throw');
  assert(threwProvenance);}

 {// The detector revision stays optional, so AGOD-08's call path is unchanged.
  const registry=Evidence.createRegistry({romHash:'rom-a',coreRevision:'core-1',profileRevision:'prof-1'});
  for(const group of ['DISCOVERY','CALIBRATION','HOLDOUT'])
   registry.register({id:group,goalId:'g',group,parentStateHash:'p-'+group,restorePath:['boot'],
    episodeOrigin:'live',outcome:'confirmed',restored:false,atMs:1000});
  const promotion=registry.promote('g',{polarity:'NEGATIVE',polarityEvidenced:true,profileRevision:'prof-1',nowMs:1000});
  const status=registry.verificationStatus('g',{nowMs:1200,detectorRevision:'anything'});
  note('a registry built without a detector revision','still verifies, and a detector revision cannot revoke what was never recorded',
   'verified '+promotion.verified+', status '+status.state);
  assert.equal(promotion.verified,true);
  assert.equal(promotion.validityContext.detectorRevision,null);
  assert.equal(status.state,'VALID');}

 result.totals={cases:cases.length,
  revokedByIncompatibleContext:4,revokedByContradiction:1,staleAndRevalidated:1,
  timeAloneRevokedAnything:0,
  note:'time alone never revoked a verification in any case above'};
 result.status='PASS';save();
 console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,cases}));
 console.log('PASS: '+cases.length+' cases. An incompatible ROM, core, detector or profile revision revokes a verification outright and the revocation keeps its cause; a contradiction does the same; time alone only makes a verification stale, and revalidation moves the horizon without repairing anything revoked. Evidence records refuse mutation.');
}catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
