package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class FrozenSeriesCheck {
    interface Action{void run()throws Exception;}
    static void check(boolean x,String why){if(!x)throw new AssertionError(why);}
    static void fails(Action a,String why)throws Exception{boolean failed=false;try{a.run();}catch(Exception expected){failed=true;}check(failed,why);}
    static JSONObject state()throws Exception{return new JSONObject().put("deltas",new JSONArray().put(2)).put("threshold",-1).put("rng",23).put("eligibility",.2).put("baseline",.3).put("counter",9);}
    static JSONObject start(long gen)throws Exception{return new JSONObject().put("stateHash","a".repeat(64)).put("groupId",UUID.randomUUID().toString()).put("originId",UUID.randomUUID().toString()).put("generation",gen).put("role","control").put("trained",false).put("seed",1);}
    static JSONObject request(JSONObject start)throws Exception{return new JSONObject().put("learningMode","eval").put("generation",start.getLong("generation")).put("originId",start.getString("originId")).put("manualMask",0).put("controllerSource","exo").put("frame",10);}
    public static void main(String[] args)throws Exception{
        JSONObject state=state(),context=new JSONObject().put("system","nes");FrozenSeries series=new FrozenSeries(context,state,3,2);
        for(int i=0;i<2;i++){JSONObject start=start(i+1);series.arm(start,state,3);JSONObject q=request(start);series.before(q,state,3);series.after(state,3);q.put("frame",12);series.before(q,state,3);series.after(state,3);series.trial(new JSONObject().put("outcome",i==0?"success":"unknown").put("confidence",i==0?"diagnostic":"unknown"),state,3);}
        JSONObject proof=series.finish(state,3);check(proof.getBoolean("valid")&&proof.getJSONArray("trials").length()==2,"whole series validated, unknown remains explicit");check(series.finish(state,3).toString().equals(proof.toString()),"finish idempotent for persistence retry");
        File root=Files.createTempDirectory("evaluation-archive-").toFile();try{EvaluationArchive archive=new EvaluationArchive(root);check(archive.save(proof).toString().equals(archive.save(proof).toString()),"archive write idempotent");JSONObject altered=new JSONObject(proof.toString()).put("valid",false);fails(()->archive.save(altered),"saved proof cannot be overwritten");}finally{for(File file:root.listFiles())Files.delete(file.toPath());Files.delete(root.toPath());}
        for(String kind:new String[]{"between-windows","configuration","manual","sub-frame-intervention","generation","rewind"}){
            FrozenSeries bad=new FrozenSeries(context,state,3,1);JSONObject start=start(7),q=request(start);bad.arm(start,state,3);bad.before(q,state,3);bad.after(state,3);JSONObject changed=new JSONObject(state.toString());long version=3;
            if(kind.equals("between-windows"))changed.put("eligibility",.9);if(kind.equals("configuration"))version=4;if(kind.equals("manual"))q.put("manualMask",1);if(kind.equals("sub-frame-intervention"))q.put("intervened",true);if(kind.equals("generation"))q.put("generation",8);if(kind.equals("rewind"))q.put("frame",2);final long v=version;
            fails(()->bad.before(q,changed,v),"reject "+kind);check(!bad.finish(changed,v).getBoolean("valid"),"failed proof cannot be successful: "+kind);
        }
        FrozenSeries incomplete=new FrozenSeries(context,state,3,1);check(!incomplete.finish(state,3).getBoolean("valid"),"zero-window interrupted series unconfirmed");
        FrozenSeries train=new FrozenSeries(context,state,3,1);JSONObject trained=start(1).put("trained",true);fails(()->train.arm(trained,state,3),"trained start cannot become frozen holdout");
        JSONObject timedContext=new JSONObject(context.toString()).put("timing","lockstep-1x");FrozenSeries timing=new FrozenSeries(timedContext,state,3,1);JSONObject timed=start(1);timing.arm(timed,state,3);fails(()->timing.before(request(timed).put("runtimeClock","realtime").put("emulationRate",1),state,3),"realtime cannot masquerade as locked control");
        FrozenSeries pin=new FrozenSeries(context,state,3,1);JSONObject pinned=start(1).put("startFrame",10);pin.arm(pinned,state,3);fails(()->pin.before(request(pinned).put("frame",12),state,3),"extra frames before first inference invalidate pinned start");
        JSONObject profiled=new JSONObject(context.toString()).put("profileSha256","b".repeat(64)).put("actuatorSha256","c".repeat(64));FrozenSeries profileGuard=new FrozenSeries(profiled,state,3,1);fails(()->profileGuard.profile("b".repeat(64),"d".repeat(64)),"changed action-hold or clock invalidates proof without weight changes");
        System.out.println("PASS: frozen whole-series and between-window state, generation/configuration/manual/frame guards, unknown outcomes, incomplete rejection and immutable idempotent proof archive");
    }
}
