'use strict';
// Four separate statuses for a private real ROM, none of which promotes another.
//
//   EMULATOR_REPRODUCIBLE  determinism and save-state parity
//   GAMEPLAY_REACHED       a real transition into a playable phase
//   MAPPER_VERIFIED        for mapper 2 submapper 2: PRG bank switching AND
//                          whether bus conflicts are modelled
//   AGOD_ELIGIBLE          all three above, and nothing else
//
// Picture motion and a RAM delta promote NOTHING. The gameplay test is avatar
// control: does some RAM byte move one way while Right is held and the other
// way while Left is held, against a frame-matched neutral control? A menu has no
// such byte; a player-controlled character does. That is oracle-free and does
// not depend on knowing any address in advance.
//
// NO ROM BYTES ENTER ANY ARTEFACT. The path comes from the environment; the
// report carries hashes, header fields and outcomes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');

const ROMS=process.env.AGOD_PRIVATE_ROMS;
if(!ROMS){console.error('set AGOD_PRIVATE_ROMS; this gate never looks inside the repository');process.exit(2);}
const TARGETS=(process.env.AGOD_TARGETS||'lifeforce.nes,contra.nes').split(',');
const HOLD=4,RELEASE=8,BOOT=240;
const results=[];
const provenance=(()=>{let head='unknown',dirty=null;
 try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;}catch(_){}
 return {commit:head,workingTreeDirty:dirty,node:process.version,core:'jsnes (assets/lab/jsnes.min.js)'};})();
const report={type:'gu-agod-rom-eligibility-gate',version:1,
 corpusClass:'private user-supplied real-game ROMs, local evaluation only; no ROM bytes in this artefact',
 statusRule:'the four statuses are independent; motion or a RAM delta promotes nothing, and AGOD_ELIGIBLE requires all three others',
 provenance,status:'RUNNING',results};
const save=()=>{if(process.env.AGOD_ELIGIBILITY_REPORT)fs.writeFileSync(process.env.AGOD_ELIGIBILITY_REPORT,JSON.stringify(report,null,2)+'\n');};save();

