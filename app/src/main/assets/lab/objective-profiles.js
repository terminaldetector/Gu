/* Objective observations are separate from learned layers. PR1 never admits reward. */
(function(root){'use strict';
 const VERSION=1,TYPE='gu-game-objective-profile',TTL_MS=48*60*60*1000,MAX_BYTES=128*1024,MAX_PROFILES=16,MAX_CANDIDATES=256;
 const clone=value=>JSON.parse(JSON.stringify(value)),byteLength=value=>new TextEncoder().encode(value).length;
 const fail=message=>{throw Error(message);};
 const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 function keys(value,allowed,label){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('Invalid '+label+' fields');}
 function text(value,max,label){if(typeof value!=='string'||!value.length||value.length>max)fail('Invalid '+label);return value;}
 function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)fail('Invalid '+label);return value;}
 function list(value,max,label){if(!Array.isArray(value)||value.length>max)fail('Invalid '+label);return value;}
 function strings(value,max,count,label){return list(value,count,label).map(item=>text(item,max,label));}
 function contracts(){const value=root.FlyGoalDiscovery||(typeof require==='function'?require('./goal-discovery.js'):null);if(!value?.validateContext||!value?.contextKey)fail('Game discovery contracts unavailable');return value;}
 function context(value){return contracts().validateContext(value);}
 function contextKey(value){return contracts().contextKey(context(value));}
 function sameContext(a,b){if(contextKey(a)!==contextKey(b))fail('Objective profile context mismatch');}
 function clock(value){return integer(value,0,Number.MAX_SAFE_INTEGER,'profile time');}
 function spec(value,c){
  keys(value,['address','width','format','endian'],'event predicate');
  const width=integer(value.width,1,4,'predicate width'),address=integer(value.address,c.ramLayout.base,c.ramLayout.base+c.ramLayout.length-width,'predicate address');
  if(!['unsigned','signed','bcd'].includes(value.format)||!['little','big'].includes(value.endian))fail('Invalid event encoding');
  return {address,width,format:value.format,endian:value.endian};
 }
 function group(value){
  keys(value,['runId','originId','startId','trajectoryId','partition','independence'],'evidence source');
  if(value.partition!=='discovery'||value.independence!=='unverified')fail('PR1 evidence cannot claim independence or use holdout');
  const out={};for(const key of ['runId','originId','startId','trajectoryId']){const field=value[key];if(field!==null&&field!==undefined)text(field,160,'evidence source');out[key]=field??null;}
  return {...out,partition:'discovery',independence:'unverified'};
 }
 function event(value,c){
  keys(value,['version','id','predicate','status','role','polarity','confidence','rank','aliasGroup','confounds','alternatives','observations','changes','sourceRefs','provenanceComplete'],'event hypothesis');
  if(value.version!==VERSION||!['CANDIDATE','REJECTED'].includes(value.status)||value.role!=='unknown'||value.polarity!=='unknown'||value.confidence!==null)fail('PR1 event semantics are unverified');
  if(typeof value.rank!=='number'||!Number.isFinite(value.rank)||Math.abs(value.rank)>1e9)fail('Invalid diagnostic rank');
  const observations=integer(value.observations,0,Number.MAX_SAFE_INTEGER,'observations'),changes=integer(value.changes,0,observations,'changes'),confounds=strings(value.confounds,120,24,'confounds');if(value.status==='REJECTED'&&!confounds.length)fail('Rejected event requires a reason');
  const sourceRefs=list(value.sourceRefs,32,'event source references').map(ref=>integer(ref,0,31,'event source reference'));
  if(new Set(sourceRefs).size!==sourceRefs.length||typeof value.provenanceComplete!=='boolean'||value.provenanceComplete&&observations>0&&!sourceRefs.length)fail('Invalid event provenance');
  return {version:VERSION,id:text(value.id,160,'event id'),predicate:spec(value.predicate,c),status:value.status,role:'unknown',polarity:'unknown',confidence:null,rank:value.rank,aliasGroup:text(value.aliasGroup,160,'alias group'),confounds,alternatives:strings(value.alternatives,64,16,'alternatives'),observations,changes,sourceRefs:sourceRefs.sort((a,b)=>a-b),provenanceComplete:value.provenanceComplete};
 }
 function goal(value,events,c){
  keys(value,['version','id','eventId','predicate','polarity','significance','horizon','relations','alternatives','falseInterpretations'],'goal hypothesis');
  const referenced=events.find(item=>item.id===value.eventId),predicate=spec(value.predicate,c);
  if(value.version!==VERSION||!referenced||referenced.status!=='CANDIDATE'||value.polarity!=='unknown'||value.significance!=='unknown'||value.horizon!=='unknown'||JSON.stringify(predicate)!==JSON.stringify(referenced.predicate))fail('PR1 goal meaning is unknown');
  if(list(value.relations,0,'goal relations').length)fail('PR1 goal relations are unverified');
  return {version:VERSION,id:text(value.id,180,'goal id'),eventId:referenced.id,predicate:clone(referenced.predicate),polarity:'unknown',significance:'unknown',horizon:'unknown',relations:[],alternatives:strings(value.alternatives,64,16,'goal alternatives'),falseInterpretations:strings(value.falseInterpretations,120,24,'false interpretations')};
 }
 function validateProfile(value,expected,{now=Date.now()}={}){
  keys(value,['type','version','profileRevision','context','status','createdAt','updatedAt','validUntil','gamePhases','eventHypotheses','goalHypotheses','goalEvidence','hypothesisCoverage','rewardScales','exclusions','invalidationReasons'],'objective profile');
  if(value.type!==TYPE||value.version!==VERSION||value.profileRevision!==1)fail('Unsupported objective profile schema');
  if(value.status==='verified')fail('VERIFIED profiles require a causal evidence gate; unavailable in PR1');
  if(!['discovering','provisional','invalidated'].includes(value.status))fail('Invalid objective profile status');
  const c=context(value.context);if(expected!==undefined)sameContext(c,expected);
  const at=clock(now),createdAt=clock(value.createdAt),updatedAt=clock(value.updatedAt),validUntil=clock(value.validUntil);
  if(createdAt>updatedAt||updatedAt>at||validUntil<=at||validUntil<updatedAt||validUntil-updatedAt>TTL_MS)fail('Objective profile expired or clock/context freshness is unknown');
  const events=list(value.eventHypotheses,MAX_CANDIDATES,'event hypotheses').map(item=>event(item,c));
  if(new Set(events.map(item=>item.id)).size!==events.length)fail('Duplicate event hypothesis');
  const goals=list(value.goalHypotheses,MAX_CANDIDATES,'goal hypotheses').map(item=>goal(item,events,c));
  if(new Set(goals.map(item=>item.id)).size!==goals.length||new Set(goals.map(item=>item.eventId)).size!==goals.length||goals.length!==events.filter(item=>item.status==='CANDIDATE').length)fail('Invalid goal references');
  const phases=list(value.gamePhases,1,'game phases');
  if(phases.length!==1)fail('PR1 phase is unknown');keys(phases[0],['version','phase','confidence','evidence'],'game phase');
  if(phases[0].version!==VERSION||phases[0].phase!=='unknown'||phases[0].confidence!==null||list(phases[0].evidence,0,'phase evidence').length)fail('PR1 phase is unknown');
  const evidence=value.goalEvidence;keys(evidence,['version','partition','independence','independentStarts','observations','sources'],'goal evidence');
  if(evidence.version!==VERSION||evidence.partition!=='discovery'||evidence.independence!=='unverified'||evidence.independentStarts!==0)fail('PR1 evidence cannot verify a goal');
  const sources=list(evidence.sources,32,'evidence sources').map(group),observations=integer(evidence.observations,0,Number.MAX_SAFE_INTEGER,'evidence observations');if(new Set(sources.map(item=>JSON.stringify(item))).size!==sources.length)fail('Duplicate evidence source');
  if(events.some(item=>item.sourceRefs.some(ref=>ref>=sources.length)))fail('Event source reference is outside retained evidence');
  const coverage=value.hypothesisCoverage;keys(coverage,['scope','complete','candidatesOmitted','rejectionsOmitted'],'hypothesis coverage');
  const candidatesOmitted=integer(coverage.candidatesOmitted,0,MAX_CANDIDATES,'omitted candidates'),rejectionsOmitted=integer(coverage.rejectionsOmitted,0,32,'omitted rejections');
  if(coverage.scope!=='reported-hypotheses'||typeof coverage.complete!=='boolean'||coverage.complete!==(candidatesOmitted+rejectionsOmitted===0))fail('Invalid hypothesis coverage');
  list(value.rewardScales,0,'reward scales');
  const exclusions=list(value.exclusions,MAX_CANDIDATES,'exclusions').map(item=>{keys(item,['eventId','reasons'],'exclusion');if(!events.some(event=>event.id===item.eventId&&event.status==='REJECTED'))fail('Unknown excluded event');return {eventId:item.eventId,reasons:strings(item.reasons,120,24,'exclusion reasons')};});if(new Set(exclusions.map(item=>item.eventId)).size!==exclusions.length)fail('Duplicate exclusion');
  const invalidationReasons=strings(value.invalidationReasons,160,16,'invalidation reasons');if(value.status==='invalidated'&&!invalidationReasons.length)fail('Invalidation requires a reason');
  if(value.status==='discovering'&&events.some(item=>item.status==='CANDIDATE')||value.status==='provisional'&&!events.some(item=>item.status==='CANDIDATE'))fail('Objective profile status does not match its candidates');
  const normalized={type:TYPE,version:VERSION,profileRevision:1,context:c,status:value.status,createdAt,updatedAt,validUntil,gamePhases:[{version:VERSION,phase:'unknown',confidence:null,evidence:[]}],eventHypotheses:events,goalHypotheses:goals,goalEvidence:{version:VERSION,partition:'discovery',independence:'unverified',independentStarts:0,observations,sources},hypothesisCoverage:{scope:'reported-hypotheses',complete:coverage.complete,candidatesOmitted,rejectionsOmitted},rewardScales:[],exclusions,invalidationReasons};
  if(byteLength(JSON.stringify(normalized))>MAX_BYTES)fail('Objective profile exceeds size budget');return normalized;
 }
 function createProfile(c,report,{now=Date.now()}={}){
  c=context(c);clock(now);
  if(!object(report)||report.type!=='gu-goal-discovery-report'||report.version!==VERSION||report.detectorRevision!=='agod-foundation-1'||report.rewardStatus!=='UNKNOWN')fail('Invalid candidate report');
  sameContext(c,report.context);
  if(!['DISCOVERING','CANDIDATES','UNKNOWN'].includes(report.status))fail('Candidate report cannot verify a profile');
  const candidates=list(report.candidates,MAX_CANDIDATES,'report candidates'),rejections=list(report.rejections??[],32,'report rejections'),ids=new Set(),extra=[];
  for(const item of candidates){const id=text(item?.id,160,'candidate id');if(ids.has(id))fail('Duplicate candidate id');ids.add(id);}
  for(const item of rejections){const id=text(item?.id,160,'rejection id');if(item.status!=='REJECTED')fail('Invalid rejection exemplar');if(!ids.has(id)){ids.add(id);extra.push(item);}}
  const current=candidates.slice(0,MAX_CANDIDATES-extra.length),sources=[],sourceKeys=new Map(),origins=[];
  const events=[...current,...extra].map((item,index)=>{
   origins.push(index<current.length?'candidate':'rejection');
   if(!object(item)||item.role!=='unknown'||item.polarity!=='unknown'||item.confidence!==null)fail('Candidate report claims verified semantics');
   const groups=list(item.provenance?.groups??[],32,'candidate provenance'),refs=new Set();let provenanceComplete=groups.length>0;
   if(item.provenance&&item.provenance.independence!=='unverified')fail('Candidate provenance cannot claim independence');
   // References retain which discovery sources support each candidate without
   // duplicating full provenance lists in every event. Pool truncation is explicit.
   for(const input of groups){const normalized=group(input),key=JSON.stringify(normalized);if(!sourceKeys.has(key)&&sources.length<32){sourceKeys.set(key,sources.length);sources.push(normalized);}if(sourceKeys.has(key))refs.add(sourceKeys.get(key));else provenanceComplete=false;}
   return event({version:VERSION,id:item.id,predicate:item.spec,status:item.status,role:'unknown',polarity:'unknown',confidence:null,rank:item.rank,aliasGroup:item.aliasGroup,confounds:item.confounds??[],alternatives:item.alternatives??[],observations:item.statistics?.observations??0,changes:item.statistics?.changes??0,sourceRefs:[...refs],provenanceComplete},c);
  });
  let candidatesOmitted=candidates.length-current.length,rejectionsOmitted=0;
  const compiled=()=>{const goals=events.filter(item=>item.status==='CANDIDATE').map(item=>({version:VERSION,id:'goal:'+item.id,eventId:item.id,predicate:clone(item.predicate),polarity:'unknown',significance:'unknown',horizon:'unknown',relations:[],alternatives:item.alternatives.slice(),falseInterpretations:item.confounds.slice()}));return {type:TYPE,version:VERSION,profileRevision:1,context:c,status:goals.length?'provisional':'discovering',createdAt:now,updatedAt:now,validUntil:now+TTL_MS,gamePhases:[{version:VERSION,phase:'unknown',confidence:null,evidence:[]}],eventHypotheses:events,goalHypotheses:goals,goalEvidence:{version:VERSION,partition:'discovery',independence:'unverified',independentStarts:0,observations:report.stats?.accepted??0,sources},hypothesisCoverage:{scope:'reported-hypotheses',complete:candidatesOmitted+rejectionsOmitted===0,candidatesOmitted,rejectionsOmitted},rewardScales:[],exclusions:events.filter(item=>item.status==='REJECTED').map(item=>({eventId:item.id,reasons:item.confounds.slice()})),invalidationReasons:[]};};
  let profile=compiled();
  while(byteLength(JSON.stringify(profile))>MAX_BYTES&&events.length){
   // Retain bounded negative-control exemplars before low-ranked live aliases.
   let index=origins.lastIndexOf('candidate');if(index<0)index=events.length-1;
   origins[index]==='candidate'?candidatesOmitted++:rejectionsOmitted++;events.splice(index,1);origins.splice(index,1);profile=compiled();
  }
  return validateProfile(profile,c,{now});
 }
 function rewardEvidence(c,{generation,frame}={}){return {version:VERSION,status:'UNKNOWN',source:'auto-discovery',context:context(c),generation:integer(generation,0,Number.MAX_SAFE_INTEGER,'generation'),frame:integer(frame,0,Number.MAX_SAFE_INTEGER,'frame'),reason:'PR1 candidate discovery has no verified goal or reward'};}
 async function digest(crypto,text){if(!crypto?.subtle)fail('Objective profile integrity requires Web Crypto');const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return Array.from(new Uint8Array(result),value=>value.toString(16).padStart(2,'0')).join('');}
 class Store{
  constructor({indexedDB=root.indexedDB,crypto=root.crypto,maxProfiles=MAX_PROFILES,maxBytes=MAX_BYTES,maxPending=16,timeoutMs=10000,now=()=>Date.now(),name='gu-game-objectives-v1'}={}){
   if(typeof now!=='function')fail('Invalid profile clock');this.indexedDB=indexedDB;this.crypto=crypto;this.maxProfiles=integer(maxProfiles,1,MAX_PROFILES,'profile count budget');this.maxBytes=integer(maxBytes,1024,MAX_BYTES,'profile byte budget');this.maxPending=integer(maxPending,1,16,'pending profile budget');this.timeoutMs=integer(timeoutMs,10,30000,'profile timeout');this.now=now;this.name=text(name,120,'database name');this.opening=null;this.active=0;
  }
  open(){
   if(!this.indexedDB)return Promise.reject(Error('Objective profile cache requires IndexedDB'));
   if(!this.opening)this.opening=new Promise((resolve,reject)=>{const request=this.indexedDB.open(this.name,VERSION);let settled=false;
    const refuse=error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);},timer=setTimeout(()=>refuse(Error('Objective profile cache open timed out')),this.timeoutMs);
    request.onupgradeneeded=()=>{if(settled){request.transaction.abort();return;}request.result.createObjectStore('profiles');};request.onerror=()=>refuse(request.error||Error('Objective profile cache unavailable'));
    request.onblocked=()=>refuse(Error('Objective profile cache is open in another page'));
    request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;clearTimeout(timer);db.onversionchange=()=>{db.close();this.opening=null;};resolve(db);};
   }).catch(error=>{this.opening=null;throw error;});return this.opening;
  }
  async close(){if(this.opening){const db=await this.opening;db.close();this.opening=null;}}
  async request(work){if(this.active>=this.maxPending)fail('Objective profile cache busy; pending budget exceeded');this.active++;try{return await work();}finally{this.active--;}}
  async read(c,{fresh=true}={}){
   c=context(c);const key=contextKey(c),db=await this.open(),row=await new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readonly'),q=tx.objectStore('profiles').get(key);let value,problem;const timer=setTimeout(()=>{problem=Error('Objective profile read timed out');try{tx.abort();}catch(_){reject(problem);}},this.timeoutMs);q.onsuccess=()=>{value=q.result;};tx.oncomplete=()=>{clearTimeout(timer);resolve(value);};tx.onabort=()=>{clearTimeout(timer);reject(problem||tx.error||Error('Objective profile read aborted'));};});
   if(row===undefined)return null;
   this.envelope(row,key);if(await digest(this.crypto,row.payload)!==row.sha256)fail('Objective profile checksum mismatch');
   let parsed;try{parsed=JSON.parse(row.payload);}catch(_){fail('Objective profile JSON is damaged');}
   const checkedAt=clock(this.now());if(row.updatedAt>checkedAt)fail('Objective profile is future-dated; clock freshness is unknown');
   const profile=validateProfile(parsed,c,{now:fresh?checkedAt:row.updatedAt});if(profile.updatedAt!==row.updatedAt)fail('Objective profile envelope time mismatch');return {profile,revision:row.revision,row};
  }
  async get(c){return this.request(async()=>{const found=await this.read(c);return found?{profile:found.profile,revision:found.revision}:null;});}
  // Integrity/schema-checked revision for a fresh discovery's CAS replacement.
  // This is never permission to apply expired evidence as a current goal.
  async getForRefresh(c){return this.request(async()=>{const found=await this.read(c,{fresh:false});return found?{profile:found.profile,revision:found.revision,fresh:false}:null;});}
  envelope(row,key){
   keys(row,['version','key','revision','updatedAt','payload','sha256','bytes'],'profile envelope');
   if(row.version!==VERSION||row.key!==key||typeof row.payload!=='string'||row.payload.length>this.maxBytes||! /^[a-f0-9]{64}$/.test(row.sha256))fail('Objective profile envelope is damaged');
   integer(row.revision,1,Number.MAX_SAFE_INTEGER,'stored revision');clock(row.updatedAt);integer(row.bytes,0,this.maxBytes,'stored bytes');if(byteLength(row.payload)!==row.bytes)fail('Objective profile size mismatch');
  }
  async put(input,{expectedRevision}={}){
   return this.request(async()=>{
   const profile=validateProfile(input,input.context,{now:this.now()}),key=contextKey(profile.context),payload=JSON.stringify(profile),bytes=byteLength(payload);if(bytes>this.maxBytes)fail('Objective profile exceeds cache budget');
   if(expectedRevision!==undefined)integer(expectedRevision,0,Number.MAX_SAFE_INTEGER,'expected revision');
   // Verify the preceding candidate envelope before replacing it. Expiration may
   // start fresh discovery, but corruption/forged semantics require explicit repair.
   const verified=await this.read(profile.context,{fresh:false}),sha256=await digest(this.crypto,payload),db=await this.open();
   return new Promise((resolve,reject)=>{const tx=db.transaction('profiles','readwrite'),store=tx.objectStore('profiles'),get=store.get(key);let problem,result;
    const timer=setTimeout(()=>abort(Error('Objective profile write acknowledgement timed out')),this.timeoutMs);
    const abort=error=>{problem=error;try{tx.abort();}catch(_){reject(error);}};
    get.onsuccess=()=>{try{
     const old=get.result;if(old!==undefined)this.envelope(old,key);
     if(Boolean(old)!==Boolean(verified)||old&&['revision','payload','sha256','bytes','updatedAt'].some(field=>old[field]!==verified.row[field]))throw Error('Objective profile revision conflict');
     const revision=old?.revision||0;if(expectedRevision!==undefined&&expectedRevision!==revision)throw Error('Objective profile revision conflict');
     if(revision>=Number.MAX_SAFE_INTEGER)throw Error('Objective profile revision limit');
     const commit=()=>{try{const next=revision+1;store.put({version:VERSION,key,revision:next,updatedAt:profile.updatedAt,payload,sha256,bytes},key);result={revision:next};}catch(error){abort(error);}};
     if(old!==undefined){commit();return;}
     const count=store.count();count.onsuccess=()=>{if(count.result>=this.maxProfiles){abort(Error('Objective profile cache full; previous profiles retained'));return;}commit();};
    }catch(error){abort(error);}};
    tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};tx.onabort=()=>{clearTimeout(timer);reject(problem||tx.error||Error('Objective profile write aborted; previous data retained'));};tx.onerror=()=>{};
   });
   });
  }
 }
 root.FlyObjectiveProfiles={VERSION,TYPE,TTL_MS,MAX_BYTES,MAX_PROFILES,createProfile,validateProfile,rewardEvidence,Store};
 if(typeof module!=='undefined')module.exports=root.FlyObjectiveProfiles;
})(typeof window!=='undefined'?window:globalThis);
