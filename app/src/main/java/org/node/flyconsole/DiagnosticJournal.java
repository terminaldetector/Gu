package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Bounded local flight recorder. No ROM, model parameters or screenshots are collected. */
final class DiagnosticJournal {
    static final int SEGMENT_BYTES=512*1024,SEGMENTS=8,MAX_LINE=16*1024;
    final String runId=UUID.randomUUID().toString();
    private final File root;
    private final int segmentBytes,segments;
    private long sequence,index;
    private JSONObject previousMarker;
    DiagnosticJournal(File root)throws Exception{this(root,SEGMENT_BYTES,SEGMENTS);}
    DiagnosticJournal(File root,int segmentBytes,int segments)throws Exception {
        if(segmentBytes<MAX_LINE||segments<2||segments>32)throw new IOException("Лимиты диагностического журнала");this.root=root;this.segmentBytes=segmentBytes;this.segments=segments;
        if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Журнал недоступен");
        File[] previous=files();for(File file:previous)index=Math.max(index,Long.parseLong(file.getName().substring(7,19)));if(previous.length>0)index++; // Never append a new run to a possibly interrupted tail.
        File marker=new File(root,"last-state.json");if(marker.exists())try{previousMarker=decode(new String(Files.readAllBytes(marker.toPath()),StandardCharsets.UTF_8));}catch(Exception damaged){previousMarker=new JSONObject().put("damaged",true);}
    }
    private File[] files()throws IOException{File[] all=root.listFiles((dir,name)->name.matches("events-[0-9]{12}\\.jsonl"));if(all==null)throw new IOException("Журнал не читается");Arrays.sort(all,Comparator.comparing(File::getName));return all;}
    static String sha(byte[] bytes)throws Exception{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))out.append(String.format(Locale.ROOT,"%02x",b&255));return out.toString();}
    private static Object bounded(Object value,int depth)throws Exception {
        if(value==null||value==JSONObject.NULL)return JSONObject.NULL;
        if(value instanceof String){String text=(String)value;return text.length()>2048?text.substring(0,2048)+"…":text;}
        if(value instanceof Number)return Double.isFinite(((Number)value).doubleValue())?value:JSONObject.NULL;
        if(value instanceof Boolean)return value;
        if(depth>=5)return "[depth limited]";
        if(value instanceof JSONArray){JSONArray source=(JSONArray)value,out=new JSONArray();for(int i=0;i<Math.min(32,source.length());i++)out.put(bounded(source.get(i),depth+1));if(source.length()>32)out.put("[truncated]");return out;}
        if(value instanceof JSONObject){JSONObject source=(JSONObject)value,out=new JSONObject();Iterator<String> keys=source.keys();int count=0,omitted=0;
            while(keys.hasNext()){String key=keys.next();Object child=source.get(key);if(++count>48||key.matches("base64|romData|retina|image|weights")||key.matches("state|configuration|fdb")&&(child instanceof JSONObject||child instanceof JSONArray)){omitted++;continue;}out.put(key.substring(0,Math.min(80,key.length())),bounded(child,depth+1));}if(omitted>0)out.put("omittedFields",omitted);return out;}
        return String.valueOf(value);
    }
    static JSONObject bounded(JSONObject value)throws Exception{return (JSONObject)bounded(value,0);}
    synchronized JSONObject append(String level,String component,String name,JSONObject context,JSONObject data,long at,long elapsed,boolean durable)throws Exception {
        if(!level.matches("debug|info|warn|error|fatal")||!component.matches("[A-Za-z0-9_.:-]{1,80}")||!name.matches("[A-Za-z0-9_.:-]{1,100}"))throw new IOException("Неверное событие журнала");
        JSONObject event=new JSONObject().put("version",1).put("runId",runId).put("sequence",++sequence).put("at",at).put("elapsedMs",elapsed).put("level",level).put("component",component).put("name",name).put("context",bounded(context)).put("data",bounded(data));
        byte[] line=line(event);if(line.length>MAX_LINE){event.put("data",new JSONObject().put("truncated",true).put("message",String.valueOf(data.opt("message")).substring(0,Math.min(2048,String.valueOf(data.opt("message")).length()))));line=line(event);}if(line.length>MAX_LINE)throw new IOException("Событие журнала превышает лимит");
        File target=new File(root,String.format(Locale.ROOT,"events-%012d.jsonl",index));if(target.length()+line.length>segmentBytes)target=new File(root,String.format(Locale.ROOT,"events-%012d.jsonl",++index));
        try(FileOutputStream out=new FileOutputStream(target,true)){out.write(line);if(durable)out.getFD().sync();}
        File[] all=files();for(int i=0;i<all.length-segments;i++)Files.delete(all[i].toPath());return event;
    }
    private static byte[] line(JSONObject event)throws Exception{String payload=event.toString();return (new JSONObject().put("version",1).put("sha256",sha(payload.getBytes(StandardCharsets.UTF_8))).put("payload",payload).toString()+"\n").getBytes(StandardCharsets.UTF_8);}
    static JSONObject decode(String row)throws Exception{JSONObject box=new JSONObject(row);if(box.has("payload")){String payload=box.getString("payload");if(box.getInt("version")!=1||!sha(payload.getBytes(StandardCharsets.UTF_8)).equals(box.getString("sha256")))throw new IOException("SHA256 события не совпадает");return new JSONObject(payload);}JSONObject event=box.getJSONObject("event");if(!CheckpointDigest.matches(event,box.getString("sha256")))throw new IOException("SHA256 старого события не совпадает");return event;}
    synchronized void marker(String stage,long at,long elapsed)throws Exception {
        JSONObject value=new JSONObject().put("runId",runId).put("stage",stage).put("at",at).put("elapsedMs",elapsed);File target=new File(root,"last-state.json"),tmp=File.createTempFile("marker-",".tmp",root);
        try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(line(value));out.getFD().sync();}Files.move(tmp.toPath(),target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}finally{Files.deleteIfExists(tmp.toPath());}
    }
    synchronized void flush()throws Exception{for(File file:files())try(RandomAccessFile out=new RandomAccessFile(file,"rw")){out.getFD().sync();}}
    synchronized JSONObject status()throws Exception {long bytes=0;File[] all=files();for(File file:all)bytes+=file.length();return new JSONObject().put("runId",runId).put("sequence",sequence).put("bytes",bytes).put("segments",all.length).put("limitBytes",(long)segmentBytes*segments).put("previousProcess",previousMarker==null?JSONObject.NULL:new JSONObject(previousMarker.toString())).put("durability","critical events fsync; normal events flushed every 5 seconds; abrupt power loss may lose tail");}
    private static void entry(ZipOutputStream out,String name,byte[] bytes)throws IOException{out.putNextEntry(new ZipEntry(name));out.write(bytes);out.closeEntry();}
    /** Raw segments stay available even when their tail is damaged/interrupted. */
    synchronized void export(File target,JSONObject metadata,Map<String,File> attachments)throws Exception {
        flush();JSONArray descriptors=new JSONArray();List<byte[]> content=new ArrayList<>();List<String> names=new ArrayList<>();long total=0;int invalid=0,valid=0,skipped=0;
        for(File file:files()){
            if(file.length()>segmentBytes)throw new IOException("Сегмент журнала превышает лимит");byte[] bytes=Files.readAllBytes(file.toPath());int bad=0,good=0;
            for(String row:new String(bytes,StandardCharsets.UTF_8).split("\n")){if(row.isEmpty())continue;try{if(row.getBytes(StandardCharsets.UTF_8).length>MAX_LINE)throw new IOException("oversized row");decode(row);good++;}catch(Exception damaged){bad++;}}
            String name="events/"+file.getName();names.add(name);content.add(bytes);descriptors.put(new JSONObject().put("path",name).put("bytes",bytes.length).put("sha256",sha(bytes)).put("validRows",good).put("invalidRows",bad));total+=bytes.length;valid+=good;invalid+=bad;
        }
        for(Map.Entry<String,File> attachment:attachments.entrySet()){
            String name=attachment.getKey();File file=attachment.getValue();if(!name.matches("(episodes/[a-f0-9-]{36}\\.(open|closed)|evaluations/[a-f0-9-]{36}|comparisons/[a-f0-9-]{36}\\.result)\\.json")||!file.isFile()||Files.isSymbolicLink(file.toPath())||file.length()>128*1024||content.size()>=264||total+file.length()>12L*1024*1024){skipped++;continue;}
            byte[] bytes=Files.readAllBytes(file.toPath());if(total+bytes.length>12L*1024*1024){skipped++;continue;}names.add(name);content.add(bytes);descriptors.put(new JSONObject().put("path",name).put("bytes",bytes.length).put("sha256",sha(bytes)));total+=bytes.length;
        }
        JSONObject manifest=new JSONObject().put("type","gu-device-diagnostics").put("version",1).put("exportedAt",System.currentTimeMillis()).put("metadata",metadata).put("journal",status()).put("files",descriptors).put("validRows",valid).put("invalidRows",invalid).put("skippedAttachments",skipped).put("containsRomOrWeights",false);
        File tmp=File.createTempFile("diagnostics-",".tmp",target.getParentFile());try{try(FileOutputStream file=new FileOutputStream(tmp)){try(ZipOutputStream out=new ZipOutputStream(file)){entry(out,"manifest.json",manifest.toString(2).getBytes(StandardCharsets.UTF_8));for(int i=0;i<names.size();i++)entry(out,names.get(i),content.get(i));}}try(RandomAccessFile sync=new RandomAccessFile(tmp,"rw")){sync.getFD().sync();}Files.move(tmp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{Files.deleteIfExists(tmp.toPath());}
    }
}
