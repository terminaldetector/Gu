/* Does the game READ this variable? (user requirement after S4b)

   Two things were being run together. "An action changes this field" is
   action-mediated: pressing a button changes many bytes at once, and any of
   them could be the one that matters. "This field's own value changes what the
   machine does" is isolated RAM-field causality, and it is the question that
   decides whether a quantity is part of the game or just a number going up.

   Both are answered here by the same instrument: write a value into the field
   directly, leave everything else identical, and look at what follows.

     fieldCausality      poke the MODULATOR and measure the candidate's gain
                         rate. If the rate only moves when the modulator's
                         BUTTON is pressed but not when its field is poked, the
                         modulation was action-mediated and the field was never
                         the cause.
     downstreamConsumer  poke the CANDIDATE and run a fixed schedule. If RAM
                         outside the field's own bytes diverges, something reads
                         it. If nothing diverges, nothing in the cartridge
                         consumes it, whatever a label says.

   The second test is the one that can contradict a closed label, and it is
   meant to: an accumulated variable must not count as beneficial because the
   oracle says so. Needs driver.poke(address, value). Not wired into any
   production screen. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);
const SCHEMA_VERSION=1,PROBE_REVISION='agod-consumers-s4c-2';
const DEFAULT_FRAME_BUDGET=400000;
const frozen=Object.freeze.bind(Object);

const decode=(memory,field)=>Ram.decode(memory,{address:field.address,width:field.width,
 endian:field.endian==='n/a'?'little':field.endian,
 encoding:field.encodingDetermined===false?'binary':(field.encoding==='bcd'?'bcd':'binary')});
const spanOf=field=>{const out=[];for(let i=0;i<field.width;i++)out.push(field.address+i);return out;};

/* Little-endian byte write of a plain integer, which is all these probes need:
   the value only has to be a different, reachable one. */
function pokeValue(driver,field,value){
 let remaining=value>>>0;
 const order=field.endian==='big'?spanOf(field).slice().reverse():spanOf(field);
 for(const address of order){driver.poke(address,remaining&255);remaining=remaining>>>8;}
}

function requirePoke(driver){
 if(!driver||typeof driver.poke!=='function')
  throw new Error('these probes need driver.poke(address, value): a counterfactual on a field cannot be done by playing');
}

/* A probe that does not terminate must fail, not hang. The first version of
   this module wrote `i<options.driveTimes||16`, which parses as
   `(i<options.driveTimes)||16` and is truthy on every iteration whatever the
   value - an infinite loop that simply stopped the run with no error. This
   wrapper makes any such mistake surface as a thrown budget error instead. */
function metered(driver,budget){
 let frames=0;
 const limit=Number.isInteger(budget)?budget:DEFAULT_FRAME_BUDGET;
 return {...driver,
  run(mask,count){
   frames+=count;
   if(frames>limit)throw new Error('frame budget exceeded after '+frames+
    ' emulated frames: the probe is not terminating');
   return driver.run(mask,count);
  },
  framesUsed(){return frames;}};
}

/* A signature of everything EXCEPT the field itself, so the field's own
   continuation can never be mistaken for a consumer. */
function signature(driver,excluded){
 const ram=driver.readRam();
 let h1=0x811c9dc5,h2=0x01000193;
 for(let address=0;address<ram.length;address++){
  if(excluded.has(address))continue;
  const byte=ram[address];
  h1=(h1^byte)*0x01000193>>>0;
  h2=(h2+byte*31+(address&255))>>>0;h2=(h2<<7|h2>>>25)>>>0;
 }
 return ('00000000'+h1.toString(16)).slice(-8)+('00000000'+h2.toString(16)).slice(-8);
}

