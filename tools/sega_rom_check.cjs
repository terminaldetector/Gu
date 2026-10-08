'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const Sega=require('../app/src/main/assets/lab/sega-core.js');
const Factory=require('../app/src/main/assets/lab/sega/genplus.js');
const original=Buffer.from(require('../app/src/main/assets/lab/demo-sega.json').base64,'base64');
const raw=Uint8Array.from(original);raw.fill(0,0,4); // A valid stack can wrap from SSP=0.
const swapped=raw.slice();for(let i=0;i+1<raw.length;i+=2){swapped[i]=raw[i+1];swapped[i+1]=raw[i];}
const copier=new Uint8Array(raw.length+512);copier.set(raw,512);
const swappedCopier=new Uint8Array(raw.length+512);swappedCopier.set(swapped,512);
function smd(bytes,offset){const out=new Uint8Array(bytes.length+offset);for(let o=0;o<bytes.length;o+=16384)for(let i=0;i<8192;i++){out[offset+o+i]=bytes[o+2*i+1];out[offset+o+8192+i]=bytes[o+2*i];}return out;}
const mdx=new Uint8Array(raw.length+5);mdx.set(raw.map(x=>x^0x40),4);
const variants=[raw,swapped,copier,swappedCopier,smd(raw,512),smd(raw,0),mdx];
for(const v of variants)assert.deepEqual(Sega.normalizeRom(v).bytes,raw,'canonical cartridge identity');
const unsigned=raw.slice();unsigned.fill(32,256,272);assert.deepEqual(Sega.normalizeRom(unsigned).bytes,unsigned,'unsigned homebrew with valid reset PC');
assert.throws(()=>Sega.normalizeRom(new Uint8Array(513)));
assert.throws(()=>Sega.normalizeRom(new Uint8Array(16384)));
assert.throws(()=>Sega.normalizeRom(new Uint8Array(32*1024*1024+513)));
const odd=raw.slice(0,-1);assert.equal(Sega.normalizeRom(odd).bytes.at(-1),255);
const x32=raw.slice();x32.set(Buffer.from('SEGA 32X'),256);assert.throws(()=>Sega.normalizeRom(x32));
(async()=>{
 if(process.argv.includes('--loader-only')){console.log('PASS: cartridge normalization/identity and malformed-format limits');return;}
 const core=await Sega.create({},Factory,{wasmBinary:fs.readFileSync('app/src/main/assets/lab/sega/genplus.wasm')});
 for(const bytes of variants){core.loadROM(bytes);for(let i=0;i<8;i++)core.frame();assert(core.pixels.some(x=>x!==0),'converted cartridge really boots');assert.equal(core.g._lab_rom_size(),raw.length);}
 for(const [region,code,fps] of [[1,128,60],[2,192,50],[3,0,60],[4,64,50]]){
  core.configureRegion(region);core.loadROM(raw);core.frame();assert.equal(core.g._lab_get_region(),code);assert.equal(core.fps,fps);
 }
 core.configureRegion(0);
 const large=new Uint8Array(9*1024*1024);large.set(raw);core.loadROM(large);core.frame();assert.equal(core.g._lab_rom_size(),large.length,'cartridge above old 8 MiB limit');
 console.log('PASS: SSP=0 cartridge boot, raw/swap/copier/SMD/MDX identities, regions and >8 MiB actual WASM load');
})().catch(e=>{console.error(e);process.exit(1);});
