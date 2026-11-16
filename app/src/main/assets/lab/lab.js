/* GU console host: the four emulator cores, ROM loading, video, audio, pacing,
   input (screen pad, keyboard, Android gamepads), snapshots and the RAM viewer.
   AGOD observes frames through window.gameObjectiveDiscovery; no agent runs here.
   The future vision-action controller attaches through a separate port. */
'use strict';
const $ = id => document.getElementById(id);
const requestedPlatform=new URLSearchParams(location.search).get('system');
const labPlatform=Object.prototype.hasOwnProperty.call(FlyPlatforms,requestedPlatform)?requestedPlatform:'nes';
const buttonNames=FlyPlatforms[labPlatform].buttons;
if(buttonNames.length===12){document.body.classList.add('sega');document.querySelector('.actions').appendChild(document.querySelector('[data-button="2"]'));}
if(labPlatform==='sega')document.querySelectorAll('[data-sega-only]').forEach(el=>el.hidden=false);
document.querySelectorAll('[data-button]').forEach(el=>{const i=Number(el.dataset.button);el.hidden=i>=buttonNames.length;if(!el.hidden)el.textContent=buttonNames[i];});
let ramLimit=FlyPlatforms[labPlatform].ram;
const screen = $('screen'), context = screen.getContext('2d', {alpha:false});
let image = context.createImageData(256,240);
let nes, loaded = false, playing = false;
let romHash = '', frame = 0, generation = 0;
let manualMask = 0, appliedMask = 0;
let emulationRate=1,acceleratedFrames=0,deferredVideo=false,videoDirty=false,latestVideo=null;
const emulationClock=new FlyEmulationClock();
let emulationMeasureState='';
let liveFps=0,fpsFrames=0,fpsAt=performance.now(),emulatorRestarts=0;
let lastFrame = 0;
let audioContext = null, audioNode = null, soundEnabled = false;
const audioLeft = new Float32Array(32768), audioRight = new Float32Array(32768);
let audioWrite = 0, audioRead = 0;
const holding = new Map();
let romLoading=false, romLoadSequence=0;
let measuredFrames=0, measuredCpuMs=0, measuredStarted=performance.now();
let diagnosticHash=null;
/* the boundary the emulator itself draws (pause, reset, load): AGOD's live trace is detached */
function emulatorBoundary(reason='emulator-boundary'){try{window.gameObjectiveDiscovery?.boundary(reason);}catch(error){try{window.guLogger?.event?.('goal.discovery-error',{message:String(error.message||error)},'error');}catch(_){}}
 for(const port of [window.labFrameSource,window.labActionSink])if(port)try{port.boundary(reason);}catch(_){}}
/* a session id for provenance (AGOD sessions, logs) - one per loaded cartridge */
function originId(){try{return crypto.randomUUID();}catch(_){return 'o-'+Date.now().toString(36)+Math.random().toString(36).slice(2);}}
function showTab(tab){
 if(!['game','platform','research','info'].includes(tab))return;
 if(tab!=='game'&&window.userInterface)window.userInterface.leave();
 document.querySelector('main').dataset.tab=tab;
 holding.clear();refreshManual();
 controlsEnabled(tab==='game');
 document.querySelectorAll('[data-page]').forEach(el=>el.hidden=el.dataset.page!==tab);
 document.querySelectorAll('.tab-bar [data-tab]').forEach(el=>{const active=el.dataset.tab===tab;el.classList.toggle('active',active);el.setAttribute('aria-selected',String(active));});
 window.scrollTo(0,0);
}
function fitVideo(){
 if(!document.body.classList.contains('game-mode')){screen.style.removeProperty('width');screen.style.removeProperty('height');screen.style.removeProperty('transform');return;}
 const space=screen.parentElement,fit=Math.min(space.clientWidth/screen.width,space.clientHeight/screen.height),scale=window.userInterface?window.userInterface.videoScale(fit):fit;
 if(scale>0){screen.style.width=(screen.width*scale)+'px';screen.style.height=(screen.height*scale)+'px';const at=window.userInterface?.videoOffset(Math.max(0,space.clientWidth-screen.width*scale),Math.max(0,space.clientHeight-screen.height*scale));screen.style.transform=at?'translate('+at.x+'px,'+at.y+'px)':'';}
}
function openGame(){showTab('game');document.body.classList.add('game-mode');if(window.userInterface)window.userInterface.layout();fitVideo();window.consoleNavigation?.gameOpened();}
function leaveGame(tab='game'){if(window.userInterface)window.userInterface.leave();document.body.classList.remove('game-mode');showTab(tab);fitVideo();window.consoleNavigation?.legacyOpened(tab);}
function log(text) {
  if(!String(text).startsWith('окно '))window.guLogger?.event?.('ui.message',{message:String(text)});
  const lines = ($('log').textContent + '\n' + text).trim().split('\n').slice(-80);
  $('log').textContent = lines.join('\n');
}
let noticeTimer;
function status(text,error=false) {
 if(error)window.guLogger?.event?.('ui.error',{message:String(text)},'error');
 $('status').textContent=text;$('status').className=error?'error':'';
 const notice=$('gameNotice');if(!notice)return;
 notice.textContent=text;notice.classList.toggle('error',error);notice.classList.add('visible');
 clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>notice.classList.remove('visible'),7000);
}
function nativeCall(name,...args) {
  if (typeof window.FlyBridge==='undefined') { status('Android bridge недоступен: NES можно тестировать в браузере.',true); return; }
  window.FlyBridge[name](...args);
}
function normalizeMask(mask) {
  if(mask&16)mask&=~32;if(mask&32)mask&=~16;
  if(mask&64)mask&=~128;if(mask&128)mask&=~64;
  return mask;
}
let appliedMask2=0;
function releasePorts() {
  if(!nes)return;
  for(const port of [1,2])for(let i=0;i<((labPlatform==='sega'||labPlatform==='snes')?12:8);i++)nes.buttonUp(port,i);
  appliedMask=0;appliedMask2=0;
}
function applyPortMask(port,mask,old) {
  if(!loaded)return;
  for(let i=0;i<((labPlatform==='sega'||labPlatform==='snes')?12:8);i++)if((mask&(1<<i))!==(old&(1<<i))) {
    if(mask&(1<<i))nes.buttonDown(port,i);else nes.buttonUp(port,i);
  }
}
/* the human holds port 1. A controller installed as window.labActionSink (F1) may
   hold ports 1 and 2; a human press on port 1 takes it from the controller at once.
   Between frames only the human path runs here; advanceFrame applies both. */
