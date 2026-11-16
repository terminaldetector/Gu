/* Game-first navigation: emulator, saves, settings and the AGOD research pages. No agent routes. */
'use strict';
(()=>{
 const body=document.body,main=document.querySelector('main');
 const shell=document.createElement('section');shell.id='consoleShell';
 shell.innerHTML='<header id="consoleHeader"><button id="consoleBack" aria-label="Назад">‹</button><h1 id="consoleTitle">GU</h1></header><nav id="consoleNav" class="console-list" aria-label="Меню приложения"></nav><div id="consoleContent"></div><p id="consoleMessage" role="status" aria-live="polite"></p>';
 main.before(shell);body.classList.add('emulator-shell');
 const nav=$('consoleNav'),content=$('consoleContent'),message=$('consoleMessage');
 let current='home',stack=['home'],rendering=false,resumePlaying=false,navigationVersion=0,actionVersion=0,loadIntent=null;
 const portals=[];
 const titles={home:'GU',open:'Открыть игру',recent:'Недавние игры','game-actions':'Действия с игрой',saves:'Сохранения игры',options:'Настройки',input:'Клавиатура и геймпад',lab:'Лаборатория',about:'О приложении',audio:'Звук',timing:'Скорость игры','settings-display':'Видео','settings-touch':'Экранное управление','settings-pad':'Геймпад','settings-keyboard':'Клавиатура','settings-console':'Система','settings-diagnostics':'Диагностика','settings-appearance':'Интерфейс','settings-landscape':'Альбомная ориентация'};
 function say(text,error=false){message.textContent=text;message.className=error?'error':'';}
 function restore(){for(const [node,marker]of portals.splice(0)){marker.replaceWith(node);node.classList.remove('console-category-active');}content.replaceChildren();}
 function mount(node){if(!node)return;const marker=document.createComment('console-menu-position');node.replaceWith(marker);portals.push([node,marker]);node.classList.add('console-category-active');content.append(node);}
 function paragraph(text){const p=document.createElement('p');p.textContent=text;content.append(p);return p;}
 function row(id,label,action,{disabled=false,detail='',arrow=true}={}){
  const button=document.createElement('button');button.id=id;button.disabled=disabled;button.type='button';
  const text=document.createElement('span');text.textContent=label;button.append(text);
  if(detail){const small=document.createElement('small');small.textContent=detail;button.append(small);}
  if(arrow){const glyph=document.createElement('span');glyph.className='console-chevron';glyph.textContent='›';glyph.setAttribute('aria-hidden','true');button.append(glyph);}
  button.onclick=async()=>{actionVersion++;try{await action();}catch(error){say(error.message||String(error),true);}};nav.append(button);return button;
 }
 const link=(id,label,route,options)=>row(id,label,()=>go(route),options);
 const romTitle=()=>loaded?$('romName').textContent.replace(/ · [a-f0-9]{12}$/,''):'Игра не открыта';
 function cancelKeyBinding(){if(bindingKey){bindingKey=false;$('bindKey').textContent='Назначить клавишу';}}
 function clearLoadIntent(){loadIntent=null;try{sessionStorage.removeItem('gu-console-library-intent');}catch(_){}}
 function pauseForMenu(remember=true){cancelKeyBinding();if(remember&&body.classList.contains('game-mode'))resumePlaying=playing;if(playing)window.labPause();holding.clear();controllerMasks.clear();refreshManual();controlsEnabled(false);}
 function gameOpened(){restore();shell.hidden=true;body.classList.remove('console-home','console-menu-page');current='game';navigationVersion++;clearLoadIntent();}
 function resume(forcePlay=true){
  if(!loaded){say('Сначала откройте игру.',true);return;}
  openGame();
  if((forcePlay||resumePlaying)&&!playing)$('play').click();
 }
 async function gameOperation(op){if(!loaded)throw Error('Сначала откройте игру');await window.labGameStates[op]('quick');say(op==='save'?'Состояние игры сохранено.':'Состояние игры загружено.');}
 function gameActions(){
  row('navPlay','Продолжить игру',()=>resume(),{disabled:!loaded,detail:romTitle()});
  row('navQuickSave','Быстрое сохранение',()=>gameOperation('save'),{disabled:!loaded,arrow:false});
  row('navQuickLoad','Быстрая загрузка',()=>gameOperation('load'),{disabled:!loaded,arrow:false});
  link('navSlots','Все сохранения','saves',{disabled:!loaded});
  row('navReset','Перезапустить игру',()=>{if(confirm('Перезапустить игру с начала?')){$('resetNes').click();say('Игра перезапущена.');}},{disabled:!loaded,arrow:false});
  link('navMainMenu','Главное меню','home');
 }
 function root(){
  const last=$('continueLastGame');row('navResume','Продолжить игру',()=>{if(loaded)resume();else last?.click();},{disabled:!loaded&&(!last||last.disabled),detail:loaded?romTitle():''});
  link('navOpen','Открыть игру','open');link('navRecent','Недавние игры','recent');
  link('navSystem','Действия с игрой','game-actions',{disabled:!loaded});
  link('navTouch','Экранное управление','settings-touch');link('navInput','Клавиатура и геймпад','input');
  link('navOptions','Настройки','options');
  link('navLab','Лаборатория','lab');link('navDiagnostics','Диагностика','settings-diagnostics');link('navAbout','О приложении','about');
  if(typeof window.FlyBridge?.finishExit==='function')row('navExit','Сохранить и выйти',()=>window.labRequestExit(),{arrow:false});
 }
 function render(route){
  restore();nav.replaceChildren();say('');content.dataset.route=route;shell.hidden=false;body.classList.toggle('console-home',route==='home');body.classList.add('console-menu-page');
  $('consoleTitle').textContent=titles[route]||({'learned':'Обученная модель','two-players':'Два игрока'})[route]||'Лаборатория';
  $('consoleBack').hidden=route==='home'&&!loaded;nav.hidden=false;
  if(route==='home')root();
  else if(route==='game-actions')gameActions();
  else if(route==='open'){
   paragraph('Выберите игровую систему и откройте файл ROM или ZIP.');mount(document.querySelector('[data-page="platform"]'));content.querySelector('[data-page]')?.removeAttribute('hidden');
  }else if(route==='recent'){
   const library=document.querySelector('.rom-library');if(library){mount(library);const details=library.querySelector('details');details.open=true;window.labLibrary?.refresh().catch(error=>say(error.message,true));}else paragraph('Недавние игры сохраняются в Android-приложении. Откройте ROM через главное меню.');
  }else if(route==='saves'){
   paragraph('Сохранённые состояния текущей игры.');mount(document.querySelector('.snapshots'));window.labGameStates?.list().catch(error=>say(error.message,true));
  }else if(route==='options'){
   for(const [id,label,target]of [['navVideo','Видео','settings-display'],['navAudio','Звук','audio'],['navTiming','Скорость игры','timing'],['navConsole','Система','settings-console'],['navLandscape','Альбомная ориентация','settings-landscape'],['navAppearance','Интерфейс','settings-appearance']])link(id,label,target);
  }else if(route==='input'){
   link('navPad','Геймпад','settings-pad');link('navKeyboard','Клавиатура','settings-keyboard');link('navInputTouch','Экранные кнопки','settings-touch');
  }else if(route.startsWith('settings-')){
   mount($(route));
   if(route==='settings-keyboard'||route==='settings-pad')content.querySelector('details')?.setAttribute('open','');
  }else if(route==='audio'){
   const button=document.createElement('button');button.id='consoleAudioToggle';button.textContent=$('audio').textContent;button.onclick=()=>{$('audio').click();button.textContent=$('audio').textContent;};content.append(button);paragraph('При ускорении звук автоматически приглушается.');
  }else if(route==='timing'){
   const label=document.createElement('label');label.htmlFor='consoleSpeed';label.textContent='Скорость эмуляции';const select=document.createElement('select');select.id='consoleSpeed';for(const rate of [1,2,3,5,10]){const option=document.createElement('option');option.value=rate;option.textContent='×'+rate;select.append(option);}select.value=String(emulationRate);select.onchange=()=>setEmulationRate(Number(select.value));content.append(label,select);paragraph('Достижимая скорость зависит от устройства.');
  }else if(route==='lab'){
   for(const [id,label,target]of [['navLabResearch','Исследование цели игры (AGOD)','legacy-research'],['navLabPlatform','Тестовые картриджи','legacy-platform']])link(id,label,target);
  }else if(route==='about'){paragraph('GU · 2.1.4');paragraph('Эмулятор NES, SNES, Mega Drive и Game Boy с автономным модулем исследования цели игры (AGOD). Работает без сети.');link('navAboutDiagnostics','Диагностический отчёт','settings-diagnostics');}
  else if(route.startsWith('legacy-')){
   const tab=route.slice(7);body.classList.remove('console-menu-page','console-home');showTab(tab);if(tab==='info')document.querySelectorAll('.settings-category').forEach(el=>el.classList.add('console-category-active'));
  }
  window.scrollTo(0,0);requestAnimationFrame(()=>nav.querySelector('button:not(:disabled)')?.focus({preventScroll:true}));
 }
 function go(route,{replace=false,preserveResume=false}={}){
  if(rendering)return;rendering=true;
  try{navigationVersion++;actionVersion++;clearLoadIntent();pauseForMenu(!preserveResume);if($('quickMenu').open)$('quickMenu').close();leaveGame('info');if(replace||route==='home')stack=[route];else if(stack.at(-1)!==route)stack.push(route);current=route;render(route);window.guLogger?.event('navigation.page',{page:route});}
  finally{rendering=false;}
 }
 const previousBack=window.labBack;
 function back(){
  if(bindingKey){cancelKeyBinding();return true;}
  if(window.userInterface?.editing()||window.userInterface?.binding()||$('quickMenu').open)return previousBack?.()||false;
  if(body.classList.contains('game-mode')){stack=['home'];go('game-actions');return true;}
  if(stack.length>1){stack.pop();go(stack.at(-1));return true;}
  if(loaded){resume(false);return true;}return window.labRequestExit?.()||false;
 }
 window.consoleNavigation={go,legacy:tab=>go('legacy-'+tab),back,resume,pause:pauseForMenu,gameOpened,legacyOpened:tab=>{if(!rendering)go(tab==='game'?'home':'legacy-'+tab);},page:()=>current};
 window.labBack=back;$('consoleBack').onclick=back;$('gameExit').onclick=()=>{stack=['home'];go('game-actions');};
 document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||bindingKey||window.userInterface?.binding()||window.userInterface?.editing())return;
  const code=event.code||event.key;
  if(code==='Escape'){if(back()){event.preventDefault();event.stopPropagation();}return;}
  if(body.classList.contains('game-mode')||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;
  const keys=[...shell.querySelectorAll('button:not(:disabled),select,input')].filter(el=>el.getClientRects().length);
  if(code==='ArrowDown'||code==='ArrowUp'){const next=(keys.indexOf(document.activeElement)+(code==='ArrowDown'?1:-1)+keys.length)%keys.length;if(keys.length)keys[next].focus();event.preventDefault();}
  else if(event.keyCode===96){document.activeElement?.click();event.preventDefault();}
  else if(event.keyCode===97){back();event.preventDefault();}
 });
 document.querySelectorAll('[data-settings-target]').forEach(button=>button.addEventListener('click',()=>go(button.dataset.settingsTarget)));
 window.addEventListener('lab-rom-open-request',event=>{const row=event.detail;if(!row||!Object.hasOwn(FlyPlatforms,row.system)||!/^[a-f0-9]{64}$/.test(row.sha256))return;loadIntent={hash:row.sha256,system:row.system,version:navigationVersion};try{sessionStorage.setItem('gu-console-library-intent',JSON.stringify({hash:row.sha256,system:row.system}));}catch(_){}});
 window.addEventListener('lab-rom-open-failed',event=>{if(loadIntent?.hash===event.detail?.sha256&&loadIntent?.system===event.detail?.system)clearLoadIntent();});
 window.addEventListener('lab-rom-loaded',event=>{if(event.detail?.userOpened&&current==='open'||loadIntent&&loadIntent.version===navigationVersion&&loadIntent.hash===romHash&&loadIntent.system===labPlatform)resume();else if(current==='home')render('home');});
 if($('continueLastGame'))new MutationObserver(()=>{if(current==='home')render('home');}).observe($('continueLastGame'),{attributes:true,attributeFilter:['disabled']});
 new MutationObserver(()=>{if(!body.classList.contains('game-mode')&&$('status').classList.contains('error'))say($('status').textContent,true);}).observe($('status'),{childList:true,characterData:true,subtree:true});
 $('platformSelect').addEventListener('change',()=>{try{sessionStorage.setItem('gu-console-open','1');}catch(_){}});
 const readableSpeed=()=>{const button=$('gameBoost'),label=button.textContent.replace(/^Цель\s+/,'');if(button.textContent!==label)button.textContent=label;};
 new MutationObserver(readableSpeed).observe($('gameBoost'),{childList:true,characterData:true,subtree:true});readableSpeed();
 window.addEventListener('blur',cancelKeyBinding);
 for(const id of ['uiLandscapePanel','uiLandscapeMonitors','uiLandscapeMonitorPosition'])$(id).closest('.row > div')?.classList.add('console-research-only');
 const oldLandscapeHelp=$('uiLandscapeInput').closest('.row')?.nextElementSibling;if(oldLandscapeHelp?.tagName==='P')oldLandscapeHelp.classList.add('console-research-only');
 let initial='home',libraryIntent=null;try{if(sessionStorage.getItem('gu-console-open')==='1'){initial='open';sessionStorage.removeItem('gu-console-open');}const raw=sessionStorage.getItem('gu-console-library-intent');if(raw){const row=JSON.parse(raw);if(row.system===labPlatform&&/^[a-f0-9]{64}$/.test(row.hash)){libraryIntent=row;initial='recent';}}}catch(_){}
 go(initial,{replace:true});if(libraryIntent)loadIntent={...libraryIntent,version:navigationVersion};
})();
