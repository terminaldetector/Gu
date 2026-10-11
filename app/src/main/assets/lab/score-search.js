/* Discover numeric counters from synchronized screen/RAM observations. No OCR reward delay. */
(function(root){'use strict';
const LIMIT=4096,multipliers=[1,10,100,1000];
function read(mem,s){
 if(!(mem instanceof Uint8Array)||!Number.isInteger(s.address)||!Number.isInteger(s.width)||s.address<0||s.width<1||s.width>4||s.address+s.width>mem.length||!['unsigned','bcd'].includes(s.format)||!['big','little'].includes(s.endian)||!multipliers.includes(s.multiplier))throw Error('Неверный найденный счётчик');
 let n=0;for(let j=0;j<s.width;j++){const b=mem[s.address+(s.endian==='big'?j:s.width-1-j)];if(s.format==='bcd'){if((b&15)>9||(b>>>4)>9)return null;n=n*100+(b>>>4)*10+(b&15);}else n=n*256+b;}return n*s.multiplier;
}
function compact(rows,mem){
 // Zero padding can produce many aliases for the same counter. Preserve every
 // candidate until the next observation, then display the smallest valid span.
 const out=new Map();for(const s of rows){let address=s.address,width=s.width;
  if(mem)while(width>1&&mem[s.endian==='big'?address:address+width-1]===0){if(s.endian==='big')address++;width--;}
  let multiplier=s.multiplier;if(mem&&s.format==='bcd')while(width>1&&multipliers.includes(multiplier*100)&&mem[s.endian==='little'?address:address+width-1]===0){if(s.endian==='little')address++;width--;multiplier*=100;}
  const key=s.format+'|'+(width===1?'byte':s.endian)+'|'+address+'|'+width+'|'+multiplier;
  const candidate={...s,address,width,multiplier};if(!out.has(key))out.set(key,candidate);
 }return [...out.values()];
}
function scan(mem,score){
 if(!(mem instanceof Uint8Array)||mem.length<1||mem.length>131072||!Number.isSafeInteger(score)||score<1||score>999999999)throw Error('Для поиска сначала получите ненулевой счёт.');
 const rows=[];for(let address=0;address<mem.length;address++)for(let width=1;width<=4&&address+width<=mem.length;width++)for(const format of ['unsigned','bcd'])for(const endian of width===1?['big']:['big','little'])for(const multiplier of multipliers){
  if(score%multiplier)continue;const s={address,width,format,endian,multiplier};if(read(mem,s)===score){rows.push(s);if(rows.length>LIMIT)throw Error('Слишком много совпадений. Наберите больше очков и повторите поиск.');}
 }return rows;
}
function narrow(rows,mem,previous,current){
 if(!Number.isSafeInteger(current)||current<=previous||current>999999999)throw Error('Нужен выросший счёт в этой же игре; таймер и сброс не подтверждают награду.');
 return rows.filter(s=>read(mem,s)===current);
}
function validate(source,profile,system,hash,ramLimit){
 if(!source||source.version!==1||source.system!==system||source.romHash!==hash||!Array.isArray(source.evidence)||source.evidence.length!==2||!source.counter)throw Error('Сначала подтвердите счёт через «Поиск scores».');
 const [a,b]=source.evidence;if(![a,b].every(e=>Number.isSafeInteger(e.score)&&e.score>0&&e.score<=999999999&&Number.isSafeInteger(e.frame)&&e.frame>=0)||b.score<=a.score||b.frame<=a.frame)throw Error('Счёт не подтверждён двумя различными наблюдениями.');
 const s=source.counter;read(new Uint8Array(ramLimit),s);
 if(Number(profile.rewardAddress)!==s.address||Number(profile.ramWidth)!==s.width||profile.ramFormat!==s.format||profile.ramEndian!==s.endian||Number(profile.rewardScale)<=0||profile.ramWrap===true)throw Error('Профиль отличается от подтверждённого счёта. Повторите поиск или выберите RAM.');
 return source;
}
root.FlyScoreSearch={read,scan,narrow,compact,validate,LIMIT};if(typeof module!=='undefined')module.exports=root.FlyScoreSearch;
})(typeof window==='undefined'?globalThis:window);
