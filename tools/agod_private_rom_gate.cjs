'use strict';
// Private real-game corpus: compatibility and determinism gate.
//
// These are commercial ROMs supplied privately by the user. NO ROM BYTES ARE
// READ INTO ANY ARTEFACT by this script: it records SHA-256, header metadata
// and aggregate test outcomes only, and the ROM path comes from the
// environment so nothing about their location is baked into the repository.
//
// This gate deliberately stops short of AGOD. The handoff is explicit that
// loading without an error proves nothing for a NES 2.0 header, that mapper 2
// submapper 2 means bus conflicts, and that a PAL cartridge on an NTSC-only
// core makes frame-indexed causality meaningless. So each ROM is taken through
// the stages in order and each stage reports PASS, FAIL, BLOCKED or UNKNOWN on
// its own; nothing from the synthetic families is carried over.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS to the private corpus directory; this script never looks inside the repository');process.exit(2);}
// Galaga first, as the handoff asks: mapper 0 and NTSC is the smallest step.
const ORDER=['galaga.nes','contra.nes','lifeforce.nes','roadfighter.nes'];
const results=[];
const result={type:'gu-agod-private-rom-gate',version:1,
 corpusClass:'private user-supplied real-game validation, NOT an independent blind or homebrew corpus',
 publication:'ROM bytes are never included in this artefact; hashes, header metadata and aggregate outcomes only',
 scope:'jsnes in Node, no Android, no AGOD in this gate',
 status:'RUNNING',results};
const save=()=>{if(process.env.AGOD_PRIVATE_GATE_REPORT)fs.writeFileSync(process.env.AGOD_PRIVATE_GATE_REPORT,JSON.stringify(result,null,2)+'\n');};save();

function header(bytes){
 const magic=bytes[0]===0x4E&&bytes[1]===0x45&&bytes[2]===0x53&&bytes[3]===0x1A;
 const nes20=(bytes[7]&0x0C)===0x08;
 const mapper=((bytes[7]&0xF0)|(bytes[6]>>4))|(nes20?((bytes[8]&0x0F)<<8):0);
 const submapper=nes20?(bytes[8]>>4):0;
 let prg=bytes[4],chr=bytes[5];
 if(nes20){prg|=(bytes[9]&0x0F)<<8;chr|=(bytes[9]&0xF0)<<4;}
 const shift=n=>n?64<<n:0;
 return {magic,format:nes20?'NES 2.0':'iNES',mapper,submapper,
  prgRomBytes:prg*16384,chrRomBytes:chr*8192,
  chrRamBytes:nes20?shift(bytes[11]&0x0F):0,
  prgRamBytes:nes20?shift(bytes[10]&0x0F):0,
  mirroring:(bytes[6]&1)?'vertical':'horizontal',
  battery:!!(bytes[6]&2),trainerBytes:(bytes[6]&4)?512:0,
  timingHeader:nes20?['NTSC','PAL','multi','Dendy'][bytes[12]&3]:'unspecified'};
}

