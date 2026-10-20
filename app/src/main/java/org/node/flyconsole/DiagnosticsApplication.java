package org.node.flyconsole;

import android.app.*;
import android.os.Bundle;
import org.json.JSONObject;

/** Lifecycle/crash collection starts before loading any emulator or connectome. */
public final class DiagnosticsApplication extends Application {
    private int resumed;
    @Override public void onCreate(){super.onCreate();DeviceLog.start(this);Thread.UncaughtExceptionHandler previous=Thread.getDefaultUncaughtExceptionHandler();Thread.setDefaultUncaughtExceptionHandler((thread,error)->{if(DeviceLog.get()!=null)DeviceLog.get().crash(thread,error);if(previous!=null)previous.uncaughtException(thread,error);else{android.os.Process.killProcess(android.os.Process.myPid());System.exit(10);}});
        registerActivityLifecycleCallbacks(new ActivityLifecycleCallbacks(){
            private void event(Activity activity,String name){try{if(DeviceLog.get()!=null)DeviceLog.get().event("info","lifecycle",name,new JSONObject().put("activity",activity.getClass().getSimpleName()).put("instance",Integer.toHexString(System.identityHashCode(activity))).put("changingConfigurations",activity.isChangingConfigurations()));}catch(Exception ignored){}}
            public void onActivityCreated(Activity a,Bundle state){event(a,"activity.created");}
            public void onActivityStarted(Activity a){event(a,"activity.started");}
            public void onActivityResumed(Activity a){event(a,"activity.resumed");if(resumed++==0&&DeviceLog.get()!=null)DeviceLog.get().foreground(true);}
            public void onActivityPaused(Activity a){event(a,"activity.paused");if(--resumed<=0){resumed=0;if(DeviceLog.get()!=null)DeviceLog.get().foreground(false);}}
            public void onActivityStopped(Activity a){event(a,"activity.stopped");}
            public void onActivitySaveInstanceState(Activity a,Bundle state){event(a,"activity.instance-state");}
            public void onActivityDestroyed(Activity a){event(a,"activity.destroyed");}
        });
    }
    @Override public void onTrimMemory(int level){if(DeviceLog.get()!=null)try{DeviceLog.get().event("warn","android","memory.trim",new JSONObject().put("level",level));}catch(Exception ignored){}super.onTrimMemory(level);}
    @Override public void onLowMemory(){if(DeviceLog.get()!=null)DeviceLog.get().event("error","memory.low","Android onLowMemory");super.onLowMemory();}
}
