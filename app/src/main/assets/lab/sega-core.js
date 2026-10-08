/* Local Genesis Plus GX adapter. Original engine licence: noncommercial redistribution. */
(function(root){'use strict';
const CORE='genplus-fly-6090aff9-api5';
function header(bytes){return String.fromCharCode(...bytes.slice(256,272));}
function vectors(bytes){if(bytes.length<514||bytes.length%2)return false;const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),pc=d.getUint32(4)&0xffffff,sp=d.getUint32(0);return pc>=8&&pc<bytes.length&&!(pc&1)&&((sp&0xff0000)===0xff0000||sp===0x1000000);}
function normalizeRom(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<514||bytes.length>8*1024*1024+512)throw Error('Mega Drive ROM: 514 байт–8 МиБ (+512 байт SMD)');
 if(bytes[0]===80&&bytes[1]===75)throw Error('ZIP откройте через Android-проводник приложения; в архиве должен быть один ROM');
 let rom=bytes,format='raw';
 if(!header(rom).startsWith('SEGA')){
  const swapped=bytes.slice();for(let i=0;i+1<swapped.length;i+=2){swapped[i]=bytes[i+1];swapped[i+1]=bytes[i];}
  if(header(swapped).startsWith('SEGA')&&vectors(swapped)){rom=swapped;format='word-swapped';}
  else if(bytes.length>512&&(bytes.length-512)%16384===0){
   const raw=new Uint8Array(bytes.length-512);for(let o=0;o<raw.length;o+=16384)for(let i=0;i<8192;i++){raw[o+2*i]=bytes[512+o+8192+i];raw[o+2*i+1]=bytes[512+o+i];}
   if(vectors(raw)){rom=raw;format='SMD';}
  }
 }
 if(rom.length>8*1024*1024||!vectors(rom))throw Error('Неверные стартовые векторы или размер Mega Drive ROM');
 const text=header(rom);if(/32X|MEGA CD/i.test(text))throw Error('Sega CD и 32X не поддерживаются этим режимом');
 const warnings=[];if(!text.startsWith('SEGA'))warnings.push('Нестандартная подпись SEGA: запуск по корректным векторам');
 const end=new DataView(rom.buffer,rom.byteOffset,rom.byteLength).getUint32(0x1a4);if(end&&end+1>rom.length)warnings.push('Размер в заголовке больше файла: возможен усечённый ROM или нестандартный заголовок');
 return {bytes:rom,format,warnings};
}
function validateRom(bytes){const n=normalizeRom(bytes);return {mapper:'Mega Drive cartridge',timing:0,battery:false,format:n.format,warnings:n.warnings};}
function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return typeof btoa==='function'?btoa(text):Buffer.from(bytes).toString('base64');}
function decode(text){if(typeof text!=='string'||text.length>2*1024*1024)throw Error('Неверный размер снимка Sega');const b=typeof atob==='function'?atob(text):Buffer.from(text,'base64').toString('binary');return Uint8Array.from(b,c=>c.charCodeAt(0));}
class SegaConsole {
 constructor(module,opts={}){this.g=module;this.opts=opts;this.opts.sampleRate=this.opts.sampleRate||44100;this.papu={sampleRate:44100};this.mask=0;this.romData=null;this.pixels=null;this.mask2=0;this.padTypes=module._lab_set_pad_type?[6,6]:[0,0];this.twoPlayerSupported=typeof module._lab_core_api==='function'&&module._lab_core_api()>=4;this.cpu={mem:new Proxy({}, {get:(_,key)=>{if(key==='length')return 65536;if(typeof key==='symbol')return undefined;const i=Number(key);return Number.isInteger(i)&&i>=0&&i<65536?this.g._lab_read_ram(i):undefined;}})};}
 static async create(opts={},factory=root.GenPlusFactory,moduleOptions={}){if(!factory)throw Error('Sega core factory unavailable');const g=await factory(moduleOptions);if(typeof g._lab_core_api!=='function'||g._lab_core_api()<4)throw Error('Sega API4+ required: rebuild with tools/build_sega.py');g._init();return new SegaConsole(g,opts);}
 loadROM(bytes){bytes=normalizeRom(bytes).bytes;this.romData=bytes.slice();const p=this.g._get_rom_buffer_ref(bytes.length);this.g.HEAPU8.set(bytes,p);this.g._start();this.configurePads(this.padTypes);this.mask=0;this.mask2=0;}
 buttonDown(port,index){if((port!==1&&port!==2)||!Number.isInteger(index)||index<0||index>11)throw Error('Invalid Sega controller');if(port===2)this.mask2|=1<<index;else this.mask|=1<<index;}
 buttonUp(port,index){if((port!==1&&port!==2)||!Number.isInteger(index)||index<0||index>11)throw Error('Invalid Sega controller');if(port===2)this.mask2&=~(1<<index);else this.mask&=~(1<<index);}
 configurePads(types){if(!Array.isArray(types)||types.length!==2||types.some(x=>![0,3,6].includes(Number(x))))throw Error('Sega pad type: auto / 3 / 6');this.padTypes=types.map(Number);if(this.g._lab_set_pad_type){for(let p=0;p<2;p++)this.g._lab_set_pad_type(p,this.padTypes[p]);}else if(this.padTypes.some(x=>x!==0))throw Error('Для выбора 3/6 кнопок требуется новая сборка ядра');this.mask=this.mask2=0;}
 frame(){const g=this.g,input=new Float32Array(g.HEAPF32.buffer,g._get_input_buffer_ref(),64);input.fill(0);for(let player=0;player<2;player++){const o=player*32,mask=player===0?this.mask:this.mask2;input[o+10]=mask&1?1:0;input[o+11]=mask&2?1:0;input[o+9]=mask&4?1:0;input[o+15]=mask&8?1:0;input[o+8]=mask&256?1:0;input[o+12]=mask&512?1:0;input[o+13]=mask&1024?1:0;input[o+14]=mask&2048?1:0;input[o+7]=mask&16?-1:mask&32?1:0;input[o+6]=mask&64?-1:mask&128?1:0;}g._tick();
  if(!g._lab_video_buffer_valid())throw Error('Повреждён кадровый буфер Sega');const stride=g._lab_video_pitch()/4;if(!Number.isInteger(stride)||stride<1||stride>640)throw Error('Неверный шаг строки Sega');const w=g._lab_video_width(),h=g._lab_video_height();if(w<1||w>640||h<1||h>480)throw Error('Неверный размер кадра Sega');if(!this.pixels||this.pixels.length!==w*h)this.pixels=new Uint32Array(w*h);const raw=new Uint32Array(g.HEAPU8.buffer,g._get_frame_buffer_ref(),640*480);for(let y=0;y<h;y++)for(let x=0;x<w;x++)this.pixels[y*w+x]=raw[y*stride+x]&0xffffff;if(this.opts.onFrame)this.opts.onFrame(this.pixels,w,h);
  const n=g._sound();if(n<0||n>2048)throw Error('Неверный аудиобуфер');if(this.opts.onAudioSample){const left=new Float32Array(g.HEAPF32.buffer,g._get_web_audio_l_ref(),n),right=new Float32Array(g.HEAPF32.buffer,g._get_web_audio_r_ref(),n);const step=44100/this.opts.sampleRate;for(let i=0;i<n;i+=step){const at=Math.floor(i),next=Math.min(n-1,at+1),f=i-at;this.opts.onAudioSample(left[at]*(1-f)+left[next]*f,right[at]*(1-f)+right[next]*f);}}
 }
 reloadROM(){this.g._lab_reset();this.mask=0;this.mask2=0;}
 get fps(){return this.g._lab_fps();}
 setFramerate(){}
 toJSON(){const n=this.g._lab_save_state();if(n<16||n>0xfd000)throw Error('Sega state size invalid');return {kind:'sega',core:CORE,padTypes:this.padTypes.slice(),mask:this.mask,mask2:this.mask2,video:this.pixels?{w:this.g._lab_video_width(),h:this.g._lab_video_height(),data:base64(new Uint8Array(this.pixels.buffer))}:null,data:base64(this.g.HEAPU8.slice(this.g._lab_state_ref(),this.g._lab_state_ref()+n))};}
 validateState(state){if(!state||state.kind!=='sega'||![CORE,'genplus-fly-6090aff9-api4'].includes(state.core)||!Number.isInteger(state.mask)||state.mask<0||state.mask>4095||!Number.isInteger(state.mask2)||state.mask2<0||state.mask2>4095)throw Error('Снимок другого ядра Sega');if(state.padTypes&&(!Array.isArray(state.padTypes)||state.padTypes.length!==2||state.padTypes.some(x=>![0,3,6].includes(x))))throw Error('Неверный тип Sega pad');const bytes=decode(state.data),size=this.g._lab_save_state(),p=this.g._lab_state_ref();if(bytes.length!==size||bytes.slice(0,16).some((x,i)=>x!==this.g.HEAPU8[p+i]))throw Error('Неверный формат снимка Sega');if(state.video){const v=state.video,video=decode(v.data);if(!Number.isInteger(v.w)||!Number.isInteger(v.h)||v.w<1||v.w>640||v.h<1||v.h>480||video.length!==v.w*v.h*4)throw Error('Неверный видео-снимок');}return bytes;}
 fromJSON(state){const bytes=this.validateState(state);this.configurePads(state.padTypes||[0,0]);this.g.HEAPU8.set(bytes,this.g._lab_state_ref());if(!this.g._lab_load_state())throw Error('Не удалось восстановить Sega');this.mask=state.mask;this.mask2=state.mask2;if(state.video){const v=state.video,bytes=decode(v.data);if(!Number.isInteger(v.w)||!Number.isInteger(v.h)||v.w<1||v.w>640||v.h<1||v.h>480||bytes.length!==v.w*v.h*4)throw Error('Неверный видео-снимок');this.pixels=new Uint32Array(bytes.buffer);const raw=new Uint32Array(this.g.HEAPU8.buffer,this.g._get_frame_buffer_ref(),640*480);for(let y=0;y<v.h;y++)raw.set(this.pixels.subarray(y*v.w,(y+1)*v.w),y*(this.g._lab_video_pitch()/4));if(this.opts.onFrame)this.opts.onFrame(this.pixels,v.w,v.h);}}
}
SegaConsole.validateRom=validateRom;SegaConsole.normalizeRom=normalizeRom;root.SegaConsole=SegaConsole;if(typeof module!=='undefined')module.exports=SegaConsole;
})(typeof window==='undefined'?globalThis:window);

