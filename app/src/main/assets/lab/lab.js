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
let sampledRetina=new Array(16).fill(0),previousRetina=null,startSnapshot=null;
const profileFields=["rewardMode","rewardAddress","rewardScale","ramWidth","ramFormat","ramEndian","ramWrap","actionMasks","deathEnabled","deathAddress","deathValue","deathReward","winEnabled","winAddress","winValue","winReward","epsilon","alpha","episodeLength","autoEpisode"];
const learner=new FlyLearner(1),trials=[],transitions=[];
let lastDecisionFeatures=null,sampledControllerMask=0,graphIdentity=null;
let episodeSteps=0,episodeReward=0,rewardPending=0,finishPending=false,lastRewardValue=null,diagnosticHash=null,learnReward=0;
function learningBoundary(){learner.boundary();lastRewardValue=null;episodeSteps=0;episodeReward=0;rewardPending=0;finishPending=false;previousRetina=null;lastDecisionFeatures=null;learnReward=0;}
function learningKey(){return JSON.stringify({romHash,inputs:ids('inputIds'),outputs:ids('outputIds'),profile:profileValues(),configuration:configuration()});}
function learningStats(){ $('learningStats').textContent='Обновлений: '+learner.updates+' · эпизодов: '+learner.episodes+' · награда: '+episodeReward.toFixed(2)+' · шаг: '+episodeSteps+' · кнопки: '+brainMask;
 const c=$('rewardChart').getContext('2d');c.fillStyle='#111626';c.fillRect(0,0,600,100);if(trials.length<2)return;const low=Math.min(0,...trials.map(t=>t.reward)),high=Math.max(1,...trials.map(t=>t.reward));c.strokeStyle='#b39bff';c.beginPath();trials.forEach((t,i)=>{const x=i*600/99,y=95-(t.reward-low)/(high-low)*85;i?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();
}
function learnedButtons(data){
 const mode=$('learnMode').value;if(mode==='off')return data.buttons;
 if($('mode').value!=='closed'||$('clock').value!=='lockstep')throw Error('Обучение требует замкнутого пошагового контура');
 if(manualMask){learningBoundary();return 0;}
 const diagnostic=$('rewardMode').value==='diagnostic';
 if(diagnostic&&romHash!==diagnosticHash)throw Error('Диагностическая награда доступна только для встроенного тестового ROM');
 const address=Number($('rewardAddress').value),scale=Number($('rewardScale').value),limit=Number($('episodeLength').value);
 const epsilon=Number($('epsilon').value),alpha=Number($('alpha').value);
 if(!Number.isInteger(address)||address<0||address>2047||!Number.isFinite(scale)||Math.abs(scale)>10||!Number.isInteger(limit)||limit<10||limit>2000||epsilon<0||epsilon>1||!Number.isFinite(epsilon)||alpha<.001||alpha>.2||!Number.isFinite(alpha))throw Error('Параметры обучения вне границ');
 learner.epsilon=epsilon;learner.alpha=alpha;
 const x=nes.cpu.mem[0],y=nes.cpu.mem[1];
 const spec={address,width:Number($('ramWidth').value),format:$('ramFormat').value,endian:$('ramEndian').value};
 const value=diagnostic?-Math.abs(200-x)-Math.abs(100-y):$('rewardMode').value==='ram'?FlyGameTools.readRam(nes.cpu.mem,spec):0;
 let reward=rewardPending;rewardPending=0;
 if(lastRewardValue!==null){if(diagnostic)reward+=(value-lastRewardValue)/8-.01;else if($('rewardMode').value==='ram')reward+=FlyGameTools.delta(value,lastRewardValue,spec,$('ramWrap').checked)*scale;}
 lastRewardValue=value;reward=Math.max(-10,Math.min(10,reward));
 const success=diagnostic?x>=200&&Math.abs(y-100)<=4:$('winEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('winAddress').value,$('winValue').value);
 const death=$('deathEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('deathAddress').value,$('deathValue').value);
 const terminal=finishPending||success||death||episodeSteps+1>=limit;finishPending=false;
 const bonus=diagnostic?2:Number($('winReward').value),penalty=Number($('deathReward').value);
 if(!Number.isFinite(bonus)||Math.abs(bonus)>10||!Number.isFinite(penalty)||Math.abs(penalty)>10)throw Error('Награда завершения вне границ');
 if(death)reward+=penalty;else if(success)reward+=bonus;
 const position=diagnostic?[x/256,y/240,(200-x)/256,(100-y)/240]:null;
 const features=learner.features(sampledRetina,data.outputs,position,previousRetina);previousRetina=sampledRetina.slice();
 learnReward=reward;episodeReward+=reward;episodeSteps++;
 if(lastDecisionFeatures){transitions.push({romHash,episode:learner.episodes,frame,sequence:data.sequence,state:lastDecisionFeatures,action:sampledControllerMask,reward,next:features.slice(),terminal,mode});if(transitions.length>200)transitions.shift();}
 const mask=learner.step(features,reward,terminal,mode==='train');lastDecisionFeatures=features.slice();
 if(terminal){trials.push({reward:episodeReward,success:success&&!death,death,steps:episodeSteps,mode});if(trials.length>100)trials.shift();log('Эпизод '+learner.episodes+': '+episodeReward.toFixed(2)+'; успех '+success);learningStats();
  if(mode==='train'&&$('autosavePolicy').checked){try{persistPolicy(false);}catch(error){log('Автосохранение: '+error.message);}}
  if($('autoEpisode').checked){restartEpisode();learningBoundary();apply(true,false);}
  else {playing=false;connected=false;releaseBrain();$('play').textContent='Запустить NES';$('brainToggle').textContent='Включить связь';nativeCall('stop');learningBoundary();}
 }
 return terminal?0:mask;
}


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
    const color=buffer[i],r=color&255,g=(color>>>8)&255,b=(color>>>16)&255,at=i*4;
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
  generation++;pendingToken=null;lastSample=0;releaseBrain();learningBoundary();
  connected=false;$('brainToggle').textContent='Включить связь';
}
window.labLoadRom=function(data) {
  const oldNes=nes,oldLoaded=loaded;
  try {
    playing=false;$('play').textContent='Запустить NES';resetSession();
    const binary=atob(data.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const info=FlyGameTools.validateRom(bytes);
    loaded=false;setupNes();nes.loadROM(bytes);loaded=true;appliedMask=0;manualMask=0;
    const changedRom=romHash!==data.sha256;romHash=data.sha256;frame=0;if(data.name.includes("diagnostic"))diagnosticHash=romHash;if(changedRom){learner.reset(Number($("seed").value));learner.setActions(FlyGameTools.actions($("actionMasks").value));startSnapshot=null;}learningBoundary();updateStartInfo();
    for(let i=0;i<5;i++){nes.frame();frame++;}
    $('romName').textContent=data.name+' · '+romHash.slice(0,12);
    status('ROM загружен. Ручное управление доступно; связь с сетью включается отдельно.');
    nativeCall('acceptRom',romHash);log('ROM SHA256: '+romHash+' · mapper '+info.mapper);if(info.submapper)log('NES2 submapper '+info.submapper+': специальная совместимость не гарантирована.');if(info.timing)log('PAL/Dendy: ядро работает с NTSC таймингом.');if(info.battery)log('Battery RAM .sav не сохраняется; используйте снимки NES.');
    if(!data.name.includes('diagnostic')){$('rewardMode').value='manual';$('learnMode').value='off';status('Внешний ROM загружен. Пройдите меню, сохраните старт и настройте профиль награды.');}
    trials.length=0;transitions.length=0;learningStats();
  }catch(error){nes=oldNes;loaded=oldLoaded;status('ROM не запущен: '+error.message,true);log(error.stack||error.message);}
};
window.labReady=function(data) {
  graphIdentity={kind:data.kind,neurons:data.neurons,edges:data.edges};ready=true;$('brainInfo').textContent=data.neurons.toLocaleString('ru')+' нейронов · '+(data.edges/1e6).toFixed(2)+' млн связей';
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
function apply(start=false,restoreStart=true) {
  try {
    if(!ready)throw Error('Коннектом ещё не готов');
    resetSession();if(start&&restoreStart&&startSnapshot)restartEpisode();configuring=true;window.startAfterConfig=start;
    if($('learnMode').value!=='off')validateProfile(profileValues());
    learner.setActions(FlyGameTools.actions($('actionMasks').value));
    nativeCall('configure',JSON.stringify(configuration()));
    status('Применение параметров и сброс состояния…');
  }catch(error){status(error.message,true);configuring=false;}
}
window.labConfigured=function(data) {
  configuring=false;connected=Boolean(window.startAfterConfig);window.startAfterConfig=false;
  $('brainToggle').textContent=connected?'Отключить связь':'Включить связь';
  history.length=0;
  status('Сеть сброшена. Конфигурация '+data.configVersion+' · '+data.mode+(connected?' · связь включена':' · связь выключена'));
  learningBoundary();nativeCall('resume');
};
function sampleFrame(now,force=false) {
  if(!connected||!ready||pendingToken!==null||configuring)return;
  if(!force&&$('clock').value==='async'&&now-lastSample<200)return;
  lastSample=now;pendingToken=++token;
  let input=retina;
  if($('freeze').checked){if(frozen===null)frozen=retina.slice();input=frozen;}else frozen=null;
  sampledRetina=input.slice();sampledControllerMask=appliedMask;
  nativeCall('sample',JSON.stringify({retina:input,token:pendingToken,generation,frame,manualMask,controllerMask:appliedMask,learningMode:$('learnMode').value,learningReward:learnReward,frozen:$('freeze').checked}));
}
window.labResult=function(data) {
  if(data.generation!==generation||data.token!==pendingToken)return;
  pendingToken=null;lastResponse=performance.now();
  if(data.error){releaseBrain();return;}
  try{brainMask=connected?learnedButtons(data):0;}catch(error){window.labError({message:error.message});brainMask=0;}updateButtons();learningStats();
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
$('saveState').onclick=()=>{try{if(!loaded)throw Error('ROM не загружен');localStorage.setItem('nes-slot',JSON.stringify({hash:romHash,state:JSON.parse(JSON.stringify(nes.toJSON()))}));status('Снимок NES сохранён. Состояние коннектома не входит в снимок.');}catch(error){status(error.message,true);}};
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
$('learnMode').onchange=()=>{window.labPause();learningBoundary();if($('learnMode').value!=='off'){$('mode').value='closed';$('clock').value='lockstep';}status('Политика изменена. Включите связь и запустите NES.');};
$('rewardMode').onchange=()=>{window.labPause();learningBoundary();};
$('rewardPlus').onclick=()=>rewardPending+=1;$('rewardMinus').onclick=()=>rewardPending-=1;$('endEpisode').onclick=()=>finishPending=true;
$('clearPolicy').onclick=()=>{try{const actions=FlyGameTools.actions($('actionMasks').value);window.labPause();learner.reset(Number($('seed').value));learner.setActions(actions);learningBoundary();trials.length=0;transitions.length=0;learningStats();}catch(error){status(error.message,true);}};
function profileValues(){const values={};for(const id of profileFields){const el=$(id);values[id]=el.type==='checkbox'?el.checked:el.value;}return values;}
function updateStartInfo(){$('startInfo').textContent=startSnapshot?'Старт: снимок текущего ROM, кадр '+startSnapshot.frame:'Старт: перезапуск ROM с начала.';}
function validateProfile(p){
 FlyGameTools.actions(p.actionMasks);if(!['diagnostic','ram','manual'].includes(p.rewardMode))throw Error('Неверная награда');
 FlyGameTools.readRam(new Uint8Array(2048),{address:p.rewardAddress,width:p.ramWidth,format:p.ramFormat,endian:p.ramEndian});
 for(const [id,min,max] of [['rewardScale',-10,10],['epsilon',0,1],['alpha',.001,.2],['episodeLength',10,2000],['deathReward',-10,10],['winReward',-10,10]]){const n=Number(p[id]);if(!Number.isFinite(n)||n<min||n>max||p[id].trim()===''||(id==='episodeLength'&&!Number.isInteger(n)))throw Error('Параметр профиля вне границ: '+id);}
 for(const name of ['death','win'])FlyGameTools.predicate(new Uint8Array(2048),p[name+'Address'],p[name+'Value']);
}
function validateConfiguration(c){
 for(const [id,min,max] of [['maxHz',0,500],['thresholdHz',1,500],['windowMs',1,100],['seed',0,2147483647],['gain',0,2]])if(!Number.isFinite(c[id])||c[id]<min||c[id]>max||(['windowMs','seed'].includes(id)&&!Number.isInteger(c[id])))throw Error('Неверная конфигурация сети: '+id);
 if(!['closed','observe','sham'].includes(c.mode)||typeof c.disableInhibition!=='boolean'||typeof c.scramble!=='boolean')throw Error('Неверная конфигурация сети');
 for(const [id,len] of [['inputs',16],['outputs',8],['lesions',null]])if(!Array.isArray(c[id])||(len!==null&&c[id].length!==len)||c[id].length>256||new Set(c[id]).size!==c[id].length||c[id].some(x=>typeof x!=='string'||!/^\d+$/.test(x)))throw Error('Неверные ID портов');
 if(c.inputs.some(x=>c.outputs.includes(x)))throw Error('Входные и выходные порты совпадают');
}
function validateSnapshot(snapshot){if(!snapshot)return;if(snapshot.hash!==romHash||!snapshot.state||!snapshot.state.cpu||!snapshot.state.ppu||!snapshot.state.mmap||!snapshot.state.papu||!Array.isArray(snapshot.state.cpu.mem)||snapshot.state.cpu.mem.length!==65536||!Array.isArray(snapshot.state.ppu.vramMem)||snapshot.state.ppu.vramMem.length!==32768||!Array.isArray(snapshot.state.ppu.buffer)||snapshot.state.ppu.buffer.length!==61440)throw Error('Неверный стартовый снимок');const probe=new jsnes.NES();probe.loadROM(nes.romData);probe.fromJSON(snapshot.state);}
function restartEpisode(){holding.clear();manualMask=0;brainMask=0;if(startSnapshot){nes.fromJSON(JSON.parse(JSON.stringify(startSnapshot.state)));frame=startSnapshot.frame;rgbaAndRetina(nes.ppu.buffer);}else{nes.reloadROM();frame=0;for(let i=0;i<5;i++){nes.frame();frame++;}}for(let i=0;i<8;i++)nes.buttonUp(1,i);appliedMask=0;audioRead=audioWrite;updateButtons();}
function policyPackage(includeStart=false){if(!ready||!loaded)throw Error("Дождитесь ROM и коннектома");validateProfile(profileValues());validateConfiguration(configuration());const actions=FlyGameTools.actions($('actionMasks').value);if(JSON.stringify(actions)!==JSON.stringify(learner.actions))throw Error('Сначала примените набор действий');const result={version:2,romHash,key:learningKey(),profile:profileValues(),configuration:configuration(),policy:learner.save(),trials:trials.slice()};if(includeStart){result.start=startSnapshot;result.transitions=transitions.slice();result.graph=graphIdentity;}return result;}
function persistPolicy(show=true){const text=JSON.stringify(policyPackage(false));localStorage.setItem('fly-policy-'+romHash,text);if(show){$('policyJson').value=text;status('Веса сохранены. Для переноса со стартом используйте экспорт JSON.');}}
function restorePolicy(saved){if(saved.romHash!==romHash||saved.key!==learningKey())throw Error('ROM, порты или профиль не совпадают');const probe=new FlyLearner();probe.load(saved.policy);window.labPause();learner.load(saved.policy);learningBoundary();trials.length=0;if(Array.isArray(saved.trials))trials.push(...saved.trials.slice(-100).filter(t=>Number.isFinite(t.reward)));learningStats();}
$('savePolicy').onclick=()=>{try{persistPolicy();}catch(error){status(error.message,true);}};
$('loadPolicy').onclick=()=>{try{const raw=$('policyJson').value.trim()||localStorage.getItem('fly-policy-'+romHash);if(!raw||raw.length>8*1024*1024)throw Error('Модель отсутствует или слишком велика');restorePolicy(JSON.parse(raw));status('Модель загружена. Выберите оценку и включите связь.');}catch(error){status(error.message,true);}};
$('captureStart').onclick=()=>{try{if(!loaded)throw Error('Загрузите ROM');window.labPause();startSnapshot={hash:romHash,frame,state:JSON.parse(JSON.stringify(nes.toJSON()))};learningBoundary();updateStartInfo();status('Старт эпизода сохранён. Автоперезапуск будет возвращаться сюда.');}catch(error){status(error.message,true);}};
$('clearStart').onclick=()=>{window.labPause();startSnapshot=null;learningBoundary();updateStartInfo();};
$('saveProfile').onclick=()=>{try{if(!ready||!loaded)throw Error('Дождитесь ROM и коннектома');validateProfile(profileValues());validateConfiguration(configuration());localStorage.setItem('fly-profile-'+romHash,JSON.stringify({version:2,romHash,profile:profileValues(),configuration:configuration(),start:startSnapshot}));status('Профиль игры сохранён.');}catch(error){status(error.message,true);}};
function restoreProfile(data){
 if(!loaded||data.version!==2||data.romHash!==romHash||!data.profile||!data.configuration)throw Error('Профиль относится к другому ROM или версии');
 validateProfile(data.profile);validateConfiguration(data.configuration);validateSnapshot(data.start);const actionSet=FlyGameTools.actions(data.profile.actionMasks);
 for(const id of profileFields)if(!Object.prototype.hasOwnProperty.call(data.profile,id)||typeof data.profile[id]!==($(id).type==='checkbox'?'boolean':'string'))throw Error('Неверное поле профиля: '+id);
 const backup=profileValues(),cfg=configuration(),oldStart=startSnapshot;
 window.labPause();
 try{for(const id of profileFields){const el=$(id);if(el.type==='checkbox')el.checked=data.profile[id];else el.value=data.profile[id];}
  for(const id of ['maxHz','thresholdHz','windowMs','seed','gain'])$(id).value=data.configuration[id];
  for(const id of ['disableInhibition','scramble'])$(id).checked=data.configuration[id];
  for(const id of ['inputs','outputs','lesions'])$(id==='inputs'?'inputIds':id==='outputs'?'outputIds':'lesions').value=data.configuration[id].join(', ');
  $('mode').value=data.configuration.mode;configuration();startSnapshot=data.start||null;learner.setActions(actionSet);learningBoundary();updateStartInfo();
 }catch(error){for(const id of profileFields){const el=$(id);if(el.type==='checkbox')el.checked=backup[id];else el.value=backup[id];}startSnapshot=oldStart;for(const id of ['maxHz','thresholdHz','windowMs','seed','gain'])$(id).value=cfg[id];for(const id of ['disableInhibition','scramble'])$(id).checked=cfg[id];$('inputIds').value=cfg.inputs.join(', ');$('outputIds').value=cfg.outputs.join(', ');$('lesions').value=cfg.lesions.join(', ');$('mode').value=cfg.mode;throw error;}
}
$('loadProfile').onclick=()=>{try{const text=localStorage.getItem('fly-profile-'+romHash);if(!text)throw Error('Профиль не сохранён');restoreProfile(JSON.parse(text));status('Профиль восстановлен. Включите связь для применения.');}catch(error){status(error.message,true);}};
$('exportModel').onclick=()=>{try{if(!loaded)throw Error('Загрузите ROM');nativeCall('exportModel',JSON.stringify(policyPackage(true)));}catch(error){status(error.message,true);}};
$('importModel').onclick=()=>nativeCall('importModel');
window.labImportModel=data=>{try{const probe=new FlyLearner();probe.load(data.policy);if(data.romHash!==romHash)throw Error('Модель другого ROM');const values={};for(const id of profileFields)values[id]=data.profile[id];const expected=JSON.stringify({romHash,inputs:data.configuration.inputs,outputs:data.configuration.outputs,profile:values,configuration:data.configuration});if(data.key!==expected||JSON.stringify(probe.actions)!==JSON.stringify(FlyGameTools.actions(values.actionMasks)))throw Error('Модель и профиль не согласованы');restoreProfile(data);restorePolicy(data);status('Профиль и модель импортированы.');}catch(error){status(error.message,true);}};
for(const id of profileFields)$(id).addEventListener('change',()=>{window.labPause();learningBoundary();status('Профиль изменён: опыт остановлен. Включите связь для продолжения.');});
setupNes();drawHistory();learningStats();requestAnimationFrame(loop);nativeCall('demo');
