package org.node.flyconsole;
import android.app.Activity;import android.os.Build;import android.view.View;import android.view.WindowInsets;import android.view.WindowManager;
/** Keep controls clear of Android 15 enforced edge-to-edge bars/cutouts. */
public final class UiInsets {
 private UiInsets(){}
 public static void apply(Activity activity,View view){activity.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);final int l=view.getPaddingLeft(),t=view.getPaddingTop(),r=view.getPaddingRight(),b=view.getPaddingBottom();view.setOnApplyWindowInsetsListener((v,insets)->{
  if(Build.VERSION.SDK_INT>=30){android.graphics.Insets i=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.displayCutout());v.setPadding(l+i.left,t+i.top,r+i.right,b+i.bottom);}else v.setPadding(l+insets.getStableInsetLeft(),t+insets.getStableInsetTop(),r+insets.getStableInsetRight(),b+insets.getStableInsetBottom());return insets;});view.requestApplyInsets();}
}
