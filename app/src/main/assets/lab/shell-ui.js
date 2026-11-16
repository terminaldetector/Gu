/* Touch quick menu: pause, game snapshots, resume and exit. */
'use strict';
(()=>{
const menu=$('quickMenu');let wantedPlay=false;
function close(){menu.close();controlsEnabled(document.body.classList.contains('game-mode'));}
function quick(){
 if(menu.open)return;wantedPlay=playing;window.labPause();holding.clear();refreshManual();controlsEnabled(false);
 $('quickContext').textContent=FlyPlatforms[labPlatform].label+' · '+$('romName').textContent;
 $('quickSave').disabled=$('quickLoad').disabled=$('quickReset').disabled=$('quickResume').disabled=!loaded;
 $('quickSaveStatus').textContent='Игра на паузе.';$('quickSaveStatus').className='note';menu.showModal();
}
$('gameExit').onclick=quick;$('gameSettings').onclick=()=>{window.labPause();leaveGame('info');};
$('quickDismiss').onclick=close;menu.addEventListener('cancel',event=>{event.preventDefault();close();});
$('quickResume').onclick=()=>{close();openGame();if(wantedPlay&&!playing)$('play').click();};
for(const [quickId,op]of [['quickSave','save'],['quickLoad','load']])$(quickId).onclick=async()=>{
 $('quickSave').disabled=$('quickLoad').disabled=true;
 try{await window.labGameStates[op]('quick');$('quickSaveStatus').textContent=op==='save'?'Быстрый снимок игры сохранён.':$('status').textContent;$('quickSaveStatus').className='note';}
 catch(e){$('quickSaveStatus').textContent='Снимок игры: '+e.message;$('quickSaveStatus').className='note error';}
 finally{$('quickSave').disabled=$('quickLoad').disabled=!loaded;}
};
$('quickReset').onclick=()=>{$('resetNes').click();$('quickSaveStatus').textContent=$('status').textContent;};
menu.querySelectorAll('[data-quick-tab]').forEach(button=>button.onclick=()=>{close();leaveGame(button.dataset.quickTab);});
document.querySelector('.app-header .eyebrow').textContent='GAME CONSOLE · AGOD';
document.querySelector('.app-header h1').textContent='FlyConsole';
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
