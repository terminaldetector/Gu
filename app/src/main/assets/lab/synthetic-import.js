/* A portable graph replaces W0. A Layer Set remains bound to its ROM and graph SHA. */
'use strict';
(() => {
 let pending=false,timer=null;
 const finish=()=>{pending=false;clearTimeout(timer);timer=null;};
 window.importSyntheticGraph=async data=>{
  if(pending){status('Импорт графа уже выполняется.',true);return;}
  if(!window.FlyBridge||typeof window.FlyBridge.installSyntheticGraph!=='function'){
   status('Для синтетического JSON нужна сборка с поддержкой импорта графов.',true);return;
  }
  pending=true;
  try{
   if(data.type!=='fly-synthetic-graph'||data.version!==1)throw Error('Неизвестный формат графа');
   const text=JSON.stringify(data);if(new TextEncoder().encode(text).length>8*1024*1024)throw Error('Граф превышает 8 МиБ');
   if(!window.labState)throw Error('Сохранение текущего опыта ещё не готово');
   await window.labState.prepare();
   status('Опыт сохранён согласно настройкам. Проверяю и подключаю синтетический граф…');
   timer=setTimeout(()=>{finish();status('Нет подтверждения импорта. Проверьте паспорт активного графа перед повтором.',true);},120000);
   window.FlyBridge.installSyntheticGraph(text);
  }catch(e){finish();status('Граф не импортирован: '+e.message,true);}
 };
 window.labSyntheticImported=async data=>{
  if(!pending)return;
  finish();
  if(!data||data.ok!==true){status('Граф не импортирован: '+(data?.error||'неизвестная ошибка')+'. Предыдущая модель сохранена.',true);return;}
  if(window.labState)await window.labState.settle();
  status('Синтетический граф подключён. Игра сохранена, сеть на паузе. Создайте Layer Set текущей игры; обучение включается отдельно.');
 };
})();
