/* AGOD stage-transition detector (directive 2026-11-13, M2.2).

   WHAT IT ANSWERS. During one continuous episode - no restore, no rewind - did
   the game leave the stage it was in and start another one? It is the signal a
   LEVEL_CLEAR claim needs and that no progress counter can give: a counter that
   keeps rising says nothing about whether a stage ended.

   WHAT IT LOOKS AT, ONLY. Per 8-frame stride: whether a commanded move took
   effect (the passive control-authority tracker built on the causal phase
   probe), the VERIFIED resource (lives), and a coarse screen signature (8 x 6
   mean luminance). No address, no ROM name, no game rule.

   A STAGE TRANSITION is a control gap that
     - lasts at least `minGapFrames` (a stage-clear sequence; a stumble is shorter),
     - loses no resource from `lossGuardFrames` before it to its end (a death is a
       loss of control WITH a resource fall - reported as LOSS, never as a stage),
     - ends with control back, and
     - comes back to a scene unlike every scene of the stage so far: the minimum
       signature distance to everything seen before the gap is above `novelty`.
   A gap that fails any of these is reported with the reason. The detector says
   CANDIDATE; a LEVEL_CLEAR claim additionally needs the independent post-run
   evidence (frames before/after, the action log) the runner saves.

   Nothing here pays a reward: a candidate is evidence for the verifier, not a
   number for the learner. */
'use strict';
(function(root){
const require_=typeof require==='function'?require:null;
const Survival=root.FlyAgodSurvival||(require_?require_('./agod-survival.js'):null);
const STAGE_REVISION='agod-stage-r1';
const DEFAULTS=Object.freeze({stride:8,minGapFrames:120,lossGuardFrames:120,novelty:0.10,sampleEvery:32,minReturnFrames:64});

/* 8 x 6 mean luminance of an RGBA/xRGB frame of width w, height h */
function signature(pixels,w,h){
 const gw=8,gh=6,out=new Float32Array(gw*gh),n=new Float32Array(gw*gh);
 if(!pixels||!w||!h)return null;
 for(let y=0;y<h;y+=4)for(let x=0;x<w;x+=4){const c=pixels[y*w+x];const i=Math.min(gh-1,Math.floor(y*gh/h))*gw+Math.min(gw-1,Math.floor(x*gw/w));
  out[i]+=(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255))/255;n[i]++;}
 for(let i=0;i<out.length;i++)out[i]=n[i]?out[i]/n[i]:0;
 return out;
}
const distance=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=Math.abs(a[i]-b[i]);return s/a.length;};

/* options: {probe (Phase.probe result in play), readResource(ram)->number, ...DEFAULTS} */
function createMonitor(options){
 const o={...DEFAULTS,...(options||{})};
 const tracker=Survival&&o.probe?Survival.authorityTracker(o.probe):null;
 if(!tracker)return null;
 const seen=[];                 /* scene signatures of the current stage */
 const events=[];let frame=0,gap=null,lastLoss=-1e9,lastResource=null,sinceSample=0,lastGood=null;
 function observe(s){
  /* s: {mask, ramBefore, ramAfter, signature} for one stride */
  frame+=o.stride;
  const r=o.readResource?o.readResource(s.ramAfter):null;
  if(Number.isFinite(r)){if(lastResource!==null&&r<lastResource){lastLoss=frame;events.push({kind:'LOSS',frame,from:lastResource,to:r});}lastResource=r;}
  const a=tracker.observe(s.mask,s.ramBefore,s.ramAfter);
  const inControl=a.active&&a.moved;
  if(!a.dropped&&s.signature){
   sinceSample+=o.stride;lastGood=s.signature;
   if(sinceSample>=o.sampleEvery&&!gap){seen.push(s.signature);sinceSample=0;}
  }
  if(a.dropped&&!gap)gap={start:frame,before:lastGood,lossAt:lastLoss};
  if(gap&&inControl){
   const length=frame-gap.start;
   const lostDuring=lastLoss>=gap.start-o.lossGuardFrames;
   let novelty=null;
   if(s.signature&&seen.length){novelty=Infinity;for(const v of seen)novelty=Math.min(novelty,distance(v,s.signature));}
   const e={frame,gapStart:gap.start,gapFrames:length,lostResource:lostDuring,novelty:novelty===null?null:+novelty.toFixed(4)};
   if(length<o.minGapFrames)e.kind='GAP',e.reason='shorter than '+o.minGapFrames+' frames';
   else if(lostDuring)e.kind='GAP',e.reason='a resource was lost around it (a death)';
   else if(novelty===null||novelty<o.novelty)e.kind='GAP',e.reason='came back to a scene of this stage (novelty '+e.novelty+')';
   else{e.kind='STAGE_TRANSITION_CANDIDATE';seen.length=0;}
   if(e.kind!=='GAP'||length>=o.minGapFrames)events.push(e);
   gap=null;
  }
  return null;
 }
 return {revision:STAGE_REVISION,observe,events:()=>events.slice(),
  transitions:()=>events.filter(e=>e.kind==='STAGE_TRANSITION_CANDIDATE'),
  state:()=>({frame,inGap:!!gap,stageScenes:seen.length})};
}

const api=Object.freeze({STAGE_REVISION,DEFAULTS,createMonitor,signature,distance});
root.FlyAgodStage=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
