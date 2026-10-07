'use strict';
const $=id=>document.getElementById(id);let modules={},runner=null,session=0,timer=null,result={format:'fly-lab-results-v1',events:[]},outputBytes=0,events=0;
const example=`const info = await fly.info();
fly.log({neurons: info.neurons, edges: info.edges});
const id = info.ids[0];
const hz = [];
for (const rate of [0, 50, 150, 300]) {
  const result = await fly.run({seed: 1, reset: true,
    steps: [{ms: 20, inputs: [{id, hz: rate}],
      outputs: [{id, label: "response"}]}]});
  fly.log(result);
  hz.push(result.results[0].outputs.response.hz);
}
fly.plot("Ответ, Гц · стимулы 0/50/150/300 Гц", hz);`;
function status(text){$('status').textContent=text;}
function native(method,...args){if(!window.CodeBridge)throw Error('Android bridge недоступен');return window.CodeBridge[method](...args);}
function validModules(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>16)throw Error('До 16 модулей');let total=0;
 for(const [id,m]of Object.entries(value)){if(!/^[a-z][a-z0-9_-]{0,47}$/.test(id)||!m||m.id!==id||m.api!==1||typeof m.name!=='string'||m.name.length>80||typeof m.entry!=='string'||!m.entry.endsWith('.js')||!m.files||typeof m.files!=='object'||Array.isArray(m.files)||!Object.hasOwn(m.files,m.entry)||Object.keys(m.files).length>64)throw Error('Неверный модуль: '+id);let bytes=0;
  for(const [path,text]of Object.entries(m.files)){if(!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.(js|json|txt|md)$/.test(path)||path.includes('..')||path.length>160||typeof text!=='string'||text.length>262144)throw Error('Неверный файл модуля');bytes+=new TextEncoder().encode(text).length;}if(bytes>1048576)throw Error('Модуль больше 1 МиБ');total+=bytes;
 }if(total>2097152)throw Error('Модули проекта больше 2 МиБ');return value;
}
function project(){return {format:'fly-lab-project-v1',name:$('name').value.trim()||'Без имени',source:$('source').value,modules:JSON.parse(JSON.stringify(modules))};}
function validateProject(p){if(!p||p.format!=='fly-lab-project-v1'||typeof p.name!=='string'||!p.name.trim()||p.name.length>80||typeof p.source!=='string'||p.source.length>262144)throw Error('Неверный проект');validModules(p.modules);return p;}
function installProject(p){validateProject(p);codeStop();$('name').value=p.name;$('source').value=p.source;modules=JSON.parse(JSON.stringify(p.modules));renderModules();status('Проект открыт. Код ещё не выполнялся.');}
function stored(){const value=JSON.parse(localStorage.getItem('fly-code-projects')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw Error('Повреждён список проектов');return Object.assign(Object.create(null),value);}
function refresh(){const names=Object.keys(stored());$('projects').replaceChildren();for(const name of names){const o=document.createElement('option');o.value=o.textContent=name;$('projects').append(o);}}
function renderModules(){$('modules').replaceChildren();for(const [id,m]of Object.entries(modules)){const row=document.createElement('div');row.className='module';const label=document.createElement('span');label.textContent=id+' · '+m.name;const b=document.createElement('button');b.textContent='Удалить';b.onclick=()=>{codeStop();delete modules[id];renderModules();};row.append(label,b);$('modules').append(row);}}
function record(event){const text=JSON.stringify(event);if(++events>512||outputBytes+text.length>1048576){codeStop();status('Лимит вывода 512 событий / 1 МиБ');return false;}outputBytes+=text.length;result.events.push(event);return true;}
function plot(name,values){if(typeof name!=='string'||name.length>100||!Array.isArray(values)||values.length<1||values.length>2000||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('График: имя до 100 символов, 1–2000 конечных чисел');if($('plots').children.length>=16)throw Error('До 16 графиков');const div=document.createElement('div'),label=document.createElement('p'),canvas=document.createElement('canvas');label.textContent=name+' · индекс отсчёта → значение';canvas.width=760;canvas.height=200;div.append(label,canvas);$('plots').append(div);const c=canvas.getContext('2d'),min=Math.min(...values),max=Math.max(...values),range=max-min||1;c.strokeStyle='#96ffcf';c.beginPath();values.forEach((v,i)=>{const x=40+i*700/Math.max(1,values.length-1),y=170-(v-min)*140/range;i?c.lineTo(x,y):c.moveTo(x,y);c.fillStyle='#96ffcf';c.fillRect(x-2,y-2,4,4);});c.stroke();c.fillStyle='#95a8c1';c.font='12px monospace';c.fillText('max '+max,4,15);c.fillText('min '+min,4,195);}
window.codeStop=()=>{if(runner){runner.terminate();runner=null;status("Остановлено.");}clearTimeout(timer);try{native('stop');}catch(ignored){}$('run').disabled=false;};
function run(){try{validateProject(project());codeStop();session=Number(native('begin'));events=0;outputBytes=0;result={format:'fly-lab-results-v1',project:project().name,source:$('source').value,modules:JSON.parse(JSON.stringify(modules)),events:[]};$('output').textContent='';$('plots').replaceChildren();const url=URL.createObjectURL(new Blob(['('+codeWorkerMain.toString()+')()'],{type:'application/javascript'}));runner=new Worker(url);URL.revokeObjectURL(url);const active=runner;runner.onmessage=event=>{if(runner!==active)return;const d=event.data;try{
 if(d.kind==='request'){if(!['info','run'].includes(d.method)||!Number.isInteger(d.id)||d.id<1||d.id>64)throw Error('Лимит / неверный API');const payload=JSON.stringify(d.payload);if(payload.length>262144)throw Error('API payload больше 256 КиБ');if(record({kind:'api-request',id:d.id,method:d.method,payload:d.payload}))native('request',session,d.id,d.method,payload);}
 else if(d.kind==='log'){if(record({kind:'log',value:d.value}))$('output').textContent+=JSON.stringify(d.value,null,2)+'\n';}
 else if(d.kind==='plot'){plot(d.name,d.values);record({kind:'plot',name:d.name,values:d.values});}
 else if(d.kind==='done'){codeStop();status('Завершено. '+events+' событий.');}
 else if(d.kind==='error')throw Error(d.value);
 }catch(error){codeStop();status('Ошибка: '+error.message);}};runner.onerror=e=>{codeStop();status('JS ошибка: '+e.message);};timer=setTimeout(()=>{codeStop();status('Остановлено: лимит 30 секунд');},30000);$('run').disabled=true;status('Выполняется…');runner.postMessage({kind:'start',source:$('source').value,modules});}catch(error){codeStop();status(error.message);}}
window.codeReceive=message=>{try{if(message.kind==='reply'){const v=message.value;if(runner&&v.session===session){if(!record({kind:'api-result',id:v.id,data:v.data,error:message.error}))return;runner.postMessage({kind:'reply',id:v.id,value:v.data,error:message.error});}return;}if(message.error)throw Error(message.error);if(message.kind==='module'){const m=message.value;const next=Object.assign({},modules,{[m.id]:m});validModules(next);codeStop();modules=next;renderModules();status('Установлен '+m.id+'; запуск выполняется только по кнопке.');}else if(message.kind==='project')installProject(message.value);else status('Файл сохранён.');}catch(error){status(error.message);}};
function guarded(fn){return()=>{try{fn();}catch(error){status(error.message);}};}
$('run').onclick=run;$('stop').onclick=()=>{codeStop();status('Остановлено.');};
$('nes').onclick=guarded(()=>native('navigate','nes'));$('sega').onclick=guarded(()=>native('navigate','sega'));$('console').onclick=guarded(()=>native('navigate','console'));
$('save').onclick=guarded(()=>{const p=validateProject(project()),all=stored();if(!Object.hasOwn(all,p.name)&&Object.keys(all).length>=20)throw Error('До 20 проектов');all[p.name]=p;localStorage.setItem('fly-code-projects',JSON.stringify(all));refresh();$('projects').value=p.name;status('Проект сохранён.');});
$('load').onclick=guarded(()=>{const p=stored()[$('projects').value];if(!p)throw Error('Выберите проект');installProject(p);});$('remove').onclick=guarded(()=>{const all=stored();delete all[$('projects').value];localStorage.setItem('fly-code-projects',JSON.stringify(all));refresh();status('Сохранённый проект удалён.');});
$('open').onclick=guarded(()=>native('pick','project'));$('install').onclick=guarded(()=>native('pick','module'));$('exportProject').onclick=guarded(()=>native('export',JSON.stringify(validateProject(project()),null,2),true));$('exportResult').onclick=guarded(()=>native('export',JSON.stringify(result,null,2),false));$('example').onclick=()=>{codeStop();$('source').value=example;status('Пример загружен.');};
$('builtin').onclick=guarded(()=>{const m={id:'signal',name:'Signal tools · MIT',api:1,entry:'index.js',files:{'index.js':'exports.mean = values => values.reduce((a,b)=>a+b,0) / values.length;\nexports.scale = (values,gain) => values.map(v=>v*gain);'}};const next=Object.assign({},modules,{signal:m});validModules(next);codeStop();modules=next;renderModules();status("Модуль signal установлен: require('signal').mean([...])");});
$('source').value=example;try{refresh();}catch(error){status('Ошибка сохранённых проектов: '+error.message);}renderModules();document.addEventListener('visibilitychange',()=>{if(document.hidden){codeStop();status('Остановлено при уходе в фон.');}});
