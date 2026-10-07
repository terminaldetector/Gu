/* ROM validation and explicit game profile primitives. */
(function(root){'use strict';
const supported=[0,1,2,3,4,5,7,9,11,34,38,66,71,79,94,118,119,140,180,240,241];
function validateRom(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<16||bytes.length>4*1024*1024||bytes[0]!==78||bytes[1]!==69||bytes[2]!==83||bytes[3]!==26)throw Error('Ожидается iNES/NES 2.0 ROM до 4 МиБ');
 const nes2=(bytes[7]&12)===8;
 let mapper=(bytes[6]>>>4)|(bytes[7]&240);
 if(nes2)mapper|=(bytes[8]&15)<<8;else if(Array.from(bytes.slice(12,16)).some(x=>x!==0))mapper&=15;
 const bankSize=(lo,hi,unit)=>hi===15?Math.pow(2,lo>>>2)*((lo&3)*2+1):((hi<<8)|lo)*unit;
 const prg=nes2?bankSize(bytes[4],bytes[9]&15,16384):bytes[4]*16384;
 const chr=nes2?bankSize(bytes[5],bytes[9]>>>4,8192):bytes[5]*8192;
 const required=16+((bytes[6]&4)?512:0)+prg+chr;
 if(prg===0||!Number.isSafeInteger(required)||required>bytes.length)throw Error('ROM обрезан: заголовок требует '+required+' байт, получено '+bytes.length);
 if(!supported.includes(mapper))throw Error('Неподдерживаемый mapper '+mapper);
 return {mapper,nes2,prg,chr,required,timing:nes2?bytes[12]&3:bytes[9]&1,submapper:nes2?bytes[8]>>>4:0,battery:Boolean(bytes[6]&2)};
}
function readRam(mem,spec){
 const address=Number(spec.address),width=Number(spec.width),format=spec.format;
 if(!Number.isInteger(address)||!Number.isInteger(width)||width<1||width>4||address<0||address+width>2048||!['unsigned','signed','bcd'].includes(format)||!['little','big'].includes(spec.endian))throw Error('Неверный формат RAM');
 let value=0;for(let k=0;k<width;k++){const i=spec.endian==='big'?k:width-1-k;const b=mem[address+i]&255;if(format==='bcd'){if((b&15)>9||(b>>>4)>9)throw Error('RAM содержит недопустимый BCD');value=value*100+(b>>>4)*10+(b&15);}else value=value*256+b;}
 if(format==='signed'&&value>=Math.pow(2,width*8-1))value-=Math.pow(2,width*8);
 return value;
}
function delta(current,previous,spec,wrap){let d=current-previous;if(wrap&&spec.format!=='signed'){const base=Math.pow(spec.format==='bcd'?100:256,Number(spec.width));if(d>base/2)d-=base;if(d<-base/2)d+=base;}return d;}
function actions(text){const a=text.split(/[\s,;]+/).filter(Boolean).map(Number);if(a.length<2||a.length>64||new Set(a).size!==a.length||a.some(x=>!Number.isInteger(x)||x<0||x>255||(x&48)===48||(x&192)===192))throw Error('Нужно 2–64 уникальных маски 0–255 без противоположных направлений');return a;}
function predicate(mem,address,value){const a=Number(address),v=Number(value);if(!Number.isInteger(a)||a<0||a>2047||!Number.isInteger(v)||v<0||v>255)throw Error('Условие завершения: RAM 0–2047, значение 0–255');return (mem[a]&255)===v;}
const api={validateRom,readRam,delta,actions,predicate};root.FlyGameTools=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
