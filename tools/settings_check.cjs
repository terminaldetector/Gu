'use strict';
const assert=require('node:assert/strict'),C=require('../app/src/main/assets/lab/controller.js'),S=require('../app/src/main/assets/lab/settings.js');
for(const [x,y,mask]of [[.1,.1,80],[.9,.1,144],[.1,.9,96],[.9,.9,160],[.5,.5,0],[.5,.1,16],[.9,.5,128],[-.01,.5,0],[1.01,.5,0]])assert.equal(C.dpad(x,y),mask);
let custom=C.bind('sega',{},2,'KeyA'),keys=C.keyboard('sega',custom);assert.equal(keys.KeyA,2);assert.equal(keys.KeyD,undefined,'old key for C is removed');assert(!Object.values(keys).includes(0),'conflicting A binding is replaced');
custom=C.bind('sega',custom,2);keys=C.keyboard('sega',custom);assert(!Object.values(keys).includes(2));assert.equal(C.keyboard('sega',{KeyA:999}).KeyA,0,'invalid binding cannot expand controller bits');assert.equal(C.keyboard('gb').KeyX,0);
const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
S.write(storage,'sega','fly',{seed:'42',scramble:true});assert.deepEqual(S.read(storage,'sega','fly'),{seed:'42',scramble:true});assert.equal(S.read(storage,'sega','male'),null);assert.equal(S.read(storage,'snes','fly'),null);
storage.setItem(S.key('sega','fly'),JSON.stringify({version:2,system:'sega',graph:'fly',fields:{}}));assert.throws(()=>S.read(storage,'sega','fly'));
console.log('PASS: eight directions/neutral/outside release, exclusive keyboard remaps/unbind, validated versioned platform/model preferences');