function downstreamConsumer(driver,options){
 requirePoke(driver);
 const field=options.field,pristine=options.pristine;
 const hold=options.hold===undefined?4:options.hold;
 const release=options.release===undefined?8:options.release;
 const masks=options.masks||[1,2,4,8,16,32,64,128];
 const steps=options.steps===undefined?24:options.steps;
 const excluded=new Set(spanOf(field));
 for(const address of options.alsoExcluded||[])excluded.add(address);
 /* Hoisted and ?? rather than inline ||, which is what broke before. */
 const driveTimes=Number.isInteger(options.driveTimes)?options.driveTimes:16;
 driver=metered(driver,options.frameBudget);

 /* A second value the field actually reaches, rather than an invented one. */
 driver.restore(pristine);
 const base=decode(driver.readRam(),field);
 for(let i=0;i<driveTimes;i++){driver.run(options.fieldMask,hold);driver.run(0,release);}
 const driven=decode(driver.readRam(),field);
 if(driven===base)
  return frozen({schemaVersion:SCHEMA_VERSION,probeRevision:PROBE_REVISION,
   status:'INCONCLUSIVE',hasConsumer:null,
   reason:'the field did not reach a second value, so there is nothing to contrast'});

 const arm=value=>{
  driver.restore(pristine);
  pokeValue(driver,field,value);
  for(let step=0;step<steps;step++){
   const mask=masks[step%masks.length];
   driver.run(mask,hold);driver.run(0,release);
  }
  return signature(driver,excluded);
 };
 const low=arm(base),high=arm(driven);
 /* Repeat the first arm to be sure the schedule itself is deterministic: without
    this a flaky signature would read as a consumer. */
 const lowAgain=arm(base);
 if(low!==lowAgain)
  return frozen({schemaVersion:SCHEMA_VERSION,probeRevision:PROBE_REVISION,
   status:'INCONCLUSIVE',hasConsumer:null,
   reason:'the schedule is not deterministic for this cartridge, so a divergence would prove nothing'});
 return frozen({schemaVersion:SCHEMA_VERSION,probeRevision:PROBE_REVISION,
  status:'OBSERVED',hasConsumer:low!==high,
  values:frozen({base,driven}),signatures:frozen({low,high}),
  excludedBytes:excluded.size,steps,
  reason:low!==high
   ?'poking this field changed what the machine did next, so something in the cartridge reads it'
   :'poking this field changed nothing outside its own bytes: no part of the cartridge consumes it'});
}

/* Is the rate modulation a property of the FIELD or only of the button? */
function fieldCausality(driver,options){
 requirePoke(driver);
 const candidate=options.candidate,modulator=options.modulator,pristine=options.pristine;
 driver=metered(driver,options.frameBudget);
 const modulatorPulses=Number.isInteger(options.modulatorPulses)?options.modulatorPulses:2;
 const hold=options.hold===undefined?4:options.hold;
 const release=options.release===undefined?8:options.release;
 const settle=options.settle===undefined?30:options.settle;
 const read=field=>decode(driver.readRam(),field);
 const stepOf=prepare=>{
  driver.restore(pristine);
  if(prepare)prepare();
  const before=read(candidate);
  driver.run(options.candidateMask,hold);driver.run(0,release);
  return read(candidate)-before;
 };
 const baseStep=stepOf(null);
 /* Reached by pressing the modulator's button: everything it touches moves. */
 const byAction=stepOf(()=>{for(let i=0;i<modulatorPulses;i++){
  driver.run(options.modulatorMask,hold);driver.run(0,settle);}});
 /* Reached by writing only the modulator field, with a value the action reaches. */
 driver.restore(pristine);
 for(let i=0;i<modulatorPulses;i++){driver.run(options.modulatorMask,hold);driver.run(0,settle);}
 const reachedValue=read(modulator);
 const byField=stepOf(()=>pokeValue(driver,modulator,reachedValue));
 const actionChanged=baseStep>0&&byAction!==baseStep;
 const fieldChanged=baseStep>0&&byField!==baseStep;
 return frozen({schemaVersion:SCHEMA_VERSION,probeRevision:PROBE_REVISION,
  status:'OBSERVED',
  baseStep,stepAfterAction:byAction,stepAfterPokingField:byField,
  modulatorValueReached:reachedValue,
  actionMediated:actionChanged,fieldMediated:fieldChanged,
  verdict:fieldChanged?'FIELD-MEDIATED':(actionChanged?'ACTION-MEDIATED-ONLY':'NO-MODULATION'),
  reason:fieldChanged
   ?'writing this field alone changed the gain rate, so the field is the cause'
   :(actionChanged
    ?'the rate moved when the button was pressed but not when the field was written: the modulation belongs to the action, not to this field'
    :'no rate change either way')});
}

const api={SCHEMA_VERSION,PROBE_REVISION,downstreamConsumer,fieldCausality,pokeValue};
root.FlyAgodConsumers=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
