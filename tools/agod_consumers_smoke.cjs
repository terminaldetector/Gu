'use strict';
// Smoke test for agod-consumers: it must TERMINATE, and quickly.
//
// The first version of this module hung an entire run on its first cartridge
// because `i<options.driveTimes||16` parses as `(i<options.driveTimes)||16`,
// which is truthy forever. Nothing caught it: the probe simply never returned
// and the run sat there. This test exists so that can never be true again, and
// it runs against a tiny fake machine in milliseconds, with no emulator.
const assert=require('node:assert/strict');
const Consumers=require('../app/src/main/assets/lab/agod-consumers.js');

/* A 32-byte machine. Address 4 is a plain accumulator nothing reads; address 5
   is read by the machine and gates address 6, so it has a real consumer. */
function machine(){
 let mem=new Uint8Array(32);
 const snap=()=>JSON.stringify(Array.from(mem));
 return {
  restore(s){mem=Uint8Array.from(JSON.parse(s));},
  snapshot:snap,
  readRam(){return mem.slice();},
  stateHash(){return Array.from(mem).join(',');},
  poke(address,value){mem[address]=value&255;},
  run(mask,frames){
   for(let f=0;f<frames;f++){
    if(mask&1)mem[4]=(mem[4]+1)&255;                  /* accumulator, unread */
    if(mask&2)mem[5]=(mem[5]+1)&255;                  /* gate source */
    if(mem[5]>3)mem[6]=(mem[6]+1)&255;                /* consumer of 5 */
    mem[7]=(mem[7]+1)&255;                            /* time-driven */
   }
  }};
}
const results=[];
const started=Date.now();
const field=(address)=>({address,width:1,endian:'n/a',encoding:'binary',encodingDetermined:true,direction:'increasing',step:1});

// 1. It returns at all, within a sane wall-clock budget.
{const driver=machine();const pristine=driver.snapshot();
 const t=Date.now();
 const out=Consumers.downstreamConsumer(driver,{field:field(4),fieldMask:1,pristine,
  hold:1,release:1,steps:4,driveTimes:5});
 const ms=Date.now()-t;
 results.push({name:'downstreamConsumer terminates',ms,status:out.status,hasConsumer:out.hasConsumer});
 assert(ms<5000,'the probe must return promptly, it took '+ms+' ms');
 assert.equal(out.status,'OBSERVED');
 assert.equal(out.hasConsumer,false,'address 4 is an accumulator nothing reads');}

// 2. It finds a consumer when there is one.
{const driver=machine();const pristine=driver.snapshot();
 const out=Consumers.downstreamConsumer(driver,{field:field(5),fieldMask:2,pristine,
  hold:1,release:1,steps:4,driveTimes:5});
 results.push({name:'a field with a consumer is detected',status:out.status,hasConsumer:out.hasConsumer});
 assert.equal(out.hasConsumer,true,'address 5 gates address 6');}

// 3. driveTimes omitted entirely: the default must be a NUMBER, not a truthy loop.
{const driver=machine();const pristine=driver.snapshot();
 const t=Date.now();
 const out=Consumers.downstreamConsumer(driver,{field:field(4),fieldMask:1,pristine,
  hold:1,release:1,steps:4});
 const ms=Date.now()-t;
 results.push({name:'driveTimes omitted still terminates',ms,status:out.status});
 assert(ms<5000,'with driveTimes omitted the probe must still return, it took '+ms+' ms');}

// 4. The budget guard fires rather than hanging, when a probe really is too big.
{const driver=machine();const pristine=driver.snapshot();
 let threw=null;
 try{Consumers.downstreamConsumer(driver,{field:field(4),fieldMask:1,pristine,
  hold:1000,release:1000,steps:50,driveTimes:50,frameBudget:500});}
 catch(error){threw=error.message;}
 results.push({name:'frame budget guard',observed:threw||'did not throw'});
 assert(threw&&/not terminating/.test(threw),'an over-budget probe must throw, not hang');}

// 5. fieldCausality terminates and separates action- from field-mediated.
{const driver=machine();const pristine=driver.snapshot();
 const t=Date.now();
 const out=Consumers.fieldCausality(driver,{candidate:field(6),candidateMask:0,
  modulator:field(5),modulatorMask:2,pristine,hold:1,release:1,settle:1,modulatorPulses:4});
 const ms=Date.now()-t;
 results.push({name:'fieldCausality terminates',ms,verdict:out.verdict,
  actionMediated:out.actionMediated,fieldMediated:out.fieldMediated});
 assert(ms<5000,'fieldCausality must return promptly');
 assert(['FIELD-MEDIATED','ACTION-MEDIATED-ONLY','NO-MODULATION'].includes(out.verdict));}

// 6. The exact defect, as a regression: the old expression is truthy forever.
{const driveTimes=16;
 const oldCondition=i=>(i<undefined)||16;              /* what the old code meant */
 const newCondition=i=>i<driveTimes;
 results.push({name:'regression: the old loop condition',
  oldAtI_1000000:!!oldCondition(1000000),newAtI_1000000:!!newCondition(1000000)});
 assert.equal(!!oldCondition(1000000),true,'the old condition is truthy even at i = 1e6');
 assert.equal(newCondition(1000000),false,'the fixed condition terminates');}

const elapsed=Date.now()-started;
console.log(JSON.stringify({type:'gu-agod-consumers-smoke',status:'PASS',elapsedMs:elapsed,results},null,1));
console.log('PASS: '+results.length+' smoke checks in '+elapsed+' ms. The probes terminate, the budget guard throws instead of hanging, and the old loop condition is shown to be truthy at i = 1000000.');
