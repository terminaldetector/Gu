'use strict';
const assert=require('node:assert/strict'),prefs=require('../app/src/main/assets/lab/interface-settings.js');
const data=new Map(),storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
const original=prefs.defaults(),custom=prefs.defaults();
custom.layouts.portrait={dpad:{x:.2,y:.8},buttons:{0:{x:.7,y:.4},11:{x:.6,y:.9}}};custom.opacity=.5;custom.actionScale=.85;
prefs.write(storage,'sega',custom);assert.deepEqual(prefs.read(storage,'sega'),custom);assert.deepEqual(prefs.read(storage,'nes'),original);
const loaded=prefs.read(storage,'sega');loaded.layouts.portrait.dpad.x=0;assert.equal(prefs.read(storage,'sega').layouts.portrait.dpad.x,.2,'reads do not alias saved coordinates');
for(const size of [{width:320,height:480},{width:480,height:320},{width:1920,height:1080}]){
 for(const p of [{x:0,y:0},{x:1,y:1},{x:.5,y:.5}]){const pos=prefs.position(p,120,100,size,70,8);assert(pos.x>=8&&pos.x+120<=size.width-8);assert(pos.y>=78&&pos.y+100<=size.height-8);}
}
for(const bad of [{...custom,version:2},{...custom,actionScale:Infinity},{...custom,thresholdOffset:1,opacity:2},{...custom,layouts:{portrait:{buttons:{4:{x:0,y:0}}},landscape:{}}}])assert.throws(()=>prefs.validate(bad));
data.set(prefs.key('sega'),'broken');assert.throws(()=>prefs.read(storage,'sega'));assert.equal(data.get(prefs.key('sega')),'broken','invalid data is never overwritten by reading');
const defaults=[{code:96,mask:1},{code:99,mask:1},{code:97,mask:2},{code:100,mask:2},{code:102,mask:4}];
const bound=prefs.bind({},1,104,defaults);assert.equal(bound[97],null);assert.equal(bound[100],null);assert.equal(bound[104],1);
const event={mask:129,axisMask:128,keyMasks:[{code:96,mask:1},{code:104,mask:0}]};
assert.equal(prefs.physical(event,bound),131,'remapped trigger combines with original A and direction');
assert.equal(prefs.physical({mask:2,axisMask:0,keyMasks:[{code:97,mask:2}]},bound),0,'replaced default sources are removed');
assert.equal(prefs.physical({mask:257,axisMask:0,keyMasks:[{code:99,mask:256},{code:96,mask:1}]},{99:10},true),1025);
assert.equal(prefs.physical({mask:129},{}),129,'old bridge payloads retain standard behavior');
assert.equal(prefs.physical({mask:0,axisMask:0,keyMasks:[]},bound),0,'all releases clear custom keys');
assert.throws(()=>prefs.physical({axisMask:4096,keyMasks:[]},{}));assert.throws(()=>prefs.physical({axisMask:0,keyMasks:[{code:999,mask:1}]},{}));assert.throws(()=>prefs.mappings({96:12}));
console.log('PASS: independent UI preferences, bounded orientation coordinates, corruption recovery, raw button remapping, trigger/direction chords and releases');
