package org.node.flyconsole;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/** Local-only WebView frontend; all connectome simulation runs on the worker. */
public final class NesLabActivity extends Activity {
    private static final String ORIGIN = "https://flyconsole.local";
    private static final int PICK_ROM = 10, EXPORT_CSV = 11, PICK_MODEL = 12, EXPORT_MODEL = 13, EXPORT_SESSION = 14, EXPORT_DIAGNOSTICS = 15;
    private boolean diagnosticExportPending,rendererGone;
    private final java.util.Map<Integer,Boolean> diagnosticControllers=new java.util.HashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScoreOcr scoreOcr=new ScoreOcr();
    private final AtomicBoolean cancel = new AtomicBoolean();
    private final AtomicLong pageEpoch=new AtomicLong(),controlEpoch=new AtomicLong();private final ThreadLocal<Long> taskPage=new ThreadLocal<>();private volatile boolean foreground;
    private WebView web;
    private volatile Graph graph;
    private Engine engine;
    private GpuLifEngine gpuEngine;
    private String backend = "cpu";
    private Experiment experiment;
    private FdbGrowth fdbGrowth;
    private JSONObject growthConfiguration;
    private FdbLearning fdbLearning;
    private JSONObject learningConfiguration;
    private volatile boolean destroyed;
    private volatile boolean pageReady;
    private String initialError;
    private volatile String labSystem="nes";
    private String activeFdbLayerId="";
    private final FdbLayerBinding fdbBinding=new FdbLayerBinding();
    private String graphKind = "FlyWire v783 / Shiu signed model";
    private String modelId=ConnectomeStore.FLYWIRE;
    private String romHash = "not-loaded";
    private final java.util.ArrayDeque<String> offeredRomHashes = new java.util.ArrayDeque<>();
    private final java.util.Map<String,JSONObject> offeredLibraryRoms=new java.util.HashMap<>();
    private String pendingLibrarySystem="",pendingLibraryHash="";
    private long lifecycleSequence;
    private String lifecycleTicket="";
    private String lifecycleFailure="";
    private final String historyRun=java.util.UUID.randomUUID().toString();
    private JSONObject activeEpisode;
    private long episodeKnown,episodeUnknown,episodeFrame,episodeInterventions;
    private double episodeRewardSum;
    private String curriculumOrigin="";
    private CurriculumStore curriculumStore;
    private FrozenSeries frozenSeries;
    private PairedEvaluation pairedEvaluation;
    private long sequence, configVersion;
    private boolean neuralConfigured;
    private volatile boolean platformPortsPending=true;
    private ControllerInput controllers;
    private boolean immersiveDisplay;
    private int latestMask;
    private BufferedWriter recorder;
    private File recording;
    private File modelExport;
    private String sessionExportId;
    private long recordedBytes;
    private boolean recordingOn;
    private volatile DualAgentContext[] dualAgents;
    private DualLayerStore.Binding[] dualBindings;
    private DualLayerStore dualStore;
    private volatile long dualEpoch=-1;
    private long dualSequence;
    private volatile DualRequestGuard dualGuard;
    private volatile String dualSession="";
    private String dualRom="",dualSystem="";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String requestedSystem=getIntent().getStringExtra("system");
        labSystem=RomImport.system(requestedSystem==null?getSharedPreferences("flyconsole-ui",MODE_PRIVATE).getString("system","nes"):requestedSystem);
        getSharedPreferences("flyconsole-ui",MODE_PRIVATE).edit().putString("system",labSystem).apply();
        web = new WebView(this);
        web.setBackgroundColor(android.graphics.Color.rgb(8,10,19));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "FlyBridge");
        web.setWebChromeClient(new android.webkit.WebChromeClient(){@Override public boolean onConsoleMessage(android.webkit.ConsoleMessage message){if(message.messageLevel()==android.webkit.ConsoleMessage.MessageLevel.ERROR||message.messageLevel()==android.webkit.ConsoleMessage.MessageLevel.WARNING)try{diagnostic(message.messageLevel()==android.webkit.ConsoleMessage.MessageLevel.ERROR?"error":"warn","web.console",new JSONObject().put("message",message.message()).put("source",message.sourceId()).put("line",message.lineNumber()));}catch(Exception ignored){}return false;}});
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String path = uri.getPath();
                if (!"https".equals(uri.getScheme()) || !"flyconsole.local".equals(uri.getHost()) ||
                    path == null || !path.startsWith("/lab/") || path.contains("..") || !"GET".equals(request.getMethod()))
                    return response("text/plain", new ByteArrayInputStream(new byte[0]));
                try {
                    String mime = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "application/javascript" :
                        path.endsWith(".json") ? "application/json" : path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".zip") ? "application/zip" : "text/html";
                    return response(mime, getAssets().open(path.substring(1)));
                } catch (IOException ex) { return response("text/plain", new ByteArrayInputStream(new byte[0])); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView view, String url) {
                diagnostic("info","web.page-ready",new JSONObject());
                if(url.startsWith(ORIGIN+"/lab/index.html"))view.evaluateJavascript("Boolean(window.guLogger && window.labPause && window.labReady)",value->{if(!destroyed&&!rendererGone&&!"true".equals(value)){diagnostic("error","web.initialization-failed",message("Основной JavaScript не запустился"));new android.app.AlertDialog.Builder(NesLabActivity.this).setTitle("Не удалось запустить игровой экран").setMessage("Сохраните диагностический отчёт для проверки ошибки.").setPositiveButton("Сохранить отчёт",(dialog,which)->exportDiagnostics()).setNegativeButton("Повторить запуск",(dialog,which)->recreate()).show();}});
                submit(() -> { pageReady = true; if(engine==null)loadGraph();else announce(); });
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,android.webkit.WebResourceError error){try{diagnostic("error","web.resource-error",new JSONObject().put("code",error.getErrorCode()).put("message",error.getDescription()).put("mainFrame",request.isForMainFrame()).put("path",request.getUrl().getPath()));}catch(Exception ignored){}}
            @Override public boolean onRenderProcessGone(WebView view,android.webkit.RenderProcessGoneDetail detail){rendererGone=true;cancel.set(true);try{diagnostic("fatal","web.renderer-gone",new JSONObject().put("didCrash",detail.didCrash()).put("priorityAtExit",detail.rendererPriorityAtExit()));}catch(Exception ignored){}if(DeviceLog.get()!=null)DeviceLog.get().webVisible(false);if(view.getParent() instanceof android.view.ViewGroup)((android.view.ViewGroup)view.getParent()).removeView(view);view.destroy();android.widget.LinearLayout fallback=new android.widget.LinearLayout(NesLabActivity.this);fallback.setOrientation(android.widget.LinearLayout.VERTICAL);android.widget.TextView text=new android.widget.TextView(NesLabActivity.this);text.setText("Игровой экран завершился с ошибкой. Последние подтверждённые сохранения остаются доступны. Сохраните диагностический отчёт перед повторным запуском.");fallback.addView(text);android.widget.Button export=new android.widget.Button(NesLabActivity.this);export.setText("Сохранить диагностический отчёт");export.setOnClickListener(v->exportDiagnostics());fallback.addView(export);android.widget.Button reopen=new android.widget.Button(NesLabActivity.this);reopen.setText("Открыть приложение заново");reopen.setOnClickListener(v->recreate());fallback.addView(reopen);setContentView(fallback);submit(()->{try{checkpointNativeCurrent();}catch(Exception failure){diagnostic("error","renderer.checkpoint-failed",message(failure.getMessage()));}});return true;}
        });
        controllers=new ControllerInput(this,data->{int id=data.optInt("id");boolean online=data.optBoolean("connected");Boolean previous=diagnosticControllers.put(id,online);if(previous==null||previous!=online)try{diagnostic("info","input.controller-connection",new JSONObject().put("id",id).put("connected",online).put("name",data.optString("name")));}catch(Exception ignored){}if(diagnosticControllers.size()>64)diagnosticControllers.clear();emit("labController",data);});controllers.system(labSystem);
        UiInsets.attachWeb(this,web);recording=new File(getFilesDir(),labSystem+"-experiment.csv");
        submit(this::loadGraph);
        web.loadUrl(ORIGIN + "/lab/index.html?system="+labSystem);
    }

    private void submit(Runnable task){if(destroyed)return;final long epoch=pageEpoch.get();try{worker.execute(()->{if(destroyed||epoch!=pageEpoch.get())return;taskPage.set(epoch);try{task.run();}finally{taskPage.remove();}});}catch(java.util.concurrent.RejectedExecutionException ignored){}}

    private WebResourceResponse response(String mime, InputStream stream) {
        WebResourceResponse response = new WebResourceResponse(mime, "UTF-8", stream);
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
        headers.put("X-Content-Type-Options", "nosniff");
        response.setResponseHeaders(headers);
        return response;
    }

    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);switchSystem(RomImport.system(intent.getStringExtra("system")));}
    private String pendingSystem=null;
    private void switchSystem(String system){
        if(system.equals(labSystem)||pendingSystem!=null)return;
        pendingSystem=system;
        // evaluateJavascript's callback does not await JS promises. The bridge acknowledgement does.
        web.evaluateJavascript("if(window.labPrepareSystemSwitch)window.labPrepareSystemSwitch("+JSONObject.quote(system)+");else if(window.FlyBridge)FlyBridge.finishSystemSwitch("+JSONObject.quote(system)+",false)",null);
    }
    private void finishSystemSwitch(String system,boolean okay){
        if(!system.equals(pendingSystem))return;
        if(!okay){pendingSystem=null;pendingLibrarySystem="";pendingLibraryHash="";return;}
        cancel.set(true);controlEpoch.incrementAndGet();
        worker.execute(()->{try{
            stopRecording();pauseDualNative();clearDualNative();invalidateFdbBinding();offeredRomHashes.clear();offeredLibraryRoms.clear();
            runOnUiThread(()->{if(destroyed)return;pageEpoch.incrementAndGet();if(controllers!=null)controllers.system(system);labSystem=system;getSharedPreferences("flyconsole-ui",MODE_PRIVATE).edit().putString("system",system).apply();pendingSystem=null;platformPortsPending=true;pageReady=false;romHash="not-loaded";invalidateFdbBinding();recording=new File(getFilesDir(),labSystem+"-experiment.csv");web.loadUrl(ORIGIN+"/lab/index.html?system="+labSystem);});
        }catch(Exception ex){runOnUiThread(()->pendingSystem=null);error("Платформа не переключена: "+ex.getMessage());}});
    }
    private long graphBudget(){return Math.max(0,Runtime.getRuntime().maxMemory()-Runtime.getRuntime().totalMemory()+Runtime.getRuntime().freeMemory())*2/3;}
    private void installGraph(Graph loaded,Engine nextEngine,Experiment next,String id){
        invalidateFdbBinding();
        closeGpu();graph=loaded;engine=nextEngine;experiment=next;modelId=id;graphKind=ConnectomeStore.title(id);backend="cpu";neuralConfigured=false;fdbGrowth=null;fdbLearning=null;growthConfiguration=null;learningConfiguration=null;invalidateFdbBinding();latestMask=0;platformPortsPending=true;initialError=null;
    }
    private void loadGraph(){try{String id=ConnectomeStore.selected(this);Graph loaded=ConnectomeStore.load(this,id,graphBudget());Experiment next=ConnectomeStore.ports(this,loaded,RomImport.wide(labSystem)&&loaded.ids.length>=28?12:8,id);Engine nextEngine=new Engine(loaded);installGraph(loaded,nextEngine,next,id);announce();}catch(Exception|OutOfMemoryError ex){error("Коннектом не загрузился: "+ex.getMessage()+". Предыдущая модель и ручная игра сохранены.");}}

    private void announce() {
        if (!pageReady) return;
        if (engine == null) { if (initialError != null) error(initialError); return; }
        try {
            JSONObject info = new JSONObject();
            info.put("hasImportedGraph",ConnectomeStore.hasImported(this)).put("system",labSystem).put("modelId",modelId).put("neurons", graph.ids.length).put("edges", graph.targets.length).put("kind", graphKind);
            try{info.put("modelManifest",ConnectomeStore.manifest(this,modelId));}catch(Exception ex){info.put("modelManifest",new JSONObject().put("model_id",modelId).put("name",graphKind));}
            Experiment ports=platformPortsPending?ConnectomeStore.ports(this,graph,RomImport.wide(labSystem)&&graph.ids.length>=28?12:8,modelId):experiment;
            info.put("inputs", ids(ports.inputs)).put("outputs", ids(ports.outputs));platformPortsPending=false;
            info.put("diagnostics",LabDiagnostics.describe(this,graph)).put("graph_sha256",graph.fingerprint()).put("notice",GraphCache.notice);
            info.put("heapMiB", Runtime.getRuntime().maxMemory() / 1048576).put("backend", backend).put("gpuAvailable", Build.VERSION.SDK_INT >= 21);
            emit("labReady", info);
        } catch (Exception ex) { error(ex.getMessage()); }
    }

    private JSONArray ids(int[] indices) {
        JSONArray array = new JSONArray();
        for (int index : indices) array.put(Long.toString(graph.ids[index]));
        return array;
    }

    private void emit(String method, JSONObject value) {
        if(value.has("error")||value.has("saveError")||method.matches("labReady|labConfigured|labLoadRom|labError|labLayerSets|labEpisodeHistory|labEvaluationSeries|labCurriculum|labDualReady|labDualExited|labDualBoundary|labLifecycleNotice"))try{
            if(DeviceLog.get()!=null)DeviceLog.get().context(new JSONObject().put("system",labSystem).put("romHash",romHash).put("graphSha256",graph==null?JSONObject.NULL:graph.fingerprint()).put("modelId",modelId).put("backend",backend).put("configVersion",configVersion).put("pageEpoch",pageEpoch.get()).put("layerId",activeFdbLayerId));
            diagnostic(value.has("error")||value.has("saveError")||method.equals("labError")?"error":"info","bridge."+method,DiagnosticSummary.of(value));
        }catch(Exception ignored){}
        if (destroyed) return;
        final long epoch=taskPage.get()==null?pageEpoch.get():taskPage.get();
        String script = "if(window." + method + ")window." + method + "(" + value + ");";
        runOnUiThread(() -> { if (!destroyed&&!rendererGone&&epoch==pageEpoch.get()) web.evaluateJavascript(script, null); });
    }
    private static JSONObject message(String text){JSONObject value=new JSONObject();try{value.put("message",text);}catch(Exception ignored){}return value;}
    private void diagnostic(String level,String event,JSONObject data){if(DeviceLog.get()!=null)DeviceLog.get().event(level,"console",event,data);}
    private void exportDiagnostics(){
        if(diagnosticExportPending)return;
        if(DeviceLog.get()==null){Toast.makeText(this,"Диагностический журнал недоступен",Toast.LENGTH_LONG).show();return;}
        diagnosticExportPending=true;
        DeviceLog.get().export((file,error)->{
            if(file!=null&&error.isEmpty()&&!destroyed){boolean stored=getSharedPreferences("diagnostics",MODE_PRIVATE).edit().putString("pendingExport",file.getName()).commit();if(!stored)error="Не удалось сохранить очередь экспорта";}
            final String failure=error;
            runOnUiThread(()->{
                if(destroyed){if(file!=null)file.delete();return;}
                if(!failure.isEmpty()||file==null){diagnosticExportPending=false;if(file!=null)file.delete();diagnostic("error","diagnostics.export-failed",message(failure));Toast.makeText(this,"Отчёт не сохранён: "+failure,Toast.LENGTH_LONG).show();emit("labDiagnosticsSaved",message(failure));return;}
                try{Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/zip").addCategory(Intent.CATEGORY_OPENABLE);intent.putExtra(Intent.EXTRA_TITLE,"gu-diagnostics-"+System.currentTimeMillis()+".zip");startActivityForResult(intent,EXPORT_DIAGNOSTICS);}
                catch(Exception error2){diagnosticExportPending=false;file.delete();getSharedPreferences("diagnostics",MODE_PRIVATE).edit().remove("pendingExport").apply();String problem=error2.getMessage()==null?error2.getClass().getSimpleName():error2.getMessage();diagnostic("error","diagnostics.export-failed",message(problem));Toast.makeText(this,problem,Toast.LENGTH_LONG).show();emit("labDiagnosticsSaved",message(problem));}
            });
        });
    }

    private void error(String message) {
        if (!pageReady) initialError = message;
        try { emit("labError", new JSONObject().put("message", message == null ? "Ошибка" : message)); }
        catch (Exception ignored) { /* JSON string insertion cannot fail for a finite string. */ }
    }

    private int[] parsePorts(JSONArray values, int length) throws Exception {
        if (values.length() != length) throw new IllegalArgumentException("Неверное число портов");
        int[] indices = new int[length];
        for (int i = 0; i < length; i++) {
            indices[i] = engine.index(Long.parseLong(values.getString(i)));
            for (int j = 0; j < i; j++) if (indices[j] == indices[i]) throw new IllegalArgumentException("Повторяющийся порт");
        }
        return indices;
    }

    private void configure(JSONObject data) throws Exception {
        if(pairedEvaluation!=null){pairedEvaluation.invalidate("Попытка перенастройки внутри парной проверки");throw new IOException("Сначала остановите парную проверку");}
        if(frozenSeries!=null){frozenSeries.invalidate("Попытка перенастройки внутри frozen series");throw new IOException("Сначала остановите контрольную серию");}
        final long configureStarted=System.nanoTime();
        if(dualAgents!=null){pauseDualNative();clearDualNative();}
        if(data.has("reset")&&!(data.get("reset") instanceof Boolean))throw new IllegalArgumentException("Reset must be boolean");
        boolean initial=!neuralConfigured;
        boolean reset=initial||data.optBoolean("reset",true);
        if (engine == null) throw new IllegalStateException("Коннектом ещё не готов");
        String requestedBackend=data.optString("backend","cpu");
        if (!requestedBackend.equals("cpu")&&!requestedBackend.equals("gpu")) throw new IllegalArgumentException("Неизвестный backend");
        if(!reset&&!requestedBackend.equals(backend))throw new IllegalArgumentException("Смена CPU/GPU требует явного сброса сети; ROM сохранён");
        if (requestedBackend.equals("gpu") && Build.VERSION.SDK_INT < 21) throw new IllegalArgumentException("GPU backend требует Android 5.0+");
        Experiment next = new Experiment(parsePorts(data.getJSONArray("inputs"), 16), parsePorts(data.getJSONArray("outputs"), RomImport.wide(labSystem)&&data.getJSONArray("outputs").length()==12?12:8));
        for (int input : next.inputs) for (int output : next.outputs)
            if (input == output) throw new IllegalArgumentException("Вход и выход не должны совпадать");
        next.mode = data.getString("mode");
        if (!next.mode.equals("observe") && !next.mode.equals("closed") && !next.mode.equals("sham"))
            throw new IllegalArgumentException("Неизвестный режим");
        next.maxHz = data.getDouble("maxHz"); next.thresholdHz = data.getDouble("thresholdHz");
        next.windowMs = data.getInt("windowMs"); if(data.getDouble("windowMs")!=next.windowMs) throw new IllegalArgumentException("Окно должно быть целым");
        next.options.gain = data.getDouble("gain");
        if (!Double.isFinite(next.maxHz) || next.maxHz < 0 || next.maxHz > 500 ||
            !Double.isFinite(next.thresholdHz) || next.thresholdHz < 1 || next.thresholdHz > 500 ||
            !Double.isFinite(next.options.gain) || next.options.gain < 0 || next.options.gain > 2 ||
            next.windowMs < 1 || next.windowMs > 100) throw new IllegalArgumentException("Параметры вне допустимых границ");
        next.options.disableInhibition = data.getBoolean("disableInhibition");
        next.scramble = data.getBoolean("scramble");
        next.agentButtonMask=systemButtonMask(data.optString("systemButtons","auto"));
        long seed=data.getLong("seed"); if(data.getDouble("seed")!=seed||seed<0||seed>2147483647L) throw new IllegalArgumentException("Seed 0–2147483647");
        if(!reset&&experiment.seed!=seed)throw new IllegalArgumentException("Изменение seed требует явного сброса сети");
        next.seedPermutation(seed);
        JSONArray lesions=data.getJSONArray("lesions"); if(lesions.length()>256) throw new IllegalArgumentException("Не более 256 абляций");
        next.options.lesions=parsePorts(lesions,lesions.length());

        FdbGrowth nextGrowth=null;JSONObject nextGrowthConfig=null;
        FdbLearning nextLearning=null;JSONObject nextLearningConfig=null;
        JSONObject fdb=data.optJSONObject("fdb");
        if(data.has("fdb")&&!data.isNull("fdb")&&fdb==null)throw new IllegalArgumentException("FDB must be JSON object");
        if(fdb!=null) {
            if(fdb.has("version")&&(!(fdb.get("version") instanceof Number)||fdb.getDouble("version")!=fdb.getInt("version")||(fdb.getInt("version")<1||fdb.getInt("version")>3)))throw new IllegalArgumentException("FDB format version");
            if(!graph.fingerprint().equals(fdb.getString("graph_sha256")))throw new IllegalArgumentException("FDB belongs to another connectome");
            GraphDelta layer=new GraphDelta(graph.ids.length);
            FdbCheckpoint.restoreLinks(layer,fdb,graph);
            FdbCheckpoint.restoreThresholds(layer,fdb,graph);
            JSONObject growth=fdb.optJSONObject("growth");
            if(fdb.has("growth")&&growth==null)throw new IllegalArgumentException("FDB growth must be object");
            if(growth!=null) {
                if(!(growth.get("enabled") instanceof Boolean))throw new IllegalArgumentException("FDB enabled must be boolean");
                nextGrowthConfig=new JSONObject(growth.toString());
                if(growth.getBoolean("enabled")) {
                    for(String field:new String[]{"interval","perWindow","maxEdges"})if(!(growth.get(field) instanceof Number)||growth.getDouble(field)!=growth.getInt(field))throw new IllegalArgumentException("FDB growth requires integers");
                    for(String field:new String[]{"explore","rewardGate"})if(!(growth.get(field) instanceof Boolean))throw new IllegalArgumentException("FDB growth requires booleans");
                    nextGrowth=new FdbGrowth(graph,layer,next.inputs,next.outputs,growth.getInt("interval"),growth.getInt("perWindow"),growth.getInt("maxEdges"),(float)growth.getDouble("initialWeight"),growth.getBoolean("explore"),growth.getBoolean("rewardGate"),next.seed);
                    JSONObject checkpoint=fdb.optJSONObject("growthState");
                    if(checkpoint!=null){
                        if(checkpoint.getInt("version")!=1||!ids(next.inputs).toString().equals(checkpoint.getJSONArray("sources").toString())||!ids(next.outputs).toString().equals(checkpoint.getJSONArray("targets").toString()))throw new IllegalArgumentException("FDB checkpoint belongs to other ports");
                        JSONArray prior=checkpoint.optJSONArray("previous");int[] counts=prior==null?null:new int[prior.length()];
                        if(prior!=null)for(int i=0;i<counts.length;i++){if(!(prior.get(i) instanceof Number)||prior.getDouble(i)!=prior.getInt(i))throw new IllegalArgumentException("FDB counts must be integers");counts[i]=prior.getInt(i);}
                        for(String k:new String[]{"windows","rng"})if(!(checkpoint.get(k) instanceof Number)||checkpoint.getDouble(k)!=checkpoint.getLong(k))throw new IllegalArgumentException("FDB checkpoint counters must be integers");
                        nextGrowth.restore(checkpoint.getLong("windows"),checkpoint.getLong("rng"),counts);
                    }
                    if(data.optBoolean("reset",true))nextGrowth.reset(next.seed);
                }
            }
            JSONObject learning=fdb.optJSONObject("learning");
            if(fdb.has("learning")&&learning==null)throw new IllegalArgumentException("FDB learning must be object");
            if(learning!=null){
                if(!(learning.get("enabled") instanceof Boolean))throw new IllegalArgumentException("FDB learning enabled must be boolean");
                nextLearningConfig=new JSONObject(learning.toString());
                if(learning.getBoolean("enabled")||learning.has("rate")){
                    if(!(learning.get("maxEdges") instanceof Number)||learning.getDouble("maxEdges")!=learning.getInt("maxEdges"))throw new IllegalArgumentException("FDB learning edge cap");
                    if(learning.has("trainBase")&&!(learning.get("trainBase") instanceof Boolean))throw new IllegalArgumentException("FDB trainBase must be boolean");
                    nextLearningConfig.put("trainBase",learning.optBoolean("trainBase",true)).put("plasticityMode",FdbLearning.validateMode(learning.optString("plasticityMode","base")));
                    nextLearning=new FdbLearning(graph,layer,next.inputs,next.outputs,learning.getDouble("rate"),learning.getInt("maxEdges"),(float)learning.getDouble("maxWeight"),learning.optBoolean("trainBase",true),nextLearningConfig.getString("plasticityMode"));
                    nextLearning.creditProfile(learning.optString("creditProfile","single-v1"));
                    nextLearning.seed(next.seed);
                    JSONObject state=fdb.optJSONObject("learningState");
                    if(state!=null){
                        FdbCheckpoint.restore(nextLearning,state,graph,next.inputs,next.outputs);
                    }
                    nextLearning.boundary(); // A model file does not restore the live game/engine phase.
                }
            }
            if(nextLearning==null){
                nextLearningConfig=new JSONObject().put("enabled",false).put("rate",.05).put("maxEdges",256).put("maxWeight",32);
                nextLearning=new FdbLearning(graph,layer,next.inputs,next.outputs,.05,256,32);nextLearning.seed(next.seed);
            }
            next.options.delta=layer;
        }

        if(!reset&&!data.optBoolean("restoreGrowthState",false)&&fdb!=null&&experiment.options.delta!=null&&java.util.Arrays.equals(next.inputs,experiment.inputs)&&java.util.Arrays.equals(next.outputs,experiment.outputs)){
            JSONObject current=fdbState();
            JSONArray ds=fdb.optJSONArray("deltas"),es=fdb.optJSONArray("edges");
            if(current.getJSONArray("deltas").toString().equals(ds==null?"[]":ds.toString())&&current.getJSONArray("edges").toString().equals(es==null?"[]":es.toString())
                &&current.getJSONObject("neuronDynamics").getJSONArray("thresholdOffsets").toString().equals(fdb.optJSONObject("neuronDynamics")==null?"[]":fdb.getJSONObject("neuronDynamics").getJSONArray("thresholdOffsets").toString())
                &&String.valueOf(nextGrowthConfig).equals(String.valueOf(growthConfiguration))&&String.valueOf(nextLearningConfig).equals(String.valueOf(learningConfiguration))){next.options.delta=experiment.options.delta;nextGrowth=fdbGrowth;nextGrowthConfig=growthConfiguration;nextLearning=fdbLearning;nextLearningConfig=learningConfiguration;}
        }
        if (requestedBackend.equals("gpu")) {
            if (gpuEngine == null) gpuEngine = new GpuLifEngine(graph);
            if(reset)gpuEngine.reset(next.seed);
        } else {
            closeGpu();
            if(reset)engine.reset(next.seed);
        }
        backend=requestedBackend;
        invalidateFdbBinding();experiment=next;fdbGrowth=nextGrowth;growthConfiguration=nextGrowthConfig;fdbLearning=nextLearning;learningConfiguration=nextLearningConfig; configVersion++; if(reset)sequence=0; latestMask=0;neuralConfigured=true;
        if(recordingOn) recorder.write("# config,"+data.put("configVersion",configVersion).put("backend",backend).toString().replace('\n',' ')+"\n");
        emit("labConfigured",new JSONObject().put("configureMs",(System.nanoTime()-configureStarted)/1e6).put("configureQueueMs",data.optDouble("configureQueueMs",0)).put("reset",reset).put("initial",initial).put("configVersion",configVersion).put("mode",next.mode).put("backend",backend).put("generation",data.optLong("generation",-1)));
    }

    private int systemButtonMask(String mode){
        if(mode.equals("auto"))return RomImport.wide(labSystem)?4095:255;
        if(mode.equals("blocked"))return RomImport.wide(labSystem)?2039:243;
        throw new IllegalArgumentException("Неизвестный режим Start/Select");
    }

    private static long dualRequestEpoch(JSONObject request)throws Exception {return DualAgentContext.integer(request,"epoch",0,9007199254740991L);}
    private JSONObject dualEnvelope(JSONObject request)throws Exception {
        Object token=request.get("token");DualRequestGuard.serial(token);
        long epoch=dualRequestEpoch(request);return new JSONObject().put("epoch",epoch).put("generation",request.optLong("generation",epoch)).put("token",token);
    }
    private void requireDual(JSONObject request)throws Exception {
        if(dualAgents==null||dualRequestEpoch(request)!=dualEpoch||!(request.get("sessionId") instanceof String)||!dualSession.equals(request.getString("sessionId")))throw new IllegalStateException("Stale dual session");
        if(!dualRom.equals(romHash)||!dualSystem.equals(labSystem))throw new IllegalStateException("Dual ROM/platform changed");
    }
    private boolean matchesDualRequest(String raw){try{JSONObject request=new JSONObject(raw);DualRequestGuard guard=dualGuard;return dualAgents!=null&&guard!=null&&dualRequestEpoch(request)==dualEpoch&&request.get("sessionId") instanceof String&&dualSession.equals(request.getString("sessionId"))&&guard.fresh(request.get("token"));}catch(Exception ex){return false;}}
    private boolean freshDualConfiguration(String raw){try{JSONObject request=new JSONObject(raw);DualRequestGuard.serial(request.get("token"));DualRequestGuard guard=dualGuard;return dualAgents==null||dualRequestEpoch(request)>dualEpoch&&guard!=null&&guard.fresh(request.get("token"));}catch(Exception ex){return false;}}
    private static JSONObject[] dualDescriptors(JSONArray values)throws Exception {
        if(values.length()!=2)throw new IllegalArgumentException("Exactly two agents required");JSONObject[] result=new JSONObject[2];for(int i=0;i<2;i++){JSONObject value=values.getJSONObject(i);String id=value.getString("id");int slot="p1".equals(id)?0:"p2".equals(id)?1:-1;if(slot<0||result[slot]!=null)throw new IllegalArgumentException("Unique P1/P2 required");result[slot]=value;}return result;
    }
    private static long graphArrayBytes(Graph graph){return 12L*graph.ids.length+8L*graph.targets.length+4;}
    private long dualEstimatedBytes(){if(dualAgents==null)return 0;long bytes=0;java.util.HashSet<Graph> seen=new java.util.HashSet<>();for(DualAgentContext agent:dualAgents){if(seen.add(agent.graph))bytes+=graphArrayBytes(agent.graph);bytes+=108L*agent.graph.ids.length+agent.layer.memoryBytes()+agent.learning.memoryBytes();}return bytes;}
    private static long heapAvailable(){Runtime runtime=Runtime.getRuntime();return Math.max(0,runtime.maxMemory()-runtime.totalMemory()+runtime.freeMemory());}
    private void configureDual(JSONObject request)throws Exception {
        JSONObject response=dualEnvelope(request);if("gb".equals(labSystem))throw new IllegalArgumentException("GB has one controller; two neural ports require NES, Sega or SNES");
        if(dualAgents!=null&&(dualRequestEpoch(request)<=dualEpoch||!dualGuard.fresh(request.get("token"))))throw new IllegalArgumentException("Stale dual configuration epoch/token");
        if(!labSystem.equals(request.getString("system"))||!romHash.matches("[a-f0-9]{64}")||!romHash.equals(request.getString("romHash")))throw new IllegalArgumentException("Dual configuration ROM/platform mismatch");
        JSONObject[] descriptors=dualDescriptors(request.getJSONArray("agents"));if(request.has("team")&&!(request.get("team") instanceof Boolean))throw new IllegalArgumentException("Team reward must be boolean");boolean team=request.optBoolean("team",false);
        String[] models=new String[2];JSONObject[] manifests=new JSONObject[2];java.util.HashMap<String,Graph> candidates=new java.util.HashMap<>();java.util.HashSet<String> missing=new java.util.HashSet<>();long extra=0;
        for(int i=0;i<2;i++){
            JSONObject descriptor=descriptors[i];models[i]=descriptor.getString("modelId");if(!ConnectomeStore.valid(models[i]))throw new IllegalArgumentException("Unknown connectome model");String mode=descriptor.getString("mode");if(!("train".equals(mode)||"eval".equals(mode)))throw new IllegalArgumentException("Agent mode");DualAgentContext.number(descriptor,"epsilon",0,1);if(descriptor.has("resume")&&!(descriptor.get("resume") instanceof Boolean))throw new IllegalArgumentException("Resume must be boolean");descriptor.getJSONObject("config");descriptor.put("teamReward",team);
            manifests[i]=ConnectomeStore.manifest(this,models[i]);String expected=manifests[i].optString("graph_sha256","");Graph candidate=GraphCache.findNamed(models[i],expected);if(candidate!=null)candidates.put(models[i],candidate);
            long n=candidate==null?DualAgentContext.integer(manifests[i],"neurons",24,500000):candidate.ids.length;extra+=108L*n;
            if(candidate==null&&missing.add(models[i]))extra+=12L*n+8L*DualAgentContext.integer(manifests[i],"edges",0,100000000)+4;
        }
        long available=heapAvailable(),reserve=64L*1024*1024;if(extra+reserve>available)throw new IOException("Two CPU models require additional "+(extra/1048576)+" MiB plus 64 MiB reserve; available "+(available/1048576)+" MiB");
        for(String model:missing){Graph loaded=ConnectomeStore.candidate(this,model,graphBudget());candidates.put(model,loaded);}
        DualLayerStore store=new DualLayerStore(getFilesDir());DualAgentContext[] next=new DualAgentContext[2];DualLayerStore.Binding[] bindings=new DualLayerStore.Binding[2];
        for(int i=0;i<2;i++){Graph candidate=candidates.get(models[i]);Experiment defaults=ConnectomeStore.ports(this,candidate,RomImport.wide(labSystem)&&candidate.ids.length>=28?12:8,models[i]);bindings[i]=store.prepare(labSystem,romHash,candidate.fingerprint(),"p"+(i+1),models[i],descriptors[i].optBoolean("resume",true));next[i]=DualAgentContext.create("p"+(i+1),models[i],candidate,defaults,descriptors[i],bindings[i].checkpoint,bindings[i].id);}
        // Checkpoints and the pair binding must commit before the live pair is replaced.
        store.commitPair(bindings,next,labSystem,romHash);if(dualAgents!=null)for(DualAgentContext old:dualAgents)old.boundary();
        dualAgents=next;dualBindings=bindings;dualStore=store;dualEpoch=dualRequestEpoch(request);dualSession=java.util.UUID.randomUUID().toString().replace("-","");dualRom=romHash;dualSystem=labSystem;dualSequence=0;dualGuard=new DualRequestGuard(request.get("token"));
        for(int i=0;i<2;i++)GraphCache.rememberNamed(models[i],next[i].graph);closeGpu();backend="cpu";neuralConfigured=false;latestMask=0;if(fdbLearning!=null)fdbLearning.boundary();
        JSONArray agents=new JSONArray();for(DualAgentContext agent:next)agents.put(agent.metadata().put("saved",true));response.put("ok",true).put("sessionId",dualSession).put("agents",agents).put("estimatedBytes",dualEstimatedBytes()).put("heapAvailableBytes",heapAvailable()).put("backend","cpu").put("paused",true).put("singleResetRequired",true);emit("labDualReady",response);
    }
    private void saveDual(JSONObject[] results)throws Exception {
        for(int i=0;i<2;i++)try{dualStore.save(dualAgents[i],dualSystem,dualRom,dualBindings[i].createdAt);results[i].put("saved",true);}catch(Exception ex){results[i].put("saved",false).put("saveError",ex.getMessage()==null?"Checkpoint save failed":ex.getMessage());}
    }
    private void sampleDual(JSONObject request)throws Exception {
        long started=System.nanoTime();JSONObject response=dualEnvelope(request);requireDual(request);if(cancel.get())throw new IllegalStateException("Dual session paused");
        JSONObject[] descriptors=dualDescriptors(request.getJSONArray("agents"));for(int i=0;i<2;i++)dualAgents[i].validateRequest(descriptors[i]);
        JSONArray values=request.getJSONArray("retina");if(values.length()!=16)throw new IllegalArgumentException("16 retinal observations required");double[] retina=new double[16];for(int i=0;i<16;i++){Object value=values.get(i);if(!(value instanceof Number))throw new IllegalArgumentException("Retina number required");retina[i]=((Number)value).doubleValue();if(!Double.isFinite(retina[i])||retina[i]<0||retina[i]>1)throw new IllegalArgumentException("Retina range");}
        long frame=DualAgentContext.integer(request,"frame",0,9007199254740991L);dualGuard.sample(request.get("token"),frame);dualSequence++;JSONObject[] results=new JSONObject[2];
        try{for(int i=0;i<2;i++)results[i]=dualAgents[i].sample(descriptors[i],retina,dualSession+":"+dualAgents[i].id+":"+dualSequence,cancel);}
        catch(Exception|OutOfMemoryError ex){cancel.set(true);for(int i=0;i<2;i++){dualAgents[i].boundary();results[i]=dualAgents[i].metadata();}saveDual(results);throw ex;}
        saveDual(results);JSONArray agents=new JSONArray();double wall=0;boolean failed=false;for(JSONObject result:results){agents.put(result);wall+=result.optDouble("wallMs",0);failed|=result.has("saveError");}if(failed)cancel.set(true);
        response.put("ok",true).put("sessionId",dualSession).put("frame",frame).put("agents",agents).put("wallMs",wall).put("pipelineWallMs",(System.nanoTime()-started)/1e6).put("estimatedBytes",dualEstimatedBytes()).put("backend","cpu");emit("labDualResult",response);
    }
    private void boundaryDual(JSONObject request)throws Exception {
        JSONObject response=dualEnvelope(request);requireDual(request);dualGuard.boundary(request.get("token"));JSONObject[] results=new JSONObject[2];for(int i=0;i<2;i++){dualAgents[i].boundary();results[i]=dualAgents[i].metadata();}saveDual(results);response.put("sessionId",dualSession).put("ok",true).put("paused",true).put("agents",new JSONArray(results));emit("labDualBoundary",response);
    }
    private void pauseDualNative()throws Exception {if(dualAgents==null)return;JSONObject[] results=new JSONObject[2];for(int i=0;i<2;i++){dualAgents[i].boundary();results[i]=dualAgents[i].metadata();}saveDual(results);for(JSONObject result:results)if(result.has("saveError"))throw new IOException(result.getString("saveError"));}
    private void clearDualNative(){dualAgents=null;dualBindings=null;dualStore=null;dualGuard=null;dualEpoch=-1;dualSequence=0;dualSession="";dualRom="";dualSystem="";}
    private void exitDual(JSONObject request)throws Exception {JSONObject response=dualEnvelope(request);requireDual(request);dualGuard.boundary(request.get("token"));pauseDualNative();response.put("sessionId",dualSession).put("ok",true).put("paused",true);clearDualNative();emit("labDualExited",response);}
    private void emitDualFailure(String method,String raw,Throwable ex){try{JSONObject response=dualEnvelope(new JSONObject(raw)).put("ok",false).put("error",ex.getMessage()==null?"Dual operation failed":ex.getMessage());if(!dualSession.isEmpty())response.put("sessionId",dualSession);emit(method,response);}catch(Exception ignored){error("Dual request failed: "+ex.getMessage());}}

    private void sample(JSONObject request) throws Exception {
        long sampleStarted=System.nanoTime();
        if (engine == null) throw new IllegalStateException("Коннектом недоступен");
        if(curriculumOrigin.isEmpty()||!curriculumOrigin.equals(request.optString("originId")))throw new IOException("Происхождение игрового отрезка не подтверждено");
        if(pairedEvaluation!=null){
            JSONObject result=pairedEvaluation.sample(request,fdbState(),configVersion,cancel).put("sequence",++sequence).put("sampleTotalMs",(System.nanoTime()-sampleStarted)/1e6).put("workerQueueMs",request.optDouble("workerQueueMs",0));emit("labResult",result);return;
        }
        if(frozenSeries!=null)frozenSeries.before(request,fdbState(),configVersion);
        JSONArray pixels=request.getJSONArray("retina"); if(pixels.length()!=16) throw new IllegalArgumentException("Нужно 16 ячеек экрана");
        String requestedMode=request.optString("learningMode","off");
        String frozenBefore=requestedMode.startsWith("benchmark")?CheckpointDigest.of(fdbState()):null;
        if("exo".equals(request.optString("controllerSource"))&&requestedMode.matches("train|eval|teach|benchmark-[a-z]+"))ensureEpisode(request,requestedMode);
        double[] brightness=new double[16]; for(int i=0;i<16;i++) brightness[i]=pixels.getDouble(i);
        double[] rates=experiment.rates(brightness);
        Engine.Result result;
        if ("gpu".equals(backend)) {
            if (gpuEngine == null) throw new IllegalStateException("GPU backend не инициализирован");
            result=gpuEngine.advance(experiment.inputs,rates,experiment.windowMs,experiment.options,cancel);
        } else result=engine.advance(experiment.inputs,rates,experiment.windowMs,experiment.options,cancel);
        int mask=experiment.buttons(result); latestMask=cancel.get()?0:mask;
        JSONObject response=new JSONObject();
        response.put("token",request.getLong("token")).put("generation",request.getLong("generation"));
        response.put("buttons",latestMask).put("backend",backend).put("backendNote","gpu".equals(backend)?"OpenGL ES 3.1 compute, float32 weights, q24.8 delayed events":"Java CPU reference");
        response.put("spikes",result.spikes).put("active",result.active).put("simMs",result.endTick*.1).put("wallMs",result.wallSeconds*1000);
        response.put("steps",result.steps).put("configVersion",configVersion);
        // Contiguous graph-index groups, not anatomical regions; same counts on CPU and GPU.
        long[] groupSpikes=new long[16]; int[] groupActive=new int[16],groupSize=new int[16];
        for(int i=0;i<result.counts.length;i++){
            int group=(int)((long)i*16/result.counts.length);
            groupSize[group]++;groupSpikes[group]+=result.counts[i];if(result.counts[i]>0)groupActive[group]++;
        }
        JSONArray groups=new JSONArray();
        for(int i=0;i<16;i++)groups.put(new JSONObject().put("spikes",groupSpikes[i]).put("active",groupActive[i]).put("neurons",groupSize[i])
            .put("hz",result.steps==0||groupSize[i]==0?0:groupSpikes[i]*10000.0/result.steps/groupSize[i]));
        response.put("neuralGroups",groups);
        JSONArray output=new JSONArray(); for(int index:experiment.outputs) output.put(result.steps==0?0:result.counts[index]*10000.0/result.steps);
        long oldRevision=experiment.options.delta==null?-1:experiment.options.delta.version();
        String learningMode=request.optString("learningMode","off");
        boolean frozen=request.optBoolean("frozen",false)||learningMode.equals("eval")||learningMode.startsWith("benchmark");
        // Unsupervised exploration stays in Lab. Automode birth is outcome-conditioned below.
        boolean grow=fdbGrowth!=null&&!cancel.get()&&!frozen&&learningMode.equals("off");int grown=0;
        int adapted=0;boolean humanLearningApplied=false;
        JSONArray experience=request.optJSONArray("experience");
        if(experience!=null&&experience.length()>16)throw new IllegalArgumentException("FDB batch limit");
        // Validate the entire bounded batch before changing any edge.
        if(experience!=null)for(int k=0;k<experience.length();k++){
            JSONObject e=experience.getJSONObject(k);JSONArray retina=e.getJSONArray("retina");
            if(retina.length()!=16||!(e.get("mask") instanceof Number)||e.getDouble("mask")!=e.getInt("mask")||e.getInt("mask")<0||e.getInt("mask")>systemButtonMask("auto")||(e.getInt("mask")&48)==48||(e.getInt("mask")&192)==192||!Double.isFinite(e.getDouble("reward"))||Math.abs(e.getDouble("reward"))>20||!(e.get("human") instanceof Boolean))throw new IllegalArgumentException("FDB labelled experience");
            for(int j=0;j<16;j++)if(!Double.isFinite(retina.getDouble(j))||retina.getDouble(j)<0||retina.getDouble(j)>1)throw new IllegalArgumentException("FDB retina");
        }
        if(grow){requireFdbMutation(request);grown=fdbGrowth.observe(result,0,experiment.options.lesions,false);}
        if(fdbLearning!=null&&learningConfiguration.getBoolean("enabled")&&experience!=null&&!cancel.get()&&!frozen&&(learningMode.equals("teach")||learningMode.equals("train")))for(int k=0;k<experience.length();k++){
            JSONObject e=experience.getJSONObject(k);double[] input=new double[16];for(int j=0;j<16;j++)input[j]=e.getJSONArray("retina").getDouble(j);
            if((e.getInt("mask")&~experiment.agentButtonMask)!=0||e.getInt("mask")>=(1<<experiment.outputs.length))continue;
            if(e.getBoolean("human"))requireFdbMutation(request);
            adapted+=fdbLearning.observe(input,e.getInt("mask"),e.getDouble("reward"),e.getBoolean("human"),experiment.options.lesions,false);humanLearningApplied|=e.getBoolean("human");
        }
        if(fdbLearning!=null)response.put("fdbLearningState",learningState());
        if(humanLearningApplied||grown>0){try{persistFdb(request.optString("layerId",""));}catch(Exception ex){response.put("fdbSaveError",ex.getMessage());}}
        if("exo".equals(request.optString("controllerSource"))&&(learningMode.matches("train|eval")||learningMode.startsWith("benchmark"))&&!cancel.get()){
            if(fdbLearning==null)throw new IllegalArgumentException("Подключите FDB перед выбором нейронного управления");
            JSONArray values=request.getJSONArray("actions");if(values.length()<2||values.length()>64)throw new IllegalArgumentException("FDB action set");int[] actions=new int[values.length()];
            for(int j=0;j<actions.length;j++){if(!(values.get(j) instanceof Number)||values.getDouble(j)!=values.getInt(j))throw new IllegalArgumentException("FDB action mask");actions[j]=values.getInt(j);}
            String id=request.getLong("generation")+":"+request.getLong("token");
            boolean train=learningMode.equals("train")&&!frozen&&learningConfiguration.getBoolean("enabled");
            if(train)requireFdbMutation(request);
            FdbLearning.Decision d=fdbLearning.decide(id,result,actions,experiment.agentButtonMask,experiment.thresholdHz,train?request.getDouble("epsilon"):0,train,experiment.options.lesions);
            response.put("fdbDecision",new JSONObject().put("id",id).put("mask",d.mask).put("probability",d.probability));
            response.put("fdbLearningState",learningState());
        }
        response.put("fdbAdapted",adapted);
        if(fdbGrowth!=null)response.put("fdbGrowthState",growthState());
        response.put("fdbGrown",grown).put("fdbRevision",experiment.options.delta==null?0:experiment.options.delta.version());
        if(experiment.options.delta!=null&&experiment.options.delta.version()!=oldRevision){
            JSONObject state=fdbState();response.put("fdbState",state);
            if(recordingOn){String mutation="# fdb_mutation,"+(sequence+1)+","+state.toString()+"\n";recorder.write(mutation);recordedBytes+=mutation.getBytes(StandardCharsets.UTF_8).length;}
        }
        response.put("fdbEdges",experiment.options.delta==null?0:experiment.options.delta.growthCount()).put("fdbDeltas",experiment.options.delta==null?0:experiment.options.delta.deltaCount());
        response.put("outputs",output).put("inputs",new JSONArray(rates)).put("sequence",++sequence);
        if(frozenSeries!=null){frozenSeries.after(fdbState(),configVersion);response.put("frozenSeriesId",frozenSeries.id);}
        if(frozenBefore!=null){String after=CheckpointDigest.of(fdbState());response.put("fdbFrozen",new JSONObject().put("before",frozenBefore).put("after",after).put("unchanged",frozenBefore.equals(after)).put("configVersion",configVersion));if(!frozenBefore.equals(after))throw new IOException("Frozen evaluation изменила полный checkpoint FDB");}
        if(recordingOn) record(request,rates,result,latestMask);
        response.put("sampleTotalMs",(System.nanoTime()-sampleStarted)/1e6).put("workerQueueMs",request.optDouble("workerQueueMs",0));
        if(gpuEngine!=null&&"gpu".equals(backend))response.put("gpuSyncMs",gpuEngine.lastSyncMs()).put("gpuUploads",new JSONArray(gpuEngine.uploadStats()));
        emit("labResult",response);
    }

    private JSONObject fdbState() throws Exception {
        JSONObject state=new JSONObject().put("version",3).put("neuronDynamics",experiment.options.delta==null?new JSONObject().put("version",1).put("thresholdOffsets",new JSONArray()):FdbCheckpoint.thresholdState(experiment.options.delta,graph)).put("graph_sha256",graph.fingerprint());
        GraphDelta layer=experiment.options.delta;
        for(String kind:new String[]{"deltas","edges"}) {
            JSONArray links=new JSONArray();
            if(layer!=null)for(GraphDelta.Edge e:kind.equals("edges")?layer.edges():layer.deltas())links.put(new JSONObject().put("source",Long.toString(graph.ids[e.source])).put("target",Long.toString(graph.ids[e.target])).put("weight",e.weight));
            state.put(kind,links);
        }
        if(learningConfiguration!=null)state.put("learning",learningConfiguration);
        if(fdbLearning!=null)state.put("learningState",learningState());
        if(growthConfiguration!=null)state.put("growth",growthConfiguration);
        if(fdbGrowth!=null)state.put("growthState",growthState());
        return state;
    }

    private JSONObject fdbBindingContext()throws Exception{return FdbLayerBinding.context(labSystem,romHash,graph.fingerprint(),ids(experiment.inputs),ids(experiment.outputs));}
    private LearnedRoles learnedRoles()throws IOException{return new LearnedRoles(new File(getFilesDir(),"learned-roles"));}
    private ComparisonStore comparisons()throws IOException{return new ComparisonStore(new File(getFilesDir(),"comparisons"));}
    private JSONObject frozenLearning(JSONObject lc)throws Exception{return new JSONObject(lc.toString()).put("enabled",false).put("trainBase",lc.optBoolean("trainBase",true)).put("plasticityMode",lc.optString("plasticityMode","base")).put("creditProfile",lc.optString("creditProfile","single-v1"));}
    private Object frozenGrowth(JSONObject growth)throws Exception{return growth==null?JSONObject.NULL:new JSONObject(growth.toString()).put("enabled",false);}
    private JSONObject evaluationProtocol(JSONObject cfg)throws Exception {
        JSONObject protocol=new JSONObject();for(String field:new String[]{"inputs","outputs","mode","windowMs","maxHz","thresholdHz","seed","gain","disableInhibition","scramble","lesions","backend"})protocol.put(field,cfg.get(field));
        JSONObject fdb=cfg.getJSONObject("fdb");return protocol.put("agentButtonMask",systemButtonMask(cfg.optString("systemButtons","auto"))).put("learning",frozenLearning(fdb.getJSONObject("learning"))).put("growth",frozenGrowth(fdb.optJSONObject("growth")));
    }
    private void verifyComparisonStarts(JSONArray plan)throws Exception {
        for(int i=0;i<plan.length();i++){JSONObject row=plan.getJSONObject(i),role=curriculum().start(curriculumContext(),row.getString("originId"),row.getString("stateHash"));if(role.getBoolean("degraded")||!role.getString("role").equals("control")||role.getBoolean("trained")||!role.getString("groupId").equals(row.getString("groupId")))throw new IOException("Происхождение удержанных стартов изменилось; Best сохранён");}
    }
    private JSONObject beginComparison(JSONObject request,JSONObject protocol,JSONObject actual)throws Exception {
        if(!backend.equals("cpu"))throw new IOException("Парная проверка требует измеренный CPU backend");
        Runtime rt=Runtime.getRuntime();long available=rt.maxMemory()-(rt.totalMemory()-rt.freeMemory());if(available<IsolatedFdbContext.estimatedBytes(graph)+32L*1024*1024)throw new IOException("Недостаточно памяти для изолированной проверки; Current сохранён");
        checkpointRoles(fdbBinding.id());JSONObject candidate=new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(fdbBinding.id()),reference=learnedRoles().reference(curriculumContext()),referenceSet=reference.getJSONObject("set");
        // Bootstrap has no previous behavioral claim: run its original FDB under the common
        // preregistered observation/control protocol. A confirmed Best is never reconfigured.
        if(reference.getString("role").equals("baseline")){JSONObject original=referenceSet.getJSONObject("configuration").getJSONObject("fdb");referenceSet.put("configuration",new JSONObject(candidate.getJSONObject("configuration").toString()).put("fdb",original)).put("profile",new JSONObject(candidate.getJSONObject("profile").toString())).put("runtime",new JSONObject(candidate.getJSONObject("runtime").toString()));}
        if(!CheckpointDigest.of(evaluationProtocol(candidate.getJSONObject("configuration"))).equals(CheckpointDigest.of(actual))||!CheckpointDigest.of(evaluationProtocol(referenceSet.getJSONObject("configuration"))).equals(CheckpointDigest.of(actual))||!CheckpointDigest.of(referenceSet.getJSONObject("profile")).equals(protocol.getString("profileSha256")))throw new IOException("Исходная / Best модель имеет другие порты, профиль или параметры; сравнение не подтверждено");
        JSONObject referenceActuator=new JSONObject(referenceSet.toString());referenceActuator.getJSONObject("runtime").put("clock","lockstep");if(!actuatorSignature(referenceActuator).equals(protocol.getString("actuatorSha256")))throw new IOException("Управление контрольной модели отличается");
        JSONArray requested=request.getJSONArray("starts"),plan=new JSONArray(),groups=curriculum().describe(curriculumContext()).getJSONArray("groups");
        for(int i=0;i<requested.length();i++){
            JSONObject row=requested.getJSONObject(i),role=curriculum().start(curriculumContext(),row.getString("originId"),row.getString("stateHash"));JSONObject lineage=null;for(int j=0;j<groups.length();j++)if(groups.getJSONObject(j).getString("id").equals(role.getString("groupId")))lineage=groups.getJSONObject(j);
            if(lineage==null||role.getBoolean("degraded"))throw new IOException("Происхождение плана не подтверждено");
            plan.put(new JSONObject().put("originId",row.getString("originId")).put("stateHash",row.getString("stateHash")).put("startFrame",row.getLong("startFrame")).put("seed",row.getLong("seed")).put("groupId",role.getString("groupId")).put("role",role.getString("role")).put("trained",role.getBoolean("trained")).put("lineage",new JSONObject(lineage.toString())));
        }
        verifyComparisonStarts(plan);JSONObject reservation;
        try{reservation=comparisons().reserve(protocol,candidate,referenceSet,reference.isNull("previousBest")?null:reference.getString("previousBest"),reference.getJSONArray("coverage"),plan);}catch(ComparisonStore.Unavailable unavailable){return new JSONObject().put("skipped",true).put("reason",unavailable.getMessage()).put("bestUpdated",false);}
        pairedEvaluation=new PairedEvaluation(graph,reservation,fdbState(),configVersion);return new JSONObject().put("id",pairedEvaluation.id).put("leg","candidate").put("referenceRole",reference.getString("role")).put("registered",true);
    }
    private JSONObject checkpointRoles(String id)throws Exception {
        return learnedRoles().checkpoint(new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(id));
    }
    private JSONObject resumeRoles(JSONObject requested)throws Exception {
        JSONObject c=LearnedRoles.context(requested.getString("system"),requested.getString("romHash"),requested.getString("graphSha256"));
        return learnedRoles().resumeMutable(new LayerSetStore(new File(getFilesDir(),"layer-sets")),c);
    }
    private EpisodeHistory history()throws IOException{return new EpisodeHistory(new File(getFilesDir(),"episode-history"));}
    private CurriculumStore curriculum()throws IOException{if(curriculumStore==null)curriculumStore=new CurriculumStore(new File(getFilesDir(),"curriculum"));return curriculumStore;}
    private String actuatorSignature(JSONObject layer)throws Exception {JSONObject cfg=layer.getJSONObject("configuration");return CheckpointDigest.of(new JSONObject().put("controllerSource",cfg.optString("controllerSource")).put("gmode",cfg.optString("gmode","off")).put("systemButtons",cfg.optString("systemButtons","auto")).put("actionHold",cfg.optJSONObject("actionHold")).put("clock",layer.getJSONObject("runtime").getString("clock")));}
    private JSONObject curriculumContext()throws Exception{return new JSONObject().put("system",labSystem).put("romHash",romHash).put("graphSha256",graph.fingerprint());}
    private void ensureEpisode(JSONObject request,String mode)throws Exception {
        if(!fdbBinding.bound())throw new IOException("История эпизода требует durable Current");
        if(activeEpisode!=null&&(request.getLong("generation")!=activeEpisode.getLong("generation")||!mode.equals(activeEpisode.getString("mode"))))closeEpisode("session-change","unknown","unknown",false);
        if(activeEpisode==null){
            JSONObject row=new JSONObject().put("episodeId",java.util.UUID.randomUUID().toString()).put("runId",historyRun).put("system",labSystem).put("romHash",romHash).put("graphSha256",graph.fingerprint()).put("layerId",fdbBinding.id()).put("mode",mode).put("generation",request.getLong("generation")).put("configVersion",configVersion).put("startFrame",request.getLong("frame")).put("core",request.optString("core","unknown")).put("source",request.optString("rewardSource","unknown")).put("provenanceGroup","rom:"+labSystem+":"+romHash).put("startStateId",request.optString("startStateId","rom-boot")).put("inputs",ids(experiment.inputs)).put("outputs",ids(experiment.outputs));
            JSONObject layer=new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(fdbBinding.id());row.put("configurationSha256",CheckpointDigest.of(layer.getJSONObject("configuration"))).put("profileSha256",CheckpointDigest.of(layer.getJSONObject("profile")));
            JSONObject assignment=curriculum().role(curriculumContext(),curriculumOrigin);row.put("originId",curriculumOrigin).put("provenanceGroup",assignment.getString("groupId")).put("curriculum",assignment);
            activeEpisode=history().begin(row,CheckpointDigest.of(fdbState()));episodeKnown=episodeUnknown=episodeInterventions=0;episodeRewardSum=0;
        }
        episodeFrame=Math.max(request.getLong("frame"),activeEpisode.getLong("startFrame"));if(request.optInt("manualMask",0)!=0)episodeInterventions++;
    }
    private void closeEpisode(String reason,String outcome,String confidence,boolean completed)throws Exception {
        if(activeEpisode==null)return;
        JSONObject result=new JSONObject().put("reason",reason).put("outcome",outcome).put("confidence",confidence).put("completed",completed).put("endFrame",Math.max(episodeFrame,activeEpisode.getLong("startFrame"))).put("knownFeedback",episodeKnown).put("unknownFeedback",episodeUnknown).put("interventions",episodeInterventions).put("rewardSum",episodeKnown==0?JSONObject.NULL:episodeRewardSum);
        history().close(activeEpisode.getString("episodeId"),result,CheckpointDigest.of(fdbState()));activeEpisode=null;
    }
    private void invalidateFdbBinding(){try{closeEpisode("context-change","unknown","unknown",false);}catch(Exception failure){android.util.Log.e("FlyConsole","Episode close failed",failure);try{emit("labHistoryNotice",new JSONObject().put("error",failure.getMessage()));}catch(Exception ignored){}activeEpisode=null;}fdbBinding.invalidate();activeFdbLayerId="";curriculumOrigin="";}
    private void requireFdbMutation(JSONObject request)throws Exception{if(pairedEvaluation!=null){pairedEvaluation.invalidate("Попытка пластичности внутри парной проверки");throw new IOException("Парная проверка запрещает пластичность");}if(frozenSeries!=null){frozenSeries.invalidate("Попытка пластичности во frozen series");throw new IOException("Пластичность внутри контрольной серии запрещена");}fdbBinding.requireMutation(request.optString("layerId",""),fdbBindingContext(),configVersion);curriculum().training(curriculumContext(),curriculumOrigin);}
    private void persistFdb(String id)throws Exception{
        fdbBinding.persist(new LayerSetStore(new File(getFilesDir(),"layer-sets")),id,fdbBindingContext(),configVersion,fdbState());
        activeFdbLayerId=fdbBinding.id();
    }
    private void checkpointNativeCurrent()throws Exception {
        if(fdbBinding.bound()&&graph!=null&&experiment!=null){persistFdb(fdbBinding.id());checkpointRoles(fdbBinding.id());}
        closeEpisode("pause-or-exit","unknown","unknown",false);
    }

    private JSONObject learningState()throws Exception{return FdbCheckpoint.save(fdbLearning,graph,experiment.inputs,experiment.outputs);}

    private JSONObject growthState()throws Exception{return new JSONObject().put("version",1).put("windows",fdbGrowth.windows()).put("rng",fdbGrowth.rng()).put("sources",ids(experiment.inputs)).put("targets",ids(experiment.outputs)).put("previous",fdbGrowth.previous()==null?JSONObject.NULL:new JSONArray(fdbGrowth.previous()));}

    private void record(JSONObject request, double[] rates, Engine.Result result, int mask) throws Exception {
        StringBuilder row = new StringBuilder();
        row.append(System.currentTimeMillis()).append(',').append(configVersion).append(',').append(sequence)
            .append(',').append(request.getLong("frame")).append(',').append(result.endTick * .1)
            .append(',').append(String.format(Locale.US, "%.3f", result.wallSeconds * 1000))
            .append(',').append(result.spikes).append(',').append(result.active).append(',').append(mask).append(',').append(request.optInt("manualMask", 0)).append(',').append(request.optBoolean("frozen", false) ? 1 : 0);
        row.append(',').append(request.optInt("controllerMask", 0)).append(',').append(request.optString("learningMode", "off").replaceAll("[^a-z]", "")).append(',').append(request.optDouble("learningReward", 0));
        for (double rate : rates) row.append(',').append(String.format(Locale.US, "%.3f", rate));
        for(int i=0;i<(RomImport.wide(labSystem)?12:8);i++)row.append(',').append(i<experiment.outputs.length?result.counts[experiment.outputs[i]]:0);
        row.append('\n');
        recorder.write(row.toString());
        recordedBytes += row.length();
        if (sequence % 10 == 0) recorder.flush();
        if (recordedBytes > 8 * 1024 * 1024) {
            stopRecording();
            error("Журнал достиг 8 МиБ и остановлен; его можно экспортировать.");
        }
    }

    private void startRecording() throws Exception {
        stopRecording();
        recording = new File(getFilesDir(), labSystem+"-experiment.csv");
        recorder = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(recording), StandardCharsets.UTF_8));
        recordedBytes = 0;
        recorder.write("# system,"+labSystem+"\n");
        recorder.write("# model," + graphKind + ",neurons=" + graph.ids.length + ",edges=" + graph.targets.length + ",backend=" + backend + ",dt_ms=0.1,brian2_parity=unverified,sha256="+graph.fingerprint()+"\n");
        recorder.write("# rom_sha256," + romHash + "\n");
        recorder.write("# recording_start,config_version="+configVersion+",sequence="+sequence+",state_preserved=true\n");
        StringBuilder header = new StringBuilder("wall_epoch_ms,config_version,sequence,emulator_frame,sim_ms,compute_ms,spikes,active,buttons_mask,manual_mask,frozen_retina,controller_mask,learning_mode,learning_reward");
        for (int i = 0; i < 16; i++) header.append(",input_hz_").append(i);
        String[] names="snes".equals(labSystem)?new String[]{"A","B","Y","Start","Up","Down","Left","Right","X","L","R","Select"}:"sega".equals(labSystem)?new String[]{"A","B","C","Start","Up","Down","Left","Right","X","Y","Z","Mode"}:Experiment.BUTTONS;
        for(String name:names)header.append(",spikes_").append(name);
        recorder.write(header.append('\n').toString());
        recordingOn = true;
        // Initial ports/configuration must accompany every recording, even if no config change occurs.
        JSONObject config = new JSONObject();
        config.put("system",labSystem).put("configVersion", configVersion).put("rom_sha256", romHash);
        config.put("inputs", ids(experiment.inputs)).put("outputs", ids(experiment.outputs));
        config.put("mode", experiment.mode).put("maxHz", experiment.maxHz).put("thresholdHz", experiment.thresholdHz);
        config.put("windowMs", experiment.windowMs).put("gain", experiment.options.gain).put("backend",backend);
        config.put("seed", experiment.seed).put("scramble", experiment.scramble);
        config.put("disableInhibition", experiment.options.disableInhibition).put("lesions", ids(experiment.options.lesions));
        recorder.write("# config," + config + "\n");
        if(experiment.options.delta!=null){recorder.write("# fdb_genome,"+experiment.options.delta.genome()+"\n");recorder.write("# fdb_state,"+fdbState().toString()+"\n");}
        emit("labRecording", new JSONObject().put("active", true));
    }

    private void closeGpu(){ if(gpuEngine!=null){ try{gpuEngine.close();}catch(Exception ignored){} gpuEngine=null; } }

    private void stopRecording() throws IOException {
        recordingOn = false;
        if (recorder != null) { recorder.close(); recorder = null; }
    }

    private RomLibrary romLibrary()throws IOException{return new RomLibrary(new File(getFilesDir(),"rom-library"));}
    private void loadRom(byte[] bytes,String name)throws Exception {loadRom(bytes,name,false);}
    private void loadRom(byte[] bytes, String name,boolean resume) throws Exception {
        loadRom(bytes,name,resume,false);
    }
    private void loadRom(byte[] bytes, String name,boolean resume,boolean userOpened) throws Exception {
        bytes=RomImport.normalize(bytes,labSystem);
        StringBuilder hash = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format(Locale.US, "%02x", b & 255));
        String candidateHash = hash.toString();
        try{offeredLibraryRoms.put(candidateHash,romLibrary().offer(labSystem,bytes,name));}
        catch(Exception failure){emit("labLibraryNotice",new JSONObject().put("error",failure.getMessage()));}
        offeredRomHashes.addLast(candidateHash);
        if (offeredRomHashes.size() > 8) offeredLibraryRoms.remove(offeredRomHashes.removeFirst());
        // Commit model/recording identity only after the JS core accepts the ROM.
        emit("labLoadRom", new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("name", name).put("sha256", candidateHash).put("resume",resume).put("system",labSystem).put("userOpened",userOpened));
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event){return controllers!=null&&controllers.key(event)||super.dispatchKeyEvent(event);}
    @Override public boolean dispatchGenericMotionEvent(android.view.MotionEvent event){return controllers!=null&&controllers.motion(event)||super.dispatchGenericMotionEvent(event);}

    public final class Bridge {
        @JavascriptInterface public void diagnostics(String raw){
            if(destroyed||raw.length()>64*1024)return;String token="";JSONObject response=new JSONObject();try{JSONObject request=new JSONObject(raw);token=request.getString("token");DeviceLog logger=DeviceLog.get();if(logger==null)throw new IOException("Журнал недоступен");String op=request.getString("op");
                if(op.equals("events"))logger.ingest(request);else if(op.equals("export"))runOnUiThread(()->exportDiagnostics());else if(!op.equals("status"))throw new IOException("Операция журнала");response.put("token",token).put("data",logger.status());
            }catch(Exception failure){try{response.put("token",token).put("error",failure.getMessage());}catch(Exception ignored){}}emit("labDiagnostics",response);
        }
        @JavascriptInterface public void dualConfigure(String json){if(destroyed||json.length()>8*1024*1024)return;if(freshDualConfiguration(json)){cancel.set(true);controlEpoch.incrementAndGet();}submit(()->{try{configureDual(new JSONObject(json));}catch(Exception|OutOfMemoryError ex){emitDualFailure("labDualReady",json,ex);}});}
        @JavascriptInterface public void dualSample(String json){if(destroyed||json.length()>65536)return;submit(()->{try{sampleDual(new JSONObject(json));}catch(Exception|OutOfMemoryError ex){if(matchesDualRequest(json))cancel.set(true);emitDualFailure("labDualResult",json,ex);}});}
        @JavascriptInterface public void dualBoundary(String json){if(destroyed||json.length()>8192)return;if(matchesDualRequest(json)){cancel.set(true);controlEpoch.incrementAndGet();}submit(()->{try{boundaryDual(new JSONObject(json));}catch(Exception|OutOfMemoryError ex){emitDualFailure("labDualBoundary",json,ex);}});}
        @JavascriptInterface public void dualExit(String json){if(destroyed||json.length()>8192)return;if(matchesDualRequest(json)){cancel.set(true);controlEpoch.incrementAndGet();}submit(()->{try{exitDual(new JSONObject(json));}catch(Exception|OutOfMemoryError ex){emitDualFailure("labDualExited",json,ex);}});}
        @JavascriptInterface public void selectConnectome(String id){
            if(destroyed||!ConnectomeStore.valid(id))return;cancel.set(true);final long epoch=controlEpoch.incrementAndGet();
            submit(()->{JSONObject response=new JSONObject();try{
                if(dualAgents!=null){pauseDualNative();clearDualNative();}
                if(!id.equals(modelId)||graph==null){
                    Graph loaded=ConnectomeStore.candidate(NesLabActivity.this,id,graphBudget());
                    Experiment next=ConnectomeStore.ports(NesLabActivity.this,loaded,RomImport.wide(labSystem)&&loaded.ids.length>=28?12:8,id);
                    Engine nextEngine=new Engine(loaded);stopRecording();ConnectomeStore.select(NesLabActivity.this,id);
                    GraphCache.installNamed(loaded,id,ConnectomeStore.title(id));installGraph(loaded,nextEngine,next,id);
                }
                response.put("ok",true).put("id",modelId);announce();
            }catch(Exception|OutOfMemoryError ex){try{response.put("ok",false).put("id",id).put("activeId",modelId).put("error","Модель не переключена: "+ex.getMessage()+". Предыдущая модель сохранена.");}catch(Exception ignored){}}
            finally{if(controlEpoch.get()==epoch&&foreground)cancel.set(false);}emit("labModelSelection",response);});
        }
        @JavascriptInterface public void installSyntheticGraph(String json){
            if(destroyed||json.getBytes(StandardCharsets.UTF_8).length>SyntheticGraphJson.MAX_BYTES)return;
            cancel.set(true);final long epoch=controlEpoch.incrementAndGet();
            submit(()->{JSONObject response=new JSONObject();try{
                if(dualAgents!=null)throw new IOException("Stop and save the dual session before importing a graph");
                Graph loaded=SyntheticGraphJson.read(new JSONObject(json),graphBudget());
                Experiment next=Experiment.automatic(loaded,RomImport.wide(labSystem)?12:8);
                Engine nextEngine=new Engine(loaded);stopRecording();
                ConnectomeStore.installSynthetic(NesLabActivity.this,loaded);
                installGraph(loaded,nextEngine,next,ConnectomeStore.IMPORTED);
                response.put("ok",true).put("graph_sha256",loaded.fingerprint());announce();
            }catch(Exception|OutOfMemoryError ex){try{response.put("ok",false).put("error",ex.getMessage()==null?"Graph import failed":ex.getMessage());}catch(Exception ignored){}}
            finally{if(controlEpoch.get()==epoch&&foreground)cancel.set(false);}emit("labSyntheticImported",response);});
        }
        @JavascriptInterface public void controls(boolean enabled){runOnUiThread(()->{if(controllers!=null)controllers.enabled(enabled&&foreground);});}
        @JavascriptInterface public void switchSystem(String system){if(!RomImport.validSystem(system))return;runOnUiThread(()->NesLabActivity.this.switchSystem(system));}
        @JavascriptInterface public void finishSystemSwitch(String system,boolean okay){if(destroyed||!RomImport.validSystem(system))return;runOnUiThread(()->NesLabActivity.this.finishSystemSwitch(system,okay));}
        @JavascriptInterface public void acceptRom(String sha256) {
            if (destroyed || sha256.length() != 64) return;
            submit(() -> {
                try {
                    if (!offeredRomHashes.remove(sha256)) return;
                    if(!sha256.equals(romHash))invalidateFdbBinding();
                    romHash = sha256;if(DeviceLog.get()!=null)DeviceLog.get().context(new JSONObject().put("system",labSystem).put("romHash",romHash).put("graphSha256",graph==null?JSONObject.NULL:graph.fingerprint()).put("backend",backend).put("configVersion",configVersion).put("pageEpoch",pageEpoch.get()));diagnostic("info","emulator.rom-accepted",message(sha256));
                    JSONObject offered=offeredLibraryRoms.remove(sha256);
                    if(offered!=null)try{NesLabActivity.this.romLibrary().accept(offered);}catch(Exception failure){emit("labLibraryNotice",new JSONObject().put("error",failure.getMessage()));}
                    latestMask=0; // ROM acceptance changes console identity, never neural state.
                    if (recordingOn) { recorder.write("# rom_sha256," + romHash + "\n"); recorder.flush(); }
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void sample(String json) {
            if (destroyed || json.length() > 8192) return;
            final long queued=System.nanoTime();submit(() -> {
                try { NesLabActivity.this.sample(new JSONObject(json).put("workerQueueMs",(System.nanoTime()-queued)/1e6)); }
                catch (Exception|OutOfMemoryError ex) { if(pairedEvaluation!=null)pairedEvaluation.invalidate("Ошибка вычисления: "+ex.getClass().getSimpleName());emitRequestFailure(json,"sample",ex.getMessage()==null?ex.getClass().getSimpleName():ex.getMessage()); }
            });
        }
        @JavascriptInterface public void fdbFeedback(String json){
            if(destroyed||json.getBytes(StandardCharsets.UTF_8).length>8192)return;
            final long queued=System.nanoTime();submit(()->{long began=System.nanoTime();String token="";JSONObject response=new JSONObject();try{
                JSONObject request=new JSONObject(json);token=request.getString("token");String op=request.getString("op");
                if(op.equals("diagnostics")&&fdbLearning==null){response.put("token",token).put("data",JSONObject.NULL);emit("labFdbFeedback",response);return;}
                if(op.equals("diagnostics")){response.put("token",token).put("data",new JSONObject().put("diagnostics",FdbDiagnostics.report(graph,experiment.options.delta,fdbLearning)));emit("labFdbFeedback",response);return;}
                if(op.equals("bind")){
                    String id=request.getString("layerId");long expected=request.getLong("configVersion");
                    if(pairedEvaluation!=null){if(!id.equals(activeFdbLayerId))throw new IOException("Current нельзя заменить внутри парной проверки");JSONObject layer=new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(id);pairedEvaluation.profile(CheckpointDigest.of(layer.getJSONObject("profile")),actuatorSignature(layer));}
                    if(frozenSeries!=null){JSONObject layer=new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(id);frozenSeries.profile(CheckpointDigest.of(layer.getJSONObject("profile")),actuatorSignature(layer));}
                    if(!(request.get("configVersion") instanceof Number)||request.getDouble("configVersion")!=expected)throw new IllegalArgumentException("FDB bind configVersion");
                    try{fdbBinding.bind(new LayerSetStore(new File(getFilesDir(),"layer-sets")),id,fdbBindingContext(),configVersion,request.getJSONObject("context"),expected,fdbState());}
                    finally{activeFdbLayerId=fdbBinding.id();}
                    JSONObject roles;try{roles=checkpointRoles(id);}catch(Exception failed){invalidateFdbBinding();throw failed;}
                    JSONObject boundData=new JSONObject().put("roles",roles).put("bound",true).put("layerId",id).put("configVersion",configVersion);
                    if(fdbLearning!=null)boundData.put("fdbState",fdbState()).put("changed",0).put("memoryBytes",(experiment.options.delta==null?0:experiment.options.delta.memoryBytes())+fdbLearning.memoryBytes());
                    response.put("token",token).put("data",boundData);
                    emit("labFdbFeedback",response);return;
                }
                if(fdbLearning==null){response.put("token",token).put("data",JSONObject.NULL);emit("labFdbFeedback",response);return;}
                long learningStarted=System.nanoTime();int changed=0;
                if(op.equals("boundary")){if(pairedEvaluation==null)fdbLearning.boundary();}
                else if(op.equals("reward")){
                    for(String key:new String[]{"mask","frames"})if(!(request.get(key) instanceof Number)||request.getDouble(key)!=request.getInt(key))throw new IllegalArgumentException("FDB feedback integer");
                    for(String key:new String[]{"valid","frozen"})if(!(request.get(key) instanceof Boolean))throw new IllegalArgumentException("FDB feedback boolean");
                    for(String key:new String[]{"reward","seconds"})if(!(request.get(key) instanceof Number))throw new IllegalArgumentException("FDB feedback number");
                    if(learningConfiguration.getBoolean("enabled")&&!request.getBoolean("frozen"))requireFdbMutation(request);
                    long beforeAutomatic=fdbLearning.automatic();
                    if(learningConfiguration.getBoolean("enabled"))changed=fdbLearning.feedback(request.getString("decision"),request.getInt("mask"),request.getDouble("reward"),request.getDouble("seconds"),request.getInt("frames"),request.getBoolean("valid"),request.getBoolean("frozen"),experiment.options.lesions);
                    if(activeEpisode!=null&&fdbLearning.automatic()>beforeAutomatic){episodeKnown++;episodeRewardSum+=request.getDouble("reward");}
                }else throw new IllegalArgumentException("Unknown FDB feedback operation");
                if(activeEpisode!=null&&op.equals("boundary")&&request.optBoolean("unknown",false))episodeUnknown++;
                response.put("feedbackMs",(System.nanoTime()-learningStarted)/1e6);long serializationStarted=System.nanoTime();
                response.put("token",token).put("data",new JSONObject().put("fdbState",fdbState()).put("changed",changed).put("revision",experiment.options.delta.version()).put("memoryBytes",experiment.options.delta.memoryBytes()+fdbLearning.memoryBytes()));
                response.put("stateAssemblyMs",(System.nanoTime()-serializationStarted)/1e6);long saveStarted=System.nanoTime();
                if(fdbBinding.bound()&&!request.optBoolean("frozen",false))try{persistFdb(op.equals("boundary")?fdbBinding.id():request.optString("layerId",""));}catch(Exception ex){response.put("saveError",ex.getMessage());}
                response.put("saveMs",(System.nanoTime()-saveStarted)/1e6).put("workerQueueMs",(began-queued)/1e6).put("feedbackTotalMs",(System.nanoTime()-began)/1e6);
                if(recordingOn)recorder.write("# fdb_feedback,"+request.toString()+","+fdbState().toString()+"\n");
            }catch(Exception e){try{response.put("token",token).put("error",e.getMessage());}catch(Exception ignored){}}emit("labFdbFeedback",response);});
        }
        @JavascriptInterface public void configure(String json) {
            if (destroyed) return;
            if(json.getBytes(StandardCharsets.UTF_8).length>4*1024*1024){emitRequestFailure(json,"configure","Конфигурация превышает 4 МиБ");return;}
            cancel.set(true);final long epoch=controlEpoch.incrementAndGet(),queued=System.nanoTime();
            submit(() -> {
                try { NesLabActivity.this.configure(new JSONObject(json).put("configureQueueMs",(System.nanoTime()-queued)/1e6)); }
                catch (Exception ex) { emitRequestFailure(json,"configure",ex.getMessage()); }
                finally { if(controlEpoch.get()==epoch&&foreground)cancel.set(false); }
            });
        }
        @JavascriptInterface public void systemButtons(String json) {
            if(destroyed||json.length()>8192)return;
            submit(()->{try{
                JSONObject data=new JSONObject(json);int mask=systemButtonMask(data.getString("mode"));
                if(pairedEvaluation!=null){pairedEvaluation.invalidate("Изменено управление внутри парной проверки");throw new IOException("Изменение управления прервало парную проверку");}
                if(frozenSeries!=null){frozenSeries.invalidate("Изменён доступ к системным кнопкам");throw new IOException("Изменение управления прервало контрольную серию");}
                if(experiment==null)throw new IllegalStateException("Коннектом не готов");
                experiment.agentButtonMask=mask;latestMask&=mask;
                if(recordingOn)recorder.write("# system_buttons,"+data.getString("mode")+",allowed_mask="+mask+"\n");
                emit("labSystemButtons",new JSONObject().put("mode",data.getString("mode")).put("generation",data.getLong("generation")));
            }catch(Exception ex){emitRequestFailure(json,"systemButtons",ex.getMessage());}});
        }
        @JavascriptInterface public void orientation(String mode) {
            final int choice;
            if("auto".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER;
            else if("portrait".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            else if("landscape".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            else return;
            runOnUiThread(()->setRequestedOrientation(choice));
        }
        @JavascriptInterface public void gameDisplay(boolean immersive) {
            runOnUiThread(()->{if(destroyed)return;immersiveDisplay=immersive;applyGameDisplay();});
        }
        @JavascriptInterface public void stop() { controlEpoch.incrementAndGet();cancel.set(true);diagnostic("info","neural.stop-request",new JSONObject()); }
        @JavascriptInterface public void resume() { if(foreground)cancel.set(false);diagnostic("info",foreground?"neural.resume-request":"neural.resume-background-rejected",new JSONObject()); }
        @JavascriptInterface public void lifecycleSaved(String raw) {
            if(destroyed||raw.length()>8192)return;
            try{JSONObject result=new JSONObject(raw);String ticket=result.getString("token");runOnUiThread(()->{
                if(destroyed||foreground||!ticket.equals(lifecycleTicket)){diagnostic("warn","lifecycle.stale-ack",message(ticket));return;}lifecycleTicket="";
                lifecycleFailure=result.optString("error");diagnostic(lifecycleFailure.isEmpty()?"info":"error","lifecycle.saved",result);if(DeviceLog.get()!=null)DeviceLog.get().stage(lifecycleFailure.isEmpty()?"background-saved":"background-save-error");if(!lifecycleFailure.isEmpty())android.util.Log.e("FlyConsole","Lifecycle save: "+lifecycleFailure);if(!rendererGone)web.onPause();
            });}catch(Exception failure){android.util.Log.e("FlyConsole","Invalid lifecycle acknowledgement",failure);}
        }
        @JavascriptInterface public void finishExit(String raw) {
            if(destroyed||raw.length()>8192)return;final long epoch=pageEpoch.get();
            submit(()->{try{JSONObject result=new JSONObject(raw);if(!result.getBoolean("gameSaved"))throw new IOException("Снимок игры не подтверждён");
                try{pauseDualNative();checkpointNativeCurrent();}catch(Exception failure){result.put("error",result.optString("error")+"; "+failure.getMessage());}
                long expectedGeneration=result.getLong("generation");String expectedRom=result.getString("romHash");
                runOnUiThread(()->{if(destroyed||epoch!=pageEpoch.get())return;web.evaluateJavascript("Boolean(!playing && generation === "+expectedGeneration+" && romHash === "+JSONObject.quote(expectedRom)+")",value->{if(destroyed||epoch!=pageEpoch.get()||!"true".equals(value))return;if(!result.optString("error").isEmpty())Toast.makeText(NesLabActivity.this,"Игра сохранена; ошибка обучения: "+result.optString("error"),Toast.LENGTH_LONG).show();finish();});});
            }catch(Exception failure){error("Выход: "+failure.getMessage());}});
        }
        @JavascriptInterface public void console() {
            runOnUiThread(() -> startActivity(new Intent(NesLabActivity.this,CodeLabActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
        }
        @JavascriptInterface public void pickRom() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, PICK_ROM);
            });
        }
        @JavascriptInterface public void romLibrary(String raw) {
            if(destroyed||raw.length()>4096)return;
            submit(()->{String token="";JSONObject reply=new JSONObject();try{
                JSONObject request=new JSONObject(raw);token=request.getString("token");String op=request.getString("op");RomLibrary library=NesLabActivity.this.romLibrary();Object result;
                if(op.equals("startup")||op.equals("list")){
                    JSONObject listing=library.list(),last=library.last(labSystem);
                    if(op.equals("startup")&&pendingLibrarySystem.equals(labSystem)&&!pendingLibraryHash.isEmpty()){last=library.find(labSystem,pendingLibraryHash);pendingLibraryHash="";pendingLibrarySystem="";}
                    result=listing.put("last",last==null?JSONObject.NULL:last);
                }else if(op.equals("open")){
                    String system=request.getString("system"),hash=request.getString("sha256");JSONObject row=library.find(system,hash);byte[] bytes=library.read(system,hash);
                    if(system.equals(labSystem))loadRom(bytes,row.getString("name"),true);
                    else{pendingLibrarySystem=system;pendingLibraryHash=hash;runOnUiThread(()->NesLabActivity.this.switchSystem(system));}
                    result=row;
                }else if(op.equals("delete")){
                    String system=request.getString("system"),hash=request.getString("sha256");if(system.equals(labSystem)&&hash.equals(romHash))throw new IOException("Сначала откройте другую игру");library.delete(system,hash);result=library.list();
                }else throw new IOException("Неизвестная операция библиотеки");
                reply.put("token",token).put("data",result);
            }catch(Exception failure){try{reply.put("token",token).put("error",failure.getMessage());}catch(Exception ignored){}}
                emit("labRomLibrary",reply);
            });
        }
        @JavascriptInterface public void episodeHistory(String raw) {
            if(destroyed||raw.length()>4096)return;submit(()->{String token="";JSONObject reply=new JSONObject();try{
                JSONObject request=new JSONObject(raw);token=request.getString("token");String op=request.getString("op");
                if(op.equals("close")){
                    if(activeEpisode!=null&&request.getLong("generation")==activeEpisode.getLong("generation")){
                        episodeFrame=Math.max(episodeFrame,request.getLong("frame"));String outcome=request.optString("outcome","unknown"),source=activeEpisode.optString("source");boolean known=outcome.matches("success|death")&&source.matches("diagnostic|ram|score");
                        if(fdbBinding.bound()){persistFdb(fdbBinding.id());checkpointRoles(fdbBinding.id());}
                        closeEpisode("episode-boundary",known?outcome:"unknown",known?(source.equals("diagnostic")?"diagnostic":"configured"):"unknown",true);
                    }
                    reply.put("data",new JSONObject().put("closed",activeEpisode==null));
                }else if(op.equals("list"))reply.put("data",history().list());else throw new IOException("Неизвестная операция истории");
                reply.put("token",token);
            }catch(Exception failure){try{reply.put("token",token).put("error",failure.getMessage());}catch(Exception ignored){}}
                emit("labEpisodeHistory",reply);
            });
        }
        @JavascriptInterface public void curriculum(String raw) {
            if(destroyed||raw.length()>8192)return;submit(()->{String token="";JSONObject reply=new JSONObject();try{
                JSONObject request=new JSONObject(raw);token=request.getString("token");String op=request.getString("op");
                if(!request.getString("romHash").equals(romHash)||!request.getString("graphSha256").equals(graph.fingerprint()))throw new IOException("Контекст отрезка изменился");
                if(!fdbBinding.bound()||!request.getString("layerId").equals(fdbBinding.id()))throw new IOException("Отрезок требует привязанный Current");
                Object data;
                if(op.equals("register")||op.equals("classify")){
                    String origin=request.getString("originId");data=NesLabActivity.this.curriculum().register(curriculumContext(),origin,request.getString("stateHash"));
                    if(op.equals("register")){if(!origin.equals(curriculumOrigin))closeEpisode("trajectory-change","unknown","unknown",false);curriculumOrigin=origin;}
                }else if(op.equals("role"))data=NesLabActivity.this.curriculum().role(curriculumContext(),request.getString("originId"));
                else throw new IOException("Неизвестная операция отрезков");
                reply.put("token",token).put("data",data);
            }catch(Exception failure){try{reply.put("token",token).put("error",failure.getMessage());}catch(Exception ignored){}}emit("labCurriculum",reply);});
        }
        @JavascriptInterface public void evaluationSeries(String raw) {
            if(destroyed||raw.length()>32768)return;submit(()->{String token="";JSONObject reply=new JSONObject();try{
                JSONObject request=new JSONObject(raw);token=request.getString("token");String op=request.getString("op");Object data;
                if(op.equals("begin")){
                    if(frozenSeries!=null||pairedEvaluation!=null)throw new IOException("Контрольная серия уже открыта");
                    if(!fdbBinding.bound()||!request.getString("layerId").equals(fdbBinding.id())||!request.getString("romHash").equals(romHash))throw new IOException("Контроль требует Current этой игры");
                    JSONObject layer=new LayerSetStore(new File(getFilesDir(),"layer-sets")).get(fdbBinding.id()),cfg=new JSONObject(layer.getJSONObject("configuration").toString());
                    if(!cfg.optString("controllerSource").equals("exo"))throw new IOException("Контрольная серия требует коннектом + FDB");
                    if(!layer.getJSONObject("runtime").getString("clock").equals("lockstep")||request.getDouble("speed")!=1||!cfg.optString("gmode","off").equals("off"))throw new IOException("Контроль требует Lockstep ×1 и одного агента");
                    JSONObject fdb=cfg.optJSONObject("fdb");if(fdb!=null)for(String field:new String[]{"deltas","edges","neuronDynamics","learningState","growthState"})fdb.remove(field);
                    boolean feedbackTrusted=false;
                    if(labSystem.equals("nes")&&layer.getJSONObject("profile").optString("rewardMode").equals("diagnostic"))try(InputStream in=getAssets().open("lab/demo-rom.json")){
                        JSONObject demo=new JSONObject(readText(in,100000));StringBuilder digest=new StringBuilder();for(byte value:MessageDigest.getInstance("SHA-256").digest(Base64.decode(demo.getString("base64"),Base64.DEFAULT)))digest.append(String.format(Locale.ROOT,"%02x",value&255));feedbackTrusted=romHash.equals(digest.toString());
                    }
                    JSONObject actual=new JSONObject().put("inputs",ids(experiment.inputs)).put("outputs",ids(experiment.outputs)).put("mode",experiment.mode).put("windowMs",experiment.windowMs).put("maxHz",experiment.maxHz).put("thresholdHz",experiment.thresholdHz).put("seed",experiment.seed).put("gain",experiment.options.gain).put("disableInhibition",experiment.options.disableInhibition).put("scramble",experiment.scramble).put("lesions",experiment.options.lesions==null?new JSONArray():ids(experiment.options.lesions)).put("agentButtonMask",experiment.agentButtonMask).put("backend",backend).put("learning",frozenLearning(learningConfiguration)).put("growth",frozenGrowth(growthConfiguration));
                    JSONObject c=curriculumContext().put("core",request.getString("core")).put("profileSha256",CheckpointDigest.of(layer.getJSONObject("profile"))).put("configurationSha256",CheckpointDigest.of(actual)).put("actuatorSha256",actuatorSignature(layer)).put("timing","lockstep-1x").put("actionsHash",CheckpointDigest.of(new JSONObject().put("actions",request.getJSONArray("actions"))));if(feedbackTrusted)c.put("criterionType","fly-nes-target-v1").put("criterionHorizon",Integer.parseInt(layer.getJSONObject("profile").getString("episodeLength")));c.put("signature",CheckpointDigest.of(c)).put("feedbackTrusted",feedbackTrusted).put("layerId",fdbBinding.id());
                    closeEpisode("frozen-start","unknown","unknown",false);if(fdbLearning!=null)fdbLearning.boundary();persistFdb(fdbBinding.id());
                    if(request.has("starts"))data=beginComparison(request,c,actual);else{frozenSeries=new FrozenSeries(c,fdbState(),configVersion,request.getInt("trials"));data=new JSONObject().put("id",frozenSeries.id);}
                }else if(pairedEvaluation!=null){
                    if(!request.getString("id").equals(pairedEvaluation.id))throw new IOException("Парная проверка устарела");
                    if(op.equals("arm")){
                        if(!request.getString("originId").equals(curriculumOrigin))throw new IOException("Происхождение контрольного старта изменилось");
                        JSONObject role=NesLabActivity.this.curriculum().start(curriculumContext(),curriculumOrigin,request.getString("stateHash"));if(role.getBoolean("degraded"))throw new IOException("Происхождение контрольной группы не подтверждено");
                        JSONObject start=new JSONObject(request.toString()).put("groupId",role.getString("groupId")).put("role",role.getString("role")).put("trained",role.getBoolean("trained"));pairedEvaluation.arm(start,fdbState(),configVersion);data=new JSONObject().put("armed",true);
                    }else if(op.equals("trial")){pairedEvaluation.trial(request,fdbState(),configVersion);data=new JSONObject().put("recorded",true);
                    }else if(op.equals("end")||op.equals("abort")){
                        boolean abort=op.equals("abort");try{verifyComparisonStarts(pairedEvaluation.reservation.getJSONArray("plan"));}catch(Exception invalid){pairedEvaluation.invalidate(invalid.getMessage());}
                        EvaluationArchive archive=new EvaluationArchive(new File(getFilesDir(),"evaluations"));JSONObject result;
                        try{result=pairedEvaluation.end(fdbState(),configVersion,archive,comparisons(),abort);}finally{if(abort)pairedEvaluation=null;}
                        if(result.optBoolean("complete")){
                            try{ComparisonStore.Promotion promotion=comparisons().conclude(pairedEvaluation.id,archive,result.getJSONObject("candidateArchive"),result.getJSONObject("referenceArchive"));
                                result.put("promotionGate",BestPromotionGate.assess(archive.read(result.getJSONObject("candidateArchive")),archive.read(result.getJSONObject("referenceArchive"))));
                                if(promotion!=null){persistFdb(fdbBinding.id());checkpointRoles(fdbBinding.id());result.put("roles",learnedRoles().promote(promotion)).put("bestUpdated",true);}
                            }finally{pairedEvaluation=null;}
                        }else if(!result.has("nextLeg"))pairedEvaluation=null;
                        data=result;
                    }else throw new IOException("Неизвестная операция парной проверки");
                }else{
                    if(frozenSeries==null||!request.getString("id").equals(frozenSeries.id))throw new IOException("Контрольная серия отсутствует / устарела");
                    if(op.equals("arm")){
                        String origin=request.getString("originId");if(!origin.equals(curriculumOrigin))throw new IOException("Происхождение контрольного старта изменилось");
                        JSONObject role=NesLabActivity.this.curriculum().start(curriculumContext(),origin,request.getString("stateHash"));if(role.getBoolean("degraded"))throw new IOException("Происхождение контрольной группы не подтверждено");
                        JSONObject start=new JSONObject(request.toString()).put("groupId",role.getString("groupId")).put("role",role.getString("role")).put("trained",role.getBoolean("trained"));
                        frozenSeries.arm(start,fdbState(),configVersion);long seed=request.getLong("seed");if(seed<0||seed>0xffffffffL)throw new IOException("Seed контрольной серии");if(gpuEngine!=null&&backend.equals("gpu"))gpuEngine.reset(seed);else engine.reset(seed);data=new JSONObject().put("armed",true);
                    }else if(op.equals("trial")){
                        frozenSeries.trial(request,fdbState(),configVersion);data=new JSONObject().put("recorded",true);
                    }else if(op.equals("end")||op.equals("abort")){
                        if(op.equals("abort"))frozenSeries.invalidate("Серия остановлена пользователем / ошибкой");
                        JSONArray checked=frozenSeries.trials();for(int i=0;i<checked.length();i++)try{JSONObject trial=checked.getJSONObject(i),role=NesLabActivity.this.curriculum().start(curriculumContext(),trial.getString("originId"),trial.getString("stateHash"));if(role.getBoolean("degraded")||!role.getString("role").equals("control")||role.getBoolean("trained")||!role.getString("groupId").equals(trial.getString("groupId")))frozenSeries.invalidate("Контрольная группа изменилась во время серии");}catch(Exception damaged){frozenSeries.invalidate("Происхождение контроля больше не подтверждено");}
                        JSONObject proof=frozenSeries.finish(fdbState(),configVersion);EvaluationArchive archive=new EvaluationArchive(new File(getFilesDir(),"evaluations"));JSONObject ref=archive.save(proof);data=new JSONObject().put("proof",proof).put("archive",ref).put("promotionGate",BestPromotionGate.assess(proof,null)).put("bestUpdated",false);frozenSeries=null;
                    }else throw new IOException("Неизвестная операция контрольной серии");
                }reply.put("token",token).put("data",data);
            }catch(Exception|OutOfMemoryError failure){String reason=failure.getMessage()==null?failure.getClass().getSimpleName():failure.getMessage();if(pairedEvaluation!=null)pairedEvaluation.invalidate(reason);if(failure instanceof OutOfMemoryError)pairedEvaluation=null;if(frozenSeries!=null)frozenSeries.invalidate(reason);try{reply.put("token",token).put("error",reason);}catch(Exception ignored){}}emit("labEvaluationSeries",reply);});
        }
        @JavascriptInterface public void demo() {
            submit(() -> {
                try (InputStream in = getAssets().open("nes".equals(labSystem)?"lab/demo-rom.json":"lab/demo-"+labSystem+".json")) {
                    JSONObject data = new JSONObject(readText(in, 100000));
                    loadRom(Base64.decode(data.getString("base64"), Base64.DEFAULT), "Fly "+labSystem.toUpperCase(Locale.ROOT)+" original diagnostic");
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void recording(boolean enabled) {
            submit(() -> {
                try {
                    if (engine == null) throw new IllegalStateException("Коннектом не готов");
                    if (enabled) startRecording();
                    else { stopRecording(); emit("labRecording", new JSONObject().put("active", false)); }
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void importModel() {
            runOnUiThread(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), PICK_MODEL));
        }
        @JavascriptInterface public void layerSets(String json) {
            if(destroyed)return;
            if(json.getBytes(StandardCharsets.UTF_8).length>LayerSetStore.MAX_BYTES+1024){error("Запрос Layer Set слишком велик");return;}
            final long epoch=pageEpoch.get();
            worker.execute(() -> {
                taskPage.set(epoch);
                String token="";JSONObject response=new JSONObject();
                try {
                    JSONObject request=new JSONObject(json);token=request.getString("token");
                    LayerSetStore store=new LayerSetStore(new File(getFilesDir(),"layer-sets"));
                    String operation=request.getString("op");response.put("operation",operation);Object result;
                    switch(operation){
                        case "list":result=store.list();break;
                        case "checkpointRoles":result=checkpointRoles(request.getString("id"));break;
                        case "roles":result=learnedRoles().status(LearnedRoles.context(store.get(request.getString("id"))));break;
                        case "resumeRoles":result=resumeRoles(request.getJSONObject("context"));break;
                        case "get":result=store.get(request.getString("id"));break;
                        case "save":
                            JSONObject set=request.getJSONObject("set");
                            if(pairedEvaluation!=null&&set.getString("id").equals(activeFdbLayerId))pairedEvaluation.profile(CheckpointDigest.of(set.getJSONObject("profile")),actuatorSignature(set));
                            if(frozenSeries!=null&&set.getString("id").equals(activeFdbLayerId))frozenSeries.profile(CheckpointDigest.of(set.getJSONObject("profile")),actuatorSignature(set));
                            if(fdbLearning!=null&&set.getString("id").equals(activeFdbLayerId))set=LayerSetStore.withFdb(set,labSystem,romHash,graph.fingerprint(),ids(experiment.inputs),ids(experiment.outputs),fdbState());
                            result=store.save(set);break;
                        case "delete":if(learnedRoles().protects(request.getString("id")))throw new IOException("Layer Set защищён ролями Current/Recovery; сохраните другое продолжение перед удалением");store.delete(request.getString("id"));if(request.getString("id").equals(activeFdbLayerId))invalidateFdbBinding();result=new JSONObject().put("id",request.getString("id"));break;
                        default:throw new IllegalArgumentException("Неизвестная операция Layer Set");
                    }
                    response.put("token",token).put("data",result);
                } catch(Exception ex){try{response.put("token",token).put("error",ex.getMessage()==null?"Layer Set недоступен":ex.getMessage());}catch(Exception ignored){}}
                emit("labLayerSets",response);
                taskPage.remove();
            });
        }
        @JavascriptInterface public void recognizeScore(String json) {
            if(destroyed)return;final long epoch=pageEpoch.get();
            scoreOcr.recognize(json,response->runOnUiThread(()->{if(!destroyed&&epoch==pageEpoch.get())emit("labScoreText",response);}));
        }
        @JavascriptInterface public void trainingSessions(String json) {
            if(destroyed)return;
            final long epoch=pageEpoch.get();
            try{worker.execute(() -> {
                taskPage.set(epoch);String token="";JSONObject response=new JSONObject();
                try {
                    if(json.getBytes(StandardCharsets.UTF_8).length>260*1024)throw new IllegalArgumentException("Запрос показа слишком велик");
                    JSONObject request=new JSONObject(json);token=request.getString("token");
                    TrainingSessionStore store=new TrainingSessionStore(new File(getFilesDir(),"human-sessions"));Object result;
                    switch(request.getString("op")){
                        case "list":result=store.list();break;
                        case "begin":result=store.begin(request.getJSONObject("session"));break;
                        case "append":result=store.append(request.getString("id"),request.getLong("sequence"),request.getJSONArray("events"));break;
                        case "close":result=store.close(request.getString("id"),request.getLong("endedAt"),request.getString("reason"));break;
                        case "read":result=store.read(request.getString("id"),request.getString("snapshot"),request.optJSONObject("cursor"));break;
                        case "delete":store.delete(request.getString("id"));result=new JSONObject().put("id",request.getString("id"));break;
                        case "export":
                            JSONObject session=store.get(request.getString("id"));result=session;
                            runOnUiThread(() -> {sessionExportId=session.optString("id");Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/x-ndjson").addCategory(Intent.CATEGORY_OPENABLE);intent.putExtra(Intent.EXTRA_TITLE,"fly-"+session.optString("system")+"-human-session.jsonl");startActivityForResult(intent,EXPORT_SESSION);});
                            break;
                        default:throw new IllegalArgumentException("Неизвестная операция показа");
                    }
                    response.put("token",token).put("data",result);
                } catch(Exception ex){try{response.put("token",token).put("error",ex.getMessage()==null?"Запись показа недоступна":ex.getMessage());}catch(Exception ignored){}}
                emit("labTrainingSessions",response);taskPage.remove();
            });}catch(java.util.concurrent.RejectedExecutionException ignored){}
        }
        @JavascriptInterface public void exportModel(String json) {
            if(destroyed)return;if(json.getBytes(StandardCharsets.UTF_8).length>8*1024*1024){error("JSON превышает 8 МиБ");return;}
            submit(() -> {
                try {
                    JSONObject document=new JSONObject(json);final String suffix=document.optString("type").endsWith("-report")?"report":"fly-layer-set".equals(document.optString("type"))?"layer-set":"model";
                    modelExport = new File(getFilesDir(), labSystem+"-"+suffix+"-export.json");
                    try (Writer writer = new OutputStreamWriter(new FileOutputStream(modelExport), StandardCharsets.UTF_8)) { writer.write(json); }
                    runOnUiThread(() -> {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE);
                        intent.putExtra(Intent.EXTRA_TITLE, "fly-"+labSystem+"-"+suffix+".json");
                        startActivityForResult(intent, EXPORT_MODEL);
                    });
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void exportCsv() {
            submit(() -> {
                try {
                    stopRecording();
                    if (recording == null || !recording.exists()) throw new IllegalStateException("Сначала включите запись");
                    emit("labRecording", new JSONObject().put("active", false));
                    runOnUiThread(() -> {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("text/csv").addCategory(Intent.CATEGORY_OPENABLE);
                        intent.putExtra(Intent.EXTRA_TITLE, "fly-"+labSystem+"-experiment.csv");
                        startActivityForResult(intent, EXPORT_CSV);
                    });
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
    }

    private void emitRequestFailure(String raw,String operation,String message) {
        try {emit("sample".equals(operation)?"labResult":"labError",LabRequestFailure.response(raw,operation,message));}
        catch(Exception malformed){
            // No safe generation/token exists. Record the malformed request without cancelling a newer one.
            android.util.Log.e("FlyConsole", "Uncorrelated "+operation+" failure: "+message,malformed);
        }
    }

    private static String readText(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) {
            if (bytes.size() + n > limit) throw new IOException("Файл слишком большой");
            bytes.write(buffer, 0, n);
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if(request==EXPORT_DIAGNOSTICS){diagnosticExportPending=false;String name=getSharedPreferences("diagnostics",MODE_PRIVATE).getString("pendingExport","");getSharedPreferences("diagnostics",MODE_PRIVATE).edit().remove("pendingExport").apply();
            if(!name.matches("gu-diagnostics-[a-f0-9-]{36}\\.zip")){JSONObject missing=message("Файл подготовленного отчёта отсутствует");diagnostic("error","diagnostics.export-missing",missing);Toast.makeText(this,"Файл подготовленного отчёта отсутствует",Toast.LENGTH_LONG).show();emit("labDiagnosticsSaved",missing);return;}File file=new File(getCacheDir(),name);
            if(result!=RESULT_OK||data==null||data.getData()==null){diagnostic("info","diagnostics.export-cancelled",new JSONObject());file.delete();emit("labDiagnosticsSaved",message("Экспорт отменён"));return;}
            final Uri destination=data.getData();new Thread(()->{String failure="";try(InputStream in=new FileInputStream(file);OutputStream out=getContentResolver().openOutputStream(destination,"wt")){if(out==null)throw new IOException("Файл назначения недоступен");byte[] buffer=new byte[64*1024];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);out.flush();}catch(Exception error){failure=error.getMessage()==null?error.getClass().getSimpleName():error.getMessage();}final String problem=failure;diagnostic(problem.isEmpty()?"info":"error","diagnostics.export-finished",message(problem));file.delete();runOnUiThread(()->{Toast.makeText(this,problem.isEmpty()?"Диагностический отчёт сохранён":"Отчёт не сохранён: "+problem,Toast.LENGTH_LONG).show();JSONObject reply=message(problem);try{reply.put("saved",problem.isEmpty());}catch(Exception ignored){}emit("labDiagnosticsSaved",reply);});},"gu-diagnostics-copy").start();return;
        }
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        submit(() -> {
            try {
                if (request == PICK_ROM) {
                    byte[] bytes;
                    try(InputStream in=getContentResolver().openInputStream(uri)){bytes=RomImport.unpack(RomImport.read(in,RomImport.MAX_FILE),labSystem);}
                    String name="Imported "+labSystem.toUpperCase(Locale.ROOT);
                    try(android.database.Cursor cursor=getContentResolver().query(uri,new String[]{android.provider.OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst())name=cursor.getString(0);}
                    loadRom(bytes,name,false,true);
                } else if (request == PICK_MODEL) {
                    try (InputStream in = getContentResolver().openInputStream(uri)) {
                        emit("labImportModel", new JSONObject(readText(in, 8 * 1024 * 1024)));
                    }
                } else if (request == EXPORT_MODEL) {
                    try (InputStream in = new FileInputStream(modelExport); OutputStream out = getContentResolver().openOutputStream(uri,"wt")) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                    }
                    runOnUiThread(() -> Toast.makeText(this, "JSON сохранён", Toast.LENGTH_SHORT).show());
                } else if (request == EXPORT_SESSION) {
                    try(OutputStream out=getContentResolver().openOutputStream(uri,"wt")) {
                        if(out==null)throw new IOException("Не удалось открыть файл экспорта");
                        new TrainingSessionStore(new File(getFilesDir(),"human-sessions")).export(sessionExportId,out);
                    }
                    runOnUiThread(() -> Toast.makeText(this,"Сессия показа сохранена",Toast.LENGTH_SHORT).show());
                } else if (request == EXPORT_CSV) {
                    try (InputStream in = new FileInputStream(recording); OutputStream out = getContentResolver().openOutputStream(uri,"wt")) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                    }
                    runOnUiThread(() -> Toast.makeText(this, "CSV сохранён", Toast.LENGTH_SHORT).show());
                }
            } catch (Exception ex) { error(ex.getMessage()); }
        });
    }

    private void applyGameDisplay() {
        int flags=android.view.View.SYSTEM_UI_FLAG_VISIBLE;
        if(immersiveDisplay)flags=android.view.View.SYSTEM_UI_FLAG_FULLSCREEN|android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION|android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY|android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE|android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN|android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if(focused)applyGameDisplay();
    }
    @Override public void onBackPressed(){
        diagnostic("info","input.back",new JSONObject());if(web==null||rendererGone){super.onBackPressed();return;}
        web.evaluateJavascript("Boolean(window.labBack&&window.labBack())",value->{if(!destroyed&&!"true".equals(value))NesLabActivity.super.onBackPressed();});
    }
    @Override protected void onPause() {
        if(controllers!=null)controllers.enabled(false);foreground=false;controlEpoch.incrementAndGet();cancel.set(true);
        final String ticket="pause-"+(++lifecycleSequence);lifecycleTicket=ticket;
        diagnostic("info","lifecycle.save-request",message(ticket));if(DeviceLog.get()!=null)DeviceLog.get().webVisible(false);
        if(web!=null&&!rendererGone)web.evaluateJavascript("if(window.labLifecycleSuspend)window.labLifecycleSuspend("+JSONObject.quote(ticket)+");",null);
        submit(()->{try{pauseDualNative();checkpointNativeCurrent();}catch(Exception ex){error("Checkpoint при паузе: "+ex.getMessage());}});
        super.onPause();
        // Keep WebView available for IndexedDB and bridge ACK; never pause a resumed page.
        if(web!=null&&!rendererGone)web.postDelayed(()->{if(!destroyed&&!foreground&&!rendererGone&&ticket.equals(lifecycleTicket)){lifecycleTicket="";lifecycleFailure="Сохранение при уходе в фон не подтверждено; сохранена прежняя проверенная версия";diagnostic("error","lifecycle.save-timeout",message(lifecycleFailure));android.util.Log.e("FlyConsole",lifecycleFailure);web.onPause();}},15000);
    }
    @Override protected void onResume() {
        super.onResume();foreground=true;lifecycleTicket="";if(controllers!=null)controllers.enabled(true); if (web != null&&!rendererGone) web.onResume();if(DeviceLog.get()!=null)DeviceLog.get().webVisible(!rendererGone);
        if(!lifecycleFailure.isEmpty())try{emit("labLifecycleNotice",new JSONObject().put("error",lifecycleFailure));lifecycleFailure="";}catch(Exception ignored){}
        if (dualAgents==null&&GraphCache.current != null && !GraphCache.same(GraphCache.current, graph)) submit(this::loadGraph);
    }
    @Override protected void onDestroy() {
        scoreOcr.close();
        if(controllers!=null)controllers.close();destroyed = true;
        cancel.set(true);
        worker.execute(() -> { try { stopRecording();pauseDualNative(); } catch (Exception ignored) { } closeGpu();clearDualNative(); });
        worker.shutdown();
        if(web!=null&&!rendererGone){web.removeJavascriptInterface("FlyBridge");web.destroy();}
        super.onDestroy();
    }
}