function updateButtons() {
  const mask=normalizeMask(manualMask),sink=typeof window!=='undefined'?window.labActionSink:null;
  if(mask&&sink)try{sink.manualOverride(1);}catch(_){}
  if(mask||!(sink&&sink.holding(1))){applyPortMask(1,mask,appliedMask);appliedMask=mask;}
  if(typeof window!=='undefined')window.userInterface?.telemetry?.();
}
/* the latest frame is kept (latestVideo) for presentation - and later for the
   vision-action controller's frame port, which reads the latest frame, never a queue */
function onVideoFrame(buffer,width=256,height=240) {
  if(screen.width!==width||screen.height!==height){screen.width=width;screen.height=height;screen.style.aspectRatio=width+"/"+height;image=context.createImageData(width,height);fitVideo();}
  latestVideo={buffer,width,height};videoDirty=true;
  if(!deferredVideo)presentVideo();
  /* F0: only when a controller runtime installed window.labFrameSource - no copy otherwise */
  if(typeof window!=='undefined'&&window.labFrameSource)try{window.labFrameSource.publish(buffer,width,height,{emuFrame:frame+1,fps:labPlatform!=='nes'&&nes&&nes.fps?nes.fps:60});}
  catch(error){try{window.guLogger?.event?.('agent.frame-source-error',{message:String(error.message||error)},'error');}catch(_){}}
}
function presentVideo(){
  if(!videoDirty||!latestVideo)return;const {buffer,width,height}=latestVideo;
  for(let i=0;i<width*height;i++){const color=buffer[i],at=i*4;image.data[at]=color&255;image.data[at+1]=(color>>>8)&255;image.data[at+2]=(color>>>16)&255;image.data[at+3]=255;}
  context.putImageData(image,0,0);videoDirty=false;
}
function coreOptions(){return {
    onFrame:onVideoFrame,
    sampleRate:audioContext?audioContext.sampleRate:labPlatform==='nes'?48000:44100,
    onAudioSample:(left,right)=>{
      if(!soundEnabled||emulationRate>1)return;
      if(audioWrite-audioRead>=audioLeft.length){audioRead++;window.guLogger?.audioOverrun?.(1);}
      audioLeft[audioWrite%audioLeft.length]=left;audioRight[audioWrite%audioRight.length]=right;audioWrite++;
    },
    onStatusUpdate:text=>log(text)
  };}
