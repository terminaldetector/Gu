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
    private static final int PICK_ROM = 10, EXPORT_CSV = 11, PICK_MODEL = 12, EXPORT_MODEL = 13, EXPORT_SESSION = 14;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
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
    private String graphKind = "FlyWire v783 / Shiu signed model";
    private String romHash = "not-loaded";
    private final java.util.ArrayDeque<String> offeredRomHashes = new java.util.ArrayDeque<>();
    private long sequence, configVersion;
    private boolean neuralConfigured;
    private volatile boolean platformPortsPending=true;
    private ControllerInput controllers;
    private int latestMask;
    private BufferedWriter recorder;
    private File recording;
    private File modelExport;
    private String sessionExportId;
    private long recordedBytes;
    private boolean recordingOn;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        labSystem=RomImport.system(getIntent().getStringExtra("system"));
        web = new WebView(this);
        web.setBackgroundColor(android.graphics.Color.rgb(8,10,19));
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.getSettings().setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "FlyBridge");
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
                submit(() -> { pageReady = true; if(engine==null)loadGraph();else announce(); });
            }
        });
        controllers=new ControllerInput(this,data->emit("labController",data));controllers.system(labSystem);
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
    private void switchSystem(String system){
        if (system.equals(labSystem)) return;
        cancel.set(true);controlEpoch.incrementAndGet();
        worker.execute(()->{try{stopRecording();offeredRomHashes.clear();}catch(IOException ex){error(ex.getMessage());}});
        web.evaluateJavascript("if(window.labPause)window.labPause();try{if(window.layerExperience)window.layerExperience.autosave();persistPolicy(false);document.getElementById('saveProfile').onclick();}catch(e){}", ignored -> {
            pageEpoch.incrementAndGet();if(controllers!=null)controllers.system(system);labSystem=system;platformPortsPending=true;pageReady=false;romHash="not-loaded";recording=new File(getFilesDir(),labSystem+"-experiment.csv");
            web.loadUrl(ORIGIN+"/lab/index.html?system="+labSystem);
        });
    }
    private void loadGraph(){neuralConfigured=false;try{long free=Runtime.getRuntime().maxMemory()-Runtime.getRuntime().totalMemory()+Runtime.getRuntime().freeMemory();Graph loaded=GraphCache.load(new File(getFilesDir(),"connectome.fly"),()->{try{return getAssets().open("brain.fly.gz");}catch(IOException ex){return getAssets().open("brain.fly");}},free*2/3);Experiment next=Experiment.automatic(loaded,RomImport.wide(labSystem)&&loaded.ids.length>=28?12:8);Engine nextEngine=new Engine(loaded);closeGpu();graph=loaded;graphKind=GraphCache.kind;experiment=next;engine=nextEngine;backend="cpu";initialError=null;announce();}catch(Exception|OutOfMemoryError ex){engine=null;graph=null;error("Коннектом не загрузился: "+ex.getMessage()+". Эмулятор доступен вручную.");}}

    private void announce() {
        if (!pageReady) return;
        if (engine == null) { if (initialError != null) error(initialError); return; }
        try {
            JSONObject info = new JSONObject();
            info.put("system",labSystem).put("neurons", graph.ids.length).put("edges", graph.targets.length).put("kind", graphKind);
            Experiment ports=platformPortsPending?Experiment.automatic(graph,RomImport.wide(labSystem)&&graph.ids.length>=28?12:8):experiment;
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
        if (destroyed) return;
        final long epoch=taskPage.get()==null?pageEpoch.get():taskPage.get();
        String script = "if(window." + method + ")window." + method + "(" + value + ");";
        runOnUiThread(() -> { if (!destroyed&&epoch==pageEpoch.get()) web.evaluateJavascript(script, null); });
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
            if(!graph.fingerprint().equals(fdb.getString("graph_sha256")))throw new IllegalArgumentException("FDB belongs to another connectome");
            GraphDelta layer=new GraphDelta(graph.ids.length);
            for(String kind:new String[]{"deltas","edges"}){
                JSONArray links=fdb.optJSONArray(kind);if(links==null){if(fdb.has(kind))throw new IllegalArgumentException("FDB list must be array");continue;}
                if(links.length()>1024)throw new IllegalArgumentException("FDB UI limit: 1024 links per list");
                for(int k=0;k<links.length();k++){
                    JSONObject link=links.getJSONObject(k);
                    if(!(link.get("source") instanceof String)||!(link.get("target") instanceof String))throw new IllegalArgumentException("FDB IDs must be strings");
                    int source=engine.index(Long.parseLong(link.getString("source")));
                    int target=engine.index(Long.parseLong(link.getString("target")));
                    double value=link.getDouble("weight");if(!Double.isFinite(value)||Math.abs(value)>127)throw new IllegalArgumentException("FDB weight must be -127..127");
                    if(kind.equals("deltas")){
                        boolean exists=false;for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target){exists=true;break;}
                        if(!exists)throw new IllegalArgumentException("FDB delta requires existing base edge");
                        layer.addWeightDelta(source,target,(float)value);
                    }else layer.addEdge(source,target,(float)value);
                }
            }
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
                    nextLearning=new FdbLearning(graph,layer,next.inputs,next.outputs,learning.getDouble("rate"),learning.getInt("maxEdges"),(float)learning.getDouble("maxWeight"));
                    JSONObject state=fdb.optJSONObject("learningState");
                    if(state!=null){
                        if(state.getInt("version")!=1||!ids(next.inputs).toString().equals(state.getJSONArray("sources").toString())||!ids(next.outputs).toString().equals(state.getJSONArray("targets").toString()))throw new IllegalArgumentException("FDB learning checkpoint ports");
                        for(String k:new String[]{"observations","human","automatic"})if(!(state.get(k) instanceof Number)||state.getDouble(k)!=state.getLong(k))throw new IllegalArgumentException("FDB learning counter");
                        nextLearning.restore(state.getLong("observations"),state.getLong("human"),state.getLong("automatic"));
                    }
                }
            }
            next.options.delta=layer;
        }

        if(!reset&&!data.optBoolean("restoreGrowthState",false)&&fdb!=null&&experiment.options.delta!=null&&java.util.Arrays.equals(next.inputs,experiment.inputs)&&java.util.Arrays.equals(next.outputs,experiment.outputs)){
            JSONObject current=fdbState();
            JSONArray ds=fdb.optJSONArray("deltas"),es=fdb.optJSONArray("edges");
            if(current.getJSONArray("deltas").toString().equals(ds==null?"[]":ds.toString())&&current.getJSONArray("edges").toString().equals(es==null?"[]":es.toString())
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
        experiment=next;fdbGrowth=nextGrowth;growthConfiguration=nextGrowthConfig;fdbLearning=nextLearning;learningConfiguration=nextLearningConfig; configVersion++; if(reset)sequence=0; latestMask=0;neuralConfigured=true;
        if(recordingOn) recorder.write("# config,"+data.put("configVersion",configVersion).put("backend",backend).toString().replace('\n',' ')+"\n");
        emit("labConfigured",new JSONObject().put("reset",reset).put("initial",initial).put("configVersion",configVersion).put("mode",next.mode).put("backend",backend).put("generation",data.optLong("generation",-1)));
    }

    private int systemButtonMask(String mode){
        if(mode.equals("auto"))return RomImport.wide(labSystem)?4095:255;
        if(mode.equals("blocked"))return RomImport.wide(labSystem)?2039:243;
        throw new IllegalArgumentException("Неизвестный режим Start/Select");
    }

    private void sample(JSONObject request) throws Exception {
        if (engine == null) throw new IllegalStateException("Коннектом недоступен");
        JSONArray pixels=request.getJSONArray("retina"); if(pixels.length()!=16) throw new IllegalArgumentException("Нужно 16 ячеек экрана");
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
        int grown=fdbGrowth==null||cancel.get()?0:fdbGrowth.observe(result,request.optDouble("learningReward",0),experiment.options.lesions,frozen);
        int adapted=0;
        JSONArray experience=request.optJSONArray("experience");
        if(experience!=null&&experience.length()>16)throw new IllegalArgumentException("FDB batch limit");
        // Validate the entire bounded batch before changing any edge.
        if(experience!=null)for(int k=0;k<experience.length();k++){
            JSONObject e=experience.getJSONObject(k);JSONArray retina=e.getJSONArray("retina");
            if(retina.length()!=16||!(e.get("mask") instanceof Number)||e.getDouble("mask")!=e.getInt("mask")||e.getInt("mask")<0||e.getInt("mask")>systemButtonMask("auto")||(e.getInt("mask")&48)==48||(e.getInt("mask")&192)==192||!Double.isFinite(e.getDouble("reward"))||Math.abs(e.getDouble("reward"))>20||!(e.get("human") instanceof Boolean))throw new IllegalArgumentException("FDB labelled experience");
            for(int j=0;j<16;j++)if(!Double.isFinite(retina.getDouble(j))||retina.getDouble(j)<0||retina.getDouble(j)>1)throw new IllegalArgumentException("FDB retina");
        }
        if(fdbLearning!=null&&learningConfiguration.getBoolean("enabled")&&experience!=null&&!cancel.get()&&!frozen&&(learningMode.equals("teach")||learningMode.equals("train")))for(int k=0;k<experience.length();k++){
            JSONObject e=experience.getJSONObject(k);double[] input=new double[16];for(int j=0;j<16;j++)input[j]=e.getJSONArray("retina").getDouble(j);
            if((e.getInt("mask")&~experiment.agentButtonMask)!=0||e.getInt("mask")>=(1<<experiment.outputs.length))continue;
            adapted+=fdbLearning.observe(input,e.getInt("mask"),e.getDouble("reward"),e.getBoolean("human"),experiment.options.lesions,false);
        }
        if(fdbLearning!=null)response.put("fdbLearningState",learningState());
        response.put("fdbAdapted",adapted);
        if(fdbGrowth!=null)response.put("fdbGrowthState",growthState());
        response.put("fdbGrown",grown).put("fdbRevision",experiment.options.delta==null?0:experiment.options.delta.version());
        if(experiment.options.delta!=null&&experiment.options.delta.version()!=oldRevision){
            JSONObject state=fdbState();response.put("fdbState",state);
            if(recordingOn){String mutation="# fdb_mutation,"+(sequence+1)+","+state.toString()+"\n";recorder.write(mutation);recordedBytes+=mutation.getBytes(StandardCharsets.UTF_8).length;}
        }
        response.put("fdbEdges",experiment.options.delta==null?0:experiment.options.delta.growthCount()).put("fdbDeltas",experiment.options.delta==null?0:experiment.options.delta.deltaCount());
        response.put("outputs",output).put("inputs",new JSONArray(rates)).put("sequence",++sequence);
        if(recordingOn) record(request,rates,result,latestMask);
        emit("labResult",response);
    }

    private JSONObject fdbState() throws Exception {
        JSONObject state=new JSONObject().put("graph_sha256",graph.fingerprint());
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

    private JSONObject learningState()throws Exception{return new JSONObject().put("version",1).put("observations",fdbLearning.observations()).put("human",fdbLearning.human()).put("automatic",fdbLearning.automatic()).put("sources",ids(experiment.inputs)).put("targets",ids(experiment.outputs));}

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

    private void loadRom(byte[] bytes, String name) throws Exception {
        bytes=RomImport.normalize(bytes,labSystem);
        StringBuilder hash = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format(Locale.US, "%02x", b & 255));
        String candidateHash = hash.toString();
        offeredRomHashes.addLast(candidateHash);
        if (offeredRomHashes.size() > 8) offeredRomHashes.removeFirst();
        // Commit model/recording identity only after the JS core accepts the ROM.
        emit("labLoadRom", new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("name", name).put("sha256", candidateHash));
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event){return controllers!=null&&controllers.key(event)||super.dispatchKeyEvent(event);}
    @Override public boolean dispatchGenericMotionEvent(android.view.MotionEvent event){return controllers!=null&&controllers.motion(event)||super.dispatchGenericMotionEvent(event);}

    public final class Bridge {
        @JavascriptInterface public void controls(boolean enabled){runOnUiThread(()->{if(controllers!=null)controllers.enabled(enabled&&foreground);});}
        @JavascriptInterface public void switchSystem(String system){if(!RomImport.validSystem(system))return;runOnUiThread(()->NesLabActivity.this.switchSystem(system));}
        @JavascriptInterface public void acceptRom(String sha256) {
            if (destroyed || sha256.length() != 64) return;
            submit(() -> {
                try {
                    if (!offeredRomHashes.remove(sha256)) return;
                    romHash = sha256;
                    latestMask=0; // ROM acceptance changes console identity, never neural state.
                    if (recordingOn) { recorder.write("# rom_sha256," + romHash + "\n"); recorder.flush(); }
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void sample(String json) {
            if (destroyed || json.length() > 8192) return;
            submit(() -> {
                try { NesLabActivity.this.sample(new JSONObject(json)); }
                catch (Exception ex) { error(ex.getMessage()); emitFailedSample(json); }
            });
        }
        @JavascriptInterface public void configure(String json) {
            if (destroyed) return;
            if(json.length()>1024*1024){error("Конфигурация превышает 1 МиБ");return;}
            cancel.set(true);final long epoch=controlEpoch.incrementAndGet();
            submit(() -> {
                try { NesLabActivity.this.configure(new JSONObject(json)); }
                catch (Exception ex) { error(ex.getMessage()); }
                finally { if(controlEpoch.get()==epoch&&foreground)cancel.set(false); }
            });
        }
        @JavascriptInterface public void systemButtons(String json) {
            if(destroyed||json.length()>8192)return;
            submit(()->{try{
                JSONObject data=new JSONObject(json);int mask=systemButtonMask(data.getString("mode"));
                if(experiment==null)throw new IllegalStateException("Коннектом не готов");
                experiment.agentButtonMask=mask;latestMask&=mask;
                if(recordingOn)recorder.write("# system_buttons,"+data.getString("mode")+",allowed_mask="+mask+"\n");
                emit("labSystemButtons",new JSONObject().put("mode",data.getString("mode")).put("generation",data.getLong("generation")));
            }catch(Exception ex){error(ex.getMessage());}});
        }
        @JavascriptInterface public void orientation(String mode) {
            final int choice;
            if("auto".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER;
            else if("portrait".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            else if("landscape".equals(mode))choice=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            else return;
            runOnUiThread(()->setRequestedOrientation(choice));
        }
        @JavascriptInterface public void stop() { controlEpoch.incrementAndGet();cancel.set(true); }
        @JavascriptInterface public void resume() { if(foreground)cancel.set(false); }
        @JavascriptInterface public void console() {
            runOnUiThread(() -> startActivity(new Intent(NesLabActivity.this,CodeLabActivity.class).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
        }
        @JavascriptInterface public void pickRom() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                startActivityForResult(intent, PICK_ROM);
            });
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
                    String operation=request.getString("op");Object result;
                    switch(operation){
                        case "list":result=store.list();break;
                        case "get":result=store.get(request.getString("id"));break;
                        case "save":result=store.save(request.getJSONObject("set"));break;
                        case "delete":store.delete(request.getString("id"));result=new JSONObject().put("id",request.getString("id"));break;
                        default:throw new IllegalArgumentException("Неизвестная операция Layer Set");
                    }
                    response.put("token",token).put("data",result);
                } catch(Exception ex){try{response.put("token",token).put("error",ex.getMessage()==null?"Layer Set недоступен":ex.getMessage());}catch(Exception ignored){}}
                emit("labLayerSets",response);
                taskPage.remove();
            });
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

    private void emitFailedSample(String raw) {
        try {
            JSONObject request = new JSONObject(raw);
            emit("labResult", new JSONObject().put("token", request.getLong("token")).put("generation", request.getLong("generation")).put("error", true).put("buttons", 0));
        } catch (Exception ignored) { /* malformed request cannot be acknowledged */ }
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
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        submit(() -> {
            try {
                if (request == PICK_ROM) {
                    byte[] bytes;
                    try(InputStream in=getContentResolver().openInputStream(uri)){bytes=RomImport.unpack(RomImport.read(in,RomImport.MAX_FILE),labSystem);}
                    loadRom(bytes,"Imported "+labSystem.toUpperCase(Locale.ROOT));
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

    @Override protected void onPause() {
        if(controllers!=null)controllers.enabled(false);foreground=false;controlEpoch.incrementAndGet();cancel.set(true);
        web.evaluateJavascript("if(window.labPause)window.labPause();if(window.layerExperience)window.layerExperience.autosave();try{if(loaded&&ready&&document.getElementById('autosavePolicy').checked)persistPolicy(false);}catch(e){if(window.console)console.warn(e.message);}", null);
        super.onPause();
        web.onPause();
    }
    @Override protected void onResume() {
        super.onResume();foreground=true;if(controllers!=null)controllers.enabled(true); if (web != null) web.onResume();
        if (GraphCache.current != null && !GraphCache.same(GraphCache.current, graph)) submit(this::loadGraph);
    }
    @Override protected void onDestroy() {
        if(controllers!=null)controllers.close();destroyed = true;
        cancel.set(true);
        worker.execute(() -> { try { stopRecording(); } catch (IOException ignored) { } closeGpu(); });
        worker.shutdown();
        web.removeJavascriptInterface("FlyBridge");
        web.destroy();
        super.onDestroy();
    }
}
