'use strict';
/* Track A/C data: Frame(t) -> Action(t) -> Frame(t+1) sequences from the real GU cores
   (jsnes, Snes9x, Genesis Plus GX through the AGOD platform driver), played by a
   seeded exploratory behaviour policy. Research tool, host only.

   PRIVATE OUTPUT. Frames of a commercial cartridge are its content: everything is
   written to the directory given on the command line (scratch), never to the
   repository. The metadata carries the ROM's SHA-256 and sizes, not its bytes.

   Per frame t:   action mask applied on frame t (u16), phase (0 entry, 1 play),
                  a 64x48 luminance grid of frame t (u8) for the fast motion path.
   Every K frames: the full RGB frame (u8, H x W x 3) for the slow visual path.
   No RAM is recorded and no oracle is read: the policy sees only a screen-change
   statistic (to tap Start on a frozen screen), the same thing a player sees.

   usage: node record_play.cjs --platform nes|snes|sega --rom FILE --out DIR/name
          [--frames 9000] [--every 6] [--seed 1] [--entry 900] */
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const A=path.resolve(__dirname,'../../app/src/main/assets/lab');
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:d;};
const platform=arg('platform'),romPath=arg('rom'),out=arg('out');
const FRAMES=+arg('frames',9000),EVERY=+arg('every',6),SEED=+arg('seed',1),ENTRY=+arg('entry',900);
if(!platform||!romPath||!out){console.error('usage: --platform nes|snes|sega --rom FILE --out DIR/name');process.exit(2);}
const GW=64,GH=48;

function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}

async function build(bytes){
 globalThis.FlyPlatforms=require(path.join(A,'platforms.js'));
 const PD=require(path.join(A,'agod-platform-driver.js'));
 if(platform==='nes'){
  const jsnes=require(path.join(A,'jsnes.min.js'));
  const r=PD.createNesSync({romBytes:bytes,jsnes});
  return {r,frame:()=>({px:r.core.ppu.buffer,w:256,h:240})};
 }
 let r;
 if(platform==='sega')r=await PD.create({platform,romBytes:bytes,SegaConsole:require(path.join(A,'sega-core.js')),
  factory:require(path.join(A,'sega','genplus.js')),moduleOptions:{locateFile:f=>path.join(A,'sega',f)}});
 else r=await PD.create({platform,romBytes:bytes,RetroConsole:require(path.join(A,'retro-core.js')),factory:require(path.join(A,platform,'core.js')),
  moduleOptions:{wasmBinary:fs.readFileSync(path.join(A,platform,'core.wasm')),locateFile:f=>path.join(A,platform,f)}});
 if(r.status!=='READY')throw Error(platform+' core: '+r.status+' '+(r.reason||''));
 const dims=()=>platform==='sega'?[r.core.g._lab_video_width(),r.core.g._lab_video_height()]:[r.core.videoWidth,r.core.videoHeight];
 return {r,frame:()=>{const [w,h]=dims();return {px:r.core.pixels,w,h};}};
}

/* the behaviour policy: buttons by bit (A=0,B=1,third=2,Start=3,U=4,D=5,L=6,R=7) */
function policy(random){
 const third=platform==='nes'?0:1;// Select on NES is not a play button
 const dirs=[0,128,128,64,16,32,128|16,128|32,64|16,64|32];// none, R x2, L, U, D, diagonals
 let mask=0,left=0;
 return {next(t,frozen){
  if(t<ENTRY){const k=t%60;return (k<4?8:(k>=30&&k<34?1:0));}// title screens: Start, then A
  if(frozen){left=0;return (t%40)<4?8:0;}// a frozen screen (game over, pause): tap Start
  if(left<=0){
   mask=dirs[Math.floor(random()*dirs.length)];
   if(random()<0.45)mask|=1;if(random()<0.35)mask|=2;if(third&&random()<0.2)mask|=4;
   left=1+Math.floor(-Math.log(1-random())*8);// geometric holds, mean ~8 frames
   if(left>40)left=40;
  }
  left--;return mask;}};
}

(async()=>{
 const bytes=fs.readFileSync(romPath),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const {r,frame}=await build(new Uint8Array(bytes));
 const random=rng(SEED),pol=policy(random);
 const actions=new Uint16Array(FRAMES),phase=new Uint8Array(FRAMES),lum=new Uint8Array(FRAMES*GW*GH);
 /* keyframes at the platform's play resolution; a boot screen of another size is resampled and counted */
 const [W,H]={nes:[256,240],snes:[256,224],sega:[320,224]}[platform];
 const keyframes=[];let resized=0,prevGrid=null,still=0;
 for(let t=0;t<FRAMES;t++){
  const mask=pol.next(t,still>300);
  actions[t]=mask;phase[t]=t<ENTRY?0:1;
  r.driver.run(mask,1,0);
  let {px,w,h}=frame();
  const g=lum.subarray(t*GW*GH,(t+1)*GW*GH);
  for(let y=0;y<GH;y++)for(let x=0;x<GW;x++){const c=px[Math.floor((y+.5)*h/GH)*w+Math.floor((x+.5)*w/GW)];
   g[y*GW+x]=Math.round(.2126*(c&255)+.7152*((c>>>8)&255)+.0722*((c>>>16)&255));}
  if(prevGrid){let d=0;for(let i=0;i<g.length;i++)d+=Math.abs(g[i]-prevGrid[i]);still=d/g.length<0.5?still+1:0;}
  prevGrid=g;
  if(t%EVERY===0){
   if(w!==W||h!==H)resized++;
   const rgb=Buffer.alloc(W*H*3);
   for(let y=0;y<H;y++)for(let x=0;x<W;x++){const c=px[(w===W&&h===H)?y*w+x:Math.floor(y*h/H)*w+Math.floor(x*w/W)],o=(y*W+x)*3;rgb[o]=c&255;rgb[o+1]=(c>>>8)&255;rgb[o+2]=(c>>>16)&255;}
   keyframes.push(rgb);
  }
 }
 fs.mkdirSync(path.dirname(out),{recursive:true});
 fs.writeFileSync(out+'.actions.u16',Buffer.from(actions.buffer));
 fs.writeFileSync(out+'.phase.u8',Buffer.from(phase.buffer));
 fs.writeFileSync(out+'.lum.u8.z',zlib.deflateSync(Buffer.from(lum.buffer),{level:6}));
 fs.writeFileSync(out+'.rgb.u8.z',zlib.deflateSync(Buffer.concat(keyframes),{level:6}));
 const meta={type:'gu-play-record',schema:1,private:true,platform,romSha256:sha,romBytes:bytes.length,coreName:r.coreName,coreRevision:r.coreRevision,
  frames:FRAMES,every:EVERY,keyframes:keyframes.length,width:W,height:H,lumGrid:[GH,GW],resizedKeyframes:resized,seed:SEED,entryFrames:ENTRY,
  policy:'seeded exploratory: geometric holds (mean 8), directions + A/B(+third on SNES/Sega); Start only on title screens and frozen screens',
  buttons:['A','B','third','Start','Up','Down','Left','Right']};
 fs.writeFileSync(out+'.meta.json',JSON.stringify(meta,null,1));
 console.log(JSON.stringify({out:path.basename(out),platform,frames:FRAMES,keyframes:keyframes.length,size:[W,H],resized}));
})().catch(e=>{console.error(e);process.exit(1);});
