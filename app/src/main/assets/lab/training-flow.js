/* User-facing training phases reuse the existing learner, journal and FDB engine. */
'use strict';
(()=>{
const modes={off:'off',auto:'train',rec:'teach',assist:'train',eval:'eval'},labels={off:'Игра',auto:'AUTO · без подсказок',rec:'REC · пример человека',assist:'Подсказки в потоке',eval:'Оценка · веса заморожены'};
let busy=false,selectedGraph=null,visibleDetails=false;
const phase=()=>$('learnMode').value==='teach'?'rec':$('learnMode').value==='train'?($('liveHints').checked?'assist':'auto'):$('learnMode').value==='eval'?'eval':'off';
const pair=()=>window.dualAgents?.active();
function refresh(){
 const kind=phase(),running=pair()?window.dualAgents.running():playing&&connected;
 $('trainingKind').value=kind;$('liveTrainingMode').textContent=pair()?'P1 '+$('dual1Mode').value.toUpperCase()+' · P2 '+$('dual2Mode').value.toUpperCase():labels[kind]+(running?'':' · пауза');
 const actual=playing&&liveFps>0?(liveFps/(labPlatform==='nes'?60:nes.fps)).toFixed(2):'—';
 $('liveSpeed').textContent='×'+emulationRate+(emulationRate>1?' · факт '+actual+'×':'');$('gameBoost').textContent='×'+emulationRate;$('gameBoost').classList.toggle('active',emulationRate>1);
 $('speedStatus').textContent='Выбрано ×'+emulationRate+' · фактически '+actual+'×. Ускорение исполняет игровые кадры; при расчёте модели ждёт новое решение. Звук при ×2–×10 приглушён.';
 $('liveRecord').textContent=kind==='rec'&&running?'STOP → AUTO':'REC · показать';$('liveRecord').disabled=busy||pair();$('liveAuto').disabled=$('liveHintsButton').disabled=busy;$('liveHintsButton').disabled=busy||pair();
 $('trainingStart').disabled=busy;$('trainingKind').disabled=busy;
 for(const option of $('trainingKind').options)option.disabled=pair()&&['rec','assist'].includes(option.value);
 for(const id of ['rewardPlus','rewardMinus'])$(id).disabled=kind!=='assist'||pair();
 const help={off:'Ручная игра. Для обучения выберите один из трёх форматов.',auto:'Модель играет самостоятельно. Действия человека и ручные награды не обучают её. Критерий результата задаёт RAM-профиль; без него доступно исследование без оценки успеха.',rec:'REC: играйте сами на обычной скорости. STOP завершает и сохраняет запись, затем отдаёт управление модели в текущей игре.',assist:'Модель играет, ваши нажатия временно заменяют её действие и записываются как подсказки. Награда за этот интервал не приписывается модели. В 2P кнопка «Подсказать модели» временно направляет ввод в порт агента.',eval:'Модель использует приобретённые веса. Подражание, SARSA и FDB заморожены.'};
 $('trainingFlowHelp').textContent=pair()?'Две независимые сети: режим каждого игрока задаётся в его карточке. REC и подсказки доступны одному нейронному игроку.':help[kind];
 $('liveHintTarget').hidden=kind!=='assist'||gmodeMode==='off'||pair();$('liveHintTarget').textContent=$('hintAgent').checked?'Подсказка модели · ON':'Подсказать модели';
 if(graphIdentity?.modelId!==selectedGraph&&!window.connectomeModels?.pending()){$('partnerModel').value=graphIdentity?.modelId||'flywire-v783';selectedGraph=graphIdentity?.modelId;}
 $('partnerModel').disabled=busy||!ready||!!window.connectomeModels?.pending();$('gmodeLaunch').disabled=busy||!ready||!loaded||labPlatform==='gb'||nes?.twoPlayerSupported===false;
 $('partnerStatus').textContent='Активная модель: '+(graphIdentity?.modelId==='male-cns-v1.0'?'Male CNS':graphIdentity?.modelId==='flywire-v783'?'FlyWire':'загружается')+'. Выбранная модель загружается перед запуском напарника; её обучение восстанавливается отдельно.';
}
function rate(value){
 if(![1,2,3,5,10].includes(value))throw Error('Скорость: ×1, ×2, ×3, ×5 или ×10');
 if(benchmark&&value!==1)throw Error('Сначала завершите воспроизводимую оценку');
 if(phase()==='rec'&&value!==1){status('REC записывает пример человека на ×1. Ускорение доступно после STOP → AUTO.');value=1;}
 emulationRate=value;acceleratedFrames=0;lastFrame=performance.now();audioRead=audioWrite;$('emulationSpeed').value=String(value);refresh();
 // Reopen conservatively at ×1; speed never changes neural weights or seed.
}
function fdb(){
 if($('learnerController').value!=='exo')return;
 const value=fdbConfiguration()||{version:2,graph_sha256:graphIdentity.sha256,deltas:[],edges:[]};
 if(!value.learning)value.learning={enabled:true,rate:.05,maxEdges:256,maxWeight:32};
 else if($('learnMode').value!=='eval')value.learning.enabled=true;
 if(value.growth)value.growth.enabled=false;
 $('fdbJson').value=JSON.stringify(value,null,2);
}
function choose(kind){
 if(!Object.hasOwn(modes,kind))throw Error('Неизвестный формат обучения');
 if(pair()&&['rec','assist'].includes(kind))throw Error('Для REC / подсказок завершите две сети и выберите одного нейронного игрока.');
 window.labPause();$('learnMode').value=modes[kind];$('liveHints').checked=kind==='assist';$('hintAgent').checked=false;
 if(kind==='rec'){gmodeMode='off';$('gmode').value='off';rate(1);}
 if(kind!=='off'){$('mode').value='closed';$('clock').value='realtime';$('runMode').value='continuous';}
 learningBoundary();updateGmodeHud();refresh();
}
const startOriginal=$('trainingStart').onclick;
async function start(){
 if(busy)return;busy=true;refresh();
 try{
  await window.labState.settle();if(!loaded||!ready)throw Error('Сначала откройте ROM и дождитесь модели.');
  if(pair()){
   const mode=phase()==='eval'?'eval':'train';$('dual1Mode').value=$('dual2Mode').value=mode;await window.dualAgents.configure();return;
  }
  fdb();startOriginal();
 }catch(e){status(e.message,true);}finally{busy=false;refresh();}
}
const waitSample=()=>new Promise((resolve,reject)=>{const started=performance.now();function check(){if(pendingToken===null&&!configuring)return resolve();if(performance.now()-started>30000)return reject(Error('Сеть не подтвердила конец записи'));setTimeout(check,20);}check();});
async function stopRec(){
 if(busy)return;busy=true;refresh();
 try{
  playing=false;await window.humanTeaching.stop('rec-stop');if(window.humanTeaching.error())throw Error(window.humanTeaching.error());
  await waitSample();
  // Flush only unsubmitted, executed human labels; never replay the whole archive twice.
  while(fdbExperience.length&&connected){sampleFrame(performance.now(),true);await waitSample();}
  await window.fdbAgent.drain();if(window.fdbAgent.error())throw Error(window.fdbAgent.error());
  await window.labState.checkpoint();if($('autosavePolicy').checked)persistPolicy(false);
  choose('auto');fdb();startOriginal();status('Запись сохранена. AUTO продолжает с текущего кадра.');
 }catch(e){window.labPause();status('Запись остановлена; переход в AUTO: '+e.message,true);}finally{busy=false;refresh();}
}
async function switchLive(kind){
 if(phase()==='rec'&&playing&&connected)return stopRec();
 try{choose(kind);await start();}catch(e){status(e.message,true);}
}
$('trainingKind').onchange=()=>{try{choose($('trainingKind').value);}catch(e){status(e.message,true);refresh();}};
$('learnMode').addEventListener('change',()=>{$('liveHints').checked=false;refresh();});
$('trainingStart').onclick=start;$('emulationSpeed').onchange=()=>{try{rate(Number($('emulationSpeed').value));}catch(e){status(e.message,true);refresh();}};
$('gameBoost').onclick=()=>{try{const rates=[1,2,3,5,10];rate(rates[(rates.indexOf(emulationRate)+1)%rates.length]);}catch(e){status(e.message,true);}};
$('liveRecord').onclick=()=>phase()==='rec'&&playing&&connected?stopRec():switchLive('rec');$('liveAuto').onclick=()=>switchLive('auto');$('liveHintsButton').onclick=()=>switchLive('assist');
$('liveHintTarget').onclick=()=>{holding.clear();controllerMasks.clear();refreshManual();$('hintAgent').checked=!$('hintAgent').checked;learningBoundary();refresh();};
$('liveDetails').onclick=()=>{visibleDetails=!visibleDetails;document.body.classList.toggle('game-details',visibleDetails);$('liveDetails').setAttribute('aria-pressed',String(visibleDetails));fitVideo();};
for(const [id,value]of [['rewardPlus',1],['rewardMinus',-1]])$(id).onclick=()=>{if(phase()==='assist'&&!pair())rewardPending+=value;};
$('gmodeBoost').onchange=()=>{if($('learnerController').value==='exo'&&$('gmodeBoost').checked){$('gmodeBoost').checked=false;status('Стартовая эвристика относится к SARSA. Выберите внешний адаптер для её использования.');return;}setGmodeBoost($('gmodeBoost').checked);refresh();};
$('gmodeLaunch').onclick=async()=>{
 if(busy)return;busy=true;refresh();
 const wanted=$('partnerModel').value,route=$('gmode').value==='coop-reverse'?'coop-reverse':'coop';
 try{
  window.labPause();await window.labState.settle();
  if(graphIdentity.modelId!==wanted){await window.connectomeModels.select(wanted);const began=performance.now();while(window.connectomeModels.pending()){if(performance.now()-began>121000)throw Error('Модель не подтвердила загрузку');await new Promise(r=>setTimeout(r,25));}if(graphIdentity.modelId!==wanted)throw Error('Выбранная модель не загружена');await window.labState.settle();}
  if(window.dualAgents.active()&&!await window.dualAgents.exit())throw Error('Не удалось сохранить две сети');
  $('gmode').value=route;setGMode(route);$('learnerController').value='exo';$('gmodeBoost').checked=false;gmodeBoost=false;gmodeBoostBackup=null;
  $('learnMode').value='train';$('liveHints').checked=false;$('mode').value='closed';$('clock').value='realtime';$('runMode').value='continuous';
  fdb();startOriginal();
 }catch(e){status('Напарник не запущен: '+e.message,true);}finally{busy=false;refresh();}
};
window.learningUI={phase,refresh,choose,start,stopRec,rate,busy:()=>busy};refresh();
})();