function setupNes(){nes=new jsnes.NES(coreOptions());}
async function setupSega(){nes=await SegaConsole.create(coreOptions(),window.GenPlusFactory,{locateFile:path=>'sega/'+path});}
function toggleSound() {
  try {
    if(!loaded||!nes)throw Error('Сначала загрузите ROM');
    if(!audioContext){
      const Audio = window.AudioContext||window.webkitAudioContext;
      audioContext=new Audio({sampleRate:labPlatform==='nes'?48000:44100});
      audioNode=audioContext.createScriptProcessor(2048,0,2);
      audioNode.onaudioprocess=event=>{
        const l=event.outputBuffer.getChannelData(0),r=event.outputBuffer.getChannelData(1);let starved=0;
        for(let i=0;i<l.length;i++) {
          if(soundEnabled&&emulationRate===1&&audioRead<audioWrite){l[i]=audioLeft[audioRead%audioLeft.length];r[i]=audioRight[audioRead%audioRight.length];audioRead++;}
          else {l[i]=0;r[i]=0;if(playing&&soundEnabled&&emulationRate===1)starved++;}
        }
        window.guLogger?.audio?.(l.length,starved);
      };
      audioNode.connect(audioContext.destination);
      nes.opts.sampleRate=audioContext.sampleRate;if(labPlatform==='nes'){nes.papu.sampleRate=audioContext.sampleRate;nes.setFramerate(60);}
    }
    soundEnabled=!soundEnabled;audioRead=audioWrite;
    audioContext.resume().catch(error=>status(error.message,true));
    $('audio').textContent=`Звук: ${soundEnabled?'вкл.':'выкл.'}`;
  }catch(error){status('Звук недоступен: '+error.message,true);}
}
function resetSession(){generation++;}
window.labLoadRom=async function(data) {
  const sequence=++romLoadSequence;romLoading=true;window.labContinuing=false;let launched=false;
  try{window.gameObjectiveDiscovery?.boundary('rom-loading');}catch(_){}
  try {
    if(window.labState)await window.labState.prepare();if(sequence!==romLoadSequence)return;
    window.labPause();
    const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));
    const info=labPlatform==='nes'?FlyGameTools.validateRom(bytes):labPlatform==='sega'?SegaConsole.validateRom(bytes):RetroConsole.validateRom(bytes,labPlatform);
    let committed=false,bootFrame=null;
    const opts=coreOptions();opts.onFrame=(buffer,width,height)=>{if(committed)onVideoFrame(buffer,width,height);else bootFrame={buffer:Array.from(buffer),width,height};};
    const output=opts.onAudioSample;opts.onAudioSample=(l,r)=>{if(committed)output(l,r);};
    const candidate=labPlatform==='nes'?new jsnes.NES(opts):labPlatform==='sega'?await SegaConsole.create(opts,window.GenPlusFactory,{locateFile:path=>'sega/'+path}):await RetroConsole.create(labPlatform,opts,labPlatform==='gb'?window.GambatteFactory:window.Snes9xFactory,{locateFile:path=>labPlatform+'/'+path});
    if(sequence!==romLoadSequence)return;
    if(labPlatform==='sega')candidate.configureRegion(Number($('segaRegion').value));candidate.loadROM(bytes);if(labPlatform==='sega'&&candidate.g._lab_set_pad_type)candidate.configurePads([Number($('padP1').value),Number($('padP2').value)]);for(let i=0;i<5;i++)candidate.frame();
    if(sequence!==romLoadSequence)return;
    nes=candidate;if(labPlatform==='gb'||labPlatform==='snes')ramLimit=candidate.ramSize;loaded=true;committed=true;romHash=data.sha256;window.labStartStateId='rom-boot';window.flyOriginId=originId();window.labCoreIdentity=labPlatform==='nes'?'jsnes-sha256:84946f0dae4bcf3b2dfebe84ad3bfeb1dbcb413bd9b1a69e1f45910a95fd7b41':candidate.toJSON().core;frame=5;appliedMask=0;manualMask=0;audioRead=audioWrite;
    resetSession();if(bootFrame)onVideoFrame(bootFrame.buffer,bootFrame.width,bootFrame.height);
    diagnosticHash=labPlatform==='nes'&&romHash===FlyGameTools.diagnosticSha256?romHash:null;
    emulatorBoundary('rom-loaded');measuredFrames=0;measuredCpuMs=0;measuredStarted=performance.now();
    $('romName').textContent=data.name+' · '+romHash.slice(0,12);
    $('ramOffset').max=ramLimit-64;
    $('platformInfo').textContent=FlyPlatforms[labPlatform].label+' · '+FlyPlatforms[labPlatform].core+' · '+(labPlatform==='nes'?60:nes.fps).toFixed(2)+' FPS · RAM '+ramLimit+' байт';
    status('ROM загружен.');updateHud();
    window.guLogger?.boundary?.('emulator.rom-loaded',{core:window.labCoreIdentity,romHash});nativeCall('acceptRom',romHash);log('ROM SHA256: '+romHash+' · '+(labPlatform==='nes'?'mapper '+info.mapper:FlyPlatforms[labPlatform].core+', '+nes.fps+' FPS'));
    if(labPlatform==='sega'){$('segaCompatibility').textContent='Genesis Plus GX · '+nes.regionName+' · '+nes.fps+' FPS · P1/P2 '+nes.controllerTypes.join('/')+' кнопок · '+info.format;log('Mega Drive: '+info.format+' · '+bytes.length+' байт · регион ROM '+(info.region||'не указан')+' · '+nes.regionName+' · P1/P2 '+nes.controllerTypes.join('/'));}
    if(info.submapper)log('NES2 submapper '+info.submapper+': специальная совместимость не гарантирована.');
    if(info.warnings)info.warnings.forEach(log);
    if(info.timing)log('PAL/Dendy: NES ядро работает с NTSC таймингом.');
    if(info.battery)log('Battery RAM .sav отдельно не сохраняется; используйте снимки.');
    if(window.labGameStates)await window.labGameStates.list();
    if(window.labState)await window.labState.restore();
    launched=true;window.labContinuing=Boolean(data.resume);
  }catch(error){status('ROM не запущен: '+error.message,true);log(error.stack||error.message);}
  finally{if(sequence===romLoadSequence)romLoading=false;}
  if(launched&&sequence===romLoadSequence){
    if(data.resume&&window.labGameStates)try{await window.labGameStates.continueLast();}catch(error){status('ROM открыт; продолжение игры не восстановлено: '+error.message,true);}finally{if(sequence===romLoadSequence)window.labContinuing=false;}
    if(sequence===romLoadSequence&&typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent('lab-rom-loaded',{detail:{userOpened:data.userOpened===true}}));
  }
  return launched;
};
/* a native failure (ROM import, storage) is shown; the console keeps running */
window.labError=function(data){
 const message=data&&data.message?String(data.message):'Ошибка Android-части';
 window.guLogger?.event?.('native.error',{message},'error');
 status(message,true);log(message);
};
function advanceFrame(now) {
  if(!loaded||romLoading)return;
  let coreElapsedMs=0;
  /* F1: the controller's masks for the frame about to be produced; the human wins port 1 */
  const human=normalizeMask(manualMask),sink=window.labActionSink;let agent=null,overrode=false;
  if(sink)try{
   if(human){overrode=sink.holding(1)||sink.pending(1);sink.manualOverride(1);}
   const source=window.labFrameSource;agent=sink.apply((source?source.frameIndex():frame)+1);
  }catch(error){agent=null;try{window.guLogger?.event?.('agent.action-sink-error',{message:String(error.message||error)},'error');}catch(_){}}
  const agent1=agent&&agent[1]||0,p1=human||normalizeMask(agent1),p2=normalizeMask(agent&&agent[2]||0);
  applyPortMask(1,p1,appliedMask);appliedMask=p1;applyPortMask(2,p2,appliedMask2);appliedMask2=p2;
  window.userInterface?.telemetry?.();
  const objectiveAction={mask:p1,humanMask:human,agentMask:human?0:agent1,manualOverride:overrode};
  // Detach a diagnostic trace before an excluded or intervened frame runs.
  try{window.gameObjectiveDiscovery?.beforeFrame?.({frame:frame+1,generation,action:objectiveAction});}
  catch(error){try{window.guLogger?.event?.('goal.discovery-error',{message:String(error.message||error)},'error');}catch(_){}}
  try {const started=performance.now();nes.frame();const elapsed=performance.now()-started;coreElapsedMs=elapsed;measuredCpuMs+=elapsed;measuredFrames++;window.guLogger?.coreFrame?.(elapsed,started+elapsed);frame++;}
  catch(error){playing=false;try{window.gameObjectiveDiscovery?.boundary('emulator-frame-error');}catch(_){}window.guLogger?.event?.('emulator.frame-error',{message:error.message},'error');window.labError({message:'Ошибка эмулятора: '+error.message});status('Эмуляция остановлена: '+error.message,true);$('play').textContent='Запустить эмулятор';return;}
  try{
   window.gameObjectiveDiscovery?.observeFrame({frame,generation,atMs:performance.now(),elapsedMs:coreElapsedMs,action:objectiveAction});
  }catch(error){try{window.guLogger?.event?.('goal.discovery-error',{message:String(error.message||error)},'error');}catch(_){}}
}
function emulationSpeedLabel(){
 const nominal=labPlatform!=='nes'&&nes?nes.fps:60,actual=liveFps/nominal;
 if(!playing||liveFps===0)return 'Цель ×'+emulationRate;
 return Math.abs(actual-emulationRate)<=emulationRate*.05?'×'+emulationRate:actual.toFixed(2)+'× / '+emulationRate+'×';
}
/* emulation speed (x1 / x2 / x3 / x5 / x10): sound is muted above x1 */
function setEmulationRate(value){
 value=Number(value);if(![1,2,3,5,10].includes(value))throw Error('Скорость: ×1, ×2, ×3, ×5 или ×10');
 emulationRate=value;acceleratedFrames=0;lastFrame=performance.now();emulationClock.reset(lastFrame);fpsFrames=measuredFrames;fpsAt=lastFrame;liveFps=0;audioRead=audioWrite;updateHud();
}
function updateHud(){
 const boost=$('gameBoost');if(boost){boost.textContent=emulationSpeedLabel();boost.classList.toggle('active',emulationRate>1);}
 const state=$('gameState');if(state)state.textContent=loaded?(playing?'Игра':'Пауза'):'Игра не открыта';
}
function loop(now) {
  const fps=labPlatform!=='nes'&&nes?nes.fps:60;
  if(now-fpsAt>=1000){liveFps=(measuredFrames-fpsFrames)*1000/(now-fpsAt);fpsFrames=measuredFrames;fpsAt=now;updateHud();const label=$('gameMetrics');if(label)label.textContent=liveFps.toFixed(1)+' FPS · '+(liveFps/fps).toFixed(2)+'×';}
  presentVideo();
  requestAnimationFrame(loop);
}
// Computation is paced by real time, never by requestAnimationFrame. A short
// MessageChannel continuation yields to input/rendering without the nested timer
// clamp imposing a false speed ceiling. Video presentation stays on RAF.
const emulationChannel=new MessageChannel();
function emulationPump(){
 const now=performance.now(),fps=labPlatform!=='nes'&&nes?nes.fps:60;
 const active=playing&&loaded&&!romLoading&&!document.hidden;
 emulationClock.configure(now,fps,emulationRate,active);
 const measureState=[playing&&!romLoading&&!document.hidden,fps,emulationRate].join(':');
 if(measureState!==emulationMeasureState){emulationMeasureState=measureState;fpsFrames=measuredFrames;fpsAt=now;liveFps=0;}
 const quantum=Math.max(1,Math.round(fps*.1)),started=now;
 deferredVideo=true;
 try{
  while(emulationClock.due(performance.now())&&playing&&!romLoading){
   emulationClock.step();acceleratedFrames++;
   advanceFrame(performance.now());
   if(acceleratedFrames>=quantum)acceleratedFrames=0;
   if(performance.now()-started>=4)break;
  }
 }finally{deferredVideo=false;}
 const delay=emulationClock.delay(performance.now());
 if(active&&delay<=0)emulationChannel.port2.postMessage(0);else setTimeout(emulationPump,Math.min(16,Math.max(1,delay)));
}
emulationChannel.port1.onmessage=emulationPump;
setTimeout(emulationPump,0);
window.labPause=function() {
  // Commit the pause first: save/load and Android backgrounding must always stop the core.
  playing=false;generation++;
  emulatorBoundary('pause');
  window.guLogger?.boundary?.('emulator.pause');
  manualMask=0;holding.clear();controllerMasks.clear();audioRead=audioWrite;
  try{controlsEnabled(false);}catch(_){}try{releasePorts();}catch(_){}
  $('play').textContent='Запустить эмулятор';
  try{nativeCall('stop');}catch(_){}updateHud();
};
$('play').onclick=()=>{
 if(!loaded||romLoading||window.labContinuing){status('Дождитесь загрузки ROM и снимка',true);return;}
 if(playing){window.labPause();return;}
 playing=true;$('play').textContent='Пауза';window.guLogger?.boundary?.('emulator.resume');
 controlsEnabled(true);nativeCall('resume');updateHud();
};
$('step').onclick=()=>{if(!playing)advanceFrame(performance.now());};
$('demo').onclick=()=>nativeCall('demo');$('import').onclick=()=>nativeCall('pickRom');$('audio').onclick=toggleSound;
$('gameExit').onclick=()=>leaveGame();
$('gameSettings').onclick=()=>leaveGame('platform');
$('gameBoost').onclick=()=>{const rates=[1,2,3,5,10];setEmulationRate(rates[(rates.indexOf(emulationRate)+1)%rates.length]);};
document.querySelectorAll('.tab-bar [data-tab]').forEach(el=>el.onclick=()=>showTab(el.dataset.tab));
$('enterGame').onclick=openGame;$('platformShortcut').onclick=()=>showTab('platform');
function displayPreferences(){
 const preferences={orientation:$('orientation').value,touchScale:$('touchScale').value};
 document.documentElement.style.setProperty('--pad-scale',preferences.touchScale);
 try{localStorage.setItem('fly-display',JSON.stringify(preferences));}catch(_){}
 if(window.FlyBridge&&typeof window.FlyBridge.orientation==='function')window.FlyBridge.orientation(preferences.orientation);
 if(window.userInterface)window.userInterface.layout();
}
try{const saved=JSON.parse(localStorage.getItem('fly-display')||'null');if(saved){if(['auto','portrait','landscape'].includes(saved.orientation))$('orientation').value=saved.orientation;if(['.7','.85','1','1.2','1.4'].includes(saved.touchScale))$('touchScale').value=saved.touchScale;}}catch(_){}
for(const id of ['orientation','touchScale'])$(id).onchange=displayPreferences;
displayPreferences();
if(typeof ResizeObserver!=='undefined')new ResizeObserver(fitVideo).observe(screen.parentElement);
window.addEventListener('resize',()=>{holding.clear();refreshManual();fitVideo();});
$('resetNes').onclick=()=>{if(loaded){window.labPause();try{restartFromRom();status(labPlatform.toUpperCase()+' сброшена.');}catch(error){status('Перезапуск эмулятора не выполнен: '+error.message,true);}}};
$('saveState').onclick=()=>{try{if(!loaded)throw Error('ROM не загружен');localStorage.setItem(labPlatform+'-slot',JSON.stringify({hash:romHash,system:labPlatform,frame,state:JSON.parse(JSON.stringify(nes.toJSON()))}));status('Снимок '+labPlatform.toUpperCase()+' сохранён.');}catch(error){status(error.message,true);}};
$('loadState').onclick=()=>{try{const saved=JSON.parse(localStorage.getItem(labPlatform+'-slot')||(labPlatform==='nes'?localStorage.getItem('nes-slot'):null));validateSnapshot(saved);if(!saved||saved.hash!==romHash)throw Error('Снимок отсутствует или относится к другому ROM');window.labPause();window.labStartStateId='legacy-snapshot';nes.fromJSON(saved.state);frame=Number.isSafeInteger(saved.frame)?saved.frame:0;if(labPlatform==='nes')onVideoFrame(nes.ppu.buffer);releasePorts();updateButtons();emulatorBoundary('snapshot-loaded');status(labPlatform.toUpperCase()+' восстановлена.');}catch(error){status(error.message,true);}};
const controllerMasks=new Map();let selectedController=null,customKeys={};
try{customKeys=JSON.parse(localStorage.getItem('fly-keys-'+labPlatform)||'{}');}catch(_){}
let keys=FlyController.keyboard(labPlatform,customKeys),bindingKey=false;
function controlsEnabled(on){if(window.userInterface&&window.userInterface.editing())on=false;if(window.FlyBridge&&typeof window.FlyBridge.controls==='function')window.FlyBridge.controls(on);}
function refreshManual(){
 manualMask=0;for(const mask of holding.values())manualMask|=mask;
 if(selectedController!==null)manualMask|=FlyController.gamepad(controllerMasks.get(selectedController)||0,$('controllerAB').value==='swap',labPlatform==='sega'||labPlatform==='snes');
 manualMask=FlyController.clean(manualMask,labPlatform==='sega'||labPlatform==='snes');updateButtons();
 document.querySelectorAll('[data-button]').forEach(el=>el.classList.toggle('active',Boolean(manualMask&(1<<Number(el.dataset.button)))));
 document.querySelectorAll('[data-pad-mask]').forEach(el=>el.classList.toggle('active',(manualMask&Number(el.dataset.padMask))===Number(el.dataset.padMask)));
}
window.labController=data=>{
 if(!Number.isInteger(data.id)||!Number.isInteger(data.mask)||data.mask<0||data.mask>4095)return;
 const mask=window.userInterface?window.userInterface.controller(data):data.mask;
 const select=$('controllerDevice'),key=String(data.id);
 if(!data.connected){controllerMasks.delete(data.id);const o=[...select.options].find(x=>x.value===key);if(o)o.remove();if(selectedController===data.id){selectedController=null;select.value='auto';}refreshManual();return;}
 controllerMasks.set(data.id,mask);
 if(![...select.options].some(x=>x.value===key)){const o=document.createElement('option');o.value=key;o.textContent=data.name||'Controller '+key;select.appendChild(o);}
 if(select.value==='auto'&&selectedController===null)selectedController=data.id;
 $('controllerStatus').textContent='Джойстик '+(data.name||key)+' · маска '+mask+' · P1';refreshManual();
};
$('controllerDevice').onchange=()=>{selectedController=$('controllerDevice').value==='auto'?controllerMasks.keys().next().value??null:Number($('controllerDevice').value);refreshManual();};
try{if(localStorage.getItem('fly-pad-ab-'+labPlatform)==='swap')$('controllerAB').value='swap';}catch(_){}
$('controllerAB').onchange=()=>{localStorage.setItem('fly-pad-ab-'+labPlatform,$('controllerAB').value);refreshManual();};
function keyboardInfo(){
 $('keyboardInfo').textContent='Выберите кнопку и назначьте клавишу. Старое назначение этой кнопки заменяется; Escape отменяет ввод.';
 const table=$('keyboardBindings');if(!table)return;table.replaceChildren();
 buttonNames.forEach((name,button)=>{const row=document.createElement('tr'),label=document.createElement('th'),value=document.createElement('td'),edit=document.createElement('button');label.scope='row';label.textContent=name;edit.textContent=Object.entries(keys).filter(([,v])=>v===button).map(([k])=>k).join(' / ')||'Не назначена';edit.onclick=()=>{$('keyButton').value=String(button);$('bindKey').click();};value.append(edit);row.append(label,value);table.append(row);});
}
$('bindKey').onclick=()=>{bindingKey=true;$('bindKey').textContent='Нажмите клавишу…';};
$('resetKeys').onclick=()=>{bindingKey=false;$('bindKey').textContent='Назначить клавишу';customKeys={};keys=FlyController.keyboard(labPlatform);localStorage.removeItem('fly-keys-'+labPlatform);holding.clear();refreshManual();keyboardInfo();};
$('unbindKey').onclick=()=>{customKeys=FlyController.bind(labPlatform,customKeys,Number($('keyButton').value));keys=FlyController.keyboard(labPlatform,customKeys);localStorage.setItem('fly-keys-'+labPlatform,JSON.stringify(customKeys));holding.clear();refreshManual();keyboardInfo();};
for(const [i,name] of buttonNames.entries()){const o=document.createElement('option');o.value=i;o.textContent=name;$('keyButton').appendChild(o);}keyboardInfo();
document.querySelectorAll('[data-button]').forEach(element=>{
 const button=Number(element.dataset.button);
 // Android WebView long presses must remain held game inputs, not text actions.
 for(const type of ['contextmenu','selectstart','dragstart'])element.addEventListener(type,event=>event.preventDefault());
 element.addEventListener('touchstart',event=>{if(event.cancelable)event.preventDefault();},{passive:false});
 if(element.closest('.dpad'))return;
 element.onpointerdown=event=>{event.preventDefault();element.setPointerCapture(event.pointerId);holding.set(event.pointerId,1<<button);refreshManual();};
 element.onpointerup=element.onpointercancel=element.onlostpointercapture=event=>{holding.delete(event.pointerId);refreshManual();};
});
const dpad=document.querySelector('.dpad');
function movePad(event){const r=dpad.getBoundingClientRect();holding.set(event.pointerId,FlyController.dpad((event.clientX-r.left)/r.width,(event.clientY-r.top)/r.height));refreshManual();}
for(const type of ['contextmenu','selectstart','dragstart'])dpad.addEventListener(type,event=>event.preventDefault());
dpad.addEventListener('touchstart',event=>{if(event.cancelable)event.preventDefault();},{passive:false});
dpad.onpointerdown=event=>{event.preventDefault();dpad.setPointerCapture(event.pointerId);movePad(event);};
dpad.onpointermove=event=>{if(dpad.hasPointerCapture(event.pointerId))movePad(event);};
dpad.onpointerup=dpad.onpointercancel=dpad.onlostpointercapture=event=>{holding.delete(event.pointerId);refreshManual();};
window.onkeydown=event=>{
 if(bindingKey){event.preventDefault();if(event.code!=='Escape'){if(!event.code)return;customKeys=FlyController.bind(labPlatform,customKeys,Number($('keyButton').value),event.code);keys=FlyController.keyboard(labPlatform,customKeys);localStorage.setItem('fly-keys-'+labPlatform,JSON.stringify(customKeys));}bindingKey=false;holding.clear();refreshManual();$('bindKey').textContent='Назначить клавишу';keyboardInfo();return;}
 if(document.querySelector('main').dataset.tab!=='game'||$('quickMenu').open)return;
 if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||event.target.isContentEditable)return;
 const code=event.code||event.key,button=keys[code];if(button!==undefined){event.preventDefault();holding.set('key-'+code,1<<button);refreshManual();}
};
window.onkeyup=event=>{holding.delete('key-'+(event.code||event.key));refreshManual();};
window.onblur=()=>window.labPause();
window.onfocus=()=>controlsEnabled(document.querySelector('main').dataset.tab==='game');
document.addEventListener('focusin',event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))controlsEnabled(false);});
document.addEventListener('focusout',()=>controlsEnabled(document.querySelector('main').dataset.tab==='game'));
$('applySegaRegion').onclick=()=>{try{if(labPlatform!=='sega'||!loaded)throw Error('Сначала загрузите Sega ROM');window.labPause();nes.configureRegion(Number($('segaRegion').value));nes.loadROM(nes.romData);nes.configurePads([Number($('padP1').value),Number($('padP2').value)]);restartFromRom();$('segaCompatibility').textContent=nes.regionName+' · '+nes.fps+' FPS · P1/P2 '+nes.controllerTypes.join('/')+' кнопок';status('Регион применён. Sega перезапущена.');}catch(e){status(e.message,true);}};
for(const id of ['padP1','padP2'])$(id).onchange=()=>{if(labPlatform==='sega'&&loaded){try{releasePorts();nes.configurePads([Number($('padP1').value),Number($('padP2').value)]);updateButtons();status('Тип контроллеров изменён.');}catch(error){status(error.message,true);}}};
function validateSnapshot(snapshot){
 if(!snapshot)return;
 if(!loaded||snapshot.hash!==romHash||(snapshot.system&&snapshot.system!==labPlatform))throw Error('Снимок другого ROM или платформы');
 if(labPlatform!=='nes'){nes.validateState(snapshot.state);return;}
 const probe=new jsnes.NES();probe.loadROM(nes.romData);for(let i=0;i<5;i++)probe.frame();const template=JSON.parse(JSON.stringify(probe.toJSON()));
 function check(actual,expected,path){
  if(Array.isArray(expected)){if(!Array.isArray(actual)||actual.length!==expected.length)throw Error('Неверная длина снимка: '+path);for(let i=0;i<expected.length;i++)check(actual[i],expected[i],path);}
  else if(expected&&typeof expected==='object'){if(!actual||typeof actual!=='object'||Array.isArray(actual))throw Error('Неверное поле снимка: '+path);for(const key of Object.keys(expected))check(actual[key],expected[key],path+'.'+key);}
  else if(typeof actual!==typeof expected||(typeof actual==='number'&&!Number.isFinite(actual)))throw Error('Неверное значение снимка: '+path);
 }
 check(snapshot.state,template,'state');for(const bytes of [snapshot.state.cpu.mem,snapshot.state.ppu.vramMem,snapshot.state.ppu.spriteMem])if(!Array.isArray(bytes)||bytes.some(x=>!Number.isInteger(x)||x<0||x>255))throw Error('Неверные байты RAM снимка');probe.fromJSON(snapshot.state);
}
function restartFromRom(){emulatorBoundary('restart-rom');window.labStartStateId='rom-boot';window.guLogger?.boundary?.('emulator.reset-rom');window.flyOriginId=originId();emulatorRestarts++;holding.clear();controllerMasks.clear();manualMask=0;releasePorts();nes.reloadROM();frame=0;for(let i=0;i<5;i++){nes.frame();frame++;}audioRead=audioWrite;releasePorts();}
if(labPlatform==='nes')setupNes();
$('platformSelect').value=labPlatform;
$('platformSelect').onchange=()=>nativeCall('switchSystem',$('platformSelect').value);
$('platformOpenRom').onclick=()=>nativeCall('pickRom');$('platformDemo').onclick=()=>nativeCall('demo');
$('platformInfo').textContent=FlyPlatforms[labPlatform].label+' · '+FlyPlatforms[labPlatform].core+' · '+FlyPlatforms[labPlatform].formats+' · '+FlyPlatforms[labPlatform].ports+' контроллер(а) · ZIP/GZIP';
if(labPlatform==='sega'){
 $('resetNes').textContent='Сброс только Sega';$('saveState').textContent='Снимок Sega';$('play').textContent='Запустить эмулятор';
 $('labTitle').textContent='FLY / SEGA LAB';$('import').textContent='Открыть ROM / ZIP';$('modeInfo').textContent='Mega Drive · Genesis Plus GX / WASM · A/B/C + X/Y/Z · Mode/Start';
 document.querySelector('[data-button="2"]').textContent='C';
 $('platformFooter').textContent='Genesis Plus GX · WebAssembly · некоммерческая лицензия. Mega Drive до 32 МиБ · BIN/MD/GEN/ROM/MDX, byte-swapped, SMD, ZIP и gzip. CD/32X не поддерживаются. Регион и PAL/NTSC выбирает ядро автоматически. Снимки и RAM доступны; battery .sav отдельно не экспортируется.';
}
if(labPlatform==='gb'||labPlatform==='snes'){
 $('labTitle').textContent='FLY / '+labPlatform.toUpperCase()+' LAB';$('import').textContent='Открыть ROM / ZIP';
 $('modeInfo').textContent=FlyPlatforms[labPlatform].label+' · '+FlyPlatforms[labPlatform].core+' · '+buttonNames.join(' / ');
 $('resetNes').textContent='Сброс только '+labPlatform.toUpperCase();$('saveState').textContent='Снимок '+labPlatform.toUpperCase();
 $('platformFooter').textContent=(labPlatform==='gb'?'Gambatte · GPL-2.0-or-later · GB/GBC':'Snes9x · некоммерческая лицензия · SNES/SFC')+' · локальный WebAssembly. Полные исходники ядра и адаптера включены в APK. Снимки сохраняют RAM и состояние картриджа; отдельные battery .sav не экспортируются. Цель игры AGOD ищет по WRAM.';
}
$('play').textContent='Запустить эмулятор';
let ramPrevious=null;
$('ramInspect').onclick=()=>{try{
 if(!loaded)throw Error('Загрузите ROM');const offset=Number($('ramOffset').value);if(!Number.isInteger(offset)||offset<0||offset>ramLimit-64)throw Error('Смещение должно быть 0–'+(ramLimit-64));
 const current=Array.from(nes.cpu.mem).slice(offset,offset+64);const lines=[];
 for(let i=0;i<64;i+=16)lines.push((labPlatform==='sega'?0xff0000+offset+i:offset+i).toString(16).padStart(6,'0').toUpperCase()+': '+current.slice(i,i+16).map(v=>v.toString(16).padStart(2,'0')).join(' '));
 if(ramPrevious&&ramPrevious.offset===offset){const changed=current.map((v,i)=>v!==ramPrevious.bytes[i]?'+0x'+i.toString(16)+': '+ramPrevious.bytes[i]+'→'+v:null).filter(Boolean);lines.push('Изменения: '+(changed.join(', ')||'нет'));}
 ramPrevious={offset,bytes:current};$('ramView').textContent=lines.join('\n');
 }catch(error){status(error.message,true);}};
$('ramOffset').max=ramLimit-64;
updateHud();requestAnimationFrame(loop);if(!window.FlyBridge||typeof FlyBridge.romLibrary!=='function')nativeCall('demo');
