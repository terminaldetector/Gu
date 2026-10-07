/* Local NES frontend and bounded asynchronous connectome bridge. */
'use strict';
const $ = id => document.getElementById(id);
const buttonNames = ['A','B','Select','Start','↑','↓','←','→'];
const screen = $('screen'), context = screen.getContext('2d', {alpha:false});
const image = context.createImageData(256,240);
let nes, loaded = false, playing = false, connected = false, ready = false, configuring = false;
let romHash = '', frame = 0, generation = 0, token = 0, pendingToken = null;
let manualMask = 0, brainMask = 0, appliedMask = 0, lastResponse = 0;
let lastFrame = 0, lastSample = 0, lastTelemetry = 0, frozen = null, retina = new Array(16).fill(0);
let audioContext = null, audioNode = null, soundEnabled = false;
const audioLeft = new Float32Array(32768), audioRight = new Float32Array(32768);
let audioWrite = 0, audioRead = 0;
const history = [], holding = new Map();
let recording = false;

function log(text) {
  const lines = ($('log').textContent + '\n' + text).trim().split('\n').slice(-80);
  $('log').textContent = lines.join('\n');
}
function status(text,error=false) { $('status').textContent=text; $('status').className=error?'error':''; }
function nativeCall(name,...args) {
  if (typeof window.FlyBridge==='undefined') { status('Android bridge недоступен: NES можно тестировать в браузере.',true); return; }
  window.FlyBridge[name](...args);
}
function releaseBrain() { brainMask=0; updateButtons();[...$('outputs').children].forEach(element=>element.classList.remove('on')); }
function updateButtons() {
  let mask=manualMask|brainMask;
  if(manualMask&16)mask&=~32;if(manualMask&32)mask&=~16;
  if(manualMask&64)mask&=~128;if(manualMask&128)mask&=~64;
  if(loaded)for(let i=0;i<8;i++)if((mask&(1<<i))!==(appliedMask&(1<<i))) {
    if(mask&(1<<i))nes.buttonDown(1,i);else nes.buttonUp(1,i);
  }
  appliedMask=mask;
}
function rgbaAndRetina(buffer) {
  const sums=new Float64Array(16),counts=new Uint32Array(16);
  for(let i=0;i<61440;i++) {
    const color=buffer[i],r=(color>>>16)&255,g=(color>>>8)&255,b=color&255,at=i*4;
    image.data[at]=r;image.data[at+1]=g;image.data[at+2]=b;image.data[at+3]=255;
    // Sample every fourth pixel; each of 16 cells still has hundreds of samples.
    if((i&3)===0) {
      const x=i%256,y=(i/256)|0,tile=((y/60)|0)*4+((x/64)|0);
      sums[tile]+=(.2126*r+.7152*g+.0722*b)/255;counts[tile]++;
    }
  }
  context.putImageData(image,0,0);
  retina=Array.from(sums,(sum,i)=>sum/counts[i]);
  [...$('retina').children].forEach((element,i)=>{const c=Math.round(retina[i]*255);element.style.background=`rgb(${c},${c},${c})`;});
}
function setupNes() {
  nes=new jsnes.NES({
    onFrame:rgbaAndRetina,
    sampleRate:audioContext?audioContext.sampleRate:48000,
    onAudioSample:(left,right)=>{
      if(!soundEnabled)return;
      if(audioWrite-audioRead>=audioLeft.length)audioRead++;
      audioLeft[audioWrite%audioLeft.length]=left;audioRight[audioWrite%audioRight.length]=right;audioWrite++;
    },
    onStatusUpdate:text=>log(text)
  });
}
function toggleSound() {
  try {
    if(!audioContext){
      const Audio = window.AudioContext||window.webkitAudioContext;
      audioContext=new Audio({sampleRate:48000});
      audioNode=audioContext.createScriptProcessor(2048,0,2);
      audioNode.onaudioprocess=event=>{
        const l=event.outputBuffer.getChannelData(0),r=event.outputBuffer.getChannelData(1);
        for(let i=0;i<l.length;i++) {
          if(soundEnabled&&audioRead<audioWrite){l[i]=audioLeft[audioRead%audioLeft.length];r[i]=audioRight[audioRead%audioRight.length];audioRead++;}
          else {l[i]=0;r[i]=0;}
        }
      };
      audioNode.connect(audioContext.destination);
      nes.opts.sampleRate=audioContext.sampleRate;nes.papu.sampleRate=audioContext.sampleRate;nes.setFramerate(60);
    }
    soundEnabled=!soundEnabled;audioRead=audioWrite;
    audioContext.resume().catch(error=>status(error.message,true));
    $('audio').textContent=`Звук: ${soundEnabled?'вкл.':'выкл.'}`;
  }catch(error){status('Звук недоступен: '+error.message,true);}
}
function resetSession() {
  generation++;pendingToken=null;lastSample=0;releaseBrain();
  connected=false;$('brainToggle').textContent='Включить связь';
}
window.labLoadRom=function(data) {
  try {
    playing=false;$('play').textContent='Запустить NES';resetSession();
    const binary=atob(data.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    loaded=false;setupNes();nes.loadROM(bytes);loaded=true;appliedMask=0;manualMask=0;
    romHash=data.sha256;frame=0;
    for(let i=0;i<5;i++){nes.frame();frame++;}
    $('romName').textContent=data.name+' · '+romHash.slice(0,12);
    status('ROM загружен. Ручное управление доступно; связь с сетью включается отдельно.');
    log('ROM SHA256: '+romHash);
  }catch(error){loaded=false;status('ROM не запущен: '+error.message,true);log(error.stack||error.message);}
};
window.labReady=function(data) {
  ready=true;$('brainInfo').textContent=data.neurons.toLocaleString('ru')+' нейронов · '+(data.edges/1e6).toFixed(2)+' млн связей';
  $('inputIds').value=data.inputs.join(', ');$('outputIds').value=data.outputs.join(', ');
  ['apply','brainToggle','record','console'].forEach(id=>$(id).disabled=false);
  log(data.kind+'; heap '+data.heapMiB+' МиБ. Автопорты — технические.');
};
window.labError=function(data) {
  status(data.message,true);log(data.message);$('console').disabled=false;connected=false;configuring=false;
  $('brainToggle').textContent='Включить связь';releaseBrain();
};
function ids(id) { return $(id).value.split(/[\s,;]+/).filter(Boolean); }
function configuration() {
  const seed=Number($('seed').value);
  if(!Number.isSafeInteger(seed)||seed<0||seed>2147483647)throw Error('Seed должен быть целым 0–2147483647');
  return {inputs:ids('inputIds'),outputs:ids('outputIds'),lesions:ids('lesions'),
    mode:$('mode').value,maxHz:Number($('maxHz').value),thresholdHz:Number($('thresholdHz').value),
    windowMs:Number($('windowMs').value),gain:Number($('gain').value),seed,
    disableInhibition:$('disableInhibition').checked,scramble:$('scramble').checked};
}
function apply(start=false) {
  try {
    if(!ready)throw Error('Коннектом ещё не готов');
    resetSession();configuring=true;window.startAfterConfig=start;
    nativeCall('configure',JSON.stringify(configuration()));
    status('Применение параметров и сброс состояния…');
  }catch(error){status(error.message,true);configuring=false;}
}
window.labConfigured=function(data) {
  configuring=false;connected=Boolean(window.startAfterConfig);window.startAfterConfig=false;
  $('brainToggle').textContent=connected?'Отключить связь':'Включить связь';
  history.length=0;
  status('Сеть сброшена. Конфигурация '+data.configVersion+' · '+data.mode+(connected?' · связь включена':' · связь выключена'));
  nativeCall('resume');
};
function sampleFrame(now,force=false) {
  if(!connected||!ready||pendingToken!==null||configuring)return;
  if(!force&&$('clock').value==='async'&&now-lastSample<200)return;
  lastSample=now;pendingToken=++token;
  let input=retina;
  if($('freeze').checked){if(frozen===null)frozen=retina.slice();input=frozen;}else frozen=null;
  nativeCall('sample',JSON.stringify({retina:input,token:pendingToken,generation,frame,manualMask,frozen:$('freeze').checked}));
}
window.labResult=function(data) {
  if(data.generation!==generation||data.token!==pendingToken)return;
  pendingToken=null;lastResponse=performance.now();
  if(data.error){releaseBrain();return;}
  brainMask=connected?data.buttons:0;updateButtons();
  $('spikes').textContent=data.spikes;$('active').textContent=data.active;$('compute').textContent=data.wallMs.toFixed(1);
  [...$('outputs').children].forEach((element,i)=>{element.textContent=buttonNames[i]+' '+data.outputs[i].toFixed(0)+' Гц';element.className=(data.buttons&(1<<i))?'on':'';});
  history.push(Math.log10(1+data.spikes));if(history.length>100)history.shift();drawHistory();
  $('timing').textContent='NES: '+frame+' кадров · сеть: '+data.simMs.toFixed(1)+' мс · '+$('clock').selectedOptions[0].textContent;
  if(performance.now()-lastTelemetry>1000){log('окно '+data.sequence+': '+data.spikes+' импульсов; активных '+data.active+'; кнопки '+data.buttons);lastTelemetry=performance.now();}
};
function drawHistory() {
  const c=$('activity').getContext('2d'),w=600,h=100;c.fillStyle='#111626';c.fillRect(0,0,w,h);
  c.strokeStyle='#283249';for(let y=20;y<100;y+=20){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}
  if(history.length<2)return;const max=Math.max(1,...history);c.strokeStyle='#8cf8c5';c.lineWidth=2;c.beginPath();
  history.forEach((n,i)=>{const x=i*w/99,y=95-n/max*85;i?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();
}
function advanceFrame(now,forceSample=false) {
  if(!loaded)return;
  try {updateButtons();nes.frame();frame++;sampleFrame(now,forceSample);}
  catch(error){playing=false;connected=false;releaseBrain();status('Эмуляция остановлена: '+error.message,true);$('play').textContent='Запустить NES';}
}
function loop(now) {
  if(brainMask&&now-lastResponse>500)releaseBrain();
  const lockstep=connected&&$('clock').value==='lockstep';
  if(playing&&now-lastFrame>=1000/60&&(!lockstep||pendingToken===null)&&!configuring){lastFrame=now;advanceFrame(now,lockstep);}
  requestAnimationFrame(loop);
}
window.labPause=function() {
  playing=false;connected=false;configuring=false;generation++;pendingToken=null;
  manualMask=0;holding.clear();releaseBrain();audioRead=audioWrite;
  $('play').textContent='Запустить NES';$('brainToggle').textContent='Включить связь';nativeCall('stop');
};
$('play').onclick=()=>{if(!loaded){status('Сначала загрузите ROM',true);return;}playing=!playing;$('play').textContent=playing?'Пауза NES':'Запустить NES';if(playing)nativeCall('resume');else{releaseBrain();nativeCall('stop');}};
$('step').onclick=()=>{if(!playing&&pendingToken===null){nativeCall('resume');advanceFrame(performance.now(),true);}};
$('console').onclick=()=>nativeCall('console');
$('demo').onclick=()=>nativeCall('demo');$('import').onclick=()=>nativeCall('pickRom');$('audio').onclick=toggleSound;
$('apply').onclick=()=>apply(false);
$('brainToggle').onclick=()=>{if(connected){connected=false;resetSession();nativeCall('stop');status('Связь отключена; NES доступен вручную.');}else apply(true);};
$('resetNes').onclick=()=>{if(loaded){playing=false;$('play').textContent='Запустить NES';nes.reloadROM();holding.clear();manualMask=0;brainMask=0;for(let i=0;i<8;i++)nes.buttonUp(1,i);appliedMask=0;frame=0;resetSession();for(let i=0;i<5;i++){nes.frame();frame++;}if(ready)apply(false);}};
$('gain').oninput=()=>$('gainLabel').textContent=Number($('gain').value).toFixed(2);
$('freeze').onchange=()=>{frozen=null;log('Freeze retina: '+$('freeze').checked);};
$('saveState').onclick=()=>{try{if(!loaded)throw Error('ROM не загружен');localStorage.setItem('nes-slot',JSON.stringify({hash:romHash,state:nes.toJSON()}));status('Снимок NES сохранён. Состояние коннектома не входит в снимок.');}catch(error){status(error.message,true);}};
$('loadState').onclick=()=>{try{const saved=JSON.parse(localStorage.getItem('nes-slot'));if(!saved||saved.hash!==romHash)throw Error('Снимок отсутствует или относится к другому ROM');window.labPause();nes.fromJSON(saved.state);frame=0;appliedMask=255;updateButtons();if(ready)apply(false);status('NES восстановлен; сеть сброшена.');}catch(error){status(error.message,true);}};
$('record').onclick=()=>nativeCall('recording',!recording);$('export').onclick=()=>nativeCall('exportCsv');
window.labRecording=data=>{recording=data.active;$('record').textContent=recording?'Остановить запись':'Запись CSV';$('record').className=recording?'active':'';};
for(let i=0;i<16;i++)$('retina').appendChild(document.createElement('span'));
buttonNames.forEach(name=>{const span=document.createElement('span');span.textContent=name+' —';$('outputs').appendChild(span);});
function refreshManual() {manualMask=0;for(const button of holding.values())manualMask|=1<<button;updateButtons();}
document.querySelectorAll('[data-button]').forEach(element=>{
  const button=Number(element.dataset.button);
  element.onpointerdown=event=>{event.preventDefault();element.setPointerCapture(event.pointerId);holding.set(event.pointerId,button);refreshManual();element.classList.add('active');};
  element.onpointerup=element.onpointercancel=event=>{holding.delete(event.pointerId);refreshManual();element.classList.remove('active');};
});
const keys={ArrowUp:4,ArrowDown:5,ArrowLeft:6,ArrowRight:7,x:0,z:1,Enter:3,Shift:2};
window.onkeydown=event=>{if(['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;const button=keys[event.key];if(button!==undefined){event.preventDefault();holding.set('key-'+event.key,button);refreshManual();}};
window.onkeyup=event=>{holding.delete('key-'+event.key);refreshManual();};
window.onblur=()=>{holding.clear();refreshManual();releaseBrain();};
setupNes();drawHistory();requestAnimationFrame(loop);nativeCall('demo');
