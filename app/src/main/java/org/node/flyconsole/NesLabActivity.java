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
    private static final int PICK_ROM = 10, EXPORT_CSV = 11, PICK_MODEL = 12, EXPORT_MODEL = 13;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancel = new AtomicBoolean();
    private final AtomicLong pageEpoch=new AtomicLong(),controlEpoch=new AtomicLong();private final ThreadLocal<Long> taskPage=new ThreadLocal<>();private volatile boolean foreground;
    private WebView web;
    private volatile Graph graph;
    private Engine engine;
    private GpuLifEngine gpuEngine;
    private String backend = "cpu";
    private Experiment experiment;
    private volatile boolean destroyed;
    private volatile boolean pageReady;
    private String initialError;
    private volatile String labSystem="nes";
    private String graphKind = "FlyWire v783 / Shiu signed model";
    private String romHash = "not-loaded";
    private final java.util.ArrayDeque<String> offeredRomHashes = new java.util.ArrayDeque<>();
    private long sequence, configVersion;
    private int latestMask;
    private BufferedWriter recorder;
    private File recording;
    private File modelExport;
    private long recordedBytes;
    private boolean recordingOn;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        labSystem="sega".equals(getIntent().getStringExtra("system"))?"sega":"nes";
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
                    String mime = path.endsWith(".js") ? "application/javascript" :
                        path.endsWith(".json") ? "application/json" : path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".zip") ? "application/zip" : "text/html";
                    return response(mime, getAssets().open(path.substring(1)));
                } catch (IOException ex) { return response("text/plain", new ByteArrayInputStream(new byte[0])); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView view, String url) {
                submit(() -> { pageReady = true; if(engine==null)loadGraph();else announce(); });
            }
        });
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

    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);switchSystem("sega".equals(intent.getStringExtra("system"))?"sega":"nes");}
    private void switchSystem(String system){
        if (system.equals(labSystem)) return;
        cancel.set(true);controlEpoch.incrementAndGet();
        worker.execute(()->{try{stopRecording();offeredRomHashes.clear();}catch(IOException ex){error(ex.getMessage());}});
        web.evaluateJavascript("if(window.labPause)window.labPause();try{persistPolicy(false);document.getElementById('saveProfile').onclick();}catch(e){}", ignored -> {
            pageEpoch.incrementAndGet();labSystem=system;pageReady=false;romHash="not-loaded";recording=new File(getFilesDir(),labSystem+"-experiment.csv");
            web.loadUrl(ORIGIN+"/lab/index.html?system="+labSystem);
        });
    }
    private void loadGraph(){try{long free=Runtime.getRuntime().maxMemory()-Runtime.getRuntime().totalMemory()+Runtime.getRuntime().freeMemory();Graph loaded=GraphCache.load(new File(getFilesDir(),"connectome.fly"),()->{try{return getAssets().open("brain.fly.gz");}catch(IOException ex){return getAssets().open("brain.fly");}},free*2/3);Experiment next=Experiment.automatic(loaded);Engine nextEngine=new Engine(loaded);closeGpu();graph=loaded;graphKind=GraphCache.kind;experiment=next;engine=nextEngine;backend="cpu";initialError=null;announce();}catch(Exception|OutOfMemoryError ex){engine=null;graph=null;error("Коннектом не загрузился: "+ex.getMessage()+". Эмулятор доступен вручную.");}}

    private void announce() {
        if (!pageReady) return;
        if (engine == null) { if (initialError != null) error(initialError); return; }
        try {
            JSONObject info = new JSONObject();
            info.put("system",labSystem).put("neurons", graph.ids.length).put("edges", graph.targets.length).put("kind", graphKind);
            info.put("inputs", ids(experiment.inputs)).put("outputs", ids(experiment.outputs));
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
        if (engine == null) throw new IllegalStateException("Коннектом ещё не готов");
        String requestedBackend=data.optString("backend","cpu");
        if (!requestedBackend.equals("cpu")&&!requestedBackend.equals("gpu")) throw new IllegalArgumentException("Неизвестный backend");
        if (requestedBackend.equals("gpu") && Build.VERSION.SDK_INT < 21) throw new IllegalArgumentException("GPU backend требует Android 5.0+");
        Experiment next = new Experiment(parsePorts(data.getJSONArray("inputs"), 16), parsePorts(data.getJSONArray("outputs"), 8));
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
        long seed=data.getLong("seed"); if(data.getDouble("seed")!=seed||seed<0||seed>2147483647L) throw new IllegalArgumentException("Seed 0–2147483647");
        next.seedPermutation(seed);
        JSONArray lesions=data.getJSONArray("lesions"); if(lesions.length()>256) throw new IllegalArgumentException("Не более 256 абляций");
        next.options.lesions=parsePorts(lesions,lesions.length());

        if (requestedBackend.equals("gpu")) {
            if (gpuEngine == null) gpuEngine = new GpuLifEngine(graph);
            gpuEngine.reset(next.seed);
        } else {
            closeGpu();
            engine.reset(next.seed);
        }
        backend=requestedBackend;
        experiment=next; configVersion++; sequence=0; latestMask=0;
        if(recordingOn) recorder.write("# config,"+data.put("configVersion",configVersion).put("backend",backend).toString().replace('\n',' ')+"\n");
        emit("labConfigured",new JSONObject().put("configVersion",configVersion).put("mode",next.mode).put("backend",backend).put("generation",data.optLong("generation",-1)));
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
        response.put("buttons",latestMask).put("backend",backend).put("backendNote","gpu".equals(backend)?"OpenGL ES 3.1 compute, q16.8 weights":"Java CPU reference");
        response.put("spikes",result.spikes).put("active",result.active).put("simMs",result.endTick*.1).put("wallMs",result.wallSeconds*1000);
        response.put("steps",result.steps).put("configVersion",configVersion);
        JSONArray output=new JSONArray(); for(int index:experiment.outputs) output.put(result.steps==0?0:result.counts[index]*10000.0/result.steps);
        response.put("outputs",output).put("inputs",new JSONArray(rates)).put("sequence",++sequence);
        if(recordingOn) record(request,rates,result,latestMask);
        emit("labResult",response);
    }

    private void record(JSONObject request, double[] rates, Engine.Result result, int mask) throws Exception {
        StringBuilder row = new StringBuilder();
        row.append(System.currentTimeMillis()).append(',').append(configVersion).append(',').append(sequence)
            .append(',').append(request.getLong("frame")).append(',').append(result.endTick * .1)
            .append(',').append(String.format(Locale.US, "%.3f", result.wallSeconds * 1000))
            .append(',').append(result.spikes).append(',').append(result.active).append(',').append(mask).append(',').append(request.optInt("manualMask", 0)).append(',').append(request.optBoolean("frozen", false) ? 1 : 0);
        row.append(',').append(request.optInt("controllerMask", 0)).append(',').append(request.optString("learningMode", "off").replaceAll("[^a-z]", "")).append(',').append(request.optDouble("learningReward", 0));
        for (double rate : rates) row.append(',').append(String.format(Locale.US, "%.3f", rate));
        for (int output : experiment.outputs) row.append(',').append(result.counts[output]);
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
        if ("gpu".equals(backend) && gpuEngine != null) gpuEngine.reset(experiment.seed); else engine.reset(experiment.seed); configVersion++; sequence = 0;
        recording = new File(getFilesDir(), labSystem+"-experiment.csv");
        recorder = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(recording), StandardCharsets.UTF_8));
        recordedBytes = 0;
        recorder.write("# system,"+labSystem+"\n");
        recorder.write("# model," + graphKind + ",neurons=" + graph.ids.length + ",edges=" + graph.targets.length + ",backend=" + backend + ",dt_ms=0.1,brian2_parity=unverified,sha256="+graph.fingerprint()+"\n");
        recorder.write("# rom_sha256," + romHash + "\n");
        StringBuilder header = new StringBuilder("wall_epoch_ms,config_version,sequence,emulator_frame,sim_ms,compute_ms,spikes,active,buttons_mask,manual_mask,frozen_retina,controller_mask,learning_mode,learning_reward");
        for (int i = 0; i < 16; i++) header.append(",input_hz_").append(i);
        for (int i=0;i<Experiment.BUTTONS.length;i++) header.append(",spikes_").append(i==2&&"sega".equals(labSystem)?"C":Experiment.BUTTONS[i]);
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
        emit("labRecording", new JSONObject().put("active", true));
    }

    private void closeGpu(){ if(gpuEngine!=null){ try{gpuEngine.close();}catch(Exception ignored){} gpuEngine=null; } }

    private void stopRecording() throws IOException {
        recordingOn = false;
        if (recorder != null) { recorder.close(); recorder = null; }
    }

    private void loadRom(byte[] bytes, String name) throws Exception {
        if (bytes.length < 16 || bytes.length > ("sega".equals(labSystem)?8:4) * 1024 * 1024 || (!"sega".equals(labSystem) && (bytes[0] != 78 || bytes[1] != 69 || bytes[2] != 83 || bytes[3] != 26)))
            throw new IllegalArgumentException("Неверный размер/заголовок ROM (NES ≤4 МиБ, Sega ≤8 МиБ)");
        StringBuilder hash = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format(Locale.US, "%02x", b & 255));
        String candidateHash = hash.toString();
        offeredRomHashes.addLast(candidateHash);
        if (offeredRomHashes.size() > 8) offeredRomHashes.removeFirst();
        // Commit model/recording identity only after the JS core accepts the ROM.
        emit("labLoadRom", new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("name", name).put("sha256", candidateHash));
    }

    public final class Bridge {
        @JavascriptInterface public void switchSystem(String system){if(!system.equals("nes")&&!system.equals("sega"))return;runOnUiThread(()->NesLabActivity.this.switchSystem(system));}
        @JavascriptInterface public void acceptRom(String sha256) {
            if (destroyed || sha256.length() != 64) return;
            submit(() -> {
                try {
                    if (!offeredRomHashes.remove(sha256)) return;
                    romHash = sha256;
                    if (engine != null) { if ("gpu".equals(backend) && gpuEngine != null) gpuEngine.reset(experiment.seed); else engine.reset(experiment.seed); configVersion++; sequence = 0; }
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
            if (destroyed || json.length() > 32768) return;
            cancel.set(true);final long epoch=controlEpoch.incrementAndGet();
            submit(() -> {
                try { NesLabActivity.this.configure(new JSONObject(json)); }
                catch (Exception ex) { error(ex.getMessage()); }
                finally { if(controlEpoch.get()==epoch&&foreground)cancel.set(false); }
            });
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
                try (InputStream in = getAssets().open("sega".equals(labSystem)?"lab/demo-sega.json":"lab/demo-rom.json")) {
                    JSONObject data = new JSONObject(readText(in, 100000));
                    loadRom(Base64.decode(data.getString("base64"), Base64.DEFAULT), "sega".equals(labSystem)?"Fly MD original diagnostic":"Fly NES diagnostic / NROM-0");
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
        @JavascriptInterface public void exportModel(String json) {
            if(destroyed)return;if(json.getBytes(StandardCharsets.UTF_8).length>8*1024*1024){error("JSON превышает 8 МиБ");return;}
            submit(() -> {
                try {
                    JSONObject document=new JSONObject(json);final String suffix="fly-evaluation-report".equals(document.optString("type"))?"report":"model";
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
                    try (InputStream in = getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) != -1) {
                            if (out.size() + n > ("sega".equals(labSystem)?8:4) * 1024 * 1024) throw new IOException("ROM превышает лимит режима");
                            out.write(buffer, 0, n);
                        }
                        bytes = out.toByteArray();
                    }
                    loadRom(bytes, "sega".equals(labSystem)?"Imported Mega Drive":"Imported .nes");
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
        foreground=false;controlEpoch.incrementAndGet();cancel.set(true);
        web.evaluateJavascript("if(window.labPause)window.labPause();", null);
        super.onPause();
        web.onPause();
    }
    @Override protected void onResume() {
        super.onResume();foreground=true; if (web != null) web.onResume();
        if (GraphCache.current != null && GraphCache.current != graph) submit(this::loadGraph);
    }
    @Override protected void onDestroy() {
        destroyed = true;
        cancel.set(true);
        worker.execute(() -> { try { stopRecording(); } catch (IOException ignored) { } closeGpu(); });
        worker.shutdown();
        web.removeJavascriptInterface("FlyBridge");
        web.destroy();
        super.onDestroy();
    }
}
