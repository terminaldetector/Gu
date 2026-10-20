package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Append-only start/end records. An interrupted or corrupt end is never a completed episode. */
final class EpisodeHistory {
    static final long MAX_BYTES=16L*1024*1024;
    static final int MAX_EPISODES=2048;
    private static final Object LOCK=new Object();
    private final File root;
    EpisodeHistory(File root)throws IOException {this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("История эпизодов недоступна");}
    private File file(String id,String phase)throws IOException {if(id==null||!id.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}"))throw new IOException("Неверный ID эпизода");return new File(root,id+"."+phase+".json");}
    private JSONObject read(File file)throws Exception {if(!file.isFile()||file.length()>65536)throw new IOException("Запись эпизода отсутствует или слишком велика");JSONObject box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)),record=box.getJSONObject("record");if(box.getInt("version")!=1||record.getInt("version")!=1||!file.getName().startsWith(record.getString("episodeId")+".")||!CheckpointDigest.matches(record,box.getString("sha256")))throw new IOException("Повреждена запись эпизода");return record;}
    private void append(File file,JSONObject record)throws Exception {
        if(file.exists())throw new IOException("Эпизод уже записан");byte[] bytes=new JSONObject().put("version",1).put("sha256",CheckpointDigest.of(record)).put("record",record).toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>65536)throw new IOException("Запись эпизода слишком велика");
        long occupied=0;File[] files=root.listFiles();if(files==null)throw new IOException("История не читается");for(File f:files)occupied+=f.length();if(occupied+bytes.length>MAX_BYTES)throw new IOException("История заполнена; прежний опыт сохранён");
        File tmp=File.createTempFile("episode-",".tmp",root);try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.ATOMIC_MOVE);}finally{Files.deleteIfExists(tmp.toPath());}
    }
    JSONObject begin(JSONObject metadata,String stateDigest)throws Exception {synchronized(LOCK){
        File[] files=root.listFiles((d,n)->n.endsWith(".open.json"));if(files==null||files.length>=MAX_EPISODES)throw new IOException("Лимит истории эпизодов; прежний опыт сохранён");
        if(!stateDigest.matches("[a-f0-9]{64}"))throw new IOException("Неверный checkpoint эпизода");
        JSONObject row=new JSONObject(metadata.toString());String id=row.getString("episodeId");file(id,"open");
        if(!RomImport.validSystem(row.getString("system"))||!row.getString("romHash").matches("[a-f0-9]{64}")||!row.getString("graphSha256").matches("[a-f0-9]{64}")||!row.getString("mode").matches("train|eval|teach|benchmark-[a-z]+")||row.getString("provenanceGroup").isEmpty())throw new IOException("Неверный контекст эпизода");
        row.put("version",1).put("status","recording").put("startedAt",System.currentTimeMillis()).put("beforeFdb",stateDigest).put("split","unassigned").put("independent",false);
        JSONObject assignment=row.optJSONObject("curriculum");if(assignment!=null&&assignment.optString("role").matches("train|control|excluded")&&!assignment.optBoolean("degraded"))row.put("split",assignment.getString("role"));
        append(file(id,"open"),row);return row;
    }}
    JSONObject close(String id,JSONObject result,String stateDigest)throws Exception {synchronized(LOCK){
        JSONObject base=read(file(id,"open"));File end=file(id,"closed");if(end.exists())throw new IOException("Эпизод уже завершён");
        if(!stateDigest.matches("[a-f0-9]{64}")||!result.getString("outcome").matches("success|death|unknown")||!result.getString("confidence").matches("diagnostic|configured|unknown")||result.getLong("knownFeedback")<0||result.getLong("unknownFeedback")<0||result.getLong("endFrame")<base.getLong("startFrame"))throw new IOException("Неверный результат эпизода");
        if(result.getString("confidence").equals("unknown")&&!result.getString("outcome").equals("unknown"))throw new IOException("Недостоверный исход не может стать успехом или поражением");
        JSONObject row=new JSONObject(base.toString());for(String key:new String[]{"reason","outcome","confidence","completed","endFrame","knownFeedback","unknownFeedback","interventions","rewardSum"})if(result.has(key))row.put(key,result.get(key));
        row.put("episodeId",id).put("beforeFdb",base.getString("beforeFdb")).put("afterFdb",stateDigest).put("endedAt",System.currentTimeMillis()).put("status",result.getBoolean("completed")?"completed":"interrupted");
        // No assignment or confidence supplied by a result may manufacture held-out evidence.
        row.put("split",base.getString("split")).put("independent",false);append(end,row);return row;
    }}
    JSONObject list()throws Exception {synchronized(LOCK){
        JSONArray rows=new JSONArray();int damaged=0;File[] files=root.listFiles((d,n)->n.endsWith(".open.json"));if(files==null)throw new IOException("История не читается");
        for(File f:files)try{JSONObject row=read(f);try{File end=file(row.getString("episodeId"),"closed");if(end.exists())row=read(end);}catch(Exception bad){row.put("warning","Результат повреждён; эпизод не считается завершённым");}rows.put(row);}catch(Exception bad){damaged++;}
        return new JSONObject().put("episodes",rows).put("damagedRecords",damaged);
    }}
}
