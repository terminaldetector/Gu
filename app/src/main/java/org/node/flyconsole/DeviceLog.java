package org.node.flyconsole;

import android.app.*;
import android.content.*;
import android.content.pm.*;
import android.os.*;
import android.webkit.WebView;
import org.json.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

/** App-wide recorder, independent of the neural worker and WebView renderer. */
final class DeviceLog {
    interface Exported{void done(File report,String error);}
    private static DeviceLog instance;
    private final Application app;
    private final DiagnosticJournal journal;
    private final ThreadPoolExecutor io=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<>(128),r->{Thread t=new Thread(r,"gu-diagnostics-io");t.setDaemon(true);return t;});
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor(r->{Thread t=new Thread(r,"gu-diagnostics-clock");t.setDaemon(true);return t;});
    private final AtomicLong dropped=new AtomicLong(),writeErrors=new AtomicLong();
    private volatile String failure="",context="{}",diskStatus="{}";
    private volatile boolean foreground;
    private volatile boolean webVisible,mainStalled,webStalled;
    private volatile long mainHeartbeat=SystemClock.elapsedRealtime(),webHeartbeat;
    private volatile String webContext="{}",webKey="",frontendHealth="";
    private final Handler main=new Handler(Looper.getMainLooper());
    private volatile JSONObject identity;
    private long previousCpu=-1,previousElapsed=-1;
    private DeviceLog(Application app)throws Exception{this.app=app;journal=new DiagnosticJournal(new File(app.getFilesDir(),"device-diagnostics"));identity=identity();diskStatus=journal.status().toString();}
    static void start(Application app){try{instance=new DeviceLog(app);instance.event("info","android","process.start",instance.identity);instance.stage("created");instance.enqueue(()->instance.exitHistory());instance.timer.scheduleWithFixedDelay(()->instance.tick(),5,5,TimeUnit.SECONDS);}catch(Exception failure){android.util.Log.e("FlyConsole","Diagnostic logger unavailable",failure);}}
    static DeviceLog get(){return instance;}
    private boolean enqueue(Runnable work){try{io.execute(work);return true;}catch(RejectedExecutionException full){dropped.incrementAndGet();return false;}}
    private void failed(Throwable error){writeErrors.incrementAndGet();failure=error.getClass().getSimpleName()+": "+error.getMessage();android.util.Log.e("FlyConsole","Diagnostic recorder: "+failure);}
    void context(JSONObject value){try{context=DiagnosticJournal.bounded(value).toString();}catch(Exception ignored){}}
    void event(String level,String component,String name,JSONObject data){
        try{JSONObject saved=DiagnosticJournal.bounded(data),ctx=new JSONObject(context);long at=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime();enqueue(()->{try{journal.append(level,component,name,ctx,saved,at,elapsed,level.matches("error|fatal"));}catch(Exception|OutOfMemoryError error){failed(error);}});}catch(Exception|OutOfMemoryError error){failed(error);}
    }
    void event(String level,String name,String message){try{event(level,"android",name,new JSONObject().put("message",message));}catch(Exception ignored){}}
    void stage(String value){long at=System.currentTimeMillis(),elapsed=SystemClock.elapsedRealtime();enqueue(()->{try{journal.marker(value,at,elapsed);journal.flush();}catch(Exception error){failed(error);}});}
    void foreground(boolean visible){foreground=visible;mainHeartbeat=SystemClock.elapsedRealtime();enqueue(()->{previousCpu=-1;previousElapsed=-1;});event("info","lifecycle",visible?"app.foreground":"app.background",new JSONObject());stage(visible?"foreground":"background");}
    void webVisible(boolean value){webVisible=value;webHeartbeat=SystemClock.elapsedRealtime();webStalled=false;}
    private void tick(){try{long elapsed=SystemClock.elapsedRealtime();if(foreground){
        if(elapsed-mainHeartbeat>15000&&!mainStalled){mainStalled=true;StringBuilder stack=new StringBuilder();StackTraceElement[] frames=Looper.getMainLooper().getThread().getStackTrace();for(int i=0;i<Math.min(24,frames.length);i++)stack.append(frames[i]).append('\n');event("error","android","main.heartbeat-gap",new JSONObject().put("gapMs",elapsed-mainHeartbeat).put("stack",stack.toString()).put("meaning","observed main looper stall; not an Android ANR verdict"));}
        if(webVisible&&elapsed-webHeartbeat>20000&&!webStalled){webStalled=true;event("warn","android","web.heartbeat-gap",new JSONObject().put("gapMs",elapsed-webHeartbeat));}
        main.post(()->{long time=SystemClock.elapsedRealtime();if(mainStalled){mainStalled=false;event("info","main.responsive-again",Long.toString(time-mainHeartbeat));}mainHeartbeat=time;});
    }enqueue(()->sample());}catch(Exception failure){failed(failure);}}
    JSONObject status(){try{return new JSONObject(diskStatus).put("available",true).put("droppedEvents",dropped.get()).put("writeErrors",writeErrors.get()).put("lastError",failure).put("queuedEvents",io.getQueue().size()).put("sourceId",BuildConfig.GU_SOURCE_ID);}catch(Exception error){return new JSONObject();}}
    private JSONObject identity()throws Exception {
        PackageInfo info=app.getPackageManager().getPackageInfo(app.getPackageName(),0);PackageInfo web=WebView.getCurrentWebViewPackage();
        return new JSONObject().put("appVersion",info.versionName).put("versionCode",Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode).put("sourceId",BuildConfig.GU_SOURCE_ID).put("debuggable",(app.getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0).put("package",app.getPackageName()).put("lastUpdateTime",info.lastUpdateTime).put("device",Build.MANUFACTURER+" "+Build.MODEL).put("android",Build.VERSION.RELEASE).put("sdk",Build.VERSION.SDK_INT).put("abis",new JSONArray(Arrays.asList(Build.SUPPORTED_ABIS))).put("webview",web==null?"unknown":web.versionName).put("pid",android.os.Process.myPid()).put("heapLimitBytes",Runtime.getRuntime().maxMemory()).put("metricsScope","native process CPU/PSS exclude the separate WebView renderer; JS reports emulator timing separately").put("gpuUtilization",JSONObject.NULL).put("audioSynchronizationVerified",false);
    }
    private void exitHistory(){try{if(Build.VERSION.SDK_INT<30){event("info","process.exit-history-unavailable","Android API < 30");return;}ActivityManager manager=(ActivityManager)app.getSystemService(Context.ACTIVITY_SERVICE);if(manager==null)return;for(ApplicationExitInfo exit:manager.getHistoricalProcessExitReasons(app.getPackageName(),0,5)){int reason=exit.getReason();event(reason==ApplicationExitInfo.REASON_CRASH||reason==ApplicationExitInfo.REASON_CRASH_NATIVE||reason==ApplicationExitInfo.REASON_ANR?"error":"info","android","process.exit-history",new JSONObject().put("reasonCode",reason).put("description",exit.getDescription()).put("timestamp",exit.getTimestamp()).put("pid",exit.getPid()).put("processName",exit.getProcessName()).put("status",exit.getStatus()).put("importance",exit.getImportance()).put("pssKiB",exit.getPss()).put("rssKiB",exit.getRss()).put("source","Android ApplicationExitInfo"));}}catch(Exception failure){event("warn","process.exit-history-unavailable",failure.getMessage());}}
    private void sample(){try{
        if(!foreground)return;long started=SystemClock.elapsedRealtime(),cpu=android.os.Process.getElapsedCpuTime();Runtime runtime=Runtime.getRuntime();Debug.MemoryInfo memory=new Debug.MemoryInfo();Debug.getMemoryInfo(memory);
        JSONObject data=new JSONObject().put("scope","app-process-only").put("cpuTimeMs",cpu).put("pssKiB",memory.getTotalPss()).put("privateDirtyKiB",memory.getTotalPrivateDirty()).put("javaUsedBytes",runtime.totalMemory()-runtime.freeMemory()).put("javaCommittedBytes",runtime.totalMemory()).put("javaLimitBytes",runtime.maxMemory()).put("nativeHeapBytes",Debug.getNativeHeapAllocatedSize()).put("gpuUtilization",JSONObject.NULL).put("webContext",new JSONObject(webContext)).put("webContextAgeMs",started-webHeartbeat);
        data.put("webVisible",webVisible).put("appForeground",foreground);if(previousCpu>=0&&previousElapsed>=0&&started>previousElapsed)data.put("cpuCorePercent",100.0*(cpu-previousCpu)/(started-previousElapsed)).put("intervalMs",started-previousElapsed);previousCpu=cpu;previousElapsed=started;
        BatteryManager battery=(BatteryManager)app.getSystemService(Context.BATTERY_SERVICE);if(battery!=null){for(int[] property:new int[][]{{BatteryManager.BATTERY_PROPERTY_CAPACITY,0},{BatteryManager.BATTERY_PROPERTY_CURRENT_NOW,1},{BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER,2}}){int value=battery.getIntProperty(property[0]);data.put(new String[]{"batteryPercent","batteryCurrentMicroamp","batteryChargeMicroampHour"}[property[1]],value==Integer.MIN_VALUE?JSONObject.NULL:value);}}
        Intent state=app.registerReceiver(null,new IntentFilter(Intent.ACTION_BATTERY_CHANGED));if(state!=null)data.put("batteryVoltageMv",state.hasExtra(BatteryManager.EXTRA_VOLTAGE)?state.getIntExtra(BatteryManager.EXTRA_VOLTAGE,0):JSONObject.NULL).put("batteryTemperatureTenthsC",state.hasExtra(BatteryManager.EXTRA_TEMPERATURE)?state.getIntExtra(BatteryManager.EXTRA_TEMPERATURE,0):JSONObject.NULL).put("plugged",state.hasExtra(BatteryManager.EXTRA_PLUGGED)?state.getIntExtra(BatteryManager.EXTRA_PLUGGED,0):JSONObject.NULL);
        data.put("batteryMeaning","raw Android sensor values; not a calibrated energy measurement").put("recorderSampleMs",SystemClock.elapsedRealtime()-started);
        data.put("loggerDroppedEvents",dropped.get()).put("loggerWriteErrors",writeErrors.get());journal.append("info","android","device.metrics",new JSONObject(context),data,System.currentTimeMillis(),started,false);journal.flush();diskStatus=journal.status().toString();
    }catch(Exception error){failed(error);}}
    void crash(Thread thread,Throwable error){try{
        StringBuilder stack=new StringBuilder();Throwable current=error;for(int c=0;current!=null&&c<4;c++,current=current.getCause()){stack.append(current.getClass().getName()).append(": ").append(current.getMessage()).append('\n');StackTraceElement[] frames=current.getStackTrace();for(int i=0;i<Math.min(24,frames.length);i++)stack.append(frames[i]).append('\n');}
        journal.append("fatal","android","process.uncaught",new JSONObject(context),new JSONObject().put("thread",thread.getName()).put("message",stack.toString()),System.currentTimeMillis(),SystemClock.elapsedRealtime(),true);journal.marker("uncaught-exception",System.currentTimeMillis(),SystemClock.elapsedRealtime());
    }catch(Throwable failed){android.util.Log.e("FlyConsole","Could not persist crash",failed);}}
    void ingest(JSONObject request)throws Exception {
        if(!request.getString("clientId").matches("[a-f0-9-]{36}"))throw new IOException("ID страницы журнала");
        JSONArray rows=request.getJSONArray("events");if(rows.length()>16)throw new IOException("Пакет журнала превышает лимит");
        if(rows.length()>0){JSONObject latest=rows.getJSONObject(rows.length()-1).getJSONObject("context"),signature=new JSONObject();for(String field:new String[]{"system","romHash","core","graphSha256","playing","connected","requestedBackend","learningMode","controllerSource","clock","emulationRate","hidden","dual"})signature.put(field,latest.opt(field));String fresh=signature.toString();if(!fresh.equals(webKey)){webKey=fresh;enqueue(()->{previousCpu=-1;previousElapsed=-1;});}webContext=DiagnosticJournal.bounded(latest).toString();}
        String health=request.getString("clientId")+":"+request.optLong("frontendDropped")+":"+request.optLong("ackLost")+":"+request.optLong("unconfirmedEvents");if(!health.equals(frontendHealth)&&(request.optLong("frontendDropped")>0||request.optLong("ackLost")>0||request.optLong("unconfirmedEvents")>0)){frontendHealth=health;event("warn","recorder","logger.frontend-loss",new JSONObject().put("clientId",request.getString("clientId")).put("frontendDropped",request.optLong("frontendDropped")).put("ackLost",request.optLong("ackLost")).put("unconfirmedEvents",request.optLong("unconfirmedEvents")));}
        if(webStalled){webStalled=false;event("info","web.responsive-again",Long.toString(SystemClock.elapsedRealtime()-webHeartbeat));}webHeartbeat=SystemClock.elapsedRealtime();
        for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i),data=new JSONObject().put("clientId",request.getString("clientId")).put("clientSequence",row.getLong("sequence")).put("clientAt",row.getLong("at")).put("clientElapsedMs",row.getDouble("elapsedMs")).put("details",row.getJSONObject("data")).put("clientContext",row.getJSONObject("context"));event(row.getString("level"),"web",row.getString("name"),data);}
    }
    void export(Exported callback){if(!enqueue(()->{File report=null;String error="";try{
        JSONObject metadata=new JSONObject(identity.toString()).put("recorder",status());MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(app.getApplicationInfo().sourceDir)){byte[] buffer=new byte[64*1024];int n;while((n=in.read(buffer))!=-1)hash.update(buffer,0,n);}StringBuilder sha=new StringBuilder();for(byte b:hash.digest())sha.append(String.format(Locale.ROOT,"%02x",b&255));metadata.put("apkSha256",sha.toString());
        Map<String,File> attachments=new LinkedHashMap<>();for(String[] folder:new String[][]{{"episode-history","episodes"},{"evaluations","evaluations"},{"comparisons","comparisons"}}){File[] files=new File(app.getFilesDir(),folder[0]).listFiles((dir,name)->name.matches("[a-f0-9-]{36}(\\.(open|closed|result))?\\.json")&&(!folder[0].equals("comparisons")||name.endsWith(".result.json")));if(files==null)continue;Arrays.sort(files,Comparator.comparingLong(File::lastModified).reversed());for(int i=0;i<Math.min(80,files.length);i++)attachments.put(folder[1]+"/"+files[i].getName(),files[i]);}
        report=new File(app.getCacheDir(),"gu-diagnostics-"+UUID.randomUUID()+".zip");journal.export(report,metadata,attachments);
    }catch(Exception|OutOfMemoryError failure){failed(failure);error=failure.getMessage()==null?failure.getClass().getSimpleName():failure.getMessage();}callback.done(report,error);}))callback.done(null,"Очередь журнала заполнена; повторите экспорт");}
}
