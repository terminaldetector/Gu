/* Experimental AGOD + neural contour, behind a flag (Sol decision: milestone 1).

   The research modules were reachable only from check scripts. This is the one
   place the running lab can reach them from, and it is built so that the
   flag-off path costs the production contour nothing at all: the modules are
   not fetched, not parsed and not registered until the flag is on. That is why
   this file loads them on demand instead of index.html listing all seven.

   With the flag off every entry point returns a named refusal. Nothing is
   patched, no listener is installed and no element is added, so a lab session
   that never enables this is byte-identical in behaviour to one without the
   file - which the accompanying check verifies by serving the page twice, with
   and without this script, and comparing what the page does.

   No user-facing toggle yet, deliberately: the research panel is asserted on by
   existing UI checks, and adding a control there is a product decision, not a
   research one. The flag is set through setEnabled() or localStorage. */
(function(root){'use strict';
const FLAG='gu-agod-neural-experimental-v1',BRIDGE_REVISION='agod-experimental-s1-1';
const MODULES=Object.freeze(['agod-ram.js','agod-causal.js','agod-goals.js','agod-reward.js',
 'agod-evidence.js','agod-pipeline.js','agod-dqn.js']);
const GLOBALS=Object.freeze(['FlyAgodRam','FlyAgodCausal','FlyAgodGoals','FlyAgodReward',
 'FlyAgodEvidence','FlyAgodPipeline','FlyAgodDqn']);
const frozen=Object.freeze.bind(Object);
let override=null,loading=null;

function stored(){try{return !!root.localStorage&&root.localStorage.getItem(FLAG)==='true';}catch(_){return false;}}
const enabled=()=>override===null?stored():override;
function setEnabled(value){
 override=!!value;
 try{if(root.localStorage)root.localStorage.setItem(FLAG,override?'true':'false');}catch(_){}
 return enabled();
}
const disabled=what=>frozen({status:'DISABLED',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
 reason:'the experimental AGOD and neural contour is off; '+what+' is not available'});

function inject(file){
 return new Promise((resolve,reject)=>{
  const element=root.document.createElement('script');
  element.src=file;element.async=false;
  element.onload=()=>resolve(file);
  element.onerror=()=>reject(new Error('could not load experimental module '+file));
  root.document.head.appendChild(element);
 });
}

/* Loads the stages in dependency order, once. The pipeline module reads its
   dependencies off the global at load time, so the order here matters. */
function ready(){
 if(!enabled())return Promise.resolve(disabled('loading the research stages'));
 if(!loading)loading=(async()=>{
  const loaded=[];
  for(const file of MODULES){if(!root.document)throw new Error('no document to load into');loaded.push(await inject(file));}
  const missing=GLOBALS.filter(name=>!root[name]);
  if(missing.length)throw new Error('modules loaded but did not register: '+missing.join(', '));
  return frozen({status:'READY',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
   modules:loaded.slice(),globals:GLOBALS.slice(),
   pipelineRevision:root.FlyAgodPipeline.PIPELINE_REVISION,
   learnerRevision:root.FlyAgodDqn.LEARNER_REVISION});
 })().catch(error=>{loading=null;throw error;});
 return loading;
}

/* The single research entry point. It refuses rather than guesses: off, not
   loaded, or whatever the pipeline itself refuses. */
function session(driver,options){
 if(!enabled())return disabled('a research session');
 if(!root.FlyAgodPipeline)
  return frozen({status:'NOT-LOADED',flag:FLAG,bridgeRevision:BRIDGE_REVISION,
   reason:'call ready() and await it before starting a session'});
 return root.FlyAgodPipeline.run(driver,options);
}

const api={FLAG,BRIDGE_REVISION,MODULES,GLOBALS,enabled,setEnabled,ready,session,
 loadedModules(){return GLOBALS.filter(name=>!!root[name]);}};
root.FlyAgodExperimental=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
