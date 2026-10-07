const assert=require('node:assert/strict');
const L=require('../app/src/main/assets/lab/learner.js');
const jsnes=require('../app/src/main/assets/lab/jsnes.min.js');
const rom=Uint8Array.from(Buffer.from(require('../app/src/main/assets/lab/demo-rom.json').base64,'base64'));
const l=new L(123),nes=new jsnes.NES({onFrame:()=>{},onAudioSample:()=>{}});nes.loadROM(rom);
function episode(train){nes.reloadROM();for(let b=0;b<8;b++)nes.buttonUp(1,b);for(let i=0;i<5;i++)nes.frame();l.boundary();let prev=null,mask=0,sum=0;
 for(let t=0;t<180;t++){for(let b=0;b<8;b++)mask&(1<<b)?nes.buttonDown(1,b):nes.buttonUp(1,b);nes.frame();const x=nes.cpu.mem[0],y=nes.cpu.mem[1],value=-Math.abs(200-x)-Math.abs(100-y);const success=x>=200&&Math.abs(y-100)<=4;let r=prev===null?0:(value-prev)/8-.01;prev=value;if(success)r+=2;sum+=r;const f=l.features(new Array(16).fill(.1),new Array(8).fill(0),[x/256,y/240,(200-x)/256,(100-y)/240]);mask=l.step(f,r,success||t===179,train);if(success)return {sum,success};}return {sum,success:false};}
const before=Array.from({length:20},()=>episode(false));for(let i=0;i<100;i++)episode(true);const saved=JSON.stringify(l.save());const after=Array.from({length:20},()=>episode(false));assert.equal(JSON.stringify(l.save()),saved.replace(/"episodes":\d+/, '"episodes":'+l.episodes).replace(/"rng":\d+/, '"rng":'+l.rng),'evaluation keeps weights and update count');
const mean=a=>a.reduce((s,x)=>s+x.sum,0)/a.length;
console.log({before:mean(before),after:mean(after),success:after.filter(x=>x.success).length,updates:l.updates});assert(mean(after)>mean(before)+3);assert(after.filter(x=>x.success).length>=15);
const restored=new L();restored.load(JSON.parse(saved));assert.deepEqual(restored.weights,l.weights);assert.throws(()=>restored.load({version:1,weights:[]}));
const a=new L(1),b=new L(1),f=a.features(new Array(16).fill(0),new Array(8).fill(0));for(let i=0;i<100;i++)assert.equal(a.step(f,1,false,true),b.step(f,1,false,true));
console.log('PASS: actual NES task improves, frozen evaluation, model validation/persistence, seeded reproducibility');
