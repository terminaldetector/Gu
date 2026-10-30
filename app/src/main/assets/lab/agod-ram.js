/* Experimental typed RAM field identification (TZ v2.0, AGOD-02, E2).

   The existing miner enumerates candidates and never commits: agod_rom_check
   reports `fullTypeIdentified:false` as a constant, and the exact typed spec of
   the counter is merely present in the candidate list on 1 of 7 cartridges.
   This module commits to one type per quantity, or says why it cannot.

   The discriminator is the step structure of a causally attributed span. A
   counter driven by one action moves by the same amount each time it is driven;
   a wrong width, a wrong byte order or a wrong encoding turns that constant
   step into a scatter. Wrap-around is read modulo the span, so an eight-bit
   counter rolling 255 -> 0 is still a step of +1 and not a collapse.

   Two things are deliberately NOT claimed:
     - signedness. Two's complement and unsigned decodings of the same bytes
       differ by a constant, so their modular steps are identical. Nothing
       inside RAM distinguishes them, so the field reports UNKNOWN rather than
       the conventional guess.
     - bytes that never changed. A constant upper byte is not evidence of
       belonging to the span, so width is reported as what was observed to move,
       and full width is claimed only when a carry reached every byte.
   Not wired into any production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=1,DETECTOR_REVISION='agod-ram-e2-1';
const MAX_WIDTH=4,ENCODINGS=Object.freeze(['binary','bcd']);
const frozen=Object.freeze.bind(Object);

function decode(bytes,spec){
 let value=0;
 for(let k=0;k<spec.width;k++){
  const byte=bytes[spec.address+(spec.endian==='big'?k:spec.width-1-k)];
  if(byte===undefined)return null;
  if(spec.encoding==='bcd'){if((byte&15)>9||(byte>>>4)>9)return null;value=value*100+(byte>>>4)*10+(byte&15);}
  else value=value*256+byte;
 }
 return value;
}
const modulusOf=spec=>spec.encoding==='bcd'?Math.pow(100,spec.width):Math.pow(256,spec.width);
/* A counter that wraps has not jumped backwards by the whole range; it has
   stepped by one. Read every difference as its smallest signed representative. */
function wrapToSigned(delta,modulus){
 const half=modulus/2,wrapped=((delta%modulus)+modulus)%modulus;
 return wrapped>=half?wrapped-modulus:wrapped;
}

/* How well does one interpretation explain the samples? */
function analyseSpec(samples,spec){
 const modulus=modulusOf(spec),values=[],steps=[];
 let movedBytes=new Set();
 for(const sample of samples){
  const value=decode(sample,spec);
  if(value===null)return frozen({spec,usable:false,reason:'encoding invalid in at least one sample'});
  values.push(value);
 }
 for(let i=1;i<samples.length;i++){
  let changed=false;
  for(let k=0;k<spec.width;k++)if(samples[i][spec.address+k]!==samples[i-1][spec.address+k]){changed=true;movedBytes.add(spec.address+k);}
  if(!changed)continue;
  steps.push(wrapToSigned(values[i]-values[i-1],modulus));
 }
 if(!steps.length)return frozen({spec,usable:false,reason:'the span never changed'});
 /* Every byte of the claimed span must have been seen to move. Otherwise the
    span is an assumption about a constant byte, not an observation. */
 if(movedBytes.size<spec.width)
  return frozen({spec,usable:false,reason:'only '+movedBytes.size+' of '+spec.width+' bytes were ever observed to change',observedWidth:movedBytes.size});
 const distinct=[...new Set(steps)].sort((a,b)=>a-b);
 const magnitudes=steps.map(Math.abs);
 const signs=new Set(steps.map(step=>Math.sign(step)));
 return frozen({spec,usable:true,series:values.join(','),
  samples:values.length,transitions:steps.length,
  distinctSteps:distinct.length,step:distinct.length===1?distinct[0]:null,
  maxAbsStep:Math.max(...magnitudes),monotone:signs.size===1,
  direction:signs.size===1?(steps[0]>0?'increasing':'decreasing'):'mixed'});
}

/* Lexicographic and deliberately dull: a constant step first, then fewer
   distinct steps, then a smaller step, then the wider span. No weights to
   tune, so there is no knob that could be turned until the answer is right. */
