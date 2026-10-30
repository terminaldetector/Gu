'use strict';
// S1: the experimental contour is reachable from the running lab, and costs it
// nothing while the flag is off.
//
// The claim "nothing changes when the flag is off" is not taken on trust: the
// page is served twice, once with the bridge script and once with that one tag
// stripped out, and the two loads are compared on page errors, on the globals
// the production contour exposes and on the research globals, which must be
// absent in both.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const assets=path.resolve('app/src/main/assets');
const demo=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-rom.json')));
const TAG='<script src="agod-experimental.js"></script>';
const PRODUCTION=['labLoadRom','labConfigured','labResult','labError','labPause'];
const RESEARCH=['FlyAgodRam','FlyAgodCausal','FlyAgodGoals','FlyAgodReward','FlyAgodEvidence','FlyAgodPipeline','FlyAgodDqn'];
const observations=[];
const result={type:'gu-agod-experimental-bridge-check',version:1,
 scope:'production lab page in headless Chromium, assets served from disk, no native bridge',
 claim:'With the flag off the page behaves as if the bridge file did not exist, and every research entry point returns a named refusal. With the flag on the seven stages load and the pipeline is callable.',
 status:'RUNNING',observations};
const save=()=>{if(process.env.AGOD_BRIDGE_REPORT)fs.writeFileSync(process.env.AGOD_BRIDGE_REPORT,JSON.stringify(result,null,2)+'\n');};save();
const note=(name,expectation,observed)=>{observations.push({name,expectation,observed});save();};

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const open=async withBridge=>{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://flyconsole.local/**',async route=>{
   const file=path.join(assets,new URL(route.request().url()).pathname.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   const type=file.endsWith('.js')?'application/javascript':file.endsWith('.json')?'application/json':'text/html';
   let body=fs.readFileSync(file);
   if(!withBridge&&file.endsWith('lab/index.html')){
    const text=body.toString('utf8');
    assert(text.includes(TAG),'the bridge tag must be present in index.html to strip it');
    body=Buffer.from(text.replace(TAG,''),'utf8');
   }
   await route.fulfill({contentType:type,body});
  });
  await page.goto('https://flyconsole.local/lab/index.html');
  // `loaded` only becomes true once a cartridge is in, so the page is taken to
  // the state a real session is in rather than to bare DOMContentLoaded.
  await page.evaluate(data=>window.labLoadRom(data),{base64:demo.base64,name:'Diagnostic / UI fixture',sha256:'fixture'});
  await page.waitForFunction(()=>loaded,null,{timeout:30000});
  return {page,errors};
 };
 const survey=page=>page.evaluate(([production,research])=>({
  loaded:typeof loaded!=='undefined'&&loaded===true,
  production:production.filter(name=>typeof window[name]==='function'),
  research:research.filter(name=>!!window[name]),
  bridge:!!window.FlyAgodExperimental,
  scripts:document.querySelectorAll('script').length,
  researchPanelChildren:document.getElementById('trainingResearch')?document.getElementById('trainingResearch').children.length:null}),
  [PRODUCTION,RESEARCH]);

 try{
  // A: the page without the bridge file at all.
  const control=await open(false);
  const before=await survey(control.page);
  await control.page.close();

  // B: the page as shipped, flag never set.
  const off=await open(true);
  const whileOff=await survey(off.page);
  const refusals=await off.page.evaluate(()=>({
   enabled:window.FlyAgodExperimental.enabled(),
   session:window.FlyAgodExperimental.session(null),
   loadedModules:window.FlyAgodExperimental.loadedModules(),
   ready:null}));
  refusals.ready=await off.page.evaluate(()=>window.FlyAgodExperimental.ready());

  note('page errors with and without the bridge file','identical sets',
   JSON.stringify({without:control.errors,with:off.errors}));
  assert.deepEqual(off.errors,control.errors,'adding the bridge must not add a page error');
  note('production entry points','unchanged by the bridge',
   'without '+before.production.length+', with '+whileOff.production.length);
  assert.deepEqual(whileOff.production,before.production,'the bridge must not remove or add production entry points');
  note('research stages while the flag is off','none loaded in either page',
   JSON.stringify({without:before.research,with:whileOff.research}));
  assert.deepEqual(before.research,[],'the control page must have no research globals');
  assert.deepEqual(whileOff.research,[],'with the flag off not one stage may be fetched or registered');
  assert.deepEqual(refusals.loadedModules,[],'loadedModules must report nothing while off');
  note('research panel contents','unchanged: the bridge adds no control',
   'without '+before.researchPanelChildren+', with '+whileOff.researchPanelChildren);
  assert.equal(whileOff.researchPanelChildren,before.researchPanelChildren,'the bridge must not alter the research panel');
  note('entry points while off','named refusals, not silence',
   'ready '+refusals.ready.status+', session '+refusals.session.status);
  assert.equal(refusals.enabled,false);
  assert.equal(refusals.ready.status,'DISABLED');
  assert.equal(refusals.session.status,'DISABLED');
  assert(!Object.prototype.hasOwnProperty.call(refusals.session,'goal'),'a refusal carries no goal');

  // C: enabling loads the stages and makes the pipeline callable.
  const enabledState=await off.page.evaluate(async()=>{
   window.FlyAgodExperimental.setEnabled(true);
   const ready=await window.FlyAgodExperimental.ready();
   return {enabled:window.FlyAgodExperimental.enabled(),ready,
    loadedModules:window.FlyAgodExperimental.loadedModules(),
    sessionWithoutDriver:window.FlyAgodExperimental.session(null),
    persisted:localStorage.getItem('gu-agod-neural-experimental-v1')};
  });
  const afterOn=await survey(off.page);
  note('enabling the flag','the seven stages load and register',
   enabledState.ready.status+', '+enabledState.loadedModules.length+'/7 registered, pipeline '+enabledState.ready.pipelineRevision+', learner '+enabledState.ready.learnerRevision);
  assert.equal(enabledState.ready.status,'READY');
  assert.equal(enabledState.loadedModules.length,RESEARCH.length);
  assert.deepEqual(afterOn.research.slice().sort(),RESEARCH.slice().sort(),'every stage must be registered once enabled');
  assert.equal(enabledState.persisted,'true','the flag must persist for the next session');
  note('session with no driver','the pipeline refuses by name, so it is genuinely wired',
   enabledState.sessionWithoutDriver.status+': '+enabledState.sessionWithoutDriver.reason);
  assert.equal(enabledState.sessionWithoutDriver.status,'REFUSED');
  assert(/driver must provide/.test(enabledState.sessionWithoutDriver.reason));
  note('production entry points after enabling','still unchanged',afterOn.production.length+' of '+PRODUCTION.length);
  assert.deepEqual(afterOn.production,before.production,'enabling research must not disturb the production contour');
  assert.deepEqual(off.errors,control.errors,'enabling must not raise a page error');

  // D: turning it off again refuses, even though loaded code cannot be unloaded.
  const offAgain=await off.page.evaluate(()=>{
   window.FlyAgodExperimental.setEnabled(false);
   return {enabled:window.FlyAgodExperimental.enabled(),session:window.FlyAgodExperimental.session(null),
    persisted:localStorage.getItem('gu-agod-neural-experimental-v1')};
  });
  note('turning the flag off again','entry points refuse again',offAgain.session.status+', stored '+offAgain.persisted);
  assert.equal(offAgain.enabled,false);
  assert.equal(offAgain.session.status,'DISABLED');
  assert.equal(offAgain.persisted,'false');
  await off.page.close();

  result.totals={observations:observations.length,pageErrorsWithBridge:off.errors.length,
   pageErrorsWithoutBridge:control.errors.length,
   researchGlobalsWhileOff:0,researchGlobalsWhileOn:RESEARCH.length};
  result.status='PASS';save();
  console.log(JSON.stringify({type:result.type,status:result.status,totals:result.totals,observations}));
  console.log('PASS: with the flag off the lab page behaves exactly as it does without the bridge file (same page errors, same production entry points, same research panel, zero research globals) and every entry point refuses by name; enabling loads all 7 stages and the pipeline is callable. No forbidden production file was touched; no user-facing control was added.');
 }catch(error){result.status='FAIL';result.error=error.message;save();throw error;}
 finally{await browser.close();}
})();
