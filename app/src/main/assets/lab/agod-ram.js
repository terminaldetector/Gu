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
/* ---------------------------------------------------------------------------
   S11A: TRANSITION SUPPORT, pre-registered before any run on a real cartridge.

   The defect: analyseSpec collects a step only where the span changed, so a
   byte that changes exactly ONCE across the samples yields one step,
   distinctSteps === 1, and is declared IDENTIFIED with a constant step. One
   transition cannot establish that a step is constant.

   The rule under test, fixed here and not tuned afterwards:
     at least TWO observed transitions, and the non-zero steps must agree.

   What the rule does NOT claim: that a single-transition field is useless. One
   transition may belong to a game event, a flag, a counter with only one unit
   of resource available, or something else. Such a field is reported as
   INSUFFICIENT_TRANSITION_SUPPORT and KEPT for diagnosis, never silently
   dropped and never relabelled as a decoy.

   Off by default, so the legacy typing remains the control mode. --------- */
const TRANSITION_SUPPORT_RULE=Object.freeze({
 ruleRevision:'s11a-transition-support-1',
 declaredBefore:'committed before any S11A run on a real cartridge',
 minObservedTransitions:2,
 requireStepAgreement:true,
 statement:'at least two observed transitions whose non-zero steps agree',
 onFailure:'INSUFFICIENT_TRANSITION_SUPPORT: the candidate is kept with its measurements for diagnosis; this is a statement about the evidence, NOT about the field being useless',
 defaultEnabled:false});
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
 /* S11A: WHERE each transition happened, not only what step it produced. A
    single step says nothing about whether it is constant; the sample indices
    say how much support the claim has. Diagnostic only - no rule reads these. */
 const transitionIndices=[];
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
  transitionIndices.push(i);
 }
 if(!steps.length)return frozen({spec,usable:false,reason:'the span never changed'});
 /* Every byte of the claimed span must have been seen to move. Otherwise the
    span is an assumption about a constant byte, not an observation. */
 if(movedBytes.size<spec.width)
  return frozen({spec,usable:false,reason:'only '+movedBytes.size+' of '+spec.width+' bytes were ever observed to change',observedWidth:movedBytes.size});
 const distinct=[...new Set(steps)].sort((a,b)=>a-b);
 const magnitudes=steps.map(Math.abs);
 const signs=new Set(steps.map(step=>Math.sign(step)));
 const nonzero=steps.filter(step=>step!==0);
 const distinctNonzero=[...new Set(nonzero)].sort((a,b)=>a-b);
 return frozen({spec,usable:true,series:values.join(','),
  samples:values.length,transitions:steps.length,
  distinctSteps:distinct.length,step:distinct.length===1?distinct[0]:null,
  maxAbsStep:Math.max(...magnitudes),monotone:signs.size===1,
  direction:signs.size===1?(steps[0]>0?'increasing':'decreasing'):'mixed',
  /* S11A diagnostics. Recorded on every analysis; nothing here changes a
     verdict unless the caller asks for the transition-support rule. */
  observedTransitions:steps.length,
  transitionSampleIndices:frozen(transitionIndices.slice(0,64)),
  distinctNonzeroSteps:distinctNonzero.length,
  nonzeroSteps:frozen(distinctNonzero.slice(0,16)),
  stepAgreementAcrossTransitions:nonzero.length>1&&distinctNonzero.length===1,
  firstChangeSampleIndex:transitionIndices.length?transitionIndices[0]:null,
  lastChangeSampleIndex:transitionIndices.length?transitionIndices[transitionIndices.length-1]:null});
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
 /* S11A diagnostics, reported whether or not the rule is enabled. */
 const framesPerSample=Number.isInteger(options.framesPerSample)?options.framesPerSample:null;
 /* S11C: a transition is observed BETWEEN two snapshots, so what is known is an
    INTERVAL, never a frame. The earlier transitionFrameIndices multiplied a
    snapshot index by the frames per event and read like an exact frame; it was
    the boundary of an observation interval. Intervals are reported instead, with
    the sampling mode that produced them, and no exact event time is claimed
    without per-frame observation.

    POST_ONLY     sample i is taken after event i+1, so a change seen between
                  samples i-1 and i happened during event i+1: frames
                  [i*F, (i+1)*F).
    PRE_AND_POST  sample 0 is taken before any event at frame 0 and sample i>0
                  after event i, so a change between i-1 and i happened during
                  event i: frames [(i-1)*F, i*F). */
 const samplingMode=options.samplingMode==='PRE_AND_POST'?'PRE_AND_POST':'POST_ONLY';
 const interval=index=>{
  if(framesPerSample===null)return null;
  const start=samplingMode==='PRE_AND_POST'?(index-1)*framesPerSample:index*framesPerSample;
  return {sampleIndex:index,
   intervalStartFrame:start,intervalEndFrame:start+framesPerSample,
   snapshotSource:samplingMode==='PRE_AND_POST'&&index===1
    ?'between the pre-event snapshot and the snapshot after event 1'
    :'between two post-event snapshots',
   exactFrameKnown:false};
 };
 const support=frozen({
  samplingMode,
  observedTransitions:best.observedTransitions,
  transitionSampleIndices:best.transitionSampleIndices,
  transitionIntervals:framesPerSample===null?null
   :frozen(best.transitionSampleIndices.map(index=>frozen(interval(index)))),
  /* kept under an honest name: these are interval STARTS, not event times */
  transitionIntervalStartFrames:framesPerSample===null?null
   :frozen(best.transitionSampleIndices.map(index=>interval(index).intervalStartFrame)),
  timingCaveat:'each transition is located to an observation interval of '
   +(framesPerSample===null?'unknown':framesPerSample)+' frames, not to a frame. No exact event time is claimed.',
  distinctNonzeroSteps:best.distinctNonzeroSteps,
  nonzeroSteps:best.nonzeroSteps,
  stepAgreementAcrossTransitions:best.stepAgreementAcrossTransitions,
  firstChangeSampleIndex:best.firstChangeSampleIndex,
  lastChangeSampleIndex:best.lastChangeSampleIndex,
  firstChangeInterval:framesPerSample===null||best.firstChangeSampleIndex===null?null
   :frozen(interval(best.firstChangeSampleIndex)),
  lastChangeInterval:framesPerSample===null||best.lastChangeSampleIndex===null?null
   :frozen(interval(best.lastChangeSampleIndex)),
  observationHorizonSamples:best.samples,
  observationHorizonFrames:framesPerSample===null?null:best.samples*framesPerSample,
  transitionSupportStatus:(best.observedTransitions>=TRANSITION_SUPPORT_RULE.minObservedTransitions
   &&(!TRANSITION_SUPPORT_RULE.requireStepAgreement||best.stepAgreementAcrossTransitions))
   ?'SUPPORTED':'INSUFFICIENT',
  ruleRevision:TRANSITION_SUPPORT_RULE.ruleRevision});
 const fieldRecord=frozen({address:spec.address,width:spec.width,
  endian:spec.width===1?'n/a':spec.endian,
  encoding:encodings.length===1?encodings[0]:'undetermined',
  encodingCandidates:frozen(encodings),
  encodingDetermined:encodings.length===1,
  signedness:'UNKNOWN',
  widthBasis:'observed-active: every byte of this span was seen to change',
  step:best.step,direction:best.direction,
  transitions:best.transitions,samples:best.samples,
  transitionSupport:support});
 /* The rule, only when the caller asks for it. The candidate is preserved. */
 if(options.transitionSupport===true&&support.transitionSupportStatus!=='SUPPORTED')
  return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
   status:'INSUFFICIENT_TRANSITION_SUPPORT',
   reason:'a constant step cannot be established from '+support.observedTransitions
    +' observed transition(s)'+(support.stepAgreementAcrossTransitions?'':' with agreeing steps'),
   rule:TRANSITION_SUPPORT_RULE,
   /* kept, not discarded: this is a statement about the evidence */
   provisionalField:fieldRecord,
   keptForDiagnosis:true,
   notAClaimOfUselessness:'one transition may belong to a game event, a flag, or a counter with a single unit available; this says only that constancy is not established'});
 return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
  status:'IDENTIFIED',
  field:fieldRecord,
  runnerUp:considered[1]?frozen({spec:considered[1].spec,distinctSteps:considered[1].distinctSteps,maxAbsStep:considered[1].maxAbsStep}):null,
  consideredInterpretations:considered.length,
  rejectedInterpretations:unusable.length});
}

const api={SCHEMA_VERSION,DETECTOR_REVISION,TRANSITION_SUPPORT_RULE,MAX_WIDTH,ENCODINGS,decode,wrapToSigned,spansOf,analyseSpec,identifyField};
root.FlyAgodRam=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
