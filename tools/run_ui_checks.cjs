'use strict';
// Keep CI failures inspectable even when the job's full console log is unavailable.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawn,spawnSync}=require('node:child_process');
const suites=[
 'console_layout','interface_ui','landscape_ui','layer_ui','platform_ui','training_ui','dual_layout','polish_ui','training_flow_ui','release_regression_ui','autonomous_console_ui','continuation_ui','autonomous_episodes_ui','episode_starts_ui','session_logger_ui','console_navigation_ui','agent_quick_panel_ui','agent_teaching_panel_ui','portrait_rotation_ui','plasticity_speed_ui','action_hold_ui'
];
const annotation=value=>String(value).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
const requested=process.argv.slice(2),unknown=requested.filter(name=>!suites.includes(name));
if(unknown.length){console.error('Unknown UI suites: '+unknown.join(', '));process.exitCode=1;}
else (async()=>{
 const selected=requested.length?suites.filter(name=>requested.includes(name)):suites;
 const output=path.resolve(process.env.UI_CHECK_REPORT_DIR||'ui-check-results');fs.mkdirSync(output,{recursive:true});
 let browser=process.env.CHROMIUM_EXECUTABLE||null,playwright=null;
 try{const pw=require('playwright');playwright=require('playwright/package.json').version;browser=browser||pw.chromium.executablePath();}catch(error){playwright='unavailable: '+error.message;}
 const version=browser?spawnSync(browser,['--version'],{encoding:'utf8',timeout:10000}):null;
 const report={schema:1,startedAt:new Date().toISOString(),status:'running',environment:{node:process.version,platform:process.platform,architecture:process.arch,osRelease:os.release(),playwright,browserExecutable:browser,browserVersion:version?String(version.stdout||version.stderr||version.error?.message||'').trim():null},selectedSuites:selected,results:[]};
 const save=()=>fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(report,null,2)+'\n');save();
 console.log('UI environment: '+JSON.stringify(report.environment));
 for(const name of selected){
  const script='tools/'+name+'_check.cjs',stdout=name+'.stdout.log',stderr=name+'.stderr.log',started=Date.now();
  const result={name,script,status:'running',startedAt:new Date(started).toISOString(),stdout,stderr};report.results.push(result);save();
  const out=fs.openSync(path.join(output,stdout),'w'),err=fs.openSync(path.join(output,stderr),'w');let failureText='';
  console.log('::group::UI '+name);
  const completion=await new Promise(resolve=>{
   const child=spawn(process.execPath,[script],{env:process.env,stdio:['ignore','pipe','pipe']});let launchError=null;
   child.stdout.on('data',data=>{fs.writeSync(out,data);process.stdout.write(data);});
   child.stderr.on('data',data=>{fs.writeSync(err,data);process.stderr.write(data);if(failureText.length<32768)failureText+=data.toString();});
   child.on('error',error=>{launchError=error.message;fs.writeSync(err,launchError+'\n');});
   child.on('close',(code,signal)=>resolve({code,signal,launchError}));
  });
  fs.closeSync(out);fs.closeSync(err);Object.assign(result,completion,{status:completion.code===0&&!completion.launchError?'passed':'failed',durationMs:Date.now()-started,completedAt:new Date().toISOString()});save();
  console.log('::endgroup::');
  if(result.status==='failed'){
   const lines=failureText.trim().split(/\r?\n/).filter(Boolean),reason=completion.launchError||lines.find(line=>/AssertionError|TimeoutError|Error:/.test(line))||lines[0]||('exit '+completion.code+(completion.signal?' ('+completion.signal+')':''));
   console.error('::error title='+annotation('UI check failed: '+name)+'::'+annotation(reason.slice(0,1500)+'; logs: '+path.join(output,stderr)));
  }
 }
 report.status=report.results.every(result=>result.status==='passed')?'passed':'failed';report.completedAt=new Date().toISOString();save();
 const failed=report.results.filter(result=>result.status==='failed').map(result=>result.name);
 console.log('UI checks: '+(report.results.length-failed.length)+'/'+report.results.length+' passed'+(failed.length?'; failed: '+failed.join(', '):'')+'. Report: '+path.join(output,'summary.json'));
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### UI checks\n\n'+report.results.map(result=>'- '+(result.status==='passed'?'✅':'❌')+' `'+result.name+'` ('+(result.durationMs/1000).toFixed(2)+'s)').join('\n')+'\n\nFull stdout, stderr and browser versions: **FlyConsole-ui-check-results** artifact.\n');
 process.exitCode=failed.length?1:0;
})().catch(error=>{console.error('::error title=UI runner failed::'+annotation(error.stack||error));process.exitCode=1;});
