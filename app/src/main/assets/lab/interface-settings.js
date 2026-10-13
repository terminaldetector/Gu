/* Versioned presentation and physical-pad preferences, independent of learned layers. */
(function(root){'use strict';
const landscape=()=>({panel:'compact',input:'auto',screenLayout:'rails',videoFit:'fit',videoScale:1,offsetX:0,offsetY:0,sideSpace:.18,dpadScale:1,actionScale:1,monitors:3,monitorPlacement:'top',fullscreen:true});
const defaults=()=>({version:2,theme:'dark',accent:'mint',density:'comfortable',shape:'round',opacity:.9,visible:true,leftHanded:false,dpadScale:1,actionScale:1,gap:6,inset:8,videoFit:'fit',videoScale:1,landscape:landscape(),layouts:{portrait:{},landscape:{}}});
const bounds={opacity:[.25,1],dpadScale:[.65,1.5],actionScale:[.65,1.5],gap:[2,14],inset:[4,28],videoScale:[.6,1]};
function validate(v){
 if(v?.version===1)v={...v,version:2,landscape:{...landscape(),videoFit:v.videoFit,videoScale:v.videoScale}};
 if(!v||v.version!==2||!['dark','light','system'].includes(v.theme)||!['mint','blue','amber'].includes(v.accent)||!['comfortable','compact'].includes(v.density)||!['round','soft','square'].includes(v.shape)||!['fit','integer'].includes(v.videoFit)||typeof v.visible!=='boolean'||typeof v.leftHanded!=='boolean')throw Error('Настройки интерфейса повреждены');
 for(const [k,[a,b]]of Object.entries(bounds))if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<a||v[k]>b)throw Error('Параметр интерфейса вне границ: '+k);
 const l=v.landscape;
 if(!l||!['compact','full'].includes(l.panel)||!['auto','touch','gamepad'].includes(l.input)||!['rails','overlay'].includes(l.screenLayout)||!['fit','integer'].includes(l.videoFit)||!['top','bottom'].includes(l.monitorPlacement)||typeof l.fullscreen!=='boolean'||!Number.isInteger(l.monitors)||l.monitors<0||l.monitors>3)throw Error('Настройки альбомного режима повреждены');
 for(const [k,[a,b]]of Object.entries({videoScale:[.6,1],offsetX:[-1,1],offsetY:[-1,1],sideSpace:[.12,.3],dpadScale:[.65,1.5],actionScale:[.65,1.5]}))if(typeof l[k]!=='number'||!Number.isFinite(l[k])||l[k]<a||l[k]>b)throw Error('Параметр альбомного режима вне границ: '+k);
 for(const o of ['portrait','landscape']){const l=v.layouts?.[o];if(!l||typeof l!=='object'||Array.isArray(l))throw Error('Неверный макет');const valid=p=>p&&Object.keys(p).every(k=>['x','y'].includes(k))&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;for(const [k,p]of Object.entries(l)){if(k==='buttons'){if(!p||Object.entries(p).some(([b,p])=>!/^([0-3]|8|9|10|11)$/.test(b)||!valid(p)))throw Error('Неверное положение кнопки');}else if(!['dpad','actions','system'].includes(k)||!valid(p))throw Error('Неверное положение группы');}}
 return JSON.parse(JSON.stringify(v));
}
const key=system=>'fly-interface-v1-'+system;
function read(storage,system){const raw=storage.getItem(key(system));if(raw===null)return defaults();if(raw.length>16384)throw Error('Настройки интерфейса слишком велики');return validate(JSON.parse(raw));}
function write(storage,system,v){storage.setItem(key(system),JSON.stringify(validate(v)));}
function mappings(v,max=11){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length>64||Object.entries(v).some(([k,b])=>!/^\d{1,3}$/.test(k)||Number(k)>255||b!==null&&(!Number.isInteger(b)||b<0||b>max)))throw Error('Назначения геймпада повреждены');return {...v};}
function physical(data,custom,extended=false){
 if(!Array.isArray(data.keyMasks))return data.mask;
 if(data.keyMasks.length>64||!Number.isInteger(data.axisMask)||data.axisMask<0||data.axisMask>255)throw Error('Неверные оси геймпада');
 let mask=data.axisMask;
 for(const k of data.keyMasks){if(!k||!Number.isInteger(k.code)||k.code<0||k.code>255||!Number.isInteger(k.mask)||k.mask<0||k.mask>4095)throw Error('Неверный ввод геймпада');const b=custom[k.code];mask|=b===undefined?k.mask:b===null?0:1<<b;}
 return mask&(extended?4095:255);
}
function bind(custom,button,code,base=[]){const v=mappings(custom);if(!Number.isInteger(button)||button<0||button>11||!Number.isInteger(code)||code<0||code>255)throw Error('Неверная кнопка');for(const b of base)if(b.mask===1<<button)v[b.code]=null;for(const [k,b]of Object.entries(v))if(b===button)v[k]=null;v[code]=button;return mappings(v);}
// Normalized positions are bounded again after rotation, resize or a size change.
function position(p,w,h,viewport,top=0,inset=8){const x=inset+p.x*Math.max(0,viewport.width-w-2*inset),y=top+inset+p.y*Math.max(0,viewport.height-top-h-2*inset);return{x,y};}
root.FlyInterfaceSettings={defaults,validate,read,write,key,mappings,physical,bind,position};if(typeof module!=='undefined')module.exports=root.FlyInterfaceSettings;
})(typeof window==='undefined'?globalThis:window);
