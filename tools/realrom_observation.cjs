'use strict';
/* Observation encoders for the real-ROM learning harness (research, P1).
   Sixteen values in [0,1] - the size of the learner's input layer - so the
   encoder is the only thing that changes between arms of an A/B.

   legacy-16  the existing 4x4 mean luminance (control, byte-for-byte the old
              retina, including its width guess).
   motion-16  4x4 cells of frame CHANGE since the previous decision, after the
              global scroll between the two frames is estimated and removed:
              a scrolling background is not motion, a sprite crossing it is.
   fused-16   slots with a fixed meaning: controlled position (only from fields
              the phase probe proved causal), the verified resource, time since
              the last loss, the scroll estimate, and 8 cells of compensated
              motion. A sensor that does not exist is 0 AND its availability
              slot is 0 - absence is explicit, never a guessed value.

   Frame size comes from the core (videoWidth/videoHeight, or the Sega core's
   own accessors), not from the buffer length. Nothing here reads an oracle or
   a hand-picked address: positions come from the causal probe, the resource
   from the verified objective. */

const ENCODER_REVISION='realrom-obs-r1';
const GW=64,GH=48;              /* luminance grid the motion features use */
const SHIFT_X=4,SHIFT_Y=2;      /* scroll search, in grid cells, per decision */

function legacyRetina(core){
 const p=core.pixels||(core.ppu&&null);const v=new Array(16).fill(0),n=new Array(16).fill(0);
 if(!p)return v;
 const w=p.length>=320*224?320:256,h=Math.floor(p.length/w);
 for(let y=0;y<h;y+=4)for(let x=0;x<w;x+=4){const c=p[y*w+x];const i=Math.min(3,Math.floor(y*4/h))*4+Math.min(3,Math.floor(x*4/w));
  v[i]+=(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255))/255;n[i]++;}
 return v.map((s,i)=>n[i]?s/n[i]:0);
}

function dims(core){
 if(Number.isInteger(core.videoWidth)&&Number.isInteger(core.videoHeight)&&core.videoWidth>0&&core.videoHeight>0)
  return [core.videoWidth,core.videoHeight];
 const g=core.g;
 if(g&&typeof g._lab_video_width==='function'){const w=g._lab_video_width(),h=g._lab_video_height();if(w>0&&h>0)return [w,h];}
 return null;
}

/* GW x GH mean luminance; null when the core has no frame or the size is not known */
function grid(core){
 const p=core.pixels,d=dims(core);
 if(!p||!d)return null;
 const [w,h]=d;if(p.length<w*h)return null;
 const out=new Float32Array(GW*GH);
 for(let gy=0;gy<GH;gy++){const y0=Math.floor(gy*h/GH),y1=Math.max(y0+1,Math.floor((gy+1)*h/GH));
  for(let gx=0;gx<GW;gx++){const x0=Math.floor(gx*w/GW),x1=Math.max(x0+1,Math.floor((gx+1)*w/GW));
   let s=0,n=0;
   for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const c=p[y*w+x];s+=.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255);n++;}
   out[gy*GW+gx]=n?s/n/255:0;}}
 return out;
}

/* the global shift (dx,dy) that best maps prev onto cur, and the residual */
function scroll(prev,cur){
 let best={dx:0,dy:0,err:Infinity};
 for(let dy=-SHIFT_Y;dy<=SHIFT_Y;dy++)for(let dx=-SHIFT_X;dx<=SHIFT_X;dx++){
  let e=0,n=0;
  for(let y=Math.max(0,dy);y<GH+Math.min(0,dy);y++)for(let x=Math.max(0,dx);x<GW+Math.min(0,dx);x++){
   e+=Math.abs(cur[y*GW+x]-prev[(y-dy)*GW+(x-dx)]);n++;}
  e/=n||1;
  /* ties go to the smaller shift: a static screen is not a scroll */
  if(e<best.err-1e-9||(Math.abs(e-best.err)<=1e-9&&Math.abs(dx)+Math.abs(dy)<Math.abs(best.dx)+Math.abs(best.dy)))best={dx,dy,err:e};
 }
 return best;
}

/* compensated motion per grid cell (0 where the shifted previous frame has no data) */
function motionMap(prev,cur,s){
 const m=new Float32Array(GW*GH);
 for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){
  const px=x-s.dx,py=y-s.dy;
  if(px<0||py<0||px>=GW||py>=GH)continue;
  m[y*GW+x]=Math.abs(cur[y*GW+x]-prev[py*GW+px]);}
 return m;
}
const squash=v=>Math.min(1,Math.sqrt(Math.max(0,v)*4));
function pool(m,cols,rows){
 const out=new Array(cols*rows).fill(0),n=new Array(cols*rows).fill(0);
 for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const i=Math.min(rows-1,Math.floor(y*rows/GH))*cols+Math.min(cols-1,Math.floor(x*cols/GW));out[i]+=m[y*GW+x];n[i]++;}
 return out.map((s,i)=>squash(n[i]?s/n[i]:0));
}

/* options: {probe, readResource(ram)->number|null, initialResource, readRam()} */
function create(kind,core,options){
 const o=options||{};
 if(kind==='legacy-16'||!kind)return {kind:'legacy-16',revision:ENCODER_REVISION+'/legacy-16',observe:()=>legacyRetina(core),reset(){},last:()=>null};
 if(kind!=='motion-16'&&kind!=='fused-16')throw Error('unknown observation encoder '+kind);
 let prev=null,lastScroll={dx:0,dy:0,err:0},stepsSinceLoss=0,lastResource=null;
 /* positions: the first causal field of each axis the probe proved */
 const axes=(o.probe&&o.probe.axes)||[];
 const field=name=>{const a=axes.find(x=>x.axis===name&&x.integrators>0&&x.fields&&x.fields.length);return a?a.fields[0]:null;};
 const xField=field('horizontal'),yField=field('vertical');
 function observe(){
  const cur=grid(core);
  let m=null;
  if(cur&&prev){lastScroll=scroll(prev,cur);m=motionMap(prev,cur,lastScroll);}
  prev=cur;
  if(kind==='motion-16')return m?pool(m,4,4):new Array(16).fill(0);
  /* fused-16 */
  const ram=o.readRam?o.readRam():null;
  const v=new Array(16).fill(0);
  if(ram&&xField!==null){v[0]=ram[xField]/255;v[2]=1;}
  if(ram&&yField!==null){v[1]=ram[yField]/255;v[3]=1;}
  if(ram&&o.readResource){const r=o.readResource(ram);
   if(Number.isFinite(r)&&o.initialResource>0){v[4]=Math.max(0,Math.min(1,r/o.initialResource));
    if(lastResource!==null&&r<lastResource)stepsSinceLoss=0;lastResource=r;}}
  v[5]=Math.min(1,stepsSinceLoss/75);stepsSinceLoss++;   /* 75 decisions = 10 s */
  v[6]=.5+lastScroll.dx/(2*SHIFT_X);v[7]=.5+lastScroll.dy/(2*SHIFT_Y);
  if(m){const cells=pool(m,4,2);for(let i=0;i<8;i++)v[8+i]=cells[i];}
  return v;
 }
 return {kind,revision:ENCODER_REVISION+'/'+kind,observe,
  reset(){prev=null;lastScroll={dx:0,dy:0,err:0};stepsSinceLoss=0;lastResource=null;},
  last:()=>({scroll:lastScroll,xField:xField!==null,yField:yField!==null})};
}

module.exports={ENCODER_REVISION,create,legacyRetina,grid,scroll,motionMap,pool,dims,GW,GH};
