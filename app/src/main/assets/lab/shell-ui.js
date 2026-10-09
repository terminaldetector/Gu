/* Touch quick menu, separate from the running emulator and learning engines. */
'use strict';
(()=>{
const menu=$('quickMenu');let wantedPlay=false,wantedLink=false;
function close(){menu.close();controlsEnabled(document.body.classList.contains('game-mode'));}
function quick(){
 if(menu.open)return;wantedPlay=playing;wantedLink=connected;window.labPause();holding.clear();refreshManual();controlsEnabled(false);
 $('quickContext').textContent=FlyPlatforms[labPlatform].label+' · '+$('romName').textContent+' · '+(graphIdentity?.modelId||'модель загружается');
 $('quickSave').disabled=$('quickLoad').disabled=$('quickResume').disabled=!loaded;
 $('quickSaveStatus').textContent='Сохраняю подтверждённое обучение…';menu.showModal();
 window.labState.checkpoint().then(()=>{$('quickSaveStatus').textContent='Настройки и обучение сохранены.';$('quickSaveStatus').className='note';}).catch(e=>{$('quickSaveStatus').textContent='Сохранение: '+e.message;$('quickSaveStatus').className='note error';});
}
$('gameExit').onclick=quick;$('gameSettings').onclick=()=>{window.labPause();leaveGame('info');};
$('quickDismiss').onclick=close;menu.addEventListener('cancel',event=>{event.preventDefault();close();});
$('quickResume').onclick=()=>{close();openGame();if(wantedLink&&!window.dualAgents?.active())connectBrain();if(wantedPlay&&!playing)$('play').click();};
for(const [quickId,original]of [['quickSave','saveState'],['quickLoad','loadState']])$(quickId).onclick=()=>{$(original).click();$('quickSaveStatus').textContent=$('status').textContent;};
menu.querySelectorAll('[data-quick-tab]').forEach(button=>button.onclick=()=>{close();leaveGame(button.dataset.quickTab);});
document.querySelector('.app-header .eyebrow').textContent='CONNECTOME CONSOLE';
document.querySelector('.app-header h1').textContent='FlyConsole';$('console').textContent='Код · LAB';
window.labQuickMenu=quick;
window.labBack=()=>{if(menu.open){close();return true;}if(document.body.classList.contains('game-mode')){quick();return true;}return false;};
})();
