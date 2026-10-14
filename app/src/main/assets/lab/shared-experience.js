/* Immutable shared FDB snapshots. Only the per-game effective copy is trained. */
(function(root){'use strict';
const TYPE='fly-shared-experience',LIMIT=2048,clone=x=>JSON.parse(JSON.stringify(x));
const canonical=x=>JSON.stringify(sort(x));
function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
function sha256(value){
 const data=new TextEncoder().encode(value),bits=data.length*8,n=((data.length+9+63)>>6)<<6,b=new Uint8Array(n);b.set(data);b[data.length]=128;const dv=new DataView(b.buffer);dv.setUint32(n-8,Math.floor(bits/4294967296));dv.setUint32(n-4,bits>>>0);
 const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
 const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64),r=(x,n)=>(x>>>n)|(x<<(32-n));
 for(let at=0;at<n;at+=64){for(let i=0;i<16;i++)w[i]=dv.getUint32(at+i*4);for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
 let [a,c,d,e,f,g,j,k]=h;for(let i=0;i<64;i++){const t1=(k+(r(f,6)^r(f,11)^r(f,25))+((f&g)^(~f&j))+K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&c)^(a&d)^(c&d)))>>>0;k=j;j=g;g=f;f=(e+t1)>>>0;e=d;d=c;c=a;a=(t1+t2)>>>0;}[a,c,d,e,f,g,j,k].forEach((v,i)=>h[i]=(h[i]+v)>>>0);}
 return h.map(x=>x.toString(16).padStart(8,'0')).join('');
}
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),id=x=>typeof x==='string'&&/^[1-9][0-9]{0,18}$/.test(x),key=x=>x.source+':'+x.target;
function contract(c){
 if(!c||c.version!==1||c.observation!=='retina4x4-row-major-v1'||!['lif-f32-threshold-v1'].includes(c.dynamics)||!Array.isArray(c.inputs)||c.inputs.length!==16||!Array.isArray(c.outputs)||![8,12].includes(c.outputs.length)||!Array.isArray(c.actions)||c.actions.length!==c.outputs.length||[...c.inputs,...c.outputs].some(x=>!id(x))||new Set([...c.inputs,...c.outputs]).size!==16+c.outputs.length)throw Error('Несовместимый контракт сенсорики / портов');
 if(!Array.isArray(c.actionMasks)||!c.actionMasks.length||c.actionMasks.length>64||c.actionMasks.some(x=>!Number.isInteger(x)||x<0||x>=(1<<c.outputs.length))||!Number.isInteger(c.allowedMask)||c.allowedMask<0||c.allowedMask>=(1<<c.outputs.length))throw Error('Контракт действий');
 if(c.actions.some(x=>typeof x!=='string'||!/^([a-z][a-z0-9-]{0,39}|unused)$/.test(x)))throw Error('Неверная семантика действий');
 if(!Number.isFinite(c.maxHz)||c.maxHz<0||c.maxHz>500||!Number.isFinite(c.gain)||c.gain<0||c.gain>2||!Number.isInteger(c.windowMs)||c.windowMs<1||c.windowMs>100||!Number.isFinite(c.thresholdHz)||c.thresholdHz<1||c.thresholdHz>500||!['cpu','gpu'].includes(c.backend)||c.scramble!==false||c.disableInhibition!==false||c.lesions!==false)throw Error('Контракт требует неизменённую сенсорику и параметры динамики');
 const h=c.actionHold;if(!h||!['model','limited'].includes(h.mode)||!Number.isInteger(h.limitMs)||h.limitMs<50||h.limitMs>5000||!Number.isInteger(h.timeoutMs)||h.timeoutMs<1000||h.timeoutMs>30000||c.sham!==false)throw Error('Несовместимый режим входа / удержания кнопок');
 return clone(c);
}
function overlay(o,contribution=false){
 if(!o||typeof o!=='object')throw Error('Нет слоя FDB');const result={deltas:[],edges:[],thresholds:[]};
 for(const kind of ['deltas','edges']){const seen=new Set(),list=o[kind]||[];if(!Array.isArray(list)||list.length>LIMIT)throw Error('Лимит связей общего опыта');for(const x of list){if(!x||!id(x.source)||!id(x.target)||x.source===x.target||seen.has(key(x))||!Number.isFinite(x.weight)||Math.abs(x.weight)>(contribution?254:127))throw Error('Неверная / повторная связь общего опыта');seen.add(key(x));if(x.weight!==0)result[kind].push({source:x.source,target:x.target,weight:Math.fround(x.weight)});}result[kind].sort((a,b)=>key(a).localeCompare(key(b)));}
 const seen=new Set(),list=o.thresholds||[];if(!Array.isArray(list)||list.length>LIMIT)throw Error('Лимит порогов');for(const t of list){if(!t||!id(t.neuron)||seen.has(t.neuron)||!Number.isFinite(t.offsetMv)||Math.abs(t.offsetMv)>(contribution?10:5))throw Error('Неверный порог');seen.add(t.neuron);if(t.offsetMv!==0)result.thresholds.push({neuron:t.neuron,offsetMv:Math.fround(t.offsetMv)});}result.thresholds.sort((a,b)=>a.neuron.localeCompare(b.neuron));const base=new Set(result.deltas.map(key));if(result.edges.some(x=>base.has(key(x))))throw Error('Связь не может быть одновременно ΔW и Wexo');return result;
}
function combine(a,b,subtract=false){a=overlay(a,true);b=overlay(b,true);const o={};for(const kind of ['deltas','edges','thresholds']){const neuron=kind==='thresholds',field=neuron?'offsetMv':'weight',k=neuron?x=>x.neuron:key,m=new Map(a[kind].map(x=>[k(x),clone(x)]));for(const x of b[kind]){const v=m.get(k(x))||{...x,[field]:0};v[field]=Math.fround(v[field]+(subtract?-1:1)*x[field]);m.set(k(x),v);}o[kind]=[...m.values()].filter(x=>x[field]!==0);}return overlay(o,subtract);}
const empty=()=>({deltas:[],edges:[],thresholds:[]});
function fromFdb(f){return overlay({deltas:f?.deltas||[],edges:f?.edges||[],thresholds:f?.neuronDynamics?.thresholdOffsets||[]});}
function toFdb(o,graph){o=overlay(o);return{version:3,graph_sha256:graph,deltas:o.deltas,edges:o.edges,neuronDynamics:{version:1,thresholdOffsets:o.thresholds},learning:{enabled:true,rate:.05,maxEdges:2048,maxWeight:127,trainBase:true,plasticityMode:'expanded'}};}
function validate(layer){
 if(!layer||layer.type!==TYPE||layer.version!==1||!['root','genre','game'].includes(layer.scope)||typeof layer.name!=='string'||!layer.name.trim()||layer.name.length>80||!hex(layer.graphSha)||!hex(layer.digest)||!['candidate','validated'].includes(layer.status)||!Array.isArray(layer.sourceRoms)||layer.sourceRoms.length>100||layer.sourceRoms.some(x=>!hex(x))||new Set(layer.sourceRoms).size!==layer.sourceRoms.length)throw Error('Неверный общий слой');
 contract(layer.contract);overlay(layer.overlay,layer.scope==='genre');
 if(layer.scope==='genre'&&(!hex(layer.parentDigest)||typeof layer.genre!=='string'||!layer.genre.trim()||layer.genre.length>80))throw Error('Жанровой слой требует точную версию ROOT');
 if(layer.scope!=='genre'&&layer.parentDigest!==null)throw Error('Лишний родитель');
 if(layer.scope==='game'&&(!hex(layer.romHash)||layer.sourceRoms.length!==1||layer.sourceRoms[0]!==layer.romHash))throw Error('Игровой опыт требует свой ROM');
 const copy=clone(layer);delete copy.digest;if(sha256(canonical(copy))!==layer.digest)throw Error('SHA общего опыта не совпадает');
 if(layer.status==='validated'){validateEvidence(layer.evidence,layer.sourceRoms);const candidate={...copy,status:'candidate',evidence:null};if(layer.evidence.candidateDigest!==sha256(canonical(candidate)))throw Error('Отчёт относится к другому кандидату');}
 return clone(layer);
}
function seal(data){const p=clone(data);delete p.digest;p.digest=sha256(canonical(p));return validate(p);}
function stack(layers,ctx,allowCandidate=false){
 if(!Array.isArray(layers)||layers.length>2)throw Error('ROOT и не более одного жанрового слоя');let result=empty(),parent=null;
 for(let i=0;i<layers.length;i++){const l=validate(layers[i]);if(l.graphSha!==ctx.graphSha||canonical(l.contract)!==canonical(contract(ctx.contract)))throw Error('Другой мозг, порты, сенсорика или действия');if(l.status!=='validated'&&!allowCandidate)throw Error('Кандидат допускается только в явном эксперименте');
 if(l.scope==='game'){if(layers.length!==1||l.romHash!==ctx.romHash)throw Error('Индивидуальный граф другого ROM');}
 else if(i===0&&l.scope!=='root'||i===1&&(l.scope!=='genre'||l.parentDigest!==parent))throw Error('Неверная иерархия ROOT → жанр');
 result=combine(result,l.overlay);parent=l.digest;}
 return result;
}
function binding(b,ctx){if(b===null||b===undefined)return null;if(b.version!==1||!Array.isArray(b.layers)||typeof b.experimental!=='boolean')throw Error('Неверная привязка общего опыта');stack(b.layers,ctx,b.experimental);return clone(b);}
function candidate({name,scope,genre='',graphSha,contract:adapter,effective,romHash,parent=null,sourceRoms=[]}){
 contract(adapter);if(!hex(romHash))throw Error('Загрузите игру');let inherited=empty();if(scope==='genre'){if(!parent||validate(parent).scope!=='root'||parent.graphSha!==graphSha||canonical(parent.contract)!==canonical(adapter))throw Error('Выберите совместимый ROOT');inherited=parent.overlay;}
 return seal({type:TYPE,version:1,name,scope,genre:scope==='genre'?genre:'',graphSha,contract:clone(adapter),overlay:scope==='genre'?combine(overlay(effective),inherited,true):overlay(effective),parentDigest:scope==='genre'?parent.digest:null,romHash:scope==='game'?romHash:null,sourceRoms:scope==='game'?[romHash]:[...new Set([...sourceRoms,romHash])].sort(),status:'candidate',evidence:null});
}
function validateEvidence(e,sources){
 if(!e||e.version!==1||typeof e.metric!=='string'||!e.metric.trim()||!['higher','lower'].includes(e.direction)||!Array.isArray(e.pairs)||e.pairs.length<3||e.pairs.length>200)throw Error('Нужны парные проверки переноса минимум на 3 seed');const seen=new Set(),seeds=new Set();let sum=0;const protocols=new Map();
 for(const p of e.pairs){if(!hex(p.romHash)||sources.includes(p.romHash)||!Number.isInteger(p.seed)||p.seed<0||p.seed>2147483647||!Number.isInteger(p.episodes)||p.episodes<1||!Number.isInteger(p.trainingSteps)||p.trainingSteps<1||!Number.isFinite(p.control)||!Number.isFinite(p.transfer)||!Number.isFinite(p.controlCostMs)||p.controlCostMs<0||!Number.isFinite(p.transferCostMs)||p.transferCostMs<0||!hex(p.protocolSha))throw Error('Неверный / неотложенный эксперимент');const protocol=[p.protocolSha,p.episodes,p.trainingSteps].join(':');if(protocols.has(p.romHash)&&protocols.get(p.romHash)!==protocol)throw Error('Протокол и бюджет seed должны совпадать');protocols.set(p.romHash,protocol);const k=p.romHash+':'+p.seed;if(seen.has(k))throw Error('Повтор seed/ROM');seen.add(k);seeds.add(p.seed);sum+=(p.transfer-p.control)*(e.direction==='higher'?1:-1);}
 if(seeds.size<3||sum/e.pairs.length<=0)throw Error('Положительный средний перенос на трёх seed не подтверждён');
 return clone(e);
}
function promote(layer,evidence){layer=validate(layer);if(layer.status!=='candidate')throw Error('Выберите непроверенного кандидата');if(layer.scope==='game')throw Error('Индивидуальный слой не публикуется как универсальный');validateEvidence(evidence,layer.sourceRoms);if(evidence.candidateDigest!==layer.digest)throw Error('Отчёт относится к другому кандидату');return seal({...layer,status:'validated',evidence:clone(evidence)});}
class Store{
 constructor(storage){this.storage=storage;}
 list(){const raw=this.storage.getItem('fly-shared-experience-v1');const rows=raw?JSON.parse(raw):[];if(!Array.isArray(rows)||rows.length>32)throw Error('Повреждён каталог общего опыта');return rows.map(validate);}
 put(layer){layer=validate(layer);const rows=this.list();if(rows.some(x=>x.digest===layer.digest))return layer;if(rows.length>=32)throw Error('До 32 общих слоёв');const text=JSON.stringify([...rows,layer]);if(new TextEncoder().encode(text).length>4*1024*1024)throw Error('Каталог общего опыта превышает 4 МиБ');this.storage.setItem('fly-shared-experience-v1',text);return clone(layer);}
 remove(digest){this.storage.setItem('fly-shared-experience-v1',JSON.stringify(this.list().filter(x=>x.digest!==digest)));}
}
root.FlySharedExperience={TYPE,canonical,sha256,contract,overlay,combine,empty,fromFdb,toFdb,validate,seal,stack,binding,candidate,promote,validateEvidence,Store};if(typeof module!=='undefined')module.exports=root.FlySharedExperience;
})(typeof window==='undefined'?globalThis:window);
