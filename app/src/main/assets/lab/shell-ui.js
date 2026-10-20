/* Touch quick menu, separate from the running emulator and learning engines. */
'use strict';
(()=>{
const menu=$('quickMenu');let wantedPlay=false,wantedLink=false;
function close(){menu.close();controlsEnabled(document.body.classList.contains('game-mode'));}
function quick(){
 if(menu.open)return;wantedPlay=playing;wantedLink=connected;window.labPause();holding.clear();refreshManual();controlsEnabled(false);
 $('quickContext').textContent=FlyPlatforms[labPlatform].label+' · '+$('romName').textContent+' · '+(graphIdentity?.modelId||'модель загружается');
 $('quickSave').disabled=$('quickLoad').disabled=$('quickReset').disabled=$('quickResume').disabled=!loaded;
 const fault=window.labAgentStatus?.().failure;
 $('quickSaveStatus').textContent=fault?'Последняя ошибка агента: '+fault.message+' · ручная игра доступна.':'Сохраняю текущее обучение…';menu.showModal();
 window.labState.checkpoint().then(()=>{$('quickSaveStatus').textContent=fault?'Последняя ошибка агента: '+fault.message+' · веса не объявлены проверенными.':'Настройки и текущее обучение сохранены.';$('quickSaveStatus').className=fault?'note error':'note';}).catch(e=>{$('quickSaveStatus').textContent='Сохранение: '+e.message;$('quickSaveStatus').className='note error';});
}
$('gameExit').onclick=quick;$('gameSettings').onclick=()=>{window.labPause();leaveGame('info');};
$('quickDismiss').onclick=close;menu.addEventListener('cancel',event=>{event.preventDefault();close();});
$('quickResume').onclick=()=>{close();openGame();if(wantedLink&&!window.dualAgents?.active())connectBrain();if(wantedPlay&&!playing)$('play').click();};
for(const [quickId,op]of [['quickSave','save'],['quickLoad','load']])$(quickId).onclick=async()=>{
 $('quickSave').disabled=$('quickLoad').disabled=true;
 try{await window.labGameStates[op]('quick');$('quickSaveStatus').textContent=op==='save'?'Быстрый снимок игры сохранён. Веса хранятся отдельно.':$('status').textContent;$('quickSaveStatus').className='note';}
 catch(e){$('quickSaveStatus').textContent='Снимок игры: '+e.message;$('quickSaveStatus').className='note error';}
 finally{$('quickSave').disabled=$('quickLoad').disabled=!loaded;}
};
$('quickReset').onclick=()=>{$('resetNes').click();$('quickSaveStatus').textContent=$('status').textContent;};
menu.querySelectorAll('[data-quick-tab]').forEach(button=>button.onclick=()=>{close();leaveGame(button.dataset.quickTab);});
document.querySelector('.app-header .eyebrow').textContent='CONNECTOME CONSOLE';
document.querySelector('.app-header h1').textContent='FlyConsole';$('console').textContent='Код · LAB';
window.labQuickMenu=quick;
let exiting=false;
window.labRequestExit=()=>{
 if(!window.FlyBridge||typeof FlyBridge.finishExit!=='function')return false;
 if(exiting)return true;exiting=true;const hash=romHash;
 const saving=window.labState.suspend(),fence=generation;
 saving.then(result=>{
  if(playing||generation!==fence||romHash!==hash){status('Выход отменён: игровая сессия изменилась.');return;}
  if(!result.gameSaved){status('Не удалось сохранить игру перед выходом: '+result.error,true);return;}
  FlyBridge.finishExit(JSON.stringify({...result,generation:fence,romHash:hash}));
 }).catch(e=>status('Выход: '+e.message,true)).finally(()=>{exiting=false;});return true;
};
if(window.FlyBridge&&typeof FlyBridge.finishExit==='function'){const exit=document.createElement('button');exit.id='quickExit';exit.textContent='Сохранить и выйти';exit.onclick=window.labRequestExit;menu.querySelector('.quick-list').append(exit);}
window.labBack=()=>{if(menu.open){close();return true;}if(document.body.classList.contains('game-mode')){quick();return true;}return loaded?window.labRequestExit():false;};
})();
