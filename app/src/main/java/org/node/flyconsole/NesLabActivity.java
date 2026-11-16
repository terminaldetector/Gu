package org.node.flyconsole;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/** Local-only WebView emulator host: ROM import and library, game lifecycle,
    controllers, diagnostics and score OCR. The emulators and AGOD run in the page;
    there is no neural backend (archived on branch archive/gu-2be2dae-male-cns-fdb). */
public final class NesLabActivity extends Activity {
    private static final String ORIGIN = "https://flyconsole.local";
    private static final int PICK_ROM = 10, EXPORT_DIAGNOSTICS = 15;
    private boolean diagnosticExportPending,rendererGone;
    private final java.util.Map<Integer,Boolean> diagnosticControllers=new java.util.HashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ScoreOcr scoreOcr=new ScoreOcr();
    private final AtomicLong pageEpoch=new AtomicLong();private final ThreadLocal<Long> taskPage=new ThreadLocal<>();private volatile boolean foreground;
    private WebView web;
    private volatile boolean destroyed;
    private volatile boolean pageReady;
    private String initialError;
    private volatile String labSystem="nes";
    private String romHash = "not-loaded";
    private final java.util.ArrayDeque<String> offeredRomHashes = new java.util.ArrayDeque<>();
    private final java.util.Map<String,JSONObject> offeredLibraryRoms=new java.util.HashMap<>();
    private String pendingLibrarySystem="",pendingLibraryHash="";
    private long lifecycleSequence;
    private volatile String lifecycleTicket="";
    private String lifecycleFailure="";
    private ControllerInput controllers;
    private boolean immersiveDisplay;

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
                if(url.startsWith(ORIGIN+"/lab/index.html"))view.evaluateJavascript("Boolean(window.guLogger && window.labPause && window.labLoadRom)",value->{if(!destroyed&&!rendererGone&&!"true".equals(value)){diagnostic("error","web.initialization-failed",message("Основной JavaScript не запустился"));new android.app.AlertDialog.Builder(NesLabActivity.this).setTitle("Не удалось запустить игровой экран").setMessage("Сохраните диагностический отчёт для проверки ошибки.").setPositiveButton("Сохранить отчёт",(dialog,which)->exportDiagnostics()).setNegativeButton("Повторить запуск",(dialog,which)->recreate()).show();}});
                submit(() -> { pageReady = true; if(initialError!=null){String pending=initialError;initialError=null;error(pending);} });
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,android.webkit.WebResourceError error){try{diagnostic("error","web.resource-error",new JSONObject().put("code",error.getErrorCode()).put("message",error.getDescription()).put("mainFrame",request.isForMainFrame()).put("path",request.getUrl().getPath()));}catch(Exception ignored){}}
            @Override public boolean onRenderProcessGone(WebView view,android.webkit.RenderProcessGoneDetail detail){rendererGone=true;try{diagnostic("fatal","web.renderer-gone",new JSONObject().put("didCrash",detail.didCrash()).put("priorityAtExit",detail.rendererPriorityAtExit()));}catch(Exception ignored){}if(DeviceLog.get()!=null)DeviceLog.get().webVisible(false);if(view.getParent() instanceof android.view.ViewGroup)((android.view.ViewGroup)view.getParent()).removeView(view);view.destroy();android.widget.LinearLayout fallback=new android.widget.LinearLayout(NesLabActivity.this);fallback.setOrientation(android.widget.LinearLayout.VERTICAL);android.widget.TextView text=new android.widget.TextView(NesLabActivity.this);text.setText("Игровой экран завершился с ошибкой. Последние подтверждённые сохранения остаются доступны. Сохраните диагностический отчёт перед повторным запуском.");fallback.addView(text);android.widget.Button export=new android.widget.Button(NesLabActivity.this);export.setText("Сохранить диагностический отчёт");export.setOnClickListener(v->exportDiagnostics());fallback.addView(export);android.widget.Button reopen=new android.widget.Button(NesLabActivity.this);reopen.setText("Открыть приложение заново");reopen.setOnClickListener(v->recreate());fallback.addView(reopen);setContentView(fallback);return true;}
        });
        controllers=new ControllerInput(this,data->{int id=data.optInt("id");boolean online=data.optBoolean("connected");Boolean previous=diagnosticControllers.put(id,online);if(previous==null||previous!=online)try{diagnostic("info","input.controller-connection",new JSONObject().put("id",id).put("connected",online).put("name",data.optString("name")).put("sources",data.optInt("sources")).put("virtual",data.opt("virtual")));}catch(Exception ignored){}if(diagnosticControllers.size()>64)diagnosticControllers.clear();emit("labController",data);});controllers.system(labSystem);
        UiInsets.attachWeb(this,web);
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
        worker.execute(()->{try{
            offeredRomHashes.clear();offeredLibraryRoms.clear();
            runOnUiThread(()->{if(destroyed)return;pageEpoch.incrementAndGet();if(controllers!=null)controllers.system(system);labSystem=system;getSharedPreferences("flyconsole-ui",MODE_PRIVATE).edit().putString("system",system).apply();pendingSystem=null;pageReady=false;romHash="not-loaded";web.loadUrl(ORIGIN+"/lab/index.html?system="+labSystem);});
        }catch(Exception ex){runOnUiThread(()->pendingSystem=null);error("Платформа не переключена: "+ex.getMessage());}});
    }

    private void emit(String method, JSONObject value) {
        if(value.has("error")||value.has("saveError")||method.matches("labLoadRom|labError|labLifecycleNotice"))try{
            if(DeviceLog.get()!=null)DeviceLog.get().context(new JSONObject().put("system",labSystem).put("romHash",romHash).put("pageEpoch",pageEpoch.get()));
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
        if (!pageReady) { initialError = message; return; }
        try { emit("labError", new JSONObject().put("message", message == null ? "Ошибка" : message)); }
        catch (Exception ignored) { /* JSON string insertion cannot fail for a finite string. */ }
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
        // Commit ROM identity only after the JS core accepts the ROM.
        emit("labLoadRom", new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("name", name).put("sha256", candidateHash).put("resume",resume).put("system",labSystem).put("userOpened",userOpened));
    }

    @Override public boolean dispatchKeyEvent(android.view.KeyEvent event){return controllers!=null&&controllers.key(event)||super.dispatchKeyEvent(event);}
    @Override public boolean dispatchGenericMotionEvent(android.view.MotionEvent event){return controllers!=null&&controllers.motion(event)||super.dispatchGenericMotionEvent(event);}

    /** The emulator-host bridge: exactly the methods the page calls
        (tools/emulator_independence_check.cjs checks both directions). */
    public final class Bridge {
        @JavascriptInterface public void diagnostics(String raw){
            if(destroyed||raw.length()>64*1024)return;String token="";JSONObject response=new JSONObject();try{JSONObject request=new JSONObject(raw);token=request.getString("token");DeviceLog logger=DeviceLog.get();if(logger==null)throw new IOException("Журнал недоступен");String op=request.getString("op");
                if(op.equals("events"))logger.ingest(request);else if(op.equals("export"))runOnUiThread(()->exportDiagnostics());else if(!op.equals("status"))throw new IOException("Операция журнала");response.put("token",token).put("data",logger.status());
            }catch(Exception failure){try{response.put("token",token).put("error",failure.getMessage());}catch(Exception ignored){}}emit("labDiagnostics",response);
        }
        @JavascriptInterface public void controls(boolean enabled){runOnUiThread(()->{if(controllers!=null)controllers.enabled(enabled&&foreground);});}
        @JavascriptInterface public void switchSystem(String system){if(!RomImport.validSystem(system))return;runOnUiThread(()->NesLabActivity.this.switchSystem(system));}
        @JavascriptInterface public void finishSystemSwitch(String system,boolean okay){if(destroyed||!RomImport.validSystem(system))return;runOnUiThread(()->NesLabActivity.this.finishSystemSwitch(system,okay));}
        @JavascriptInterface public void acceptRom(String sha256) {
            if (destroyed || sha256.length() != 64) return;
            submit(() -> {
                try {
                    if (!offeredRomHashes.remove(sha256)) return;
                    romHash = sha256;if(DeviceLog.get()!=null)DeviceLog.get().context(new JSONObject().put("system",labSystem).put("romHash",romHash).put("pageEpoch",pageEpoch.get()));diagnostic("info","emulator.rom-accepted",message(sha256));
                    JSONObject offered=offeredLibraryRoms.remove(sha256);
                    if(offered!=null)try{NesLabActivity.this.romLibrary().accept(offered);}catch(Exception failure){emit("labLibraryNotice",new JSONObject().put("error",failure.getMessage()));}
                } catch (Exception ex) { error(ex.getMessage()); }
            });
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
        /* the page pauses / resumes the emulator; the host only records it */
        @JavascriptInterface public void stop() { diagnostic("info","emulator.pause-request",new JSONObject()); }
        @JavascriptInterface public void resume() { diagnostic("info",foreground?"emulator.resume-request":"emulator.resume-background",new JSONObject()); }
        // WebView may defer the pause script until after onResume. Read only volatile
        // state here: the JavaScript-interface thread must never wait for the UI thread.
        @JavascriptInterface public boolean lifecyclePending(String ticket) {
            return ticket!=null&&!ticket.isEmpty()&&!destroyed&&!foreground&&ticket.equals(lifecycleTicket);
        }
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
                long expectedGeneration=result.getLong("generation");String expectedRom=result.getString("romHash");
                runOnUiThread(()->{if(destroyed||epoch!=pageEpoch.get())return;web.evaluateJavascript("Boolean(!playing && generation === "+expectedGeneration+" && romHash === "+JSONObject.quote(expectedRom)+")",value->{if(destroyed||epoch!=pageEpoch.get()||!"true".equals(value))return;finish();});});
            }catch(Exception failure){error("Выход: "+failure.getMessage());}});
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
        @JavascriptInterface public void demo() {
            submit(() -> {
                try (InputStream in = getAssets().open("nes".equals(labSystem)?"lab/demo-rom.json":"lab/demo-"+labSystem+".json")) {
                    JSONObject data = new JSONObject(readText(in, 100000));
                    loadRom(Base64.decode(data.getString("base64"), Base64.DEFAULT), "Fly "+labSystem.toUpperCase(Locale.ROOT)+" original diagnostic");
                } catch (Exception ex) { error(ex.getMessage()); }
            });
        }
        @JavascriptInterface public void recognizeScore(String json) {
            if(destroyed)return;final long epoch=pageEpoch.get();
            scoreOcr.recognize(json,response->runOnUiThread(()->{if(!destroyed&&epoch==pageEpoch.get())emit("labScoreText",response);}));
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
        if(controllers!=null)controllers.enabled(false);foreground=false;
        final String ticket="pause-"+(++lifecycleSequence);lifecycleTicket=ticket;
        diagnostic("info","lifecycle.save-request",message(ticket));if(DeviceLog.get()!=null)DeviceLog.get().webVisible(false);
        if(web!=null&&!rendererGone)web.evaluateJavascript("if(window.labLifecycleSuspend)window.labLifecycleSuspend("+JSONObject.quote(ticket)+");",null);
        super.onPause();
        // Keep WebView available for IndexedDB and bridge ACK; never pause a resumed page.
        if(web!=null&&!rendererGone)web.postDelayed(()->{if(!destroyed&&!foreground&&!rendererGone&&ticket.equals(lifecycleTicket)){lifecycleTicket="";lifecycleFailure="Сохранение при уходе в фон не подтверждено; сохранена прежняя проверенная версия";diagnostic("error","lifecycle.save-timeout",message(lifecycleFailure));android.util.Log.e("FlyConsole",lifecycleFailure);web.onPause();}},15000);
    }
    @Override protected void onResume() {
        super.onResume();foreground=true;lifecycleTicket="";if(controllers!=null)controllers.enabled(true); if (web != null&&!rendererGone) web.onResume();if(DeviceLog.get()!=null)DeviceLog.get().webVisible(!rendererGone);
        if(!lifecycleFailure.isEmpty())try{emit("labLifecycleNotice",new JSONObject().put("error",lifecycleFailure));lifecycleFailure="";}catch(Exception ignored){}
    }
    @Override protected void onDestroy() {
        scoreOcr.close();
        if(controllers!=null)controllers.close();destroyed = true;
        worker.shutdown();
        if(web!=null&&!rendererGone){web.removeJavascriptInterface("FlyBridge");web.destroy();}
        super.onDestroy();
    }
}
