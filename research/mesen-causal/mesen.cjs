'use strict';
// The external instrument, addressed only by argv and JSON Lines.
//
// Shared by every stage-B tool so there is ONE wrapper rather than a copy per
// experiment - the same reason the S11B host was consolidated in R2. No GPL
// source is copied here: this file only builds argument lists and parses the
// instrument's JSON output.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');

const GU=path.resolve(__dirname,'..','..');
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');

function instrument(options){
 const opts=options||{};
 const binary=opts.binary||process.env.MESEN_AGENT;
 if(!binary||!fs.existsSync(binary))throw new Error('set MESEN_AGENT to the built mesen-agent binary');
 const work=opts.work||fs.mkdtempSync(path.join(os.tmpdir(),'gu-mesen-'));
 const home=path.join(work,'mesen-home');
 if(!fs.existsSync(home))fs.mkdirSync(home,{recursive:true});
 let invocations=0,wallClockMs=0;
 const run=(args,callOpts)=>{
  const started=Date.now();invocations++;
  let stdout='',stderr='',status=0;
  try{
   stdout=execFileSync(binary,[...args,'--home',home],
    {encoding:'utf8',timeout:(callOpts&&callOpts.timeoutMs)||300000,
     maxBuffer:256*1024*1024,stdio:['ignore','pipe','pipe']});
  }catch(problem){
   status=problem.status===undefined?-1:problem.status;
   stdout=problem.stdout?problem.stdout.toString():'';
   stderr=problem.stderr?problem.stderr.toString():'';
  }
  const elapsed=Date.now()-started;wallClockMs+=elapsed;
  const records=stdout.split('\n').filter(Boolean).map(line=>{
   try{return JSON.parse(line);}catch(_){return {event:'UNPARSEABLE',line};}});
  return {records,status,stderr,elapsedMs:elapsed,
   first:e=>records.find(r=>r.event===e)||null,
   all:e=>records.filter(r=>r.event===e),
   summary:()=>records.find(r=>r.event==='summary')||null,
   luaLog:()=>records.filter(r=>r.event==='lua_log'||r.event==='lua_error')};
 };
 return {binary,work,home,run,
  binarySha256:sha256(fs.readFileSync(binary)),
  cost:()=>({instrumentInvocations:invocations,instrumentWallClockMs:wallClockMs}),
  /* memory spaces, parsed from the one-record-per-space shape the instrument
     actually emits. The B0 audit looked for a plural/array record and therefore
     reported memorySpacesListed:false - a parser error of mine, not a gap. */
  memorySpaces(rom){
   const r=run([rom,'--frames','0','--list-memory']);
   return r.all('memory_space').map(x=>({type:x.type,size:x.size}));
  },
  /* one disassembled instruction: address, text, and its LENGTH in bytes, which
     is what makes the sampled-PC semantics measurable rather than guessed */
  disassemble(rom,address,lines){
   const r=run([rom,'--frames','5','--disassemble','0x'+address.toString(16)+':'+(lines||1)]);
   return r.all('disassembly').map(x=>({address:x.address,text:x.text,bytes:x.bytes,
    length:x.bytes?x.bytes.length/2:null,
    absoluteType:x.absolute_type,absoluteAddress:x.absolute_address}));
  }};
}

/* A GU synthetic fixture, written out as a .nes file beside its closed oracle.
   The oracle is used only to CHECK the instrument and is never handed to
   discovery. */
function fixture(work,generator,seed,extraArgs){
 const tag=generator.replace(/\W+/g,'_')+'-'+seed;
 const romJson=path.join(work,'rom-'+tag+'.json');
 const oracleJson=path.join(work,'oracle-'+tag+'.json');
 execFileSync(process.env.PYTHON||'python3',
  [path.join(GU,'tools',generator),'--seed',String(seed),
   '--out',romJson,'--oracle-out',oracleJson,...(extraArgs||[])],{cwd:GU});
 const bytes=Buffer.from(JSON.parse(fs.readFileSync(romJson)).base64,'base64');
 const nes=path.join(work,'rom-'+tag+'.nes');
 fs.writeFileSync(nes,bytes);
 return {nes,bytes,sha256:sha256(bytes),
  oracle:JSON.parse(fs.readFileSync(oracleJson))};
}

/* NES controller bit order, shared by the GU hosts, the fixture ROMs and this
   instrument's --input names. Asserted rather than assumed: a single-bit mask
   must name exactly one button. */
const BUTTON_NAMES=['a','b','select','start','up','down','left','right'];
const buttonOf=mask=>{
 for(let b=0;b<8;b++)if(mask===(1<<b))return BUTTON_NAMES[b];
 throw new Error('mask '+mask+' is not a single button');
};

/* Input schedules in the instrument's own --input grammar. Frame numbers are
   relative to the start of the invocation, which the instrument documents. */
const schedules={
 /* a pulse train: `pulses` presses of `hold` frames, `release` frames apart */
 train(button,pulses,hold,release,startFrame){
  const out=[];let at=startFrame===undefined?10:startFrame;
  for(let p=0;p<pulses;p++){out.push('0:'+button+'@'+at+'-'+(at+hold-1));at+=hold+release;}
  return out;
 },
 /* one continuous hold of `frames` frames: ONE press edge, whatever its length */
 hold(button,frames,startFrame){
  const at=startFrame===undefined?10:startFrame;
  return ['0:'+button+'@'+at+'-'+(at+frames-1)];
 },
 neutral(){return [];}};

/* The Lua side. Every script this module builds is OBSERVATIONAL: a memory
   callback that returns a value would overwrite the memory operation, so the
   helpers below never return one, and the tools assert the RAM is unchanged. */
function luaFile(work,name,body){
 const file=path.join(work,name);
 fs.writeFileSync(file,body);
 return file;
}
const luaPreamble=outPath=>`
-- Written by GU research/mesen-causal. Observational only.
local OUT = ${JSON.stringify(outPath)}
local records = {}
local function emit(t)
  local parts = {}
  for k, v in pairs(t) do
    local value
    if type(v) == "string" then value = string.format("%q", v)
    elseif type(v) == "boolean" then value = tostring(v)
    elseif v == nil then value = "null"
    else value = tostring(v) end
    parts[#parts+1] = string.format("%q", k) .. ":" .. value
  end
  records[#records+1] = "{" .. table.concat(parts, ",") .. "}"
end
local function flush()
  local f = io.open(OUT, "w")
  f:write(table.concat(records, "\\n") .. "\\n")
  f:close()
end
`;

module.exports={instrument,fixture,buttonOf,BUTTON_NAMES,schedules,
 luaFile,luaPreamble,sha256,GU};
