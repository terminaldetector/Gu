package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class EpisodeHistoryCheck {
    static void check(boolean x,String why){if(!x)throw new AssertionError(why);}
    interface Action{void run()throws Exception;}
    static void fails(Action action,String why)throws Exception{boolean failed=false;try{action.run();}catch(Exception expected){failed=true;}check(failed,why);}
    static void erase(File f)throws Exception{if(f.isDirectory())for(File c:f.listFiles())erase(c);Files.deleteIfExists(f.toPath());}
    static JSONObject metadata(String id)throws Exception{return new JSONObject().put("episodeId",id).put("runId",UUID.randomUUID().toString()).put("system","nes").put("romHash","a".repeat(64)).put("graphSha256","b".repeat(64)).put("mode","train").put("provenanceGroup","same-trajectory").put("startFrame",10);}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("episode-history-").toFile();String id=UUID.randomUUID().toString(),digest="c".repeat(64);
        try{
            EpisodeHistory history=new EpisodeHistory(root);history.begin(metadata(id),digest);check(new EpisodeHistory(root).list().getJSONArray("episodes").getJSONObject(0).getString("status").equals("recording"),"process interruption remains incomplete");
            JSONObject result=new JSONObject().put("outcome","unknown").put("confidence","unknown").put("completed",true).put("endFrame",25).put("knownFeedback",0).put("unknownFeedback",5).put("rewardSum",JSONObject.NULL).put("provenanceGroup","forged-control").put("independent",true).put("split","control");
            JSONObject closed=history.close(id,result,digest);check(closed.isNull("rewardSum"),"unknown is not reward zero");check(!closed.getBoolean("independent")&&closed.getString("split").equals("unassigned")&&closed.getString("provenanceGroup").equals("same-trajectory"),"result cannot invent independent control provenance");
            fails(()->history.close(id,result,digest),"closed episodes immutable");fails(()->history.begin(metadata(id),digest),"start records immutable");
            Files.writeString(new File(root,id+".closed.json").toPath(),"corrupt");JSONObject fallback=history.list().getJSONArray("episodes").getJSONObject(0);check(fallback.getString("status").equals("recording")&&fallback.has("warning"),"corrupt result cannot be counted as completed");
            String next=UUID.randomUUID().toString();history.begin(metadata(next),digest);JSONObject fabricated=new JSONObject(result.toString()).put("outcome","death");fails(()->history.close(next,fabricated,digest),"unknown evidence cannot imply negative outcome");
            File quota=new File(root,"quota");try(RandomAccessFile file=new RandomAccessFile(quota,"rw")){file.setLength(EpisodeHistory.MAX_BYTES);}fails(()->history.close(next,result,digest),"quota error explicit; old records retained");Files.delete(quota.toPath());history.close(next,result,digest);
            JSONObject state=new JSONObject().put("delta",new JSONArray().put(2)).put("rng",4).put("baseline",.2).put("eligibility",.1).put("threshold",-2).put("counter",5),reordered=new JSONObject().put("counter",5).put("threshold",-2).put("eligibility",.1).put("baseline",.2).put("rng",4).put("delta",new JSONArray().put(2));
            JSONObject small=new JSONObject().put("small",1e-8).put("negativeZero",-0.0).put("float",.1f).put("counter",9007199254740991L);check(CheckpointDigest.of(small).equals(CheckpointDigest.of(new JSONObject(small.toString()))),"numeric digest survives JSON storage including tiny values and float/double representation");String whole=CheckpointDigest.of(state);check(whole.equals(CheckpointDigest.of(reordered)),"fingerprint independent of object key order");for(String field:new String[]{"rng","baseline","eligibility","threshold","counter"}){JSONObject changed=new JSONObject(state.toString());changed.put(field,99);check(!whole.equals(CheckpointDigest.of(changed)),"full-state fingerprint detects "+field);}
            fails(()->history.begin(metadata("../bad"),digest),"episode path validation");System.out.println("PASS: durable append-only episode history, process interruption, unknown outcomes, provenance protection, corruption/quota and full-state digest sensitivity");
        }finally{erase(root);}
    }
}
