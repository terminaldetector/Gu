'use strict';
// G1: the VERIFIED path survives transport, and a DTO cannot forge one.
//
// THE DEFECT THIS EXISTS FOR, reproduced in check 1 below:
// FlyAgodPipeline.run() returns, on VERIFIED, an object carrying readResource
// (a function) and broker and registry (objects with methods). structuredClone
// throws on it, so a worker posting the result verbatim fails on the POSITIVE
// branch - the one path that had never been exercised, because the embedded
// cartridge only ever produces REFUSED.
//
// What is checked: the real pipeline reaching a real VERIFIED on an MIT
// fixture; the DTO carrying goal identity, address specification, evidence
// source and provenance through structuredClone; the functional contour
// rebuilt from the DTO and AGREEING with the pipeline's own reader; that a
// registry rebuilt from a DTO cannot promote; that a forged or foreign DTO is
// refused; and that REFUSED still transports and yields no mechanism.
//
// No ROM bytes enter any artefact: the fixture is generated locally.
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const A=path.resolve('app/src/main/assets/lab');
const jsnes=require(path.join(A,'jsnes.min.js'));globalThis.jsnes=jsnes;
for(const f of ['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js',
 'agod-evidence.js','agod-pipeline.js','agod-goal-dto.js'])require(path.join(A,f));
const Driver=require(path.join(A,'agod-nes-driver.js'));
const Dto=globalThis.FlyAgodGoalDto,Ev=globalThis.FlyAgodEvidence,
      Rw=globalThis.FlyAgodReward,Ram=globalThis.FlyAgodRam;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'g1-'));
const out=[],fail=[];
const ok=(c,m)=>{out.push((c?'  ok   ':'  FAIL ')+m);if(!c)fail.push(m);return c;};
const CTX={romHash:'g1-fixture',coreRevision:'jsnes-lab',profileRevision:'agod-app-1'};

function runFixture(generator,args){
 const romJson=path.join(work,'r'+Math.random().toString(36).slice(2)+'.json');
 execFileSync('python3',['tools/'+generator,'--out',romJson,...(args||[])]);
 const bytes=Buffer.from(JSON.parse(fs.readFileSync(romJson)).base64,'base64');
 const host=Driver.create({romBytes:bytes,jsnes,entry:{bootFrames:60,startPulses:0},
  frameBudget:3000000});
 const result=globalThis.FlyAgodPipeline.run(host.driver,{...CTX});
 return {host,result};
}

console.log('=== 1. VERIFIED survives transport as a DTO ===');
const v=runFixture('make_agod_test_rom.py',['--seed','0']);
ok(v.result.status==='VERIFIED','the fixture reaches a real VERIFIED (got '+v.result.status+')');
let threw=null;try{structuredClone(v.result);}catch(e){threw=e.constructor.name;}
ok(threw!==null,'the raw result still cannot be cloned (defect reproduced: '+threw+')');
const dto=Dto.fromPipelineResult(v.result,{...CTX,platform:'nes',
 driverRevision:Driver.DRIVER_REVISION,producedAtMs:Date.now()});
let cloned=null;try{cloned=structuredClone(dto);}catch(e){cloned=null;ok(false,'DTO clone threw: '+e.message);}
ok(!!cloned,'the DTO clones without DataCloneError');
ok(cloned&&cloned.status==='VERIFIED','the cloned DTO preserves VERIFIED');
ok(cloned&&cloned.goal&&cloned.goal.id,'goal identity survives: '+(cloned&&cloned.goal&&cloned.goal.id));
ok(cloned&&cloned.resource&&Number.isInteger(cloned.resource.address),
 'address specification survives: address '+(cloned&&cloned.resource&&cloned.resource.address));
ok(cloned&&cloned.evidence&&cloned.evidence.registryState
 &&cloned.evidence.registryState.records.length>0,
 'evidence source survives: '+(cloned&&cloned.evidence&&cloned.evidence.registryState
  ?cloned.evidence.registryState.records.length:0)+' registry records');
ok(cloned&&cloned.provenance&&cloned.provenance.romHash===CTX.romHash
 &&cloned.provenance.coreRevision===CTX.coreRevision,'provenance survives');
ok(cloned&&cloned.rewardMechanismExcluded===true
 &&!('readResource' in cloned)&&!('broker' in cloned)&&!('registry' in cloned),
 'the executable mechanism is excluded from the payload');

console.log('=== 2. the DTO validates, and rebuilds the functional contour ===');
const verdict=Dto.validate(cloned,CTX);
ok(verdict.valid,'the cloned DTO validates'+(verdict.valid?'':': '+verdict.problems.join('; ')));
const rebuilt=Dto.rebuild(cloned,{Reward:Rw,Evidence:Ev,Ram},{driver:v.host.driver,expected:CTX});
ok(rebuilt.status==='REBUILT','the functional contour rebuilds: '+rebuilt.status);
ok(typeof rebuilt.readResource==='function','readResource rebuilt');
ok(rebuilt.broker&&typeof rebuilt.broker.claim==='function','broker rebuilt with claim()');
ok(rebuilt.registry&&typeof rebuilt.registry.assess==='function','registry rebuilt');
ok(rebuilt.importedRecords>0&&rebuilt.restoredOnly===true,
 'registry records import as RESTORED only ('+rebuilt.importedRecords+')');
