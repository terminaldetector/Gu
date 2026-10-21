/* Compact, in-game agent controls. Full model/research settings stay in the console menu. */
'use strict';
(()=>{
 const toggle=document.createElement('button');toggle.id='gameAgentToggle';toggle.type='button';
 toggle.innerHTML='<span class="agent-bars" aria-hidden="true"><i></i><i></i><i></i></span><span>Агент</span>';
 toggle.setAttribute('aria-label','Быстрые настройки агента');toggle.setAttribute('aria-haspopup','dialog');toggle.setAttribute('aria-controls','agentQuickPanel');toggle.setAttribute('aria-expanded','false');
 $('gameToolbar').append(toggle);
 const panel=document.createElement('dialog');panel.id='agentQuickPanel';panel.setAttribute('aria-labelledby','agentQuickTitle');panel.setAttribute('aria-describedby','agentQuickStatus');
 panel.innerHTML='<header><div><h2 id="agentQuickTitle">Агент</h2><p id="agentQuickStatus"></p></div><button id="agentQuickClose" type="button" aria-label="Закрыть настройки агента">✕</button></header><div class="agent-quick-modes" role="group" aria-label="Управление игрой"><button id="agentQuickManual" type="button" aria-pressed="false"><strong>Ручной</strong><small>Вы управляете игрой</small></button><button id="agentQuickAuto" type="button" aria-pressed="false"><strong>AUTO</strong><small>Коннектом управляет игрой</small></button><button id="agentQuickEval" type="button" aria-pressed="false"><strong>Без обучения</strong><small>Агент играет с приобретёнными весами</small></button></div><p id="agentQuickFeedback"></p><p id="agentQuickMessage" role="status" aria-live="polite"></p><button id="agentQuickMore" type="button">Все настройки агента <span aria-hidden="true">›</span></button>';
 document.body.append(panel);
 let session=null,busy=false,failed=false,version=0;
 const buttons=()=>[...panel.querySelectorAll('button:not(:disabled)')];
 function feedback(){
  if($('rewardMode').value==='diagnostic'&&labPlatform==='nes'&&romHash===diagnosticHash)return 'Обратная связь: встроенный тест NES.';
  if($('rewardMode').value==='ram')return 'Обратная связь: настроенный RAM-профиль. Достоверность зависит от профиля.';
  if($('rewardMode').value==='score'){
   try{const p=profileValues();FlyScoreSearch.validate(p.scoreSource,p,labPlatform,romHash,ramLimit);return 'Обратная связь: подтверждённый источник счёта.';}catch(_){}
  }
  return 'Награда не подтверждена. AUTO может действовать; неизвестный результат не обучает сеть.';
 }
 function refresh(){
  if(!session)return;
  const labels={manual:'Ручной',auto:'AUTO',eval:'Без обучения',rec:'Запись примера',assist:'Подсказки',dual:'Два агента',external:'Внешний адаптер'};
  $('agentQuickStatus').textContent=(labels[session.mode]||'Агент')+' · '+(busy?'настройка…':'игра на паузе');
  for(const [id,kind]of [['agentQuickManual','manual'],['agentQuickAuto','auto'],['agentQuickEval','eval']]){
   $(id).setAttribute('aria-pressed',String(session.mode===kind));$(id).disabled=busy||kind!=='manual'&&(!ready||romLoading||window.learningUI.busy());
  }
  $('agentQuickMore').disabled=busy;$('agentQuickFeedback').textContent=!ready?'Коннектом загружается. Ручное управление доступно.':feedback();
 }
 function sameGame(s){return s&&loaded&&s.core===nes&&s.hash===romHash&&document.body.classList.contains('game-mode');}
 function dismiss(resume=true){
  if(!panel.open)return;
  const previous=session,canResume=resume&&!failed&&!busy&&sameGame(previous)&&previous.generation===generation;
  version++;session=null;panel.close();toggle.setAttribute('aria-expanded','false');
  if(busy)window.labPause();busy=false;
  controlsEnabled(playing&&document.body.classList.contains('game-mode'));
  if(canResume){
   const closedVersion=version,pausedGeneration=generation;
   // A boundary ACK can contain acquired deltas. Adopt it before any reconnect configuration.
   Promise.resolve(previous.mode!=='manual'&&previous.mode!=='dual'?window.fdbAgent?.drain():null).then(()=>{
    if(version!==closedVersion||panel.open||!sameGame(previous)||generation!==pausedGeneration)return;
    if(previous.mode!=='manual'&&previous.mode!=='dual'&&window.fdbAgent?.error())throw Error(window.fdbAgent.error());
    window.consoleNavigation.resume(false);
   }).catch(error=>{if(version===closedVersion&&sameGame(previous)){window.labPause();status('Агент остаётся на паузе: '+error.message,true);}});
  }
  if(document.body.classList.contains('game-mode'))toggle.focus({preventScroll:true});
 }
 function open(){
  if(panel.open){dismiss();return;}
  if(!document.body.classList.contains('game-mode'))return;
  const pair=window.dualAgents?.active(),linked=connected||pair;
  session={core:nes,hash:romHash,mode:pair?'dual':!linked?'manual':$('learnerController').value!=='exo'?'external':window.learningUI.phase()};
  failed=false;busy=false;version++;$('agentQuickMessage').textContent='';
  window.consoleNavigation.pause();session.generation=generation;
  panel.showModal();toggle.setAttribute('aria-expanded','true');controlsEnabled(false);refresh();
  (buttons().find(button=>button.getAttribute('aria-pressed')==='true')||$('agentQuickClose')).focus({preventScroll:true});
  window.guLogger?.event('agent.quick-panel',{open:true,mode:session.mode});
 }
 async function select(kind){
  if(busy||!panel.open)return;
  const s=session,request=++version;busy=true;failed=false;$('agentQuickMessage').textContent='';refresh();
  const valid=()=>panel.open&&session===s&&request===version&&sameGame(s)&&!document.hidden;
  try{
   const started=await window.consoleNavigation.playMode(kind,{guard:valid});
   if(!valid())return;
   if(!started)throw Error(window.labAgentStatus?.().failure?.message||'Режим не запущен. Проверьте состояние агента и повторите.');
   busy=false;window.guLogger?.event('agent.quick-mode',{mode:kind});dismiss(false);
  }catch(error){
   if(!valid())return;
   failed=true;window.labPause();s.generation=generation;
   $('agentQuickMessage').textContent=String(error.message||error)+' Игра остаётся на паузе.';
   window.guLogger?.event('agent.quick-mode-error',{mode:kind,message:String(error.message||error)},'error');
  }finally{if(session===s){busy=false;refresh();}}
 }
 toggle.onclick=open;$('agentQuickClose').onclick=()=>dismiss();
 for(const [id,kind]of [['agentQuickManual','manual'],['agentQuickAuto','auto'],['agentQuickEval','eval']])$(id).onclick=()=>select(kind);
 $('agentQuickMore').onclick=()=>{const preserveResume=!failed&&session?.generation===generation;dismiss(false);window.consoleNavigation.go('agent',{preserveResume});};
 panel.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 // A tap outside is a dismissal; scrolling within a short landscape window stays local.
 let outside=false;
 panel.addEventListener('pointerdown',event=>{outside=event.target===panel&&!inside(event);});
 panel.addEventListener('click',event=>{if(outside&&event.target===panel&&!inside(event))dismiss();outside=false;});
 function inside(event){const r=panel.getBoundingClientRect();return event.clientX>=r.left&&event.clientX<=r.right&&event.clientY>=r.top&&event.clientY<=r.bottom;}
 const previousBack=window.labBack;window.labBack=()=>{if(panel.open){dismiss();return true;}return previousBack?.()||false;};
 window.addEventListener('keydown',event=>{
  if(!panel.open)return;
  event.stopImmediatePropagation();
  if(event.code==='Escape'||event.keyCode===97){event.preventDefault();dismiss();return;}
  const keys=buttons(),index=keys.indexOf(document.activeElement);
  if(event.code==='Tab'){
   event.preventDefault();keys[(index+(event.shiftKey?-1:1)+keys.length)%keys.length]?.focus();
  }else if(['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.code)){
   event.preventDefault();keys[(index+(['ArrowDown','ArrowRight'].includes(event.code)?1:-1)+keys.length)%keys.length]?.focus();
  }else if(event.keyCode===96){event.preventDefault();document.activeElement?.click();}
 },true);
 window.addEventListener('keyup',event=>{if(panel.open)event.stopImmediatePropagation();},true);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)dismiss(false);});
 window.addEventListener('blur',()=>dismiss(false));
 window.addEventListener('lab-rom-loaded',()=>dismiss(false));
 window.agentQuickPanel={open,close:dismiss,active:()=>panel.open};
})();
