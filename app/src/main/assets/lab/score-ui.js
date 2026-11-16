/* Score-counter search: a diagnostic tool. OCR or the user names the visible score, two
 * growing observations narrow the RAM candidates to one counter, which is kept per ROM as a
 * diagnostic finding. It is not a reward: nothing here feeds a learner or a policy. */
'use strict';
(()=>{
let token=0,pending=null,snapshot=null,rows=[],choices=[],first=null,last=null,proof=null,context=null;
const identity=()=>labPlatform+'|'+romHash,key=()=> 'fly-score-'+identity();
const note=s=>$('scoreStatus').textContent=s;
function stored(){try{const raw=localStorage.getItem(key());if(!raw)return null;const v=JSON.parse(raw);FlyScoreSearch.validate(v,profileOf(v.counter),labPlatform,romHash,ramLimit);return v;}catch(_){return null;}}
function profileOf(c){return {rewardAddress:c.address,ramWidth:c.width,ramFormat:c.format,ramEndian:c.endian,rewardScale:1,ramWrap:false};}
function refresh(){
 if(context!==identity()){context=identity();snapshot=null;rows=[];choices=[];first=last=null;proof=loaded?stored():null;$('scoreNumbers').replaceChildren();$('scoreCounters').replaceChildren();if(proof)note('Сохранённый счётчик: '+proof.counter.address+' · '+proof.counter.width+' байт · '+proof.counter.format+'.');}
 $('scoreFind').disabled=!loaded||romLoading||!!pending;
 $('scoreConfirm').disabled=!snapshot||!!pending;$('scorePlay').disabled=!loaded||romLoading||!!pending;
 $('scoreTrack').disabled=!loaded||romLoading||!!pending||!first;$('scoreUse').disabled=!!pending||!last||last.score<=first?.score||choices.length!==1||!!proof;
}
function memory(){const m=new Uint8Array(ramLimit),source=nes.cpu.mem;for(let i=0;i<ramLimit;i++)m[i]=source[i]||0;return m;}
async function capture(){
 if(pending)throw Error('Дождитесь распознавания');window.labPause();presentVideo();
 if(!loaded||romLoading)throw Error('Сначала запустите игру');
 const q={identity:identity(),sequence:romLoadSequence,frame,mem:memory()};snapshot=q;
 if(!window.FlyBridge?.recognizeScore){note('Распознавание доступно в Android. Можно ввести видимый счёт ниже.');return q;}
 const id='score-'+(++token);note('Ищу числа на игровом изображении…');refresh();
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(pending?.id===id){pending=null;reject(Error('Распознавание не ответило; введите счёт вручную.'));refresh();}},20000);pending={id,q,timer,resolve,reject};refresh();FlyBridge.recognizeScore(JSON.stringify({token:id,image:screen.toDataURL('image/png').split(',')[1]}));});
 return q;
}
window.labScoreText=r=>{
 if(!pending||pending.id!==r.token)return;const p=pending;clearTimeout(p.timer);pending=null;
 if(p.q.identity!==identity()||p.q.sequence!==romLoadSequence){p.reject(Error('ROM изменился; старый результат отброшен'));refresh();return;}
 if(r.error){p.reject(Error(r.error));refresh();return;}
 $('scoreNumbers').replaceChildren();for(const c of Array.isArray(r.candidates)?r.candidates:[]){if(!/^\d{3,9}$/.test(c.digits))continue;const option=document.createElement('option');option.value=c.digits;option.textContent=c.digits+' · '+String(c.label||'число').slice(0,60);$('scoreNumbers').append(option);}
 if($('scoreNumbers').options.length)$('scoreVisible').value=$('scoreNumbers').value;
 note($('scoreNumbers').options.length?'Выберите именно игровой счёт и подтвердите число. Жизни, время и HI-SCORE не подходят.':'Цифры не распознаны. Введите видимый счёт с изображения.');p.resolve(p.q);refresh();
};
function selected(){const value=Number($('scoreVisible').value);if(!Number.isSafeInteger(value)||value<1||value>999999999)throw Error('Наберите очки и укажите ненулевой игровой счёт.');return value;}
function renderRows(){
 choices=snapshot?FlyScoreSearch.compact(rows,snapshot.mem):[];
 $('scoreCounters').replaceChildren();for(const [i,s]of choices.entries()){const option=document.createElement('option');option.value=String(i);option.textContent='Вариант '+(i+1)+' · '+s.width+' байт · '+s.format+' · ×'+s.multiplier;$('scoreCounters').append(option);}refresh();
}
function confirm(){
 if(!snapshot||snapshot.identity!==identity()||snapshot.sequence!==romLoadSequence||pending)throw Error('Сначала снимите кадр текущей игры.');const score=selected();proof=null;
 if(!first){rows=FlyScoreSearch.scan(snapshot.mem,score);first={score,frame:snapshot.frame};last=first;choices=FlyScoreSearch.compact(rows,snapshot.mem);note(rows.length?'Найдено '+choices.length+' вариантов. Продолжите игру, наберите ещё очков и нажмите «Проверить изменение».':'Совпадений нет. Проверьте число; эта игра может хранить score другим способом.');}
 else {if(snapshot.frame<=last.frame)throw Error('Продолжите игру и снимите новый кадр.');rows=FlyScoreSearch.narrow(rows,snapshot.mem,last.score,score);last={score,frame:snapshot.frame};choices=FlyScoreSearch.compact(rows,snapshot.mem);note(choices.length===1?'Счёт подтверждён. Можно подключить награду.':rows.length?'Осталось '+choices.length+' вариантов. Наберите ещё очков и проверьте снова.':'Изменения не совпали. Начните поиск заново.');}
 renderRows();
}
function reset(){first=last=proof=null;rows=[];choices=[];snapshot=null;renderRows();}
async function find(){if(pending)return;try{refresh();reset();await capture();}catch(e){note(e.message);refresh();}}
async function track(){try{await capture();}catch(e){note(e.message);refresh();}}
async function use(){try{
 if(!first||!last||last.score<=first.score||choices.length!==1)throw Error('Нужен один счётчик после проверки роста счёта.');
 const counter=choices[0];proof={version:1,system:labPlatform,romHash,counter,evidence:[first,last]};FlyScoreSearch.validate(proof,profileOf(counter),labPlatform,romHash,ramLimit);
 localStorage.setItem(key(),JSON.stringify(proof));note('Счётчик сохранён для этой игры как диагностическая находка: адрес '+counter.address+', '+counter.width+' байт, '+counter.format+'. Наградой он не является.');refresh();
 }catch(e){note(e.message);refresh();}}
$('scoreFind').onclick=find;$('scoreTrack').onclick=track;$('scoreConfirm').onclick=()=>{try{confirm();}catch(e){note(e.message);refresh();}};$('scoreUse').onclick=use;
$('scoreNumbers').onchange=()=>{$('scoreVisible').value=$('scoreNumbers').value;};
$('scorePlay').onclick=()=>{if(!loaded)return;window.labPause();openGame();$('play').click();};
window.scoreSearch={refresh,proof:()=>proof,find,track,confirm,use,forget:()=>{try{localStorage.removeItem(key());}catch(_){}proof=null;refresh();}};refresh();
window.addEventListener('lab-rom-loaded',refresh);
})();
