package org.node.flyconsole;
import android.content.Context;import android.os.Build;import android.webkit.WebView;import org.json.*;
public final class LabDiagnostics {
 private LabDiagnostics(){}
 public static JSONObject describe(Context context,Graph graph)throws Exception{
  android.content.pm.PackageInfo app=context.getPackageManager().getPackageInfo(context.getPackageName(),0);android.content.pm.PackageInfo web=WebView.getCurrentWebViewPackage();
  JSONObject device=new JSONObject().put("model",Build.MANUFACTURER+" "+Build.MODEL).put("android",Build.VERSION.RELEASE).put("sdk",Build.VERSION.SDK_INT).put("abis",new JSONArray(java.util.Arrays.asList(Build.SUPPORTED_ABIS))).put("webview",web==null?"unknown":web.versionName).put("heap_max_mib",Runtime.getRuntime().maxMemory()/1048576);
  return new JSONObject().put("version",app.versionName).put("device",device).put("model_id",GraphCache.modelId).put("graph_sha256",graph.fingerprint()).put("graph_memory_mib",graph.memoryBytes()/1048576).put("dt_ms",.1).put("synaptic_delay_ms",1.8).put("weights","W0 fixed; explicit delta and learned exogenous overlay").put("biological_parity","unverified");
 }
}
