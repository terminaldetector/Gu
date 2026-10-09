/* Small, versioned UI preferences. Acquired weights live in the existing Layer Set store. */
(function(root){'use strict';
const key=(system,graph)=>'fly-settings-v1-'+system+'-'+graph;
function read(storage,system,graph){const raw=storage.getItem(key(system,graph));if(!raw)return null;if(raw.length>32768)throw Error('Настройки слишком велики');const value=JSON.parse(raw);if(!value||value.version!==1||value.system!==system||value.graph!==graph||!value.fields||typeof value.fields!=='object'||Array.isArray(value.fields)||Object.values(value.fields).some(v=>!['string','boolean'].includes(typeof v)))throw Error('Настройки повреждены или относятся к другой модели');return value.fields;}
function write(storage,system,graph,fields){const value={version:1,system,graph,fields};storage.setItem(key(system,graph),JSON.stringify(value));}
root.FlySettings={key,read,write};if(typeof module!=='undefined')module.exports=root.FlySettings;
})(typeof window==='undefined'?globalThis:window);
