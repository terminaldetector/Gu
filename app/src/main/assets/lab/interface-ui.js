/* Presentation, touch layout and physical input preferences. No model parameters live here. */
'use strict';
(()=>{
const prefs=FlyInterfaceSettings,body=document.body,root=document.documentElement;
const groups={dpad:document.querySelector('.dpad'),actions:document.querySelector('.actions'),system:document.querySelector('.system-pad')};
const fields={uiTheme:'theme',uiAccent:'accent',uiDensity:'density',uiShape:'shape',uiOpacity:'opacity',uiDpadScale:'dpadScale',uiActionScale:'actionScale',uiGap:'gap',uiInset:'inset',uiVisible:'visible',uiLeftHanded:'leftHanded',uiVideoFit:'videoFit',uiVideoScale:'videoScale'};
const landscapeFields={uiLandscapePanel:'panel',uiLandscapeInput:'input',uiLandscapeLayout:'screenLayout',uiLandscapeFit:'videoFit',uiLandscapeScale:'videoScale',uiLandscapeX:'offsetX',uiLandscapeY:'offsetY',uiLandscapeSides:'sideSpace',uiLandscapeDpad:'dpadScale',uiLandscapeActions:'actionScale',uiLandscapeMonitors:'monitors',uiLandscapeMonitorPosition:'monitorPlacement',uiLandscapeFullscreen:'fullscreen'};
let settings=prefs.defaults(),saveBlocked=false,editing=false,drag=null,layoutQueued=false,binding=false,deviceError='';
let lastFullscreen=false;
const devices=new Map(),physicalKey='fly-physical-pad-v1-'+labPlatform;
let physicalMaps=Object.create(null);
function notice(message,error=false){$('interfaceStatus').textContent=message;$('interfaceStatus').className='note'+(error?' error':'');}
try{settings=prefs.read(localStorage,labPlatform);}catch(e){saveBlocked=true;notice(e.message+'. Сбросьте только оформление, чтобы сохранить новые настройки.',true);}
try{
 const raw=localStorage.getItem(physicalKey);
 if(raw!==null){const v=JSON.parse(raw);if(raw.length>131072||v.version!==1||!v.devices||typeof v.devices!=='object'||Array.isArray(v.devices)||Object.keys(v.devices).length>32)throw Error('Назначения геймпада повреждены');
  for(const [descriptor,map]of Object.entries(v.devices)){if(!descriptor||descriptor.length>512)throw Error('Неверное устройство');physicalMaps[descriptor]=prefs.mappings(map,buttonNames.length-1);}}
}catch(e){deviceError=e.message;physicalMaps=Object.create(null);}
function save(){if(saveBlocked)return false;try{prefs.write(localStorage,labPlatform,settings);notice('Настройки экрана и управления сохранены.');return true;}catch(e){notice('Сохранение интерфейса: '+e.message,true);return false;}}
function orientation(){return innerWidth>innerHeight?'landscape':'portrait';}
function viewport(){return{width:innerWidth,height:innerHeight};}
function minTop(){return Math.min(innerHeight/3,Math.max($('gameToolbar').getBoundingClientRect().bottom+4,body.classList.contains('landscape-compact')?0:$('liveTrainingBar').getBoundingClientRect().bottom+4,editing?$('touchEditorBar').getBoundingClientRect().bottom+4:0));}
function inset(){const s=getComputedStyle($('gamePanel'));return Math.max(settings.inset,parseFloat(s.paddingLeft)||0,parseFloat(s.paddingRight)||0);}
function clearPosition(el){for(const name of ['position','left','top','right','bottom','transform','width','height','z-index'])el.style.removeProperty(name);el.classList.remove('individual-position');}
function place(el,p){const r=el.getBoundingClientRect(),at=prefs.position(p,r.width,r.height,viewport(),minTop(),inset());el.style.position='fixed';el.style.left=at.x+'px';el.style.top=at.y+'px';el.style.right='auto';el.style.bottom='auto';el.style.transform='none';el.style.zIndex='11';}
function layout(){
 if(!body.classList.contains('game-mode')||drag)return;
 profile();
 for(const el of Object.values(groups))clearPosition(el);
 for(const el of document.querySelectorAll('.individual-position'))clearPosition(el);
 const landscape=orientation()==='landscape',gap=settings.gap,edge=inset(),scale=Number($('touchScale').value)||1,cols=buttonNames.length===12?3:2;
 // Reserve video space first. Sizes can be requested larger, but never exceed the available rails.
 const rail=Math.max(81,cols*25+(cols-1)*gap,Math.min(220,innerWidth*settings.landscape.sideSpace,(innerWidth-110)/2));
 const dRail=landscape?rail:Math.max(65,(innerWidth-2*edge-12)/2);
 const aRail=landscape?rail:Math.max(65,(innerWidth-2*edge-12)/2);
 const heightBudget=landscape?Math.max(70,innerHeight-minTop()-edge):Math.max(70,Math.min(innerHeight*.27,innerHeight-270));
 const dKey=Math.max(25,Math.min((landscape?56:46)*scale*settings.dpadScale*(landscape?settings.landscape.dpadScale:1),(dRail-6)/3,(heightBudget-6)/3));
 const aKey=Math.max(25,Math.min((landscape?56:46)*scale*settings.actionScale*(landscape?settings.landscape.actionScale:1),(aRail-(cols-1)*gap)/cols,(heightBudget-gap)/2));
 root.style.setProperty('--dpad-key',dKey+'px');root.style.setProperty('--action-key',aKey+'px');
 // A left-handed layout needs the same space for the larger of the two groups.
 const widthD=dKey*3+6,widthA=aKey*cols+(cols-1)*gap,left=settings.leftHanded?widthA:widthD,right=settings.leftHanded?widthD:widthA;
 for(const el of [$('gamePanel'),document.querySelector('.screen-stage')]){el.style.setProperty('--left-rail',(landscape?Math.max(left+edge,rail):0)+'px');el.style.setProperty('--right-rail',(landscape?Math.max(right+edge,rail):0)+'px');}
 const custom=settings.layouts[orientation()];
 for(const name of ['dpad','actions','system'])if(custom[name])place(groups[name],custom[name]);
 for(const [button,p]of Object.entries(custom.buttons||{})){
  const el=document.querySelector('[data-button="'+button+'"]');if(!el||el.hidden)continue;
  const r=el.getBoundingClientRect();el.style.width=r.width+'px';el.style.height=r.height+'px';el.classList.add('individual-position');place(el,p);
 }
 fitVideo();
}
function queueLayout(){if(layoutQueued)return;layoutQueued=true;requestAnimationFrame(()=>{layoutQueued=false;layout();});}
const media=matchMedia('(prefers-color-scheme: light)');
function appearance(){
 body.dataset.theme=settings.theme==='system'?(media.matches?'light':'dark'):settings.theme;
 body.dataset.accent=settings.accent;body.dataset.density=settings.density;
 body.classList.toggle('left-handed',settings.leftHanded);body.classList.toggle('hide-touch',!settings.visible);
 root.style.setProperty('--ui-opacity',settings.opacity);root.style.setProperty('--ui-radius',settings.shape==='round'?'50%':settings.shape==='soft'?'12px':'4px');
 root.style.setProperty('--ui-gap',settings.gap+'px');root.style.setProperty('--ui-inset',settings.inset+'px');
 for(const [id,field]of Object.entries(fields)){const el=$(id);if(el.type==='checkbox')el.checked=settings[field];else el.value=settings[field];if($(id+'Value'))$(id+'Value').textContent=Math.round(settings[field]*100)+'%';}
 for(const [id,field]of Object.entries(landscapeFields)){const el=$(id);if(el.type==='checkbox')el.checked=settings.landscape[field];else el.value=settings.landscape[field];if($(id+'Value'))$(id+'Value').textContent=Math.round(settings.landscape[field]*100)+'%';}
 layout();
}
media.addEventListener?.('change',appearance);
for(const [id,field]of Object.entries(fields))$(id).addEventListener('change',()=>{
 const el=$(id),v=el.type==='checkbox'?el.checked:['range','number'].includes(el.type)?Number(el.value):el.value;
 try{const next=prefs.validate({...settings,[field]:v});holding.clear();refreshManual();settings=next;appearance();save();}catch(e){notice(e.message,true);appearance();}
});
for(const id of ['uiVideoScale','uiOpacity','uiDpadScale','uiActionScale'])$(id).addEventListener('input',()=>{$(id+'Value').textContent=Math.round(Number($(id).value)*100)+'%';});
for(const [id,field]of Object.entries(landscapeFields))$(id).addEventListener('change',()=>{
 const el=$(id),v=el.type==='checkbox'?el.checked:el.type==='range'||field==='monitors'?Number(el.value):el.value;
 try{settings=prefs.validate({...settings,landscape:{...settings.landscape,[field]:v}});holding.clear();refreshManual();appearance();save();}catch(e){notice(e.message,true);appearance();}
});
for(const id of ['uiLandscapeScale','uiLandscapeX','uiLandscapeY','uiLandscapeSides','uiLandscapeDpad','uiLandscapeActions'])$(id).addEventListener('input',()=>{$(id+'Value').textContent=Math.round(Number($(id).value)*100)+'%';});
$('resetLandscape').onclick=()=>{settings.landscape=prefs.defaults().landscape;appearance();save();};
document.querySelectorAll('[data-settings-target]').forEach(button=>button.addEventListener('click',()=>{
 const category=$(button.dataset.settingsTarget);category.querySelectorAll('details').forEach(el=>el.open=true);category.scrollIntoView({block:'start',behavior:'smooth'});
}));
$('uiAudio').onclick=()=>{$('audio').click();$('uiAudio').textContent=$('audio').textContent;};
$('uiAudio').textContent=$('audio').textContent;
$('resetInterface').onclick=()=>{settings=prefs.defaults();saveBlocked=false;$('touchScale').value='1';displayPreferences();appearance();save();};
$('resetTouchLayout').onclick=()=>{settings.layouts={portrait:{},landscape:{}};layout();save();};
function stopDrag(){if(drag){const d=drag;drag=null;try{d.el.releasePointerCapture(d.pointer);}catch(_){}layout();}}
function finishEditor(restore=true){
 if(!editing)return;stopDrag();editing=false;body.classList.remove('touch-editing');$('touchEditorBar').hidden=true;
 holding.clear();controllerMasks.clear();refreshManual();releasePorts();controlsEnabled(restore!==false&&document.querySelector('main').dataset.tab==='game');layout();
}
function startEditor(){
 cancelBinding();if($('quickMenu').open)$('quickMenu').close();window.labPause();openGame();editing=true;body.classList.add('touch-editing');$('touchEditorBar').hidden=false;controlsEnabled(false);layout();
}
$('editTouch').onclick=$('quickTouchEdit').onclick=startEditor;$('touchEditorDone').onclick=finishEditor;
$('touchEditorReset').onclick=()=>{stopDrag();settings.layouts[orientation()]={};layout();save();};
$('touchEditorMode').onchange=stopDrag;
function dragTarget(target){
 if(target.closest('.dpad'))return{name:'dpad',el:groups.dpad};
 const button=target.closest('[data-button]');
 if($('touchEditorMode').value==='buttons'&&button)return{name:'buttons',button:button.dataset.button,el:button};
 for(const name of ['actions','system'])if(target.closest(name==='actions'?'.actions':'.system-pad'))return{name,el:groups[name]};
 return null;
}
function dragAt(event){
 const d=drag,v=viewport(),edge=inset(),top=minTop(),maxX=Math.max(0,v.width-d.w-2*edge),maxY=Math.max(0,v.height-top-d.h-2*edge);
 const x=Math.max(edge,Math.min(edge+maxX,event.clientX-d.dx)),y=Math.max(top+edge,Math.min(top+edge+maxY,event.clientY-d.dy));
 d.el.style.left=x+'px';d.el.style.top=y+'px';const p={x:maxX?(x-edge)/maxX:0,y:maxY?(y-top-edge)/maxY:0};
 const custom=settings.layouts[d.orientation];if(d.name==='buttons'){custom.buttons=custom.buttons||{};custom.buttons[d.button]=p;}else custom[d.name]=p;
 for(const child of d.children){
  const cx=Math.max(edge,Math.min(v.width-edge-child.w,child.x+x-d.x)),cy=Math.max(top+edge,Math.min(v.height-edge-child.h,child.y+y-d.y));
  child.el.style.left=cx+'px';child.el.style.top=cy+'px';const mx=Math.max(0,v.width-child.w-2*edge),my=Math.max(0,v.height-top-child.h-2*edge);
  custom.buttons[child.button]={x:mx?(cx-edge)/mx:0,y:my?(cy-top-edge)/my:0};
 }
}
// Capture before gameplay listeners: moving a pad must never demonstrate an action to FDB.
document.addEventListener('pointerdown',event=>{
 if(!editing)return;const target=dragTarget(event.target);if(!target)return;event.preventDefault();event.stopImmediatePropagation();if(drag)return;
 const r=target.el.getBoundingClientRect(),children=target.name==='buttons'?[]:[...target.el.querySelectorAll('.individual-position')].map(el=>{const r=el.getBoundingClientRect();return{el,button:el.dataset.button,x:r.x,y:r.y,w:r.width,h:r.height};});
 drag={...target,orientation:orientation(),children,pointer:event.pointerId,dx:event.clientX-r.x,dy:event.clientY-r.y,x:r.x,y:r.y,w:r.width,h:r.height};
 if(target.name==='buttons'){target.el.style.width=r.width+'px';target.el.style.height=r.height+'px';target.el.classList.add('individual-position');}
 target.el.style.position='fixed';target.el.style.left=r.x+'px';target.el.style.top=r.y+'px';target.el.style.right='auto';target.el.style.bottom='auto';target.el.style.transform='none';target.el.style.zIndex='12';target.el.setPointerCapture(event.pointerId);
},true);
document.addEventListener('pointermove',event=>{if(!editing||!drag||event.pointerId!==drag.pointer)return;event.preventDefault();event.stopImmediatePropagation();dragAt(event);},true);
for(const type of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,event=>{
 if(!editing||!drag||event.pointerId!==drag.pointer)return;event.preventDefault();event.stopImmediatePropagation();if(type==='pointerup')dragAt(event);stopDrag();save();
},true);
function currentDevice(){const id=$('controllerDevice').value==='auto'?selectedController??devices.keys().next().value:Number($('controllerDevice').value);return devices.get(id);}
function fullscreen(enabled){if(enabled===lastFullscreen)return;lastFullscreen=enabled;if(typeof window.FlyBridge?.gameDisplay==='function')window.FlyBridge.gameDisplay(enabled);}
function closeTraining(){body.classList.remove('landscape-training-open');$('landscapeTraining').setAttribute('aria-expanded','false');}
function profile(){
 const l=settings.landscape,land=orientation()==='landscape',pad=land&&!editing&&(l.input==='gamepad'||l.input==='auto'&&Boolean(currentDevice()));
 const touchVisible=settings.visible||land&&l.input==='touch';body.classList.toggle('hide-touch',!touchVisible);
 body.classList.toggle('landscape-compact',land&&(l.panel==='compact'||pad));body.classList.toggle('landscape-gamepad',pad);
 body.classList.toggle('landscape-overlay',land&&(pad||!touchVisible||l.screenLayout==='overlay'));body.classList.toggle('landscape-hud-bottom',land&&l.monitorPlacement==='bottom'&&l.monitors>0);
 if(!land||editing)closeTraining();fullscreen(land&&l.fullscreen);telemetry();
}
function text(el,value){if(el.textContent!==value)el.textContent=value;}
function telemetry(){
 const l=settings.landscape,pair=window.dualAgents?.active(),masks=pair?appliedDualMasks:gmodeMode==='coop'?[appliedHumanMask,appliedAgentMask]:gmodeMode==='coop-reverse'?[appliedAgentMask,appliedHumanMask]:[appliedAgentMask,0];
 const labels=pair?[window.dualAgents.label(1),window.dualAgents.label(2)]:[$('gmodeLeft').textContent,gmodeMode==='off'?'P2 · —':$('gmodeRight').textContent];
 for(let i=0;i<2;i++){const box=$('landscapeP'+(i+1));box.hidden=l.monitors<i+1;text(box.querySelector('b'),labels[i]);const action=buttonNames.filter((_,b)=>masks[i]&(1<<b)).join(' + ')||'—';text(box.querySelector('span'),action);const title=labels[i]+' · '+action;if(box.title!==title)box.title=title;}
 $('landscapeTraining').hidden=l.monitors<3;text($('landscapeLearningMode'),$('liveTrainingMode').textContent);text($('landscapeSpeedValue'),$('liveSpeed').textContent);
 text($('landscapePlay'),playing?'Пауза':'Старт');$('landscapePlay').disabled=$('landscapeReset').disabled=!loaded||romLoading;
 text($('landscapeConnect'),pair?'Сети':'Сеть');const linked=String(Boolean(connected||pair&&window.dualAgents.running()));if($('landscapeConnect').getAttribute('aria-pressed')!==linked)$('landscapeConnect').setAttribute('aria-pressed',linked);const title=pair?(window.dualAgents.running()?'Приостановить обе сети':'Продолжить обе сети'):$('gameConnect').textContent;if($('landscapeConnect').title!==title)$('landscapeConnect').title=title;
 text($('landscapeSpeed'),$('gameBoost').textContent);
}
$('landscapePlay').onclick=()=>{$('play').click();telemetry();};$('landscapeConnect').onclick=async()=>{const pair=window.dualAgents;if(pair?.active()){if(pair.running())pair.pause('pause');else await pair.resume();}else $('gameConnect').click();telemetry();};$('landscapeReset').onclick=()=>{$('resetNes').click();telemetry();};
$('landscapeTraining').onclick=()=>{const open=!body.classList.contains('landscape-training-open');body.classList.toggle('landscape-training-open',open);$('landscapeTraining').setAttribute('aria-expanded',String(open));};
$('landscapeTrainingClose').onclick=closeTraining;$('landscapeSpeed').onclick=()=>{$('gameBoost').click();telemetry();};
for(const id of ['liveTrainingMode','liveSpeed','gmodeLeft','gmodeRight','gameConnect','play'])new MutationObserver(telemetry).observe($(id),{childList:true,characterData:true,subtree:true});
new MutationObserver(()=>{if($('quickMenu').open)closeTraining();}).observe($('quickMenu'),{attributes:true,attributeFilter:['open']});
function deviceMap(device){return device?physicalMaps[device.descriptor]||{}:{};}
function padNotice(message,error=false){$('physicalPadStatus').textContent=message;$('physicalPadStatus').className='note'+(error?' error':'');}
function physicalInfo(){
 const device=currentDevice(),map=deviceMap(device),table=$('physicalPadBindings');table.replaceChildren();
 for(const [button,name]of buttonNames.entries()){
  const row=document.createElement('tr'),label=document.createElement('th'),value=document.createElement('td'),edit=document.createElement('button');label.scope='row';label.textContent=name;
  const base=device?.defaults||[],codes=new Set([...base.filter(b=>b.mask===1<<button&&map[b.code]===undefined).map(b=>String(b.code)),...Object.entries(map).filter(([,b])=>b===button).map(([code])=>code)]);
  edit.textContent=device?(codes.size?[...codes].map(code=>base.find(b=>b.code===Number(code))?.label||'Код '+code).join(' / '):[4,5,6,7].includes(button)?'Ось / стик':'Не назначена'):'Подключите геймпад';
  edit.onclick=()=>{$('padBindingTarget').value=String(button);$('bindPhysicalPad').click();};value.append(edit);row.append(label,value);table.append(row);
 }
 if(!binding){if(deviceError)padNotice(deviceError+'. Сбросьте назначения, чтобы восстановить настройки.',true);else padNotice(device?'Назначения: '+device.name+'. Оси управляют крестовиной; A/B можно также поменять быстрым переключателем.':'Нажмите «Назначить», затем кнопку геймпада. Устройство будет найдено автоматически.');}
}
function cancelBinding(message,restore=true){
 if(!binding)return;binding=false;$('bindPhysicalPad').textContent='Назначить · нажать на геймпаде';$('cancelPhysicalPad').hidden=true;
 controllerMasks.clear();holding.clear();refreshManual();controlsEnabled(restore!==false&&document.querySelector('main').dataset.tab==='game'&&!editing&&!$('quickMenu').open);if(message)padNotice(message);
}
function savePhysical(next){if(deviceError)throw Error(deviceError);localStorage.setItem(physicalKey,JSON.stringify({version:1,devices:next}));physicalMaps=next;}
for(const [button,name]of buttonNames.entries()){const o=document.createElement('option');o.value=button;o.textContent=name;$('padBindingTarget').append(o);}
$('bindPhysicalPad').onclick=()=>{
 if(deviceError){padNotice(deviceError+'. Сначала сбросьте назначения.',true);return;}
 if(editing)finishEditor();window.labPause();bindingKey=false;$('bindKey').textContent='Назначить клавишу';binding=true;$('bindPhysicalPad').textContent='Нажмите физическую кнопку…';$('cancelPhysicalPad').hidden=false;
 padNotice('Ожидаю кнопку для «'+buttonNames[Number($('padBindingTarget').value)]+'». Escape или «Отменить» прекращает назначение.');controlsEnabled(true);
};
$('cancelPhysicalPad').onclick=()=>cancelBinding('Назначение отменено.');
$('resetPhysicalPad').onclick=()=>{
 cancelBinding();try{const next={...physicalMaps},device=currentDevice();if(device&&!deviceError)delete next[device.descriptor];else for(const k of Object.keys(next))delete next[k];localStorage.setItem(physicalKey,JSON.stringify({version:1,devices:next}));physicalMaps=next;deviceError='';$('controllerAB').value='direct';$('controllerAB').onchange();controllerMasks.clear();refreshManual();physicalInfo();}catch(e){padNotice(e.message,true);}
};
$('controllerDevice').addEventListener('change',()=>{cancelBinding('Назначение отменено при смене устройства.');physicalInfo();});
$('controllerAB').addEventListener('change',physicalInfo);
function controller(data){
 if(!data.connected){devices.delete(data.id);if(binding)cancelBinding('Геймпад отключён: назначение отменено.');queueMicrotask(physicalInfo);queueLayout();return 0;}
 const descriptor=typeof data.descriptor==='string'&&data.descriptor.length<=512?data.descriptor:'legacy:'+String(data.name||data.id);
 const defaults=Array.isArray(data.defaults)?data.defaults.filter(v=>Number.isInteger(v.code)&&v.code>=0&&v.code<=255&&Number.isInteger(v.mask)&&v.mask>=0&&v.mask<=4095).slice(0,64):[];
 const previous=devices.get(data.id),name=String(data.name||'Геймпад').slice(0,120);devices.set(data.id,{descriptor,id:data.id,name,defaults});
 if(binding){
  const selected=$('controllerDevice').value;
  if(data.pressed&&Number.isInteger(data.keyCode)&&data.keyCode>=0&&data.keyCode<=255&&(selected==='auto'||Number(selected)===data.id)){
   try{
    const device=devices.get(data.id),next=Object.assign(Object.create(null),physicalMaps);if(!next[descriptor]&&Object.keys(next).length>=32)throw Error('Сохранено 32 устройства. Сбросьте неиспользуемое назначение.');
    next[descriptor]=prefs.bind(deviceMap(device),Number($('padBindingTarget').value),data.keyCode,defaults);savePhysical(next);
    selectedController=data.id;$('controllerAB').value='direct';$('controllerAB').onchange();cancelBinding();physicalInfo();padNotice('«'+buttonNames[Number($('padBindingTarget').value)]+'» назначена. Настройки сохраняются для этого геймпада и платформы.');
   }catch(e){cancelBinding();padNotice('Назначение не сохранено: '+e.message,true);}
  }
  return 0;
 }
 if(!previous||previous.descriptor!==descriptor||previous.name!==name){queueMicrotask(physicalInfo);queueLayout();}
 if(editing||document.querySelector('main').dataset.tab!=='game'||$('quickMenu').open||window.agentQuickPanel?.active())return 0;
 try{return prefs.physical(data,deviceMap(devices.get(data.id)),buttonNames.length===12);}catch(e){padNotice(e.message,true);return 0;}
}
document.addEventListener('keydown',event=>{
 if(event.code==='Escape'&&body.classList.contains('landscape-training-open')){closeTraining();event.preventDefault();event.stopImmediatePropagation();return;}
 if(binding){event.preventDefault();event.stopImmediatePropagation();if(event.code==='Escape')cancelBinding('Назначение отменено.');return;}
 if(editing){if(event.code==='Escape'){finishEditor();event.preventDefault();}if(!['INPUT','SELECT','TEXTAREA'].includes(event.target.tagName)){event.preventDefault();event.stopImmediatePropagation();}}
},true);
window.addEventListener('blur',()=>{cancelBinding('Назначение отменено: приложение неактивно.',false);finishEditor(false);controlsEnabled(false);});
document.addEventListener('focusin',event=>{if(binding&&['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))cancelBinding('Назначение отменено при переходе в поле настроек.');});
window.addEventListener('resize',()=>{stopDrag();queueLayout();});
const oldBack=window.labBack;window.labBack=()=>{if(editing){finishEditor();return true;}if(binding){cancelBinding('Назначение отменено.');return true;}if(body.classList.contains('landscape-training-open')){closeTraining();return true;}return oldBack?.()||false;};
window.userInterface={editing:()=>editing,binding:()=>binding,layout,telemetry,leave:()=>{closeTraining();fullscreen(false);cancelBinding();finishEditor();fullscreen(false);},controller,
 videoScale:scale=>{const v=orientation()==='landscape'?settings.landscape:settings;let n=scale*v.videoScale;return v.videoFit==='integer'&&n>=1?Math.floor(n):n;},
 videoOffset:(w,h)=>orientation()==='landscape'?{x:w*settings.landscape.offsetX/2,y:h*settings.landscape.offsetY/2}:{x:0,y:0}};
fullscreen(false);appearance();physicalInfo();
})();
