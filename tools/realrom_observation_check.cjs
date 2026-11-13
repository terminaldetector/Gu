'use strict';
/* Synthetic checks for tools/realrom_observation.cjs (P1). No cartridge:
   frames are drawn here, so what each encoder should see is known.
   - legacy-16 is byte-for-byte the old retina;
   - a pure scroll of a textured background is (almost) no motion once the
     scroll is estimated and removed, and the scroll is reported;
   - a sprite moving over a static background lights up the cell it is in;
   - the same sprite over a SCROLLING background is still found;
   - frame size comes from the core, not from the buffer length;
   - fused-16: a missing position sensor is 0 with availability 0. */
const Obs=require('./realrom_observation.cjs');
const out=[],fail=[];const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const W=256,H=224;
function texture(x,y){/* a busy background: stripes and checks, deterministic */return ((((x>>3)^(y>>3))&1)?180:60)+((x*7+y*3)&15);}
function frame(offset,sprite){
 const p=new Uint32Array(W*H);
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const v=texture(x+offset,y)&255;p[y*W+x]=v|(v<<8)|(v<<16);}
 if(sprite)for(let y=sprite.y;y<sprite.y+16;y++)for(let x=sprite.x;x<sprite.x+16;x++)if(x>=0&&y>=0&&x<W&&y<H)p[y*W+x]=0xffffff;
 return p;
}
const core={pixels:null,videoWidth:W,videoHeight:H};
const show=p=>{core.pixels=p;};
/* legacy */
show(frame(0,null));
ok(JSON.stringify(Obs.create('legacy-16',core).observe())===JSON.stringify(Obs.legacyRetina(core)),'legacy-16 is the old retina, unchanged');
/* pure scroll */
{const enc=Obs.create('motion-16',core);show(frame(0,null));enc.observe();show(frame(8,null));const v=enc.observe();
 const s=enc.last().scroll;const total=v.reduce((a,b)=>a+b,0);
 console.log('pure scroll: estimated dx=%d dy=%d residual %s, motion sum %s',s.dx,s.dy,s.err.toFixed(4),total.toFixed(3));
 ok(s.dx===-2&&s.dy===0,'an 8-pixel scroll is estimated as 2 grid cells the right way (dx '+s.dx+')');
 ok(total<0.5,'and once removed the background is (almost) no motion: '+total.toFixed(3)+' over 16 cells');
 /* without the compensation the same pair is motion everywhere */
 const raw=Obs.motionMap(Obs.grid({pixels:frame(0,null),videoWidth:W,videoHeight:H}),Obs.grid(core),{dx:0,dy:0});
 const rawTotal=Obs.pool(raw,4,4).reduce((a,b)=>a+b,0);
 ok(rawTotal>4*total+1,'uncompensated, the scroll alone reads as motion '+rawTotal.toFixed(2)+' - why compensation is needed');}
/* sprite on a static background */
{const enc=Obs.create('motion-16',core);show(frame(0,{x:180,y:150}));enc.observe();show(frame(0,{x:188,y:150}));const v=enc.observe();
 const top=v.indexOf(Math.max(...v));
 console.log('sprite: strongest cell %d (%s), cells %j',top,v[top].toFixed(2),v.map(x=>+x.toFixed(2)));
 ok(top===Math.floor(150*4/H)*4+Math.floor(188*4/W),'a moving sprite lights up its own cell ('+top+')');}
/* sprite over a scrolling background */
{const enc=Obs.create('motion-16',core);show(frame(0,{x:60,y:40}));enc.observe();show(frame(8,{x:76,y:40}));const v=enc.observe();
 const top=v.indexOf(Math.max(...v));
 ok(top===Math.floor(40*4/H)*4+Math.floor(76*4/W),'the sprite is still found while the background scrolls (cell '+top+')');}
/* frame size from the core */
{const tall={pixels:new Uint32Array(320*240),videoWidth:320,videoHeight:240};
 ok(JSON.stringify(Obs.dims(tall))==='[320,240]','frame size comes from the core (320x240), not from the buffer length');
 ok(Obs.dims({pixels:new Uint32Array(100)})===null,'an unknown size is null, not a guess');}
/* fused: availability */
{const probe={axes:[{axis:'horizontal',integrators:2,fields:[5]},{axis:'vertical',integrators:0,fields:[]}]};
 const ram=new Uint8Array(64);ram[5]=128;ram[9]=3;
 const enc=Obs.create('fused-16',core,{probe,readRam:()=>ram,readResource:r=>r[9],initialResource:3});
 show(frame(0,null));const v=enc.observe();
 ok(v[0]===128/255&&v[2]===1,'fused: the probed horizontal position is read, availability 1');
 ok(v[1]===0&&v[3]===0,'fused: no vertical sensor - value 0 AND availability 0');
 ok(v[4]===1,'fused: the verified resource, normalised (3 of 3)');
 ok(v.every(x=>x>=0&&x<=1)&&v.length===16,'sixteen values, all in [0,1]');}
console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length)process.exitCode=1;
