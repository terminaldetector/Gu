/* Local NES frontend and bounded asynchronous connectome bridge. */
'use strict';
const $ = id => document.getElementById(id);
const labPlatform=new URLSearchParams(location.search).get('system')==='sega'?'sega':'nes';
const buttonNames = ['A','B',labPlatform==='sega'?'C':'Select','Start','↑','↓','←','→'];
const ramLimit=labPlatform==='sega'?65536:2048;
const screen = $('screen'), context = screen.getContext('2d', {alpha:false});
let image = context.createImageData(256,240);
let nes, loaded = false, playing = false, connected = false, ready = false, configuring = false;
let romHash = '', frame = 0, generation = 0, token = 0, pendingToken = null;
let manualMask = 0, brainMask = 0, appliedMask = 0, lastResponse = 0;
let lastFrame = 0, lastSample = 0, lastTelemetry = 0, frozen = null, retina = new Array(16).fill(0);
let audioContext = null, audioNode = null, soundEnabled = false;
const audioLeft = new Float32Array(32768), audioRight = new Float32Array(32768);
let audioWrite = 0, audioRead = 0;
const history = [], holding = new Map();
let recording = false, romLoading=false, romLoadSequence=0, pendingSince=0, requestedConfiguration=null;
let measuredFrames=0, measuredCpuMs=0, measuredStarted=performance.now(), measuredWindows=0, measuredNetworkMs=0;
let benchmark=null,lastBenchmark=null;
let sampledRetina=new Array(16).fill(0),previousRetina=null,startSnapshot=null;
const profileFields=["rewardMode","rewardAddress","rewardScale","ramWidth","ramFormat","ramEndian","ramWrap","actionMasks","deathEnabled","deathAddress","deathValue","deathReward","winEnabled","winAddress","winValue","winReward","epsilon","alpha","episodeLength","autoEpisode"];
const learner=new FlyLearner(1),trials=[],transitions=[];
let lastDecisionFeatures=null,sampledControllerMask=0,graphIdentity=null;
let episodeSteps=0,episodeReward=0,rewardPending=0,finishPending=false,lastRewardValue=null,diagnosticHash=null,learnReward=0;
function learningBoundary(){learner.boundary();lastRewardValue=null;episodeSteps=0;episodeReward=0;rewardPending=0;finishPending=false;previousRetina=null;lastDecisionFeatures=null;learnReward=0;}
function keysEqual(a,b){try{const x=JSON.parse(a),y=JSON.parse(b);x.system=x.system||'nes';y.system=y.system||'nes';const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return JSON.stringify(sort(x))===JSON.stringify(sort(y));}catch(_){return false;}}
function learningKey(){return JSON.stringify({romHash,inputs:ids('inputIds'),outputs:ids('outputIds'),system:labPlatform,graph_sha256:graphIdentity&&graphIdentity.sha256||'unavailable',profile:profileValues(),configuration:configuration()});}
function learningStats(){ $('learningStats').textContent='Обновлений: '+learner.updates+' · эпизодов: '+learner.episodes+' · награда: '+episodeReward.toFixed(2)+' · шаг: '+episodeSteps+' · кнопки: '+brainMask;
 const c=$('rewardChart').getContext('2d');c.fillStyle='#111626';c.fillRect(0,0,600,100);if(trials.length<2)return;const low=Math.min(0,...trials.map(t=>t.reward)),high=Math.max(1,...trials.map(t=>t.reward));c.strokeStyle='#b39bff';c.beginPath();trials.forEach((t,i)=>{const x=i*600/99,y=95-(t.reward-low)/(high-low)*85;i?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();
}
function learnedButtons(data){
 if(benchmark)return benchmarkDecision(data);
 const mode=$('learnMode').value;if(mode==='off')return data.buttons;
 if($('mode').value!=='closed'||$('clock').value!=='lockstep')throw Error('Обучение требует замкнутого пошагового контура');
 if(manualMask){learningBoundary();return 0;}
 const diagnostic=$('rewardMode').value==='diagnostic';
 if(diagnostic&&(labPlatform!=='nes'||romHash!==diagnosticHash))throw Error('Диагностическая награда доступна только для встроенного тестового ROM');
 const address=Number($('rewardAddress').value),scale=Number($('rewardScale').value),limit=Number($('episodeLength').value);
 const epsilon=Number($('epsilon').value),alpha=Number($('alpha').value);
 if(!Number.isInteger(address)||address<0||address>=ramLimit||!Number.isFinite(scale)||Math.abs(scale)>10||!Number.isInteger(limit)||limit<10||limit>2000||epsilon<0||epsilon>1||!Number.isFinite(epsilon)||alpha<.001||alpha>.2||!Number.isFinite(alpha))throw Error('Параметры обучения вне границ');
 learner.epsilon=epsilon;learner.alpha=alpha;
 const x=nes.cpu.mem[0],y=nes.cpu.mem[1];
 const spec={address,width:Number($('ramWidth').value),format:$('ramFormat').value,endian:$('ramEndian').value};
 const value=diagnostic?-Math.abs(200-x)-Math.abs(100-y):$('rewardMode').value==='ram'?FlyGameTools.readRam(nes.cpu.mem,spec,ramLimit):0;
 let reward=rewardPending;rewardPending=0;
 if(lastRewardValue!==null){if(diagnostic)reward+=(value-lastRewardValue)/8-.01;else if($('rewardMode').value==='ram')reward+=FlyGameTools.delta(value,lastRewardValue,spec,$('ramWrap').checked)*scale;}
 lastRewardValue=value;reward=Math.max(-10,Math.min(10,reward));
 const success=diagnostic?x>=200&&Math.abs(y-100)<=4:$('winEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('winAddress').value,$('winValue').value,ramLimit);
 const death=$('deathEnabled').checked&&FlyGameTools.predicate(nes.cpu.mem,$('deathAddress').value,$('deathValue').value,ramLimit);
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
  else {playing=false;connected=false;releaseBrain();$('play').textContent='Запустить эмулятор';$('brainToggle').textContent='Включить связь';nativeCall('stop');learningBoundary();}
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
function rgbaAndRetina(buffer,width=256,height=240) {
  if(screen.width!==width||screen.height!==height){screen.width=width;screen.height=height;screen.style.aspectRatio=width+"/"+height;image=context.createImageData(width,height);}
  const sums=new Float64Array(16),counts=new Uint32Array(16);
  for(let i=0;i<width*height;i++) {
    const color=buffer[i],r=color&255,g=(color>>>8)&255,b=(color>>>16)&255,at=i*4;
    image.data[at]=r;image.data[at+1]=g;image.data[at+2]=b;image.data[at+3]=255;
    // Sample every fourth pixel; each of 16 cells still has hundreds of samples.
    if((i&3)===0) {
      const x=i%width,y=(i/width)|0,tile=((y/(height/4))|0)*4+((x/(width/4))|0);
      sums[tile]+=(.2126*r+.7152*g+.0722*b)/255;counts[tile]++;
    }
  }
  context.putImageData(image,0,0);
  retina=Array.from(sums,(sum,i)=>sum/counts[i]);
  [...$('retina').children].forEach((element,i)=>{const c=Math.round(retina[i]*255);element.style.background=`rgb(${c},${c},${c})`;});
}
function coreOptions(){return {
    onFrame:rgbaAndRetina,
    sampleRate:audioContext?audioContext.sampleRate:labPlatform==='sega'?44100:48000,
    onAudioSample:(left,right)=>{
      if(!soundEnabled)return;
      if(audioWrite-audioRead>=audioLeft.length)audioRead++;
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
      audioContext=new Audio({sampleRate:labPlatform==='sega'?44100:48000});
      audioNode=audioContext.createScriptProcessor(2048,0,2);
      audioNode.onaudioprocess=event=>{
        const l=event.outputBuffer.getChannelData(0),r=event.outputBuffer.getChannelData(1);
        for(let i=0;i<l.length;i++) {
          if(soundEnabled&&audioRead<audioWrite){l[i]=audioLeft[audioRead%audioLeft.length];r[i]=audioRight[audioRead%audioRight.length];audioRead++;}
          else {l[i]=0;r[i]=0;}
        }
      };
      audioNode.connect(audioContext.destination);
      if(labPlatform==='nes'){nes.opts.sampleRate=audioContext.sampleRate;nes.papu.sampleRate=audioContext.sampleRate;nes.setFramerate(60);}
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
window.labLoadRom=async function(data) {
  const sequence=++romLoadSequence;romLoading=true;
  try {
    window.labPause();
    const bytes=Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0));
    const info=labPlatform==='sega'?SegaConsole.validateRom(bytes):FlyGameTools.validateRom(bytes);
    let committed=false,bootFrame=null;
    const opts=coreOptions();opts.onFrame=(buffer,width,height)=>{if(committed)rgbaAndRetina(buffer,width,height);else bootFrame={buffer:Array.from(buffer),width,height};};
    const output=opts.onAudioSample;opts.onAudioSample=(l,r)=>{if(committed)output(l,r);};
    const candidate=labPlatform==='sega'?await SegaConsole.create(opts,window.GenPlusFactory,{locateFile:path=>'sega/'+path}):new jsnes.NES(opts);
    if(sequence!==romLoadSequence)return;
    candidate.loadROM(bytes);for(let i=0;i<5;i++)candidate.frame();
    if(sequence!==romLoadSequence)return;
    const actions=FlyGameTools.actions($('actionMasks').value),changedRom=romHash!==data.sha256;
    if(loaded&&learner.updates){try{persistPolicy(false);}catch(error){log('Перед сменой ROM: '+error.message);}}
    nes=candidate;loaded=true;committed=true;romHash=data.sha256;frame=5;appliedMask=0;manualMask=0;audioRead=audioWrite;
    resetSession();if(bootFrame)rgbaAndRetina(bootFrame.buffer,bootFrame.width,bootFrame.height);
    if(data.name.includes('diagnostic'))diagnosticHash=romHash;
    if(changedRom){learner.reset(Number($('seed').value));learner.setActions(actions);startSnapshot=null;}
    learningBoundary();updateStartInfo();measuredFrames=0;measuredCpuMs=0;measuredWindows=0;measuredNetworkMs=0;measuredStarted=performance.now();
    $('romName').textContent=data.name+' · '+romHash.slice(0,12);
    status('ROM загружен. Ручное управление доступно; связь включается отдельно.');
    nativeCall('acceptRom',romHash);log('ROM SHA256: '+romHash+' · '+(labPlatform==='sega'?'Genesis Plus GX, '+nes.fps+' FPS':'mapper '+info.mapper));
    if(info.submapper)log('NES2 submapper '+info.submapper+': специальная совместимость не гарантирована.');
    if(info.timing)log('PAL/Dendy: NES ядро работает с NTSC таймингом.');
    if(info.battery)log('Battery RAM .sav отдельно не сохраняется; используйте снимки.');
    if(!data.name.includes('diagnostic')){$('rewardMode').value='manual';$('learnMode').value='off';status('Внешний ROM загружен. Пройдите меню, сохраните старт и настройте профиль награды.');}
    trials.length=0;transitions.length=0;learningStats();
  }catch(error){status('ROM не запущен: '+error.message,true);log(error.stack||error.message);}
  finally{if(sequence===romLoadSequence)romLoading=false;}
};
window.labReady=function(data) {
  const changed=ready&&(graphIdentity.sha256||'')!==(data.graph_sha256||'');
  if(changed){window.labPause();learner.reset(Number($('seed').value));log('Граф изменён: политика сброшена.');}
  if(!ready||changed){$('inputIds').value=data.inputs.join(', ');$('outputIds').value=data.outputs.join(', ');}
  graphIdentity={kind:data.kind,neurons:data.neurons,edges:data.edges,sha256:data.graph_sha256,diagnostics:data.diagnostics};ready=true;
  $('brainInfo').textContent=data.neurons.toLocaleString('ru')+' нейронов · '+(data.edges/1e6).toFixed(2)+' млн связей';
  const d=data.diagnostics||{},device=d.device||{};
  $('passport').textContent='Fly Console Lab '+(d.version||'test')+' · '+labPlatform.toUpperCase()+'\n'+data.kind+'\nНейронов: '+data.neurons+' · связей: '+data.edges+'\nSHA256 графа: '+(data.graph_sha256||'не предоставлен')+'\nМодель: LIF · dt '+(d.dt_ms||.1)+' мс · задержка '+(d.synaptic_delay_ms||1.8)+' мс · веса фиксированы\nОценка графа и одного состояния: '+(d.graph_memory_mib||'—')+' МиБ · предел Java heap: '+data.heapMiB+' МиБ\nУстройство: '+(device.model||'тестовая среда')+' · Android '+(device.android||'—')+' / API '+(device.sdk||'—')+'\nWebView: '+(device.webview||'—')+' · ABI '+(device.abis||[]).join(', ')+'\nБиологическая эквивалентность не подтверждена. SARSA обучает внешний адаптер из 45 признаков.';
  ['apply','brainToggle','record','console'].forEach(id=>$(id).disabled=false);
  log(data.kind+'; heap '+data.heapMiB+' МиБ. Автопорты — технические.');if(data.notice)log(data.notice);
};
window.labError=function(data) {
  status(data.message,true);log(data.message);$('console').disabled=false;connected=false;configuring=false;pendingToken=null;window.startAfterConfig=false;if(benchmark)finishBenchmark('error');
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
    if(!ready)throw Error('Коннектом ещё не готов');if(romLoading)throw Error('Дождитесь загрузки ROM');
    resetSession();if(start&&restoreStart&&startSnapshot)restartEpisode();configuring=true;window.startAfterConfig=start;
    if($('learnMode').value!=='off')validateProfile(profileValues());
    learner.setActions(FlyGameTools.actions($('actionMasks').value));
    requestedConfiguration=configuration();validateConfiguration(requestedConfiguration);pendingSince=performance.now();nativeCall('configure',JSON.stringify({...requestedConfiguration,generation}));
    status('Применение параметров и сброс состояния…');
  }catch(error){status(error.message,true);configuring=false;}
}
window.labConfigured=function(data) {
  if(Number.isInteger(data.generation)&&data.generation>=0&&data.generation!==generation)return;
  configuring=false;connected=Boolean(window.startAfterConfig);window.startAfterConfig=false;
  $('brainToggle').textContent=connected?'Отключить связь':'Включить связь';
  history.length=0;
  status('Сеть сброшена. Конфигурация '+data.configVersion+' · '+data.mode+(connected?' · связь включена':' · связь выключена'));
  learningBoundary();nativeCall('resume');
};
function sampleFrame(now,force=false) {
  if(!connected||!ready||pendingToken!==null||configuring)return;
  if(!force&&$('clock').value==='async'&&now-lastSample<200)return;
  lastSample=now;pendingSince=now;pendingToken=++token;
  let input=retina;
  if($('freeze').checked){if(frozen===null)frozen=retina.slice();input=frozen;}else frozen=null;
  sampledRetina=input.slice();sampledControllerMask=appliedMask;
  nativeCall('sample',JSON.stringify({retina:input,token:pendingToken,generation,frame,manualMask,controllerMask:appliedMask,learningMode:benchmark?'benchmark-'+benchmark.policy:$('learnMode').value,learningReward:benchmark?0:learnReward,frozen:$('freeze').checked}));
}
window.labResult=function(data) {
  if(data.generation!==generation||data.token!==pendingToken)return;
  pendingToken=null;lastResponse=performance.now();measuredWindows++;measuredNetworkMs+=data.wallMs;if(benchmark)benchmark.cpuMs+=data.wallMs;
  if(data.error){releaseBrain();return;}
  try{brainMask=connected?learnedButtons(data):0;}catch(error){window.labError({message:error.message});brainMask=0;}updateButtons();learningStats();
  $('spikes').textContent=data.spikes;$('active').textContent=data.active;$('compute').textContent=data.wallMs.toFixed(1);
  [...$('outputs').children].forEach((element,i)=>{element.textContent=buttonNames[i]+' '+data.outputs[i].toFixed(0)+' Гц';element.className=(data.buttons&(1<<i))?'on':'';});
  history.push(Math.log10(1+data.spikes));if(history.length>100)history.shift();drawHistory();
  $('performance').textContent='Измерено: '+measuredFrames+' кадров · '+measuredWindows+' окон · эмуляция CPU '+measuredCpuMs.toFixed(1)+' мс · сеть CPU '+measuredNetworkMs.toFixed(1)+' мс · среднее окно '+(measuredNetworkMs/Math.max(1,measuredWindows)).toFixed(1)+' мс. Скорость попыток — в отдельном отчёте.';
  $('timing').textContent=(labPlatform==='sega'?'SEGA: ':'NES: ')+frame+' кадров · сеть: '+data.simMs.toFixed(1)+' мс · '+$('clock').selectedOptions[0].textContent;
  if(performance.now()-lastTelemetry>1000){log('окно '+data.sequence+': '+data.spikes+' импульсов; активных '+data.active+'; кнопки '+data.buttons);lastTelemetry=performance.now();}
};
function drawHistory() {
  const c=$('activity').getContext('2d'),w=600,h=100;c.fillStyle='#111626';c.fillRect(0,0,w,h);
  c.strokeStyle='#283249';for(let y=20;y<100;y+=20){c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();}
  if(history.length<2)return;const max=Math.max(1,...history);c.strokeStyle='#8cf8c5';c.lineWidth=2;c.beginPath();
  history.forEach((n,i)=>{const x=i*w/99,y=95-n/max*85;i?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();
}
function advanceFrame(now,forceSample=false) {
  if(!loaded||romLoading)return;
  try {updateButtons();const started=performance.now();nes.frame();const elapsed=performance.now()-started;measuredCpuMs+=elapsed;measuredFrames++;if(benchmark){benchmark.frames++;benchmark.emulatorMs+=elapsed;}frame++;sampleFrame(now,forceSample);}
  catch(error){playing=false;connected=false;releaseBrain();status('Эмуляция остановлена: '+error.message,true);$('play').textContent='Запустить эмулятор';}
}
function loop(now) {
  if((pendingToken!==null||configuring)&&now-pendingSince>30000)window.labError({message:'Нет ответа сети более 30 секунд: опыт остановлен'});
  if(brainMask&&now-lastResponse>500)releaseBrain();
  const lockstep=connected&&$('clock').value==='lockstep';
  if(playing&&now-lastFrame>=1000/(labPlatform==='sega'&&nes?nes.fps:60)&&(!lockstep||pendingToken===null)&&!configuring){lastFrame=now;advanceFrame(now,lockstep);}
  requestAnimationFrame(loop);
}
window.labPause=function() {
  if(benchmark)finishBenchmark('interrupted');window.startAfterConfig=false;
  playing=false;connected=false;configuring=false;generation++;pendingToken=null;
  manualMask=0;holding.clear();releaseBrain();audioRead=audioWrite;
  $('play').textContent='Запустить эмулятор';$('brainToggle').textContent='Включить связь';nativeCall('stop');
};
$('play').onclick=()=>{if(benchmark){window.labPause();return;}if(!loaded||romLoading){status('Сначала загрузите ROM',true);return;}playing=!playing;$('play').textContent=playing?'Пауза':'Запустить эмулятор';if(playing)nativeCall('resume');else{releaseBrain();nativeCall('stop');}};
$('step').onclick=()=>{if(!playing&&pendingToken===null){nativeCall('resume');advanceFrame(performance.now(),true);}};
$('console').onclick=()=>nativeCall('console');
$('demo').onclick=()=>nativeCall('demo');$('import').onclick=()=>nativeCall('pickRom');$('audio').onclick=toggleSound;
$('apply').onclick=()=>apply(false);
$('brainToggle').onclick=()=>{if(connected){connected=false;resetSession();nativeCall('stop');status('Связь отключена; эмулятор доступен вручную.');}else apply(true);};
$('resetNes').onclick=()=>{if(loaded){window.labPause();playing=false;$('play').textContent='Запустить эмулятор';nes.reloadROM();holding.clear();manualMask=0;brainMask=0;for(let i=0;i<8;i++)nes.buttonUp(1,i);appliedMask=0;frame=0;resetSession();for(let i=0;i<5;i++){nes.frame();frame++;}if(ready)apply(false);}};
$('gain').oninput=()=>$('gainLabel').textContent=Number($('gain').value).toFixed(2);
$('freeze').onchange=()=>{if(benchmark)window.labPause();frozen=null;log('Freeze retina: '+$('freeze').checked);};
$('saveState').onclick=()=>{try{if(!loaded)throw Error('ROM не загружен');localStorage.setItem(labPlatform+'-slot',JSON.stringify({hash:romHash,system:labPlatform,frame,state:JSON.parse(JSON.stringify(nes.toJSON()))}));status('Снимок NES сохранён. Состояние коннектома не входит в снимок.');}catch(error){status(error.message,true);}};
$('loadState').onclick=()=>{try{const saved=JSON.parse(localStorage.getItem(labPlatform+'-slot')||(labPlatform==='nes'?localStorage.getItem('nes-slot'):null));validateSnapshot(saved);if(!saved||saved.hash!==romHash)throw Error('Снимок отсутствует или относится к другому ROM');window.labPause();nes.fromJSON(saved.state);frame=Number.isSafeInteger(saved.frame)?saved.frame:0;if(labPlatform==='nes')rgbaAndRetina(nes.ppu.buffer);appliedMask=255;updateButtons();if(ready)apply(false);status('NES восстановлен; сеть сброшена.');}catch(error){status(error.message,true);}};
$('record').onclick=()=>{if(benchmark)window.labPause();nativeCall('recording',!recording);};$('export').onclick=()=>nativeCall('exportCsv');
window.labRecording=data=>{recording=data.active;$('record').textContent=recording?'Остановить запись':'Запись CSV';$('record').className=recording?'active':'';};
for(let i=0;i<16;i++)$('retina').appendChild(document.createElement('span'));
buttonNames.forEach(name=>{const span=document.createElement('span');span.textContent=name+' —';$('outputs').appendChild(span);});
function refreshManual() {if(benchmark&&holding.size){finishBenchmark('manual_control');window.labPause();}manualMask=0;for(const button of holding.values())manualMask|=1<<button;updateButtons();}
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
 if(labPlatform==='sega'&&p.rewardMode==='diagnostic')throw Error('Выберите RAM или ручную награду для Sega');FlyGameTools.actions(p.actionMasks);if(!['diagnostic','ram','manual'].includes(p.rewardMode))throw Error('Неверная награда');
 FlyGameTools.readRam(new Uint8Array(ramLimit),{address:p.rewardAddress,width:p.ramWidth,format:p.ramFormat,endian:p.ramEndian},ramLimit);
 for(const [id,min,max] of [['rewardScale',-10,10],['epsilon',0,1],['alpha',.001,.2],['episodeLength',10,2000],['deathReward',-10,10],['winReward',-10,10]]){const n=Number(p[id]);if(!Number.isFinite(n)||n<min||n>max||p[id].trim()===''||(id==='episodeLength'&&!Number.isInteger(n)))throw Error('Параметр профиля вне границ: '+id);}
 for(const name of ['death','win'])FlyGameTools.predicate(new Uint8Array(ramLimit),p[name+'Address'],p[name+'Value'],ramLimit);
}
function validateConfiguration(c){
 for(const [id,min,max] of [['maxHz',0,500],['thresholdHz',1,500],['windowMs',1,100],['seed',0,2147483647],['gain',0,2]])if(!Number.isFinite(c[id])||c[id]<min||c[id]>max||(['windowMs','seed'].includes(id)&&!Number.isInteger(c[id])))throw Error('Неверная конфигурация сети: '+id);
 if(!['closed','observe','sham'].includes(c.mode)||typeof c.disableInhibition!=='boolean'||typeof c.scramble!=='boolean')throw Error('Неверная конфигурация сети');
 for(const [id,len] of [['inputs',16],['outputs',8],['lesions',null]])if(!Array.isArray(c[id])||(len!==null&&c[id].length!==len)||c[id].length>256||new Set(c[id]).size!==c[id].length||c[id].some(x=>typeof x!=='string'||!/^\d+$/.test(x)))throw Error('Неверные ID портов');
 if(c.inputs.some(x=>c.outputs.includes(x)))throw Error('Входные и выходные порты совпадают');
}
function validateSnapshot(snapshot){
 if(!snapshot)return;
 if(!loaded||snapshot.hash!==romHash||(snapshot.system&&snapshot.system!==labPlatform))throw Error('Снимок другого ROM или платформы');
 if(labPlatform==='sega'){nes.validateState(snapshot.state);return;}
 const probe=new jsnes.NES();probe.loadROM(nes.romData);for(let i=0;i<5;i++)probe.frame();const template=JSON.parse(JSON.stringify(probe.toJSON()));
 function check(actual,expected,path){
  if(Array.isArray(expected)){if(!Array.isArray(actual)||actual.length!==expected.length)throw Error('Неверная длина снимка: '+path);for(let i=0;i<expected.length;i++)check(actual[i],expected[i],path);}
  else if(expected&&typeof expected==='object'){if(!actual||typeof actual!=='object'||Array.isArray(actual))throw Error('Неверное поле снимка: '+path);for(const key of Object.keys(expected))check(actual[key],expected[key],path+'.'+key);}
  else if(typeof actual!==typeof expected||(typeof actual==='number'&&!Number.isFinite(actual)))throw Error('Неверное значение снимка: '+path);
 }
 check(snapshot.state,template,'state');for(const bytes of [snapshot.state.cpu.mem,snapshot.state.ppu.vramMem,snapshot.state.ppu.spriteMem])if(!Array.isArray(bytes)||bytes.some(x=>!Number.isInteger(x)||x<0||x>255))throw Error('Неверные байты RAM снимка');probe.fromJSON(snapshot.state);
}
function restartEpisode(){holding.clear();manualMask=0;brainMask=0;if(startSnapshot){nes.fromJSON(JSON.parse(JSON.stringify(startSnapshot.state)));frame=startSnapshot.frame;if(labPlatform==='nes')rgbaAndRetina(nes.ppu.buffer);}else{nes.reloadROM();frame=0;for(let i=0;i<5;i++){nes.frame();frame++;}}for(let i=0;i<8;i++)nes.buttonUp(1,i);appliedMask=0;audioRead=audioWrite;updateButtons();}
function policyPackage(includeStart=false){if(!ready||!loaded)throw Error("Дождитесь ROM и коннектома");validateProfile(profileValues());validateConfiguration(configuration());const actions=FlyGameTools.actions($('actionMasks').value);if(JSON.stringify(actions)!==JSON.stringify(learner.actions))throw Error('Сначала примените набор действий');const result={version:2,system:labPlatform,romHash,key:learningKey(),profile:profileValues(),configuration:configuration(),policy:learner.save(),trials:trials.slice()};if(includeStart){result.start=startSnapshot;result.transitions=transitions.slice();result.graph=graphIdentity;}return result;}
function persistPolicy(show=true){const text=JSON.stringify(policyPackage(false));localStorage.setItem('fly-policy-'+romHash,text);if(show){$('policyJson').value=text;status('Веса сохранены. Для переноса со стартом используйте экспорт JSON.');}}
function restorePolicy(saved){if(saved.romHash!==romHash||!keysEqual(saved.key,learningKey()))throw Error('ROM, порты или профиль не совпадают');const probe=new FlyLearner();probe.load(saved.policy);window.labPause();learner.load(saved.policy);learningBoundary();trials.length=0;if(Array.isArray(saved.trials))trials.push(...saved.trials.slice(-100).filter(t=>Number.isFinite(t.reward)));learningStats();}
$('savePolicy').onclick=()=>{try{persistPolicy();}catch(error){status(error.message,true);}};
$('loadPolicy').onclick=()=>{try{const raw=$('policyJson').value.trim()||localStorage.getItem('fly-policy-'+romHash);if(!raw||raw.length>8*1024*1024)throw Error('Модель отсутствует или слишком велика');restorePolicy(JSON.parse(raw));status('Модель загружена. Выберите оценку и включите связь.');}catch(error){status(error.message,true);}};
$('captureStart').onclick=()=>{try{if(!loaded)throw Error('Загрузите ROM');window.labPause();startSnapshot={hash:romHash,frame,state:JSON.parse(JSON.stringify(nes.toJSON()))};learningBoundary();updateStartInfo();status('Старт эпизода сохранён. Автоперезапуск будет возвращаться сюда.');}catch(error){status(error.message,true);}};
$('clearStart').onclick=()=>{window.labPause();startSnapshot=null;learningBoundary();updateStartInfo();};
$('saveProfile').onclick=()=>{try{if(!ready||!loaded)throw Error('Дождитесь ROM и коннектома');validateProfile(profileValues());validateConfiguration(configuration());localStorage.setItem('fly-profile-'+romHash,JSON.stringify({version:2,romHash,system:labPlatform,graph_sha256:graphIdentity&&graphIdentity.sha256||'unavailable',profile:profileValues(),configuration:configuration(),start:startSnapshot}));status('Профиль игры сохранён.');}catch(error){status(error.message,true);}};
function restoreProfile(data){
 if(!loaded||data.version!==2||data.romHash!==romHash||(data.system||'nes')!==labPlatform||!data.profile||!data.configuration)throw Error('Профиль относится к другому ROM или версии');
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
window.labImportModel=data=>{try{const probe=new FlyLearner();probe.load(data.policy);if(data.romHash!==romHash)throw Error('Модель другого ROM');const values={};for(const id of profileFields)values[id]=data.profile[id];const expected=JSON.stringify({romHash,inputs:data.configuration.inputs,outputs:data.configuration.outputs,system:labPlatform,graph_sha256:graphIdentity&&graphIdentity.sha256||'unavailable',profile:values,configuration:data.configuration});if(!keysEqual(data.key,expected)||JSON.stringify(probe.actions)!==JSON.stringify(FlyGameTools.actions(values.actionMasks)))throw Error('Модель и профиль не согласованы');restoreProfile(data);restorePolicy(data);status('Профиль и модель импортированы.');}catch(error){status(error.message,true);}};
for(const id of profileFields)$(id).addEventListener('change',()=>{window.labPause();learningBoundary();status('Профиль изменён: опыт остановлен. Включите связь для продолжения.');});
for(const id of ['mode','clock','maxHz','thresholdHz','windowMs','seed','gain','disableInhibition','scramble','lesions','inputIds','outputIds'])$(id).addEventListener('change',()=>{window.labPause();learningBoundary();status('Параметры изменены: примените конфигурацию для нового опыта.');});
if(labPlatform==='nes')setupNes();
$('navNes').onclick=()=>nativeCall('switchSystem','nes');$('navSega').onclick=()=>nativeCall('switchSystem','sega');
if(labPlatform==='sega'){
 $('resetNes').textContent='Сброс Sega';$('saveState').textContent='Снимок Sega';$('play').textContent='Запустить эмулятор';
 for(const option of $('clock').options)option.textContent=option.textContent.replaceAll('NES','Sega');
 for(const el of document.querySelectorAll('p.note'))if(el.textContent.includes('стартовый снимок NES'))el.textContent='Экспорт включает профиль, стартовый снимок Sega и модель. RAM победы/смерти задаётся вручную. PAL/NTSC определяется ядром; battery .sav отдельно не экспортируется.';
 $('labTitle').textContent='FLY / SEGA LAB';$('import').textContent='Открыть .bin / .md';$('modeInfo').textContent='Mega Drive · Genesis Plus GX / WASM · A/B/C/Start';
 $('rewardMode').value='manual';$('ramEndian').value='big';$('ramWidth').value='2';$('rewardMode').querySelector('[value="diagnostic"]').disabled=true;
 document.querySelector('[data-button="2"]').textContent='C';
 for(const id of ['rewardAddress','deathAddress','winAddress'])$(id).max='65535';
 $('ramLabel').textContent='RAM смещение 0–65535 (0 соответствует $FF0000)';
 $('maskLabel').textContent='Маски Sega: A=1, B=2, C=4, Start=8, ↑=16, ↓=32, ←=64, →=128';
 $('platformFooter').textContent='Genesis Plus GX · WebAssembly · некоммерческая лицензия. Raw Mega Drive ROM; CD/32X/SMD/ZIP не поддерживаются. Регион и PAL/NTSC выбирает ядро автоматически. Снимки и RAM доступны; battery .sav отдельно не экспортируется.';
}
// Evaluation runs use a separate frozen readout so learner counters/RNG stay unchanged.
function benchmarkTrial(outcome){
 if(!benchmark)return;
 benchmark.trials.push({attempt:benchmark.trials.length+1,outcome,decisions:benchmark.decisions,frames:benchmark.frames,wall_ms:performance.now()-benchmark.started,network_compute_ms:benchmark.cpuMs,emulator_compute_ms:benchmark.emulatorMs});
}
function benchmarkReset(){benchmark.decisions=0;benchmark.frames=0;benchmark.cpuMs=0;benchmark.emulatorMs=0;benchmark.started=performance.now();benchmark.previous=null;}
function finishBenchmark(reason){
 if(!benchmark)return;const run=benchmark;
 if(reason!=='complete')benchmarkTrial(reason);
 lastBenchmark={version:1,type:'fly-evaluation-report',game:run.game,system:labPlatform,rom_sha256:romHash,graph:graphIdentity,configuration:run.configuration,profile:run.profile,policy:run.policy,seed:run.seed,criterion:run.criterion,start_frame:run.startFrame,nominal_fps:labPlatform==='sega'?nes.fps:60,trials:run.trials,summary:FlyBenchmark.summary(run.trials),weights_unchanged:JSON.stringify(learner.weights)===run.weights,finished_reason:reason,limitations:['Success means the user-configured criterion was reached; game completion is not independently verified.','The 4x4 visual adapter and LIF model are not a validated simulation of biological fly behavior.','SARSA uses raw retinal and neural features; it is an external readout.']};
 benchmark=null;playing=false;connected=false;pendingToken=null;generation++;releaseBrain();nativeCall('stop');$('play').textContent='Запустить эмулятор';$('brainToggle').textContent='Включить связь';renderBenchmark();
}
function renderBenchmark(){
 const report=lastBenchmark;if(!report)return;const s=report.summary;
 $('benchmarkResult').textContent='Критерий: '+report.criterion.description+' ('+report.criterion.scope+')\nПолитика: '+report.policy+' · завершено '+s.completed+'\nУспехов '+s.successes+' · смертей '+s.deaths+' · лимитов '+s.timeouts+' · прервано '+s.interrupted+'\nДоля успеха: '+(s.success_rate===null?'—':(s.success_rate*100).toFixed(1)+'%')+' · 95% интервал: '+(s.wilson95?s.wilson95.map(x=>(x*100).toFixed(1)+'%').join(' … '):'—')+'\nКадров '+s.frames+' · реальное время '+(s.wall_ms/1000).toFixed(2)+' с · '+s.measured_fps.toFixed(2)+' FPS ('+(s.measured_fps/report.nominal_fps).toFixed(3)+'× номинальной скорости)\nВеса сохранены: '+report.weights_unchanged+' · итог: '+report.finished_reason+'\nЭто достижение заданного RAM-критерия, а не доказательство полного прохождения игры.';
}
function benchmarkDecision(data){
 const run=benchmark;if(!run)return 0;
 const diagnostic=run.profile.rewardMode==='diagnostic';const x=nes.cpu.mem[0],y=nes.cpu.mem[1];
 const success=diagnostic?x>=200&&Math.abs(y-100)<=4:FlyGameTools.predicate(nes.cpu.mem,run.profile.winAddress,run.profile.winValue,ramLimit);
 const death=run.profile.deathEnabled&&FlyGameTools.predicate(nes.cpu.mem,run.profile.deathAddress,run.profile.deathValue,ramLimit);
 run.decisions++;
 if(success||death||run.decisions>=Number(run.profile.episodeLength)){
  benchmarkTrial(death?'death':success?'success':'timeout');
  $('benchmarkResult').textContent='Попытка '+run.trials.length+'/'+run.attempts+' · '+run.trials.at(-1).outcome;
  if(run.trials.length>=run.attempts){finishBenchmark('complete');return 0;}
  restartEpisode();benchmarkReset();apply(true,false);return 0;
 }
 if(run.policy==='neurons')return data.buttons;
 if(run.policy==='random')return run.evaluator.actions[Math.floor(run.evaluator.random()*run.evaluator.actions.length)];
 const f=run.evaluator.features(sampledRetina,data.outputs,diagnostic?[x/256,y/240,(200-x)/256,(100-y)/240]:null,run.previous);run.previous=sampledRetina.slice();
 return run.evaluator.actions[run.evaluator.choose(f,false)];
}
$('benchmarkStart').onclick=()=>{try{
 if(!loaded||!ready||romLoading)throw Error('Дождитесь ROM и графа');if($('freeze').checked)throw Error('Выключите заморозку экрана для оценки');if(!startSnapshot)throw Error('Сохраните старт эпизода после меню');
 const p=profileValues();validateProfile(p);validateSnapshot(startSnapshot);
 if(p.rewardMode==='diagnostic'&&(labPlatform!=='nes'||romHash!==diagnosticHash))throw Error('Диагностический критерий доступен только для собственного NES ROM');
 if(p.rewardMode!=='diagnostic'&&!p.winEnabled)throw Error('Задайте и проверьте RAM-критерий победы в профиле игры');
 const attempts=Number($('benchmarkAttempts').value);if(!Number.isInteger(attempts)||attempts<1||attempts>100)throw Error('Попыток должно быть 1–100');
 const description=$('benchmarkCriterion').value.trim();if(!description)throw Error('Опишите, что именно означает победа');
 window.labPause();$('mode').value='closed';$('clock').value='lockstep';learner.setActions(FlyGameTools.actions(p.actionMasks));
 const c=configuration();validateConfiguration(c);const evaluator=new FlyLearner(c.seed);evaluator.load(JSON.parse(JSON.stringify(learner.save())));evaluator.rng=c.seed>>>0||1;
 benchmark={game:$('benchmarkGame').value.trim()||'Unnamed',attempts,policy:$('benchmarkPolicy').value,seed:c.seed,evaluator,profile:p,configuration:c,weights:JSON.stringify(learner.weights),startFrame:startSnapshot.frame,criterion:{description,scope:$('benchmarkScope').value,source:p.rewardMode==='diagnostic'?'own-NES-diagnostic':'user-configured-RAM-byte',address:p.winAddress,value:p.winValue},trials:[]};
 restartEpisode();benchmarkReset();apply(true,false);playing=true;$('play').textContent='Пауза';$('benchmarkResult').textContent='Оценка 1/'+attempts+' · обучение выключено';
 }catch(error){if(benchmark)finishBenchmark('error');status(error.message,true);}};
$('benchmarkStop').onclick=()=>window.labPause();
$('benchmarkExport').onclick=()=>{if(!lastBenchmark){status('Сначала проведите оценку',true);return;}nativeCall('exportModel',JSON.stringify(lastBenchmark));};
let ramPrevious=null;
$('ramInspect').onclick=()=>{try{
 if(!loaded)throw Error('Загрузите ROM');const offset=Number($('ramOffset').value);if(!Number.isInteger(offset)||offset<0||offset>ramLimit-64)throw Error('Смещение должно быть 0–'+(ramLimit-64));
 const current=Array.from(nes.cpu.mem).slice(offset,offset+64);const lines=[];
 for(let i=0;i<64;i+=16)lines.push((labPlatform==='sega'?0xff0000+offset+i:offset+i).toString(16).padStart(6,'0').toUpperCase()+': '+current.slice(i,i+16).map(v=>v.toString(16).padStart(2,'0')).join(' '));
 if(ramPrevious&&ramPrevious.offset===offset){const changed=current.map((v,i)=>v!==ramPrevious.bytes[i]?'+0x'+i.toString(16)+': '+ramPrevious.bytes[i]+'→'+v:null).filter(Boolean);lines.push('Изменения: '+(changed.join(', ')||'нет'));}
 ramPrevious={offset,bytes:current};$('ramView').textContent=lines.join('\n');
 }catch(error){status(error.message,true);}};
$('ramOffset').max=ramLimit-64;$('benchmarkGame').value=labPlatform==='sega'?'Zero Tolerance':'NES experiment';

drawHistory();learningStats();requestAnimationFrame(loop);nativeCall('demo');
