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
   A gap that fails any of these is reported with the reason.

   r2 (measured on a private SNES run-and-gun whose stage 1 was cleared by a search
   route): control came back while the next stage was still fading in, and judged
   at that stride the dark half-drawn scene resembled a stage-1 scene (novelty
   0.019) - the clear was missed. Novelty is now the MAXIMUM over the first
   `minReturnFrames` after control returns, and a caller may pass a colour palette
   (`scene`, 8 levels per channel) instead of the 8 x 6 luminance grid: across that
   stage every scene against all earlier ones stayed <= 0.26, the next stage's
   first scenes were 0.39 - 0.47 (threshold `paletteNovelty` 0.30). The detector says
   CANDIDATE; a LEVEL_CLEAR claim additionally needs the independent post-run
   evidence (frames before/after, the action log) the runner saves.

   Nothing here pays a reward: a candidate is evidence for the verifier, not a
   number for the learner. */
'use strict';
(function(root){
const require_=typeof require==='function'?require:null;
const Survival=root.FlyAgodSurvival||(require_?require_('./agod-survival.js'):null);
const STAGE_REVISION='agod-stage-r2';
const DEFAULTS=Object.freeze({stride:8,minGapFrames:120,lossGuardFrames:120,novelty:0.10,paletteNovelty:0.30,sampleEvery:32,minReturnFrames:64});

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
/* colour palette: the share of sampled pixels in each of levels^3 RGB bins */
function palette(pixels,w,h,levels){
 const L=levels||8,out=new Float32Array(L*L*L);let n=0;if(!pixels||!w||!h)return null;
 for(let y=0;y<h;y+=4)for(let x=0;x<w;x+=4){const c=pixels[y*w+x];out[Math.floor((c&255)*L/256)*L*L+Math.floor(((c>>>8)&255)*L/256)*L+Math.floor(((c>>>16)&255)*L/256)]++;n++;}
 for(let i=0;i<out.length;i++)out[i]/=n;return out;
}
const paletteDistance=(a,b)=>{let s=0;for(let i=0;i<a.length;i++)s+=Math.abs(a[i]-b[i]);return s/2;};

/* options: {probe (Phase.probe result in play), readResource(ram)->number, ...DEFAULTS} */
function createMonitor(options){
 const o={...DEFAULTS,...(options||{})};
 const tracker=Survival&&o.probe?Survival.authorityTracker(o.probe):null;
 if(!tracker)return null;
 const seen=[];                 /* scene signatures of the current stage */
 const events=[];let frame=0,gap=null,lastLoss=-1e9,lastResource=null,sinceSample=0,lastGood=null,returning=null;
 const novel=s=>{const usePalette=!!s.scene;let v=null;
  for(const x of seen){const d=usePalette?(x.scene?paletteDistance(x.scene,s.scene):null):(x.sig?distance(x.sig,s.signature):null);if(d!==null)v=v===null?d:Math.min(v,d);}
  return v;};
 function observe(s){
  /* s: {mask, ramBefore, ramAfter, signature} for one stride */
  frame+=o.stride;
  const r=o.readResource?o.readResource(s.ramAfter):null;
  if(Number.isFinite(r)){if(lastResource!==null&&r<lastResource){lastLoss=frame;events.push({kind:'LOSS',frame,from:lastResource,to:r});}lastResource=r;}
  const a=tracker.observe(s.mask,s.ramBefore,s.ramAfter);
  const inControl=a.active&&a.moved;
  /* after a long gap, judge the scene over the first minReturnFrames back in control */
  if(returning){
   const v=(s.signature||s.scene)?novel(s):null;if(v!==null)returning.novelty=returning.novelty===null?v:Math.max(returning.novelty,v);
   if(frame>=returning.until){finish(returning);returning=null;}
   else return null;
  }
  if(!a.dropped&&(s.signature||s.scene)){
   sinceSample+=o.stride;lastGood=s.signature;
   if(sinceSample>=o.sampleEvery&&!gap){seen.push({sig:s.signature||null,scene:s.scene||null});sinceSample=0;}
  }
  if(a.dropped&&!gap)gap={start:frame,before:lastGood,lossAt:lastLoss};
  if(gap&&inControl){
   const length=frame-gap.start;
   const e={frame,gapStart:gap.start,gapFrames:length,lostResource:false,novelty:null,palette:!!s.scene};
   if(length<o.minGapFrames){e.kind='GAP';e.reason='shorter than '+o.minGapFrames+' frames';}
   else{returning={e,until:frame+o.minReturnFrames,novelty:(s.signature||s.scene)?novel(s):null};}
   gap=null;
   if(returning&&frame>=returning.until){finish(returning);returning=null;}
  }
  return null;
 }
 function finish(r){const e=r.e;e.lostResource=lastLoss>=e.gapStart-o.lossGuardFrames;e.novelty=r.novelty===null?null:+r.novelty.toFixed(4);e.decidedAt=frame;
  const threshold=e.palette?o.paletteNovelty:o.novelty;
  if(e.lostResource){e.kind='GAP';e.reason='a resource was lost around it (a death)';}
  else if(e.novelty===null||e.novelty<threshold){e.kind='GAP';e.reason='came back to a scene of this stage (novelty '+e.novelty+')';}
  else{e.kind='STAGE_TRANSITION_CANDIDATE';seen.length=0;}
  events.push(e);}
 return {revision:STAGE_REVISION,observe,events:()=>events.slice(),
  transitions:()=>events.filter(e=>e.kind==='STAGE_TRANSITION_CANDIDATE'),
  state:()=>({frame,inGap:!!gap,stageScenes:seen.length})};
}

const api=Object.freeze({STAGE_REVISION,DEFAULTS,createMonitor,signature,distance,palette,paletteDistance});
root.FlyAgodStage=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
