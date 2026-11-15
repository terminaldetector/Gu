'use strict';
/* The synthetic survival game shared by AGOD checks (moved verbatim from
   agod_survival_check.cjs): pure JS, deterministic, snapshot/restore by value,
   256 bytes of RAM - title, cursor menu, play with homing enemies, health, a
   two-byte score, and the distractors that fooled early versions on real ROMs
   (a clock, a post-death fade, a pad-perturbed RNG). R is the ORACLE layout: a
   check may consult it only after discovery has answered.
   withCore(game) adds what the research mechanisms need from an emulator core:
   a frame (64x48 RGBA-in-uint32, drawn from the player and enemy positions),
   videoWidth/videoHeight, and the built-object shape {status, driver, core,
   capabilities, framesRun, dispose}. */
const R={MODE:0,CURSOR:1,X:2,Y:3,HEALTH:4,STUN:5,SCORE_HI:6,SCORE_LO:7,CLOCK:8,FADE:9,RNG:10,TIMER:11,
 DEAD:12,ENEMY:16};/* enemies: 4 x (x,y,alive) from 16 */
const BUTTONS=['A','B','C','Start','↑','↓','←','→'];
function game(options){
 const startHealth=(options&&options.health)||5,invulnerable=(options&&options.invulnerable)||0;
 let ram=new Uint8Array(256);
 const boot=()=>{ram.fill(0);ram[R.MODE]=0;for(let i=32;i<256;i++)ram[i]=(i*37)&255;};
 boot();
 const startPlay=()=>{
  ram[R.MODE]=2;ram[R.X]=120;ram[R.Y]=180;ram[R.HEALTH]=startHealth;ram[R.STUN]=0;ram[R.SCORE_HI]=0;ram[R.SCORE_LO]=0;
  ram[R.CLOCK]=200;ram[R.FADE]=4;ram[R.TIMER]=0;ram[R.DEAD]=0;
  for(let e=0;e<4;e++){ram[R.ENEMY+e*3]=30+e*60;ram[R.ENEMY+e*3+1]=10+e*7;ram[R.ENEMY+e*3+2]=1;}
  for(let i=32;i<256;i++)ram[i]=0;
 };
 let last=0;
 function frame(mask){
  const pressed=mask&~last;last=mask;
  ram[R.RNG]=(ram[R.RNG]*5+1+(mask&0xf0?3:0))&255;
  const mode=ram[R.MODE];
  if(mode===0){if(pressed&8){ram[R.MODE]=1;ram[R.CURSOR]=0;for(let i=32;i<256;i++)ram[i]=(ram[i]+i+1)&255;}return;}
  if(mode===1){if(pressed&64)ram[R.CURSOR]=(ram[R.CURSOR]+3)&3;if(pressed&128)ram[R.CURSOR]=(ram[R.CURSOR]+1)&3;
   if(pressed&1)startPlay();return;}
  if(mode===3){/* game over */
   if(ram[R.FADE]>0&&(ram[R.TIMER]++&7)===7)ram[R.FADE]--;
   if(pressed&8){boot();}return;}
  /* play */
  ram[R.TIMER]=(ram[R.TIMER]+1)&255;
  if((ram[R.TIMER]&63)===0&&ram[R.CLOCK]>0)ram[R.CLOCK]--;
  if(ram[13]>0)ram[13]--;   /* invulnerability after a hit, as real games have */
  if(ram[R.STUN]>0)ram[R.STUN]--;
  else{
   if(mask&64)ram[R.X]=Math.max(8,ram[R.X]-2);if(mask&128)ram[R.X]=Math.min(232,ram[R.X]+2);
   if(mask&16)ram[R.Y]=Math.max(8,ram[R.Y]-2);if(mask&32)ram[R.Y]=Math.min(216,ram[R.Y]+2);
   if(pressed&1)for(let e=0;e<4;e++){const b=R.ENEMY+e*3;
    if(ram[b+2]&&Math.abs(ram[b]-ram[R.X])<40&&ram[b+1]<ram[R.Y]){ram[b+2]=0;
     const lo=ram[R.SCORE_LO]+30;if(lo>255)ram[R.SCORE_HI]++;ram[R.SCORE_LO]=lo&255;}}
  }
  /* the sprite mirror and the camera, as a real game keeps them: moving the
     player rewrites several bytes, not one */
  ram[64]=ram[R.X];ram[65]=ram[R.Y];ram[66]=(mask&0xf0)?1+(ram[R.TIMER]>>3&3):0;ram[67]=ram[R.X]>>1;ram[68]=ram[R.Y]>>1;
  for(let e=0;e<4;e++){const b=R.ENEMY+e*3;
   if(!ram[b+2]){if(((ram[R.TIMER]+e*41)&127)===0){ram[b+2]=1;ram[b]=(ram[R.TIMER]*7+e*60)&255;ram[b+1]=8;}continue;}
   if((ram[R.TIMER]+e)%2===0){ram[b]+=Math.sign(ram[R.X]-ram[b]);ram[b+1]+=Math.sign(ram[R.Y]-ram[b+1]);}
   if(ram[R.STUN]===0&&ram[13]===0&&Math.abs(ram[b]-ram[R.X])<6&&Math.abs(ram[b+1]-ram[R.Y])<6){
    ram[R.HEALTH]--;ram[R.STUN]=24;ram[13]=invulnerable;ram[b+1]=8;
    if(ram[R.HEALTH]===0){ram[R.MODE]=3;ram[R.DEAD]=1;ram[R.TIMER]=0;}
   }
  }
 }
 const driver={
  actionSpec:{buttonCount:8,buttons:BUTTONS.map((name,index)=>({index,name,mask:1<<index})),
   singleButtonMasks:BUTTONS.map((_,i)=>1<<i)},
  observedRamBytes:256,ports:1,
  run(mask,frames,mask2){if(mask2)throw new Error('one port');for(let i=0;i<frames;i++)frame(mask);},
  readRam:()=>ram.slice(),
  snapshot:()=>({ram:ram.slice(),last}),
  restore(s){ram=s.ram.slice();last=s.last;},
  stateHash(){let h=0x811c9dc5;for(const b of ram)h=Math.imul(h^b,0x01000193)>>>0;return h.toString(16);}};
 return driver;
}
function withCore(options){
 const driver=game(options);const W=64,H=48;const pixels=new Uint32Array(W*H);let frames=0;
 const run=driver.run.bind(driver);
 const draw=()=>{const ram=driver.readRam();pixels.fill(0xff202020);
  const dot=(x,y,c)=>{const px=Math.min(W-1,Math.max(0,x>>2)),py=Math.min(H-1,Math.max(0,y*H/224|0));pixels[py*W+px]=c;};
  if(ram[R.MODE]===2){dot(ram[R.X],ram[R.Y],0xff00ff00);for(let e=0;e<4;e++){const b=R.ENEMY+e*3;if(ram[b+2])dot(ram[b],ram[b+1],0xff0000ff);}}
  else pixels.fill(ram[R.MODE]===3?0xff000080:0xff404040);};
 driver.run=(mask,n,mask2)=>{run(mask,n,mask2);frames+=n;draw();};
 const restore=driver.restore.bind(driver);driver.restore=s=>{restore(s);draw();};
 draw();
 const core={pixels,videoWidth:W,videoHeight:H};
 return {status:'READY',platform:'synthetic',driver,core,capabilities:{actionSpec:driver.actionSpec,padType:null,observedRamBytes:256},
  framesRun:()=>frames,dispose(){}};
}
module.exports={R,BUTTONS,game,withCore};
