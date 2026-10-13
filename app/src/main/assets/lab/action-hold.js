/* Controller delivery policy. Neural decisions and FDB plasticity stay in the existing engine. */
(function(root){'use strict';
const defaults=Object.freeze({mode:'model',limitMs:250,timeoutMs:5000});
function settings(value){
 if(value===undefined)return {...defaults};
 if(!value||typeof value!=='object'||Array.isArray(value)||!['model','limited'].includes(value.mode)||!Number.isInteger(value.limitMs)||value.limitMs<50||value.limitMs>5000||!Number.isInteger(value.timeoutMs)||value.timeoutMs<1000||value.timeoutMs>30000)throw Error('Неверные настройки удержания кнопок модели');
 return {mode:value.mode,limitMs:value.limitMs,timeoutMs:value.timeoutMs};
}
function fromFields(field,prefix){return settings({mode:field(prefix+'Mode').value,limitMs:Number(field(prefix+'Limit').value),timeoutMs:Number(field(prefix+'Timeout').value)*1000});}
function toFields(field,prefix,value){const c=settings(value);for(const [suffix,v]of [['Mode',c.mode],['Limit',c.limitMs],['Timeout',c.timeoutMs/1000]])field(prefix+suffix).value=String(v);}
// Game time controls only an explicitly requested limit. A stalled response is
// detected in wall time at every speed. Repeated equal masks never pulse the pad.
function expiry(value,gameSeconds,wallMs){
 const c=settings(value);
 if(!Number.isFinite(gameSeconds)||gameSeconds<0||!Number.isFinite(wallMs)||wallMs<0)throw Error('Неверное время команды модели');
 if(wallMs>=c.timeoutMs)return 'timeout';
 return c.mode==='limited'&&gameSeconds*1000+1e-7>=c.limitMs?'limit':null;
}
root.FlyActionHold={defaults,settings,fromFields,toFields,expiry};
if(typeof module!=='undefined')module.exports=root.FlyActionHold;
})(typeof window==='undefined'?globalThis:window);