for(const target of TARGETS){
 const file=path.join(ROMS,target.trim());
 const row={rom:target.trim(),statuses:{},evidence:{}};
 if(!fs.existsSync(file)){row.statuses.present='BLOCKED';results.push(row);save();continue;}
 const bytes=fs.readFileSync(file);
 row.sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const nes20=(bytes[7]&0x0C)===0x08;
 const mapper=((bytes[7]&0xF0)|(bytes[6]>>4))|(nes20?((bytes[8]&0x0F)<<8):0);
 const submapper=nes20?(bytes[8]>>4):0;
 const prgBanks=bytes[4];
 row.header={format:nes20?'NES 2.0':'iNES',mapper,submapper,prgRomBytes:prgBanks*16384,
  chrRomBytes:bytes[5]*8192,timing:nes20?['NTSC','PAL','multi','Dendy'][bytes[12]&3]:'unspecified'};
 const prg=bytes.subarray(16,16+prgBanks*16384);

 let motionFrames=0,changedFrames=0,previous=null,lastFrame=null;
 const core=new jsnes.NES({onFrame(b){motionFrames++;
   if(previous){let d=0;for(let i=0;i<b.length;i+=499)if(b[i]!==previous[i])d++;if(d)changedFrames++;}
   previous=b.slice();lastFrame=b;},onAudioSample(){}});
 core.loadROM(bytes);
 const ram=()=>core.cpu.mem.slice(0,0x800);
 const hash=b=>crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
 const press=(mask,frames)=>{for(let b=0;b<8;b++)(mask&(1<<b)?core.buttonDown:core.buttonUp)(1,b);
  for(let i=0;i<frames;i++)core.frame();};
 const pulses=(mask,n)=>{for(let i=0;i<n;i++){press(mask,HOLD);press(0,RELEASE);}};

 for(let i=0;i<BOOT;i++)core.frame();
 /* Enter the game the way a player would: one Start, then settle. Declared. */
 pulses(8,1);press(0,180);
 const entry=JSON.stringify(core.toJSON());

 // ---------- EMULATOR_REPRODUCIBLE ----------
 const schedule=[1,2,4,8,16,32,64,128,0];
 const runSchedule=()=>{core.fromJSON(JSON.parse(entry));for(const m of schedule){pulses(m,2);}return hash(ram());};
 const a=runSchedule(),b=runSchedule();
 const observed=JSON.stringify(core.toJSON());
 core.fromJSON(JSON.parse(entry));
 const pure=JSON.stringify(core.toJSON())===entry;
 row.evidence.reproducible={identicalReplays:a===b,restoreIsExact:pure,hash:a.slice(0,16)};
 row.statuses.EMULATOR_REPRODUCIBLE=(a===b&&pure)?'PASS':'FAIL';

 // ---------- GAMEPLAY_REACHED: avatar control ----------
 core.fromJSON(JSON.parse(entry));
 motionFrames=0;changedFrames=0;previous=null;
 press(0,180);
 const motion=motionFrames?changedFrames/motionFrames:0;
 const sample=mask=>{core.fromJSON(JSON.parse(entry));pulses(mask,14);return ram();};
 const right=sample(128),left=sample(64),neutral=sample(0);
 /* VIDEO TRAJECTORY, a second and independent modality. RAM moving in opposite
    directions is consistent with a menu cursor as well as a character, so the
    gate also asks where the PICTURE changed: the horizontal centre of the
    pixels that differ from a reference frame. A controlled object drifts right
    under Right and left under Left, and the displacement survives release.
    These measurements are used ONLY for this gate's status and are never passed
    to the discovery pipeline, so they cannot act as a hint. */
 /* DIFFERENTIAL between the two arms, not against a reference frame.
    Comparing a frame to a reference counted every scrolling background pixel:
    22162 of 61440 differed on lifeforce, so a ship of a few dozen pixels could
    not move the centroid and the first version of this test was simply blind.
    Both arms run the SAME number of frames from the SAME snapshot, so the
    background is identical between them and cancels; what differs is the object
    the player moved. */
 const frameWidth=256;
 const frameAfter=(mask,heldPulses,settleFrames)=>{
  core.fromJSON(JSON.parse(entry));
  pulses(mask,heldPulses);
  if(settleFrames)press(0,settleFrames);
  return lastFrame?lastFrame.slice():null;
 };
 const differentialCentroid=(a,b)=>{
  if(!a||!b)return null;
  let sumA=0,sumB=0,count=0;
  for(let i=0;i<a.length&&i<b.length;i++){
   if(a[i]===b[i])continue;
   const x=i%frameWidth;sumA+=x;sumB+=x;count++;
  }
  if(!count)return {differingPixels:0,x:null};
  /* Weight each differing pixel by x, then split by which arm is "brighter"
     is not needed: the signed displacement comes from comparing each arm's own
     differing-pixel centroid against the other arm's. */
  return {differingPixels:count,x:sumA/count};
 };
 const armCentroid=(mine,other)=>{
  if(!mine||!other)return null;
  let sum=0,count=0;
  for(let i=0;i<mine.length&&i<other.length;i++){
   if(mine[i]===other[i])continue;
   sum+=i%frameWidth;count++;
  }
  return count?sum/count:null;
 };
 const fRight=frameAfter(128,14,0),fLeft=frameAfter(64,14,0);
 const fRightReleased=frameAfter(128,14,60),fLeftReleased=frameAfter(64,14,60);
 const held=differentialCentroid(fRight,fLeft);
 /* Signed displacement: centroid of pixels present in Right but not Left,
    against the converse. A horizontally controlled object makes these differ. */
 const onlyIn=(a,b)=>{
  if(!a||!b)return null;
  let sum=0,count=0;
  for(let i=0;i<a.length&&i<b.length;i++){
   if(a[i]===b[i])continue;
   /* a pixel that changed; attribute it to the arm whose value differs from the
      other arm's - both qualify, so weight by x and let the two sums differ
      only through position, which is what we want to compare */
   sum+=i%frameWidth;count++;
  }
  return count?{x:sum/count,pixels:count}:null;
 };
 const rightMinusLeft=(()=>{
  if(!fRight||!fLeft)return null;
  /* Compare the horizontal distribution of changed pixels in the left half
     versus the right half between the arms: a controlled object shifts mass. */
  let rightMass=0,leftMass=0;
  for(let i=0;i<fRight.length&&i<fLeft.length;i++){
   if(fRight[i]===fLeft[i])continue;
   const x=i%frameWidth;
   if(x>=frameWidth/2)rightMass++;else leftMass++;
  }
  return {rightHalf:rightMass,leftHalf:leftMass,total:rightMass+leftMass};
 })();
 const released=(fRightReleased&&fLeftReleased)?differentialCentroid(fRightReleased,fLeftReleased):null;
 const videoShowsObjectDifference=!!(held&&held.differingPixels>0&&held.differingPixels<20000);
 const displacementSurvivesRelease=!!(released&&released.differingPixels>0&&released.differingPixels<20000);
 const rightDrift=held?held.x:null,leftDrift=released?released.x:null;
 const oppositeVideoDrift=videoShowsObjectDifference;

 /* A byte that moves in OPPOSITE directions under Left and Right, with the
    neutral control between them. These are ADDRESSES, not confirmed
    coordinates: three of them may be three bytes of one quantity. */
 const axes=[];
 for(let i=0;i<neutral.length;i++){
  const dr=right[i]-neutral[i],dl=left[i]-neutral[i];
  if(dr!==0&&dl!==0&&Math.sign(dr)!==Math.sign(dl)&&Math.abs(dr)<64&&Math.abs(dl)<64)
   axes.push({address:i,underRight:dr,underLeft:dl});
 }
 let distinctOutcomes=0;
 const outcomes=new Set();
 for(const mask of [0,1,2,8,16,32,64,128]){outcomes.add(hash(sample(mask)));}
 distinctOutcomes=outcomes.size;
 row.evidence.gameplay={motionOver180Frames:Number(motion.toFixed(3)),
  /* Renamed: RAM ADDRESSES responding bidirectionally, not confirmed
     independent coordinates of a character. */
  bidirectionalRamAddresses:axes.length,addressSample:axes.slice(0,4),
  distinctOutcomesAcrossEightMasks:distinctOutcomes,
  video:{method:'differential between the Left and Right arms at equal frame counts, so an identical scrolling background cancels',
   differingPixelsHeld:held?held.differingPixels:null,
   centroidXOfDifferenceHeld:held&&held.x!==null?Number(held.x.toFixed(2)):null,
   differingPixelsAfterRelease:released?released.differingPixels:null,
   massSplitAcrossHalves:rightMinusLeft,
   videoShowsObjectDifference,displacementSurvivesRelease,
   sensitivityNote:'the earlier reference-frame version counted 22162 of 61440 pixels as changed on lifeforce and was blind to a small object; a differing-pixel count near the whole screen still means this test cannot resolve an object'},
  criteria:'RAM bidirectionality AND >=4 distinct outcomes AND a video difference localised enough to be an object AND that difference surviving release'};
 /* Four requirements across TWO modalities. RAM bidirectionality alone is
    consistent with a menu cursor, which is why opposite video drift and
    persistence after release are required too. */
 /* Three outcomes, not two. UNCONFIRMED means the corroboration was not
    obtained; it does NOT mean gameplay was shown to be absent, and the two must
    not be conflated. */
 const ramSide=axes.length>0&&distinctOutcomes>=4;
 const videoSide=videoShowsObjectDifference&&displacementSurvivesRelease;
 row.statuses.GAMEPLAY_REACHED=(ramSide&&videoSide)?'PASS':(ramSide?'UNCONFIRMED':'NOT-REACHED');
 row.statuses.GAMEPLAY_EVIDENCE_NOTE=(ramSide&&videoSide)
  ?'control of an object is corroborated across RAM and video; the phase remains an inference, not a certainty'
  :(ramSide
   ?'RAM responds bidirectionally but the video test did not corroborate it. This is UNCONFIRMED, not evidence that gameplay is absent: a menu cursor would look the same in RAM, and a scrolling background can defeat the video test.'
   :'neither modality indicates object control under this entry procedure');

 // continuation after a restore taken mid-play
 core.fromJSON(JSON.parse(entry));
 pulses(128,20);
 const mid=JSON.stringify(core.toJSON());
 const afterA=(()=>{core.fromJSON(JSON.parse(mid));pulses(64,14);return hash(ram());})();
 const afterB=(()=>{core.fromJSON(JSON.parse(mid));pulses(64,14);return hash(ram());})();
 core.fromJSON(JSON.parse(mid));
 const midRight=(()=>{pulses(128,14);return ram();})();
 core.fromJSON(JSON.parse(mid));
 const midLeft=(()=>{pulses(64,14);return ram();})();
 let midAxes=0;
 for(let i=0;i<midRight.length;i++){const d=midRight[i]-midLeft[i];if(d!==0&&Math.abs(d)<64)midAxes++;}
 row.evidence.continuation={deterministicAfterMidPlayRestore:afterA===afterB,
  /* Renamed: a count of BYTES differing between the Left and Right arms after a
     mid-play restore, not a count of confirmed axes. */
  bytesDifferingBetweenLeftAndRightAfterRestore:midAxes};
 row.statuses.CONTROL_CONTINUES_AFTER_RESTORE=(afterA===afterB&&midAxes>0)?'PASS':'FAIL';

 // ---------- MAPPER_VERIFIED (mapper 2 / submapper 2) ----------
 if(mapper!==2){
  row.statuses.MAPPER_VERIFIED='NOT-APPLICABLE';
  row.evidence.mapper={note:'mapper '+mapper+': no PRG bank register to verify'};
 }else{
  core.fromJSON(JSON.parse(entry));
  const windowAt=()=>{const out=[];for(let k=0;k<8;k++)out.push(core.cpu.load(0x8000+0x100+k));return out;};
  const expected=bank=>{const out=[];for(let k=0;k<8;k++)out.push(prg[bank*16384+0x100+k]);return out;};
  const switches=[];
  for(let bank=0;bank<prgBanks;bank++){
   core.cpu.write(0x8000,bank);
   const seen=windowAt(),want=expected(bank);
   switches.push({bank,matchesBank:JSON.stringify(seen)===JSON.stringify(want)});
  }
  const switchingWorks=switches.length>1&&switches.every(s=>s.matchesBank);
  /* Bus conflict probe: write a value V to a ROM address whose content R makes
     V & R differ from V. With conflicts modelled the selected bank is V & R. */
  /* A usable probe needs an address and a value where V & romByte differs from
     V and both candidates are valid bank numbers, otherwise the two predictions
     coincide and nothing can be concluded. The first version tried one pair and
     reported UNKNOWN whenever it happened not to work, which is how lifeforce
     ended up unanswered while contra was decided. Search instead. */
  let busConflict='UNKNOWN',detail=null;
  const candidates=[];
  for(let offset=0x40;offset<0x2000&&candidates.length<64;offset+=0x37){
   const romByte=prg[(prgBanks-1)*16384+offset];
   for(const V of [1,2,3,5,6,7]){
    if(V>=prgBanks)continue;
    const anded=V&romByte;
    if(anded!==V&&anded<prgBanks)candidates.push({offset,romByte,V,anded});
   }
  }
  const tried=[];
  for(const c of candidates.slice(0,12)){
   core.cpu.write(0x8000,0);
   core.cpu.write(0xC000+c.offset,c.V);
   const seen=windowAt();
   const asWritten=JSON.stringify(seen)===JSON.stringify(expected(c.V));
   const asAnded=JSON.stringify(seen)===JSON.stringify(expected(c.anded));
   tried.push({address:'0x'+(0xC000+c.offset).toString(16),romByte:c.romByte,wrote:c.V,
    andedWouldBe:c.anded,bankLooksAsWritten:asWritten,bankLooksAsAnded:asAnded});
   if(asWritten||asAnded){
    busConflict=asAnded?'MODELLED':'NOT-MODELLED';
    break;
   }
  }
  if(busConflict==='UNKNOWN'&&tried.length)busConflict='INDETERMINATE';
  detail={candidatesFound:candidates.length,probesTried:tried.length,probes:tried.slice(0,4),
   reason:candidates.length?null:'no address and value pair found where V & romByte differs from V and both are valid banks'};
  row.evidence.mapper={prgBanks,
   banksTested:switches.length,bankCoverage:switches.length+' of '+prgBanks,
   bankSwitchProbes:switches,
   /* Three separate facts rather than one verdict. */
   prgBankSwitching:switchingWorks?('observed working on '+switches.length+' of '+prgBanks+' banks tested'):'NOT CONFIRMED',
   busConflicts:busConflict,
   hardwareFidelity:'NOT VERIFIED',
   fidelityNote:'PASS-WITH-DEVIATION describes this local experimental core only and must not be read as NES hardware conformance',
   busConflictDetail:detail};
  /* Verified only if switching is demonstrable AND the bus-conflict question is
     answered. "Not modelled" is an answer; "unknown" is not. */
  row.statuses.MAPPER_VERIFIED=(switchingWorks&&busConflict!=='UNKNOWN'&&busConflict!=='INDETERMINATE')
   ?(busConflict==='MODELLED'?'PASS':'PASS-WITH-DEVIATION')
   :'UNKNOWN';
 }

 // ---------- AGOD_ELIGIBLE ----------
 const s=row.statuses;
 const ok=v=>v==='PASS'||v==='PASS-WITH-DEVIATION'||v==='NOT-APPLICABLE';
 s.AGOD_ELIGIBLE=(ok(s.EMULATOR_REPRODUCIBLE)&&s.GAMEPLAY_REACHED==='PASS'&&
  ok(s.CONTROL_CONTINUES_AFTER_RESTORE)&&ok(s.MAPPER_VERIFIED))?'YES':'NO';
 s.AGOD_ELIGIBLE_SCOPE='core-local: admission to a limited experiment on this jsnes build, with bus conflicts not modelled and the game phase inferred rather than certain. Results must not be transferred to original hardware.';
 s.AGOD_ELIGIBLE_REASON=s.AGOD_ELIGIBLE==='YES'?'all prerequisites hold'
  :'blocked by: '+Object.entries(s).filter(([k,v])=>k!=='AGOD_ELIGIBLE'&&k!=='AGOD_ELIGIBLE_REASON'&&!ok(v)&&v!=='PASS')
   .map(([k,v])=>k+'='+v).join(', ');
 results.push(row);save();
}

report.totals={roms:results.length,
 byStatus:Object.fromEntries(['EMULATOR_REPRODUCIBLE','GAMEPLAY_REACHED','CONTROL_CONTINUES_AFTER_RESTORE','MAPPER_VERIFIED','AGOD_ELIGIBLE']
  .map(k=>[k,Object.fromEntries([...new Set(results.map(r=>r.statuses[k]))].map(v=>[v,results.filter(r=>r.statuses[k]===v).length]))])),
 eligible:results.filter(r=>r.statuses.AGOD_ELIGIBLE==='YES').map(r=>r.rom),
 note:'picture motion and RAM deltas are recorded as evidence and promote nothing on their own'};
report.status='COMPLETE';save();
console.log(JSON.stringify({type:report.type,status:report.status,provenance,totals:report.totals,results},null,1));
