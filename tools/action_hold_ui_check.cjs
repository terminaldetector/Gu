'use strict';
// Actual cores and production actuator/clock; native neural responses are explicit fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('playwright'),assets=path.resolve('app/src/main/assets');let browser;
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE});
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[],rows=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://flyconsole.local/**',r=>{const p=path.join(assets,new URL(r.request().url()).pathname.slice(1));return r.fulfill({status:fs.existsSync(p)?200:404,body:fs.existsSync(p)?fs.readFileSync(p):'',contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.wasm')?'application/wasm':'text/html'});});
 await page.exposeFunction('holdDemo',async system=>{const d=JSON.parse(fs.readFileSync(path.join(assets,'lab/demo-'+(system==='nes'?'rom':system)+'.json')));d.sha256=crypto.createHash('sha256').update(Buffer.from(d.base64,'base64')).digest('hex');return page.evaluate(d=>labLoadRom(d),d);});
 await page.addInitScript(()=>{
  window.holdRequests=[];
  window.FlyBridge={demo:()=>holdDemo(new URL(location.href).searchParams.get('system')),acceptRom(){},stop(){},resume(){},orientation(){},sample(raw){holdRequests.push(JSON.parse(raw));},
   configure(raw){const q=JSON.parse(raw);setTimeout(()=>labConfigured({generation:q.generation,reset:q.reset,mode:q.mode,backend:q.backend,configVersion:1}),1);},
   fdbFeedback(raw){const q=JSON.parse(raw);setTimeout(()=>labFdbFeedback({token:q.token,data:{changed:0}}),1);}
  };
 });
 async function announce(){await page.evaluate(()=>labReady({modelId:'flywire-v783',kind:'hold delivery fixture',neurons:30,edges:1,heapMiB:512,graph_sha256:'b'.repeat(64),inputs:Array.from({length:16},(_,i)=>String(i+1)),outputs:Array.from({length:buttonNames.length},(_,i)=>String(i+17)),backend:'cpu'}));await page.evaluate(()=>labState.settle());}
 for(const system of ['nes','sega','snes','gb']){
  await page.goto('https://flyconsole.local/lab/index.html?system='+system);await page.waitForFunction(()=>loaded);await announce();
  await page.evaluate(()=>{
   window.holdReply=mask=>{
    if(pendingToken===null)sampleFrame(performance.now(),true);
    if(pendingToken===null)throw Error('no pending observation');
    labResult({generation,token:pendingToken,buttons:mask,outputs:new Array(buttonNames.length).fill(0),wallMs:20,simMs:20,spikes:0,active:0,sequence:1});
   };
   window.delivery={mask:0,frames:0,gaps:0,downs:0,ups:0,bUps:0,expected:0};
   const down=nes.buttonDown.bind(nes),up=nes.buttonUp.bind(nes),run=nes.frame.bind(nes);
   nes.buttonDown=(port,bit)=>{if(port===1){delivery.mask|=1<<bit;delivery.downs++;}return down(port,bit);};
   nes.buttonUp=(port,bit)=>{if(port===1){delivery.mask&=~(1<<bit);delivery.ups++;if(bit===buttonNames.indexOf('B'))delivery.bUps++;}return up(port,bit);};
   nes.frame=()=>{if(delivery.expected){delivery.frames++;if((delivery.mask&delivery.expected)!==delivery.expected)delivery.gaps++;}return run();};
  });
  for(const rate of [1,3,10]){
   const start=await page.evaluate(rate=>{labPause();$('learnMode').value='off';$('clock').value='realtime';$('actionHoldMode').value='model';$('actionHoldTimeout').value='5';learningUI.rate(rate);openGame();$('play').click();connected=true;lastResponse=performance.now();sampleFrame(performance.now(),true);const mask=(1<<buttonNames.indexOf('B'))|128;holdReply(mask);delivery.expected=mask;delivery.frames=delivery.gaps=0;return{downs:delivery.downs,ups:delivery.ups,at:performance.now(),mask};},rate);
   await page.waitForTimeout(800);
   const held=await page.evaluate(()=>({mask:brainMask,delivery:{...delivery},pending:pendingToken!==null,at:performance.now(),gameAge:brainGameAge}));
   assert.equal(held.mask,start.mask,'continuous B/direction at '+system+' ×'+rate);assert(held.delivery.frames>=10,'real core advanced');assert.equal(held.delivery.gaps,0,'no forced release on any actual frame');assert(held.pending,'slow response remains in flight');
   const same=await page.evaluate(mask=>{holdReply(mask);return{downs:delivery.downs,ups:delivery.ups};},start.mask);
   assert.equal(same.downs,start.downs,'same mask does not press again');assert.equal(same.ups,start.ups,'same mask never emits buttonUp');
   await page.waitForTimeout(70);
   const changed=await page.evaluate(()=>{delivery.expected=0;const bUps=delivery.bUps,mask=(1<<buttonNames.indexOf('B'))|64;holdReply(mask);return{mask:delivery.mask,bUpsBefore:bUps,bUpsAfter:delivery.bUps};});assert.equal(changed.mask,66);assert.equal(changed.bUpsBefore,changed.bUpsAfter,'changing direction must not release held B');
   await page.evaluate(()=>holdReply(0));assert.equal(await page.evaluate(()=>delivery.mask),0,'zero neural mask releases the actual core');
   rows.push({system,rate,realMilliseconds:held.at-start.at,frames:held.delivery.frames,gameSeconds:held.gameAge,heldMask:start.mask,gaps:held.delivery.gaps});
   await page.evaluate(()=>{delivery.expected=0;labPause();});
  }
  // GMode uses the same policy on the model's actual port, never the human's.
  if(system!=='gb'){
   const routed=await page.evaluate(()=>{gmodeMode='coop';$('gmode').value='coop';manualMask=0;brainMask=2;connected=true;lastResponse=performance.now();brainGameAge=1;checkBrainHold(lastResponse+800);updateButtons();const pair=[appliedHumanMask,appliedAgentMask];brainMask=0;updateButtons();gmodeMode='off';$('gmode').value='off';return pair;});assert.deepEqual(routed,[0,2]);
  }
  await page.evaluate(()=>labPause());
  if(system==='nes'){
   await page.evaluate(async()=>{leaveGame('learning');$('actionHoldMode').value='limited';$('actionHoldLimit').value='750';$('actionHoldTimeout').value='9';$('actionHoldMode').dispatchEvent(new Event('change'));await labState.checkpoint();});
   const exported=await page.evaluate(()=>policyPackage(false));assert.deepEqual(exported.configuration.actionHold,{mode:'limited',limitMs:750,timeoutMs:9000});
   await page.reload();await page.waitForFunction(()=>loaded);await announce();assert.equal(await page.inputValue('#actionHoldMode'),'limited');assert.equal(await page.inputValue('#actionHoldLimit'),'750');assert.equal(await page.inputValue('#actionHoldTimeout'),'9');assert.equal(await page.evaluate(()=>playing||connected),false,'restoring settings never starts the model');
   const migration=await page.evaluate(()=>{const p=policyPackage(false),prior=JSON.stringify(p.configuration.fdb);delete p.configuration.actionHold;restoreProfile(p);return{c:configuration().actionHold,preserved:prior===JSON.stringify(fdbConfiguration())};});assert.deepEqual(migration.c,{mode:'model',limitMs:250,timeoutMs:5000});assert(migration.preserved,'legacy profile migration retains weights');
  }
 }
 // Pausing cancels the token, so a late positive response cannot re-press B.
 await page.evaluate(()=>{openGame();$('play').click();connected=true;sampleFrame(performance.now(),true);window.lateHold={generation,token:pendingToken,buttons:2,outputs:new Array(buttonNames.length).fill(0),wallMs:20,simMs:20,spikes:0,active:0,sequence:1};labPause();labResult(lateHold);});assert.equal(await page.evaluate(()=>brainMask),0);
 assert.deepEqual(errors,[]);fs.mkdirSync('ui-preview',{recursive:true});fs.writeFileSync('ui-preview/alpha22-action-hold.json',JSON.stringify({kind:'actual-core-input-continuity',native:'explicit acknowledgement/decision fixtures',rows},null,2));console.log(JSON.stringify(rows));await browser.close();
 console.log('PASS: real NES/MD/SNES/GB cores hold B + direction at ×1/×3/×10 without gaps, same mask has no up/down pulse, zero releases, GMode/P2 routing, durable options, legacy migration and late response rejection');
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