function rankOf(analysis){
 return [analysis.distinctSteps===1?0:1,analysis.distinctSteps,analysis.maxAbsStep,-analysis.spec.width];
}
const compare=(a,b)=>{const x=rankOf(a),y=rankOf(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return a.spec.address-b.spec.address;};
const sameRank=(a,b)=>{const x=rankOf(a),y=rankOf(b);return x.every((value,i)=>value===y[i]);};

/* Contiguous runs of causally attributed addresses: a field cannot be made of
   bytes that the action was never shown to touch. */
function spansOf(addresses){
 const sorted=[...new Set(addresses)].sort((a,b)=>a-b),runs=[];
 for(const address of sorted){
  const last=runs[runs.length-1];
  if(last&&address===last[last.length-1]+1)last.push(address);else runs.push([address]);
 }
 return runs;
}

function identifyField(options){
 const samples=options.samples||[];
 if(samples.length<2)throw new Error('type identification needs at least two samples');
 const maxWidth=Number.isInteger(options.maxWidth)?Math.min(options.maxWidth,MAX_WIDTH):MAX_WIDTH;
 const considered=[],unusable=[];
 for(const run of spansOf(options.addresses||[]))
  for(let width=1;width<=Math.min(maxWidth,run.length);width++)
   for(let offset=0;offset+width<=run.length;offset++)
    for(const encoding of ENCODINGS)
     for(const endian of width===1?['little']:['little','big']){
      const analysis=analyseSpec(samples,{address:run[offset],width,encoding,endian});
      (analysis.usable?considered:unusable).push(analysis);
     }
 if(!considered.length)
  return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
   status:'UNRESOLVED',reason:unusable.length?'no interpretation survived':'no attributed span to type',
   field:null,rejected:unusable.slice(0,32)});

 considered.sort(compare);
 const best=considered[0];
 /* A span driven by one action moves by the same amount each time. Without a
    constant step there is a changing byte and no identified variable, and
    saying otherwise would be exactly the forbidden shortcut of treating a
    changing RAM byte as understood. */
 if(best.distinctSteps!==1)
  return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
   status:'UNRESOLVED',reason:'no interpretation moves by a constant step under the driving action',
   field:null,closest:frozen({spec:best.spec,distinctSteps:best.distinctSteps,direction:best.direction})});

 const rivals=considered.filter(a=>a!==best&&sameRank(a,best));
 /* Rivals that decode to the same numbers on every sample are not competing
    hypotheses: they are one hypothesis under two names, and the samples cannot
    separate them. Below 10 per digit, BCD and binary are the same number. */
 const equivalent=rivals.filter(a=>a.series===best.series&&a.spec.address===best.spec.address&&a.spec.width===best.spec.width&&a.spec.endian===best.spec.endian);
 const genuine=rivals.filter(a=>!equivalent.includes(a));
 if(genuine.length)
  return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
   status:'AMBIGUOUS',reason:'several interpretations explain the samples equally well and disagree about the value',
   field:null,tied:[best,...genuine].map(a=>a.spec).slice(0,8)});

 const spec=best.spec,encodings=[...new Set([best,...equivalent].map(a=>a.spec.encoding))].sort();
 return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
  status:'IDENTIFIED',
  field:frozen({address:spec.address,width:spec.width,
   endian:spec.width===1?'n/a':spec.endian,
   /* Determined only when the samples exclude the alternative. */
   encoding:encodings.length===1?encodings[0]:'undetermined',
   encodingCandidates:frozen(encodings),
   encodingDetermined:encodings.length===1,
   /* Named, not guessed: nothing observed here can settle it. */
   signedness:'UNKNOWN',
   widthBasis:'observed-active: every byte of this span was seen to change',
   step:best.step,direction:best.direction,
   transitions:best.transitions,samples:best.samples}),
  runnerUp:considered[1]?frozen({spec:considered[1].spec,distinctSteps:considered[1].distinctSteps,maxAbsStep:considered[1].maxAbsStep}):null,
  consideredInterpretations:considered.length,
  rejectedInterpretations:unusable.length});
}

const api={SCHEMA_VERSION,DETECTOR_REVISION,MAX_WIDTH,ENCODINGS,decode,wrapToSigned,spansOf,analyseSpec,identifyField};
root.FlyAgodRam=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