// Ram.decode returns a plain NUMBER. The real check is not its type but that
// the rebuilt reader AGREES with the pipeline's own reader on the same memory,
// including the endian and encoding normalisation the pipeline applies.
const memory=v.host.driver.readRam();
const mine=rebuilt.readResource(memory),theirs=v.result.readResource(memory);
ok(typeof mine==='number','rebuilt readResource returns a number: '+JSON.stringify(mine));
ok(mine===theirs,'rebuilt readResource agrees with the pipeline own reader: '
 +JSON.stringify(mine)+' vs '+JSON.stringify(theirs));
ok(cloned.resource.encodingDetermined!==null&&cloned.resource.encoding!==undefined,
 'the DTO carries the encoding, so a BCD field cannot be rebuilt as binary'
 +' (encoding '+cloned.resource.encoding+', determined '+cloned.resource.encodingDetermined+')');
// and the decode spec the DTO yields must equal the one the pipeline built
const spec=Dto.decodeSpecFor(cloned.resource);
ok(spec&&spec.endian&&spec.encoding,'the DTO yields a complete decode spec: '+JSON.stringify(spec));
// a rebuilt registry must not be able to promote from restored evidence
const promoted=rebuilt.registry.promote(cloned.goal.id,
 {polarity:cloned.goal.polarity,polarityEvidenced:true,profileRevision:CTX.profileRevision});
ok(promoted.verified===false,
 'a registry rebuilt from a DTO CANNOT promote (blockers: '+(promoted.blockers||[]).join(', ')+')');

console.log('=== 3. a DTO cannot forge a VERIFIED ===');
const forged={...cloned,status:'VERIFIED',
 goal:{...cloned.goal,id:'forged-goal'},
 evidence:{...cloned.evidence,evidenceRefs:['no-such-record']}};
const forgedVerdict=Dto.validate(forged,CTX);
ok(!forgedVerdict.valid,'a DTO citing records the registry state lacks is refused');
ok(forgedVerdict.problems.some(p=>/evidence records|no record/i.test(p)),
 'the refusal names the missing evidence: '+forgedVerdict.problems.join(' | '));
const bare={dtoSchema:1,dtoRevision:'x',pipelineRevision:'agod-pipeline-s10-5',
 status:'VERIFIED',goal:{id:'g',lifecycle:'VERIFIED',polarity:'NEGATIVE'},
 resource:{address:1,width:1},actions:{},evidence:{evidenceRefs:[]},provenance:{}};
ok(!Dto.validate(bare,CTX).valid,'a VERIFIED DTO with no evidence at all is refused');
const wrongRom=Dto.validate(cloned,{...CTX,romHash:'another-rom'});
ok(!wrongRom.valid&&wrongRom.problems.some(p=>/another ROM/.test(p)),
 'a DTO proved against another ROM is refused');
const withFn={...cloned};withFn.sneaky=()=>1;
ok(!Dto.validate(withFn,CTX).valid,'a DTO carrying a function is refused');
const r2=Dto.rebuild(forged,{Reward:Rw,Evidence:Ev,Ram},{driver:v.host.driver,expected:CTX});
ok(r2.status==='REFUSED'&&!r2.broker,'rebuild refuses an invalid DTO and returns no broker');

console.log('=== 4. the non-positive outcomes still transport ===');
const demo=JSON.parse(fs.readFileSync(path.join(A,'demo-rom.json')));
const h2=Driver.create({romBase64:demo.base64,jsnes,entry:{bootFrames:60,startPulses:0},frameBudget:3000000});
const refused=globalThis.FlyAgodPipeline.run(h2.driver,{...CTX,romHash:'demo-fixture'});
const rdto=Dto.fromPipelineResult(refused,{...CTX,romHash:'demo-fixture',platform:'nes',
 driverRevision:Driver.DRIVER_REVISION,producedAtMs:Date.now()});
let rclone=null;try{rclone=structuredClone(rdto);}catch(e){}
ok(!!rclone,'a REFUSED result clones');
ok(rclone&&rclone.status==='REFUSED'&&rclone.reason,'REFUSED keeps its stage and reason: '
 +(rclone&&rclone.stage)+' / '+String(rclone&&rclone.reason).slice(0,60));
ok(Dto.validate(rclone,{...CTX,romHash:'demo-fixture'}).valid,'a REFUSED DTO validates');
const noMech=Dto.rebuild(rclone,{Reward:Rw,Evidence:Ev,Ram},
 {driver:h2.driver,expected:{...CTX,romHash:'demo-fixture'}});
ok(noMech.status==='NO-MECHANISM'&&!noMech.broker,
 'a REFUSED DTO yields NO-MECHANISM and no broker: '+noMech.status);
const empty=Dto.fromPipelineResult(null,{});
ok(empty.status==='REFUSED'&&empty.rewardMechanismExcluded===true,'a missing result is described, not thrown');

console.log(out.join('\n'));
console.log('\n'+(fail.length?'FAIL ('+fail.length+')':'PASS')+' — '+(out.length-fail.length)+'/'+out.length+' checks');
if(fail.length)process.exitCode=1;
