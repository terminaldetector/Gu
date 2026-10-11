'use strict';
(()=>{
let token=0,pending=null,snapshot=null,rows=[],choices=[],first=null,last=null,proof=null,context=null;
let draftBackup=null,priorMode=$('rewardMode').value;
const identity=()=>labPlatform+'|'+romHash,key=()=> 'fly-score-'+identity();
const note=s=>$('scoreStatus').textContent=s;
function refresh(){
 if(context!==identity()){context=identity();snapshot=null;rows=[];choices=[];first=last=proof=null;$('scoreNumbers').replaceChildren();$('scoreCounters').replaceChildren();}
 $('scorePanel').hidden=$('rewardMode').value!=='score';$('scoreFind').disabled=!loaded||romLoading||!!pending||!!window.dualAgents?.active();
 $('scoreConfirm').disabled=!snapshot||!!pending;$('scorePlay').disabled=!loaded||romLoading||!!pending;
 $('scoreTrack').disabled=!loaded||romLoading||!!pending||!first||!!window.dualAgents?.active();$('scoreUse').disabled=!!pending||!last||last.score<=first?.score||choices.length!==1;
 if(proof||window.dualAgents?.active())$('scoreUse').disabled=true;if(window.dualAgents?.active()&&$('rewardMode').value==='score')note('Поиск подключает награду одной модели. Для двух независимых сетей настройте награды на карточках P1/P2 или завершите парный режим.');
}
function memory(){const m=new Uint8Array(ramLimit),source=nes.cpu.mem;for(let i=0;i<ramLimit;i++)m[i]=source[i]||0;return m;}
async function capture(){
 if(pending)throw Error('Дождитесь распознавания');if(window.dualAgents?.active())throw Error('Сначала завершите парный режим в разделе моделей P1/P2.');window.labPause();await window.labState.settle();presentVideo();
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
async function find(){if(pending)return;try{refresh();if(proof)draftBackup=JSON.parse(JSON.stringify(profileValues()));reset();await capture();}catch(e){note(e.message);refresh();}}
async function track(){try{await capture();}catch(e){note(e.message);refresh();}}
async function use(){try{
 if(!first||!last||last.score<=first.score||choices.length!==1)throw Error('Нужен один счётчик после проверки роста счёта.');
 window.labPause();await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());const counter=choices[0];$('rewardAddress').value=String(counter.address);$('ramWidth').value=String(counter.width);$('ramFormat').value=counter.format;$('ramEndian').value=counter.endian;$('ramWrap').checked=false;$('rewardScale').value=String(.001*counter.multiplier);$('rewardMode').value='score';
 proof={version:1,system:labPlatform,romHash,counter,evidence:[first,last]};FlyScoreSearch.validate(proof,profileValues(),labPlatform,romHash,ramLimit);localStorage.setItem(key(),JSON.stringify(proof));learningBoundary();trainingView();await window.labState.checkpoint();draftBackup=null;priorMode='score';note('Награда подключена: +0.001 за одно очко. Сброс счёта не наказывает модель. Профиль сохраняется вместе с обучением.');refresh();
 }catch(e){note(e.message);refresh();}}
$('scoreFind').onclick=find;$('scoreTrack').onclick=track;$('scoreConfirm').onclick=()=>{try{confirm();}catch(e){note(e.message);refresh();}};$('scoreUse').onclick=use;
$('scoreNumbers').onchange=()=>{$('scoreVisible').value=$('scoreNumbers').value;};
$('scorePlay').onclick=()=>{if(!loaded)return;window.labPause();openGame();$('play').click();};
$('rewardMode').addEventListener('change',()=>{const mode=$('rewardMode').value;if(mode==='score'&&!proof){draftBackup=profileValues();draftBackup.rewardMode=priorMode==='score'?'manual':priorMode;delete draftBackup.scoreSource;}else{draftBackup=null;priorMode=mode;}refresh();});
function abortDraft(){if($('rewardMode').value!=='score'||proof)return;const backup=draftBackup;for(const id of profileFields)if(backup){const e=$(id);if(e.type==='checkbox')e.checked=backup[id];else e.value=backup[id];}if(!backup)$('rewardMode').value='manual';proof=backup?.scoreSource||null;draftBackup=null;priorMode=$('rewardMode').value;refresh();}
window.scoreRewards={refresh,proof:()=>proof,abortDraft,restore:value=>{draftBackup=null;priorMode=$('rewardMode').value;proof=value||null;snapshot=null;rows=[];choices=[];first=last=null;context=identity();refresh();},find,track,confirm,use};refresh();
})();
