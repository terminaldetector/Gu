package org.node.flyconsole;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

public final class TrainingSessionStoreCheck {
    private interface Attempt {void run()throws Exception;}
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static void reject(Attempt attempt)throws Exception {boolean rejected=false;try{attempt.run();}catch(Exception expected){rejected=true;}require(rejected,"invalid recording was accepted");}
    private static JSONObject metadata(String id)throws Exception {return new JSONObject().put("type","fly-human-session").put("version",1).put("id",id).put("system","snes").put("romHash","a".repeat(64)).put("graphSha256","b".repeat(64)).put("name","Human round").put("startedAt",1000);}
    private static JSONObject sample(int sequence,int mask,boolean accepted)throws Exception {
        JSONArray retina=new JSONArray(),features=new JSONArray();for(int i=0;i<16;i++)retina.put(.5);for(int i=0;i<45;i++)features.put(.5);
        return new JSONObject().put("kind","sample").put("human",true).put("sequence",sequence).put("frame",sequence).put("at",1000+sequence).put("gameMs",sequence*100).put("wallMs",sequence*100).put("mask",mask).put("seconds",.1).put("frames",6).put("accepted",accepted).put("retina",retina).put("features",features);
    }
    private static void remove(File f){if(f.isDirectory())for(File child:f.listFiles())remove(child);f.delete();}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("fly-human-").toFile();
        try{
            String id=UUID.randomUUID().toString();TrainingSessionStore store=new TrainingSessionStore(root);store.begin(metadata(id));
            JSONArray batch=new JSONArray().put(sample(0,129,true)).put(sample(1,0,true)).put(sample(2,8,false));JSONObject m=store.append(id,0,batch);
            require(m.getInt("accepted")==2&&m.getInt("skipped")==1,"acceptance counts");require(m.getJSONArray("buttonMs").getDouble(7)==100&&m.getDouble("neutralMs")==100,"coverage");
            TrainingSessionStore reopened=new TrainingSessionStore(root);require(reopened.list().length()==1,"reopen");require(reopened.append(id,0,batch).toString().equals(m.toString()),"idempotent retry");
            reject(()->store.append(id,2,new JSONArray().put(sample(3,0,true))));reject(()->store.append(id,1,new JSONArray().put(sample(4,0,true))));reject(()->store.append(id,1,new JSONArray().put(sample(3,48,true))));
            reject(()->store.append(id,1,new JSONArray().put(sample(3,0,true).put("frame",1.5))));reject(()->store.get("../escape"));reject(()->store.begin(metadata(id)));
            File log=new File(new File(root,id),"events.jsonl");long prefix=log.length();try(FileOutputStream out=new FileOutputStream(log,true)){out.write("uncommitted tail".getBytes(StandardCharsets.UTF_8));}
            ByteArrayOutputStream exported=new ByteArrayOutputStream();store.export(id,exported);String[] lines=exported.toString(StandardCharsets.UTF_8).split("\n");require(lines.length==4&&!exported.toString(StandardCharsets.UTF_8).contains("uncommitted"),"stream exports committed prefix only");
            store.append(id,1,new JSONArray().put(sample(3,2,true)));require(log.length()>prefix&&!Files.readString(log.toPath()).contains("uncommitted"),"orphan tail recovery");
            store.close(id,2000,"pause");require("closed".equals(reopened.get(id).getString("status")),"close persisted");reject(()->store.append(id,2,new JSONArray().put(sample(4,0,true))));
            JSONObject closed=store.get(id);String snap=closed.getLong("events")+":"+closed.getLong("storedBytes");
            JSONObject page=store.read(id,snap,null);require(page.getJSONArray("events").length()==4&&page.isNull("next"),"bounded read after crash recovery");
            reject(()->store.read(id,"stale",null));reject(()->store.read(id,snap,new JSONObject().put("offset",2).put("event",1)));
            String pagedId=UUID.randomUUID().toString();store.begin(metadata(pagedId));
            for(int b=0;b<9;b++){JSONArray pack=new JSONArray();for(int j=0;j<32;j++)pack.put(sample(b*32+j,128,true));store.append(pagedId,b,pack);}store.close(pagedId,2000,"test");
            JSONObject paged=store.get(pagedId),cursor=null;String fixed=paged.getLong("events")+":"+paged.getLong("storedBytes");int seen=0,reads=0;
            do{JSONObject part=store.read(pagedId,fixed,cursor);JSONArray events=part.getJSONArray("events");require(events.length()<=32&&part.toString().getBytes(StandardCharsets.UTF_8).length<200*1024,"page RPC bound");for(int j=0;j<events.length();j++)require(events.getJSONObject(j).getInt("sequence")==seen++,"page sequence");reads++;cursor=part.optJSONObject("next");}while(cursor!=null);
            require(seen==288&&reads==9,"full native history beyond 200");store.delete(pagedId);
            String largeId=UUID.randomUUID().toString();store.begin(metadata(largeId));File largeDir=new File(root,largeId);JSONObject full=store.get(largeId).put("storedBytes",TrainingSessionStore.MAX_BYTES);
            Files.writeString(new File(largeDir,"meta.json").toPath(),full.toString());try(RandomAccessFile f=new RandomAccessFile(new File(largeDir,"events.jsonl"),"rw")){f.setLength(TrainingSessionStore.MAX_BYTES);}
            reject(()->store.append(largeId,0,new JSONArray().put(sample(0,0,true))));require(store.get(largeId).getLong("storedBytes")==TrainingSessionStore.MAX_BYTES,"capacity failure retains prior prefix");
            for(int i=2;i<TrainingSessionStore.MAX_SESSIONS;i++)store.begin(metadata(UUID.randomUUID().toString()));reject(()->store.begin(metadata(UUID.randomUUID().toString())));
            reject(()->store.delete(largeId));store.delete(id);require(store.list().length()==TrainingSessionStore.MAX_SESSIONS-1&&store.get(largeId).getLong("storedBytes")==TrainingSessionStore.MAX_BYTES,"delete affects only the closed selected archive");
            System.out.println("PASS: native human sessions, reopen, coverage, idempotence, strict validation, crash-tail recovery, committed streaming export and storage limits");
        }finally{remove(root);}
    }
}
