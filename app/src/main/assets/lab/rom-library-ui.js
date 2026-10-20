/* The native library owns verified cartridge copies; console snapshots remain separate. */
'use strict';
(()=>{
 if(!window.FlyBridge||typeof FlyBridge.romLibrary!=='function')return;
 const pending=new Map();let sequence=0,last=null,opening=false,persistenceError=null;
 const area=document.createElement('div');area.className='rom-library';
 const resume=document.createElement('button');resume.id='continueLastGame';resume.textContent='Продолжить последнюю игру';resume.disabled=true;
 const details=document.createElement('details'),title=document.createElement('summary'),list=document.createElement('div'),notice=document.createElement('p');
 title.textContent='Библиотека и последние игры';notice.id='romLibraryStatus';notice.className='note';notice.setAttribute('role','status');details.append(title,list);area.append(resume,details,notice);$('gamePanel').prepend(area);
 const message=(text,error=false)=>{notice.textContent=text;notice.className=error?'note error':'note';};
 function request(op,args={}){return new Promise((resolve,reject)=>{const token='rom-'+(++sequence),timer=setTimeout(()=>{pending.delete(token);reject(Error('Библиотека ROM не ответила'));},30000);pending.set(token,{resolve,reject,timer});try{FlyBridge.romLibrary(JSON.stringify({op,token,...args}));}catch(e){clearTimeout(timer);pending.delete(token);reject(e);}});}
 window.labRomLibrary=reply=>{const job=pending.get(reply.token);if(!job)return;pending.delete(reply.token);clearTimeout(job.timer);if(reply.error)job.reject(Error(reply.error));else job.resolve(reply.data);};
 window.labLibraryNotice=reply=>{persistenceError=reply.error;message('Игра запущена; сохранение ROM в библиотеку: '+reply.error,true);};
 async function open(row){if(opening)return;opening=true;resume.disabled=true;try{await request('open',{system:row.system,sha256:row.sha256});message('Открываю '+row.name+'…');}catch(e){message(e.message,true);}finally{opening=false;resume.disabled=!last;}}
 function render(data){
  last=data.last;resume.disabled=!last;list.replaceChildren();
  for(const row of [...data.games].sort((a,b)=>b.openedAt-a.openedAt)){
   const line=document.createElement('div');line.className='row';const button=document.createElement('button');button.textContent=row.name+' · '+row.system.toUpperCase()+' · '+new Date(row.openedAt).toLocaleString();button.onclick=()=>open(row);
   const remove=document.createElement('button');remove.textContent='Удалить ROM';remove.setAttribute('aria-label','Удалить ROM '+row.name);remove.onclick=async()=>{if(!window.confirm('Удалить копию ROM «'+row.name+'»? Снимки игры и обученный опыт сохранятся.'))return;try{await request('delete',{system:row.system,sha256:row.sha256});await refresh();}catch(e){message(e.message,true);}};line.append(button,remove);list.append(line);
  }
  if(!data.games.length)message('Откройте ROM: приложение сохранит копию для продолжения.');
  if(data.recoveredIndex)message('Каталог ROM восстановлен из резервной копии.',true);
 }
 async function refresh(){render(await request('list'));}
 resume.onclick=()=>{if(last)open(last);};details.addEventListener('toggle',()=>{if(details.open)refresh().catch(e=>message(e.message,true));});
 window.addEventListener('lab-rom-loaded',()=>{message(persistenceError?'Игра запущена; копия ROM не сохранена: '+persistenceError:'Игра открыта. Снимок и обучение восстанавливаются независимо.',Boolean(persistenceError));refresh().catch(e=>message(e.message,true));});
 window.labLibrary={request,refresh};
 request('startup').then(data=>{render(data);if(last)return open(last);}).catch(e=>message(e.message,true));
})();
