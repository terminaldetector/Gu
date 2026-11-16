/* The fast-loop probe's in-WebView controller (a bundled file: the page's CSP allows
   workers only from 'self'). A stand-in policy for MEASURING THE LOOP, not a player:
   32x30 luminance, mean absolute difference to the previous frame, Right plus A when
   the screen moves. The same feature is computed in Java for the native transports
   (FrameProbe.java), so the transports do the same work.
   Stage stamps use performance.timeOrigin + performance.now(), the clock the page
   uses too, so VisualReady and DecisionReady line up with FramePublished. */
'use strict';
let prev=null;
const now=()=>performance.timeOrigin+performance.now();
self.onmessage=e=>{
 const m=e.data,received=now(),px=new Uint32Array(m.buffer),W=32,H=30,lum=new Float32Array(W*H);
 for(let y=0;y<H;y++){const row=Math.floor(y*m.height/H)*m.width;
  for(let x=0;x<W;x++){const c=px[row+Math.floor(x*m.width/W)];lum[y*W+x]=(c&255)*.2126+((c>>>8)&255)*.7152+((c>>>16)&255)*.0722;}}
 let motion=0;if(prev)for(let i=0;i<lum.length;i++)motion+=Math.abs(lum[i]-prev[i]);prev=lum;motion/=lum.length;
 const visualReady=now(),mask=motion>2?129:128,decisionReady=now();
 self.postMessage({mask,frameIndex:m.frameIndex,epoch:m.epoch,seq:m.seq,motion,received,visualReady,decisionReady});
};
