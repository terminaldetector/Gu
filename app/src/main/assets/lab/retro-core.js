/* Local libretro adapter for Game Boy/Color and SNES. No runtime downloads. */
(function(root){'use strict';
const revisions={gb:'gambatte-d9d6cd0-fly1',snes:'snes9x-1bcc369-fly1'};
function normalizeRom(bytes,system){
 if(!(bytes instanceof Uint8Array))throw Error('ROM должен содержать байты');
 const warnings=[];
 if(system==='gb'){
  if(bytes.length<16384||bytes.length>8*1024*1024)throw Error('GB/GBC ROM: 16 КиБ–8 МиБ');
  let checksum=0;for(let i=0x134;i<=0x14c;i++)checksum=(checksum-bytes[i]-1)&255;
  if(checksum!==bytes[0x14d])warnings.push('Контрольная сумма заголовка GB отличается: проверьте дамп');
  return {bytes,format:bytes[0x143]&128?'Game Boy Color':'Game Boy',warnings};
 }
 if(system!=='snes')throw Error('Неизвестная платформа ROM');
 if(bytes.length%32768===512)bytes=bytes.slice(512);
 if(bytes.length<65536||bytes.length>8*1024*1024)throw Error('SNES ROM: 64 КиБ–8 МиБ (+512 байт заголовка)');
 return {bytes,format:'SNES cartridge',warnings};
}
function encode(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return typeof btoa==='function'?btoa(text):Buffer.from(bytes).toString('base64');}
function decode(text,max=12*1024*1024){if(typeof text!=='string'||text.length>max||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('Неверный снимок консоли');const s=typeof atob==='function'?atob(text):Buffer.from(text,'base64').toString('binary');return Uint8Array.from(s,c=>c.charCodeAt(0));}
class RetroConsole{
 constructor(g,system,opts){this.g=g;this.system=system;this.opts=opts;this.mask=this.mask2=0;this.romData=null;this.pixels=null;this.twoPlayerSupported=system==='snes';this.cpu={mem:new Proxy({}, {get:(_,key)=>{if(key==='length')return this.ramSize;if(typeof key==='symbol')return undefined;const i=Number(key);return Number.isInteger(i)&&i>=0&&i<this.ramSize?g._lab_read_ram(i):undefined;}})};}
 static async create(system,opts={},factory,moduleOptions={}){if(!revisions[system]||typeof factory!=='function')throw Error('Ядро '+system+' ещё не готово');const g=await factory(moduleOptions);g._lab_init();return new RetroConsole(g,system,opts);}
 static validateRom(bytes,system){const n=normalizeRom(bytes,system);return {mapper:n.format,format:n.format,warnings:n.warnings};}
 loadROM(bytes){const data=normalizeRom(bytes,this.system).bytes,p=this.g._malloc(data.length);if(!p)throw Error('Недостаточно памяти для ROM');try{this.g.HEAPU8.set(data,p);if(!this.g._lab_load_rom(p,data.length))throw Error('Ядро не приняло '+this.system.toUpperCase()+' ROM; проверьте дамп/тип картриджа');}finally{this.g._free(p);}this.romData=data.slice();this.mask=this.mask2=0;}
 buttonDown(port,index){this.button(port,index,true);}
 buttonUp(port,index){this.button(port,index,false);}
 button(port,index,on){const n=this.system==='snes'?12:8;if(![1,2].includes(port)||!Number.isInteger(index)||index<0||index>=n)throw Error('Неверная кнопка '+this.system);if(port===2&&!this.twoPlayerSupported)return;const key=port===1?'mask':'mask2';this[key]=on?this[key]|(1<<index):this[key]&~(1<<index);}
 get fps(){return this.g._lab_fps();}
 get ramSize(){return this.g._lab_ram_size();}
 frame(){const g=this.g;g._lab_tick(this.mask,this.mask2);if(!g._lab_valid())throw Error('Недопустимый кадр/звук '+this.system);const w=g._lab_width(),h=g._lab_height();if(w<1||w>512||h<1||h>512)throw Error('Нет корректного кадра '+this.system);this.videoWidth=w;this.videoHeight=h;this.pixels=new Uint32Array(g.HEAPU8.buffer,g._lab_video(),w*h).slice();if(this.opts.onFrame)this.opts.onFrame(this.pixels,w,h);
  const n=g._lab_audio_count(),rate=g._lab_sample_rate();if(n>8192||rate<=0)throw Error('Неверный звук '+this.system);if(this.opts.onAudioSample){const l=new Float32Array(g.HEAPU8.buffer,g._lab_audio_left(),n),r=new Float32Array(g.HEAPU8.buffer,g._lab_audio_right(),n),step=rate/(this.opts.sampleRate||44100);for(let i=0;i<n;i+=step){const at=Math.floor(i),next=Math.min(n-1,at+1),f=i-at;this.opts.onAudioSample(l[at]*(1-f)+l[next]*f,r[at]*(1-f)+r[next]*f);}}
 }
 reloadROM(){this.g._lab_reset();this.mask=this.mask2=0;}
 toJSON(){const n=this.g._lab_save_state();if(!n)throw Error('Снимок '+this.system+' недоступен');return {kind:this.system,core:revisions[this.system],mask:this.mask,mask2:this.mask2,data:encode(this.g.HEAPU8.slice(this.g._lab_state(),this.g._lab_state()+n)),video:this.pixels?{w:this.videoWidth,h:this.videoHeight,data:encode(new Uint8Array(this.pixels.buffer))}:null};}
 validateState(s){const limit=this.system==='snes'?4095:255;if(!s||s.kind!==this.system||s.core!==revisions[this.system]||![s.mask,s.mask2].every(v=>Number.isInteger(v)&&v>=0&&v<=limit)||(!this.twoPlayerSupported&&s.mask2!==0))throw Error('Снимок другой платформы/версии');const bytes=decode(s.data),n=this.g._lab_save_state();if(!n||bytes.length!==n)throw Error('Неверный размер снимка');if(s.video){const v=s.video,b=decode(v.data,2*1024*1024);if(!Number.isInteger(v.w)||!Number.isInteger(v.h)||v.w<1||v.w>512||v.h<1||v.h>512||b.length!==v.w*v.h*4)throw Error('Неверный снимок изображения');}return bytes;}
 fromJSON(s){const bytes=this.validateState(s),backup=this.g.HEAPU8.slice(this.g._lab_state(),this.g._lab_state()+bytes.length);this.g.HEAPU8.set(bytes,this.g._lab_state());if(!this.g._lab_load_state(bytes.length)){this.g.HEAPU8.set(backup,this.g._lab_state());this.g._lab_load_state(backup.length);throw Error('Ядро отклонило снимок');}this.mask=s.mask;this.mask2=s.mask2;if(s.video){const v=s.video;this.videoWidth=v.w;this.videoHeight=v.h;this.pixels=new Uint32Array(decode(v.data).buffer);if(this.opts.onFrame)this.opts.onFrame(this.pixels,v.w,v.h);}}
}
RetroConsole.normalizeRom=normalizeRom;root.RetroConsole=RetroConsole;if(typeof module!=='undefined')module.exports=RetroConsole;
})(typeof window==='undefined'?globalThis:window);
