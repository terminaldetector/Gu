'use strict';
// Where a result came from, recorded at the moment it was produced.
//
// WHY (R6 / specification 8). The final S11B report recorded
// provenance.commit = a2aad98 with workingTreeDirty = true. Both facts are
// true and together they say almost nothing: the published source at that
// commit was not the source that ran, and "dirty" does not say which files
// differed or what they contained. A result that cannot name the bytes that
// produced it is not reproducible, and the rule this programme works under is
// that no evidence may outlive its own provenance.
//
// So a run records, for every source file it depends on: the path, the SHA256
// of the bytes ON DISK at run time, the size, and whether that file differs
// from the committed version. The git commit and the dirty flag stay, as
// context, and are no longer the whole record.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),
      {execFileSync}=require('node:child_process');

const PROVENANCE_REVISION='agod-provenance-1';
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

/* The files every S11B-family run depends on. A tool adds its own on top. */
const CORE_SOURCES=[
 'tools/agod_s11b_adapter.cjs',
 'tools/agod_s11b_host.cjs',
 'tools/agod_phase_evidence.cjs',
 'tools/agod_provenance.cjs',
 'app/src/main/assets/lab/agod-causal.js'];

function gitInfo(repoRoot){
 const run=args=>{try{return execFileSync('git',args,
   {cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}
  catch(_){return null;}};
 const head=run(['rev-parse','HEAD']);
 const porcelain=run(['status','--porcelain']);
 const modified=porcelain===null?null
  :porcelain.split('\n').filter(Boolean).map(line=>({status:line.slice(0,2).trim(),
     path:line.slice(3)}));
 return {commit:head||'unknown',
  branch:run(['rev-parse','--abbrev-ref','HEAD']),
  commitSubject:run(['log','-1','--pretty=%s']),
  commitDate:run(['log','-1','--pretty=%cI']),
  workingTreeDirty:modified===null?null:modified.length>0,
  modifiedFileCount:modified===null?null:modified.length,
  modifiedFiles:modified===null?null:modified.slice(0,64)};
}

/* The SHA256 of each file as it is on disk right now, with whether it matches
   the committed blob. "matchesCommitted:false" is the fact that
   workingTreeDirty could not give: it names the file. */
function fileHashes(repoRoot,relativePaths){
 return relativePaths.map(relative=>{
  const absolute=path.join(repoRoot,relative);
  let onDisk=null,size=null,error=null;
  try{const bytes=fs.readFileSync(absolute);onDisk=sha256(bytes);size=bytes.length;}
  catch(problem){error=problem.message;}
  let committed=null;
  /* stderr is discarded: a file that is new since HEAD makes git print a fatal
     error, which is an expected answer here and not a failure of the run. */
  try{committed=execFileSync('git',['rev-parse','HEAD:'+relative],
   {cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch(_){}
  let committedContentHash=null;
  try{const bytes=execFileSync('git',['show','HEAD:'+relative],
   {cwd:repoRoot,maxBuffer:64*1024*1024,stdio:['ignore','pipe','ignore']});
   committedContentHash=sha256(bytes);}catch(_){}
  return {path:relative,sha256:onDisk,bytes:size,
   gitBlobAtHead:committed,
   matchesCommitted:committedContentHash===null||onDisk===null
    ?null:committedContentHash===onDisk,
   newSinceCommit:committed===null&&onDisk!==null,
   error};
 });
}

/* options: {repoRoot, sources:[...extra relative paths], tool:'relative/path.cjs'} */
function record(options){
 const opts=options||{};
 const repoRoot=opts.repoRoot||path.resolve(__dirname,'..');
 const extra=opts.sources||[];
 const tool=opts.tool?[opts.tool]:[];
 const paths=[...new Set([...tool,...CORE_SOURCES,...extra])];
 const files=fileHashes(repoRoot,paths);
 const differing=files.filter(f=>f.matchesCommitted===false).map(f=>f.path);
 return {provenanceRevision:PROVENANCE_REVISION,
  recordedAt:new Date().toISOString(),
  node:process.version,platform:process.platform,arch:process.arch,
  git:gitInfo(repoRoot),
  sourceFiles:files,
  sourceFilesDifferingFromCommit:differing,
  /* One hash over the whole declared source set, so two runs can be compared
     in one comparison instead of file by file. */
  sourceSetHash:sha256(Buffer.from(files.map(f=>f.path+':'+f.sha256).join('\n'))),
  reproducibilityNote:differing.length
   ?'THIS RUN DID NOT USE THE COMMITTED SOURCE. The files listed in '
    +'sourceFilesDifferingFromCommit differed from HEAD when the run started, and their '
    +'run-time hashes are above. A result produced this way is reproducible only against '
    +'those hashes, not against the commit.'
   :'every declared source file matched its committed version at run time'};
}

module.exports={PROVENANCE_REVISION,CORE_SOURCES,record,fileHashes,gitInfo,sha256};