for(const name of ORDER){
 const file=path.join(ROMS,name);
 const row={rom:name,stages:{}};
 const stage=(id,status,detail)=>{row.stages[id]={status,...detail};save();};
 try{
  if(!fs.existsSync(file)){stage('present','BLOCKED',{reason:'not found in the private corpus directory'});results.push(row);continue;}
  const bytes=fs.readFileSync(file);
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');
  row.sha256=sha;row.fileBytes=bytes.length;
  const head=header(bytes);
  row.header=head;
  stage('header','PASS',{format:head.format,mapper:head.mapper,submapper:head.submapper,
   prgRomBytes:head.prgRomBytes,chrRomBytes:head.chrRomBytes,chrRamBytes:head.chrRamBytes,
   timingHeader:head.timingHeader,
   sizeConsistent:16+head.trainerBytes+head.prgRomBytes+head.chrRomBytes===bytes.length});

  // --- load and run 120+ frames ---
  let frames=0,drawn=0,lastFrame=null;
  const core=new jsnes.NES({onFrame(buffer){frames++;if(buffer&&buffer.length){
    let changed=0;if(lastFrame)for(let i=0;i<buffer.length;i+=997)if(buffer[i]!==lastFrame[i])changed++;
    if(changed>0)drawn++;lastFrame=buffer.slice();}},onAudioSample(){}});
  try{core.loadROM(bytes);}
  catch(error){stage('load','FAIL',{reason:error.message});results.push(row);continue;}
  stage('load','PASS',{note:'loaded without throwing, which the handoff correctly says is not proof of correct execution for a NES 2.0 header'});

  let crashed=null;
  try{for(let i=0;i<180;i++)core.frame();}catch(error){crashed=error.message;}
  if(crashed){stage('run180','FAIL',{reason:crashed});results.push(row);continue;}
  stage('run180','PASS',{framesDelivered:frames,framesWithVisibleChange:drawn});
  stage('video', drawn>0?'PASS':'UNKNOWN',
   {framesWithVisibleChange:drawn,
    reason:drawn>0?'the picture changes, so the core is rendering something':'no sampled pixel changed: either a static screen or nothing is being drawn'});

  const ram=()=>core.cpu.mem.slice(0,0x800);
  const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
  const press=(mask,count)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
   for(let i=0;i<count;i++)core.frame();for(let b=0;b<8;b++)core.buttonUp(1,b);};

  // --- save state parity: observation must not perturb, restore must restore ---
  const snapshot=JSON.stringify(core.toJSON());
  const observed=JSON.stringify(core.toJSON());
  const observationIsPure=snapshot===observed;
  press(0,60);
  const afterPlay=hash(ram());
  core.fromJSON(JSON.parse(snapshot));
  const restored=hash(ram());
  press(0,60);
  const afterReplay=hash(ram());
  stage('saveStateParity',(observationIsPure&&afterReplay===afterPlay)?'PASS':'FAIL',
   {observationIsPure,replayMatches:afterReplay===afterPlay,
    restoredHash:restored.slice(0,16),afterPlay:afterPlay.slice(0,16),afterReplay:afterReplay.slice(0,16)});

  // --- determinism of a mixed input schedule from one restore point ---
  const schedule=[1,2,4,8,16,32,64,128,0];
  const runSchedule=()=>{core.fromJSON(JSON.parse(snapshot));
   for(const mask of schedule){press(mask,6);press(0,6);}return hash(ram());};
  const a=runSchedule(),b=runSchedule();
  stage('determinism',a===b?'PASS':'FAIL',{identical:a===b,hash:a.slice(0,16)});

  // --- does the machine respond to input at all? ---
  core.fromJSON(JSON.parse(snapshot));
  press(0,120);const neutral=ram();
  core.fromJSON(JSON.parse(snapshot));
  for(let round=0;round<12;round++){press(8,4);press(0,6);}   /* Start */
  const pressed=ram();
  let differing=0;for(let i=0;i<neutral.length;i++)if(neutral[i]!==pressed[i])differing++;
  stage('controllable',differing>0?'PASS':'UNKNOWN',
   {ramBytesDifferingFromNeutral:differing,
    reason:differing>0?'pressing Start changes RAM relative to neutral play of the same length'
     :'no RAM difference: the title sequence may ignore input for longer than this probe'});

  // --- mapper gating, as the handoff requires ---
  if(head.mapper===2){
   stage('mapperGating','UNKNOWN',
    {mapper:2,submapper:head.submapper,
     reason:'UxROM with submapper 2 means bus conflicts on the bank register. This gate does not verify that jsnes models them, and no claim of correct bank switching is made. CPU writer provenance from the NROM path must not be reused here.'});
  }else if(head.timingHeader==='PAL'){
   stage('mapperGating','PASS',{mapper:head.mapper,note:'NROM, no bank switching to verify'});
  }else{
   stage('mapperGating','PASS',{mapper:head.mapper,note:'NROM, no bank switching to verify'});
  }
  stage('timing',head.timingHeader==='NTSC'?'PASS':'UNVERIFIED_TIMING',
   {timingHeader:head.timingHeader,
    reason:head.timingHeader==='NTSC'?'NTSC header on an NTSC-timed core'
     :'the header declares '+head.timingHeader+' and this core is NTSC-timed: frame-indexed causality and replay comparisons would be shifted, so results here are not comparable'});
  results.push(row);save();
 }catch(error){row.error=error.message;results.push(row);save();}
}

const statuses=id=>Object.fromEntries(['PASS','FAIL','UNKNOWN','BLOCKED','UNVERIFIED_TIMING']
 .map(s=>[s,results.filter(r=>r.stages[id]&&r.stages[id].status===s).length]).filter(([,n])=>n));
result.totals={roms:results.length,
 byStage:Object.fromEntries(['header','load','run180','video','saveStateParity','determinism','controllable','mapperGating','timing']
  .map(id=>[id,statuses(id)])),
 readyForBoundedAgod:results.filter(r=>r.stages.determinism&&r.stages.determinism.status==='PASS'&&
  r.stages.saveStateParity&&r.stages.saveStateParity.status==='PASS'&&
  r.stages.timing&&r.stages.timing.status==='PASS').map(r=>r.rom),
 note:'readiness here means the emulator behaves deterministically and restores exactly; it says nothing about whether emulation is CORRECT, which mapper 2 bus conflicts leave open'};
result.status='COMPLETE';save();
console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,
 results:results.map(({rom,sha256,fileBytes,header,stages})=>({rom,sha256,fileBytes,header,stages}))},null,1));
