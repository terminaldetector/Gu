package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/** App-private bounded checkpoints; each replacement is atomic. No ROM or base graph bytes. */
final class LayerSetStore {
    static final int MAX_BYTES=2*1024*1024,MAX_SETS=32,TOTAL_BYTES=32*1024*1024;
    private final File directory;
    LayerSetStore(File directory)throws IOException {this.directory=directory;if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Не удалось открыть Layer Set");}
    private File file(String id){if(id==null||!id.matches("[-a-f0-9]{36}"))throw new IllegalArgumentException("Неверный ID Layer Set");return new File(directory,id+".json");}
    private static void validate(JSONObject set)throws Exception {
        if(!"fly-layer-set".equals(set.getString("type"))||(set.getInt("layerVersion")!=1&&set.getInt("layerVersion")!=2))throw new IllegalArgumentException("Неверный формат Layer Set");
        String name=set.getString("name"),notes=set.getString("notes"),system=set.getString("system");
        if(name.trim().isEmpty()||name.length()>80||notes.length()>500)throw new IllegalArgumentException("Неверное имя или заметка");
        if(!("nes".equals(system)||"sega".equals(system)||"gb".equals(system)||"snes".equals(system))||!set.getString("romHash").matches("[a-f0-9]{64}")||!set.getJSONObject("graph").getString("sha256").matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Неверная платформа или SHA256");
        for(String key:new String[]{"createdAt","updatedAt"})if(!(set.get(key) instanceof Number)||set.getDouble(key)!=set.getLong(key)||set.getLong(key)<0)throw new IllegalArgumentException("Неверная дата");
        set.getJSONObject("configuration");set.getJSONObject("profile");set.getJSONObject("runtime");set.getJSONObject("policy");
        if(set.getJSONArray("journal").length()>200)throw new IllegalArgumentException("Журнал превышает 200 записей");
    }
    private static JSONObject summary(JSONObject set)throws Exception {
        validate(set);JSONObject policy=set.getJSONObject("policy"),fdb=set.getJSONObject("configuration").optJSONObject("fdb");
        JSONObject result=new JSONObject();for(String key:new String[]{"id","name","notes","system","romHash","createdAt","updatedAt"})result.put(key,set.get(key));
        for(String key:new String[]{"actorKind","actorSlot","modelId"})if(set.has(key))result.put(key,set.get(key));
        return result.put("graphSha256",set.getJSONObject("graph").getString("sha256")).put("updates",policy.getLong("updates")).put("episodes",policy.getLong("episodes")).put("fdbEdges",length(fdb,"edges")).put("fdbDeltas",length(fdb,"deltas"));
    }
    private static int length(JSONObject obj,String key){JSONArray a=obj==null?null:obj.optJSONArray(key);return a==null?0:a.length();}
    synchronized JSONObject get(String id)throws Exception {
        File path=file(id);if(!path.isFile()||path.length()>MAX_BYTES)throw new IOException("Layer Set отсутствует или слишком велик");
        JSONObject set=new JSONObject(new String(Files.readAllBytes(path.toPath()),StandardCharsets.UTF_8));validate(set);if(!id.equals(set.getString("id")))throw new IOException("ID файла не совпадает");return set;
    }
    synchronized JSONArray list()throws Exception {
        JSONArray result=new JSONArray();File[] files=directory.listFiles();if(files==null)throw new IOException("Layer Set недоступны");
        for(File path:files)if(path.getName().matches("[-a-f0-9]{36}\\.json")){try{result.put(summary(get(path.getName().substring(0,36))));}catch(Exception ignored){/* A damaged file cannot be loaded or overwrite another set. */}}
        return result;
    }
    synchronized JSONObject save(JSONObject set)throws Exception {
        validate(set);File target=file(set.getString("id"));JSONObject metadata=summary(set);byte[] bytes=set.toString().getBytes(StandardCharsets.UTF_8);
        if(target.exists()){JSONObject old=get(set.getString("id"));if("dual-neural".equals(old.optString("actorKind"))&&(!"dual-neural".equals(set.optString("actorKind"))||!old.getString("actorSlot").equals(set.optString("actorSlot"))||!old.getString("modelId").equals(set.optString("modelId"))))throw new IOException("Dual Layer Set belongs to its actor slot");}
        if(bytes.length>MAX_BYTES)throw new IOException("Layer Set превышает 2 МиБ");
        long total=bytes.length;int count=0;File[] files=directory.listFiles();if(files==null)throw new IOException("Layer Set недоступны");
        for(File path:files)if(path.getName().matches("[-a-f0-9]{36}\\.json")){count++;if(!path.equals(target))total+=path.length();}
        if(!target.exists()&&count>=MAX_SETS)throw new IOException("Максимум 32 Layer Set");if(total>TOTAL_BYTES)throw new IOException("Хранилище Layer Set заполнено");
        File temp=File.createTempFile("layer-",".tmp",directory);
        try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}Files.move(temp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{if(temp.exists())temp.delete();}
        return metadata;
    }
    synchronized void delete(String id)throws IOException {File path=file(id);if(path.exists()&&!path.delete())throw new IOException("Не удалось удалить Layer Set");}
    /** Commit learned topology before the feedback acknowledgement, even in background. */
    synchronized JSONObject updateFdb(String id,String system,String romHash,String graphSha,JSONArray sources,JSONArray targets,JSONObject fdb)throws Exception {
        return save(withFdb(get(id),system,romHash,graphSha,sources,targets,fdb));
    }
    static JSONObject withFdb(JSONObject set,String system,String romHash,String graphSha,JSONArray sources,JSONArray targets,JSONObject fdb)throws Exception {
        JSONObject configuration=set.getJSONObject("configuration");
        if(!set.getString("system").equals(system)||!set.getString("romHash").equals(romHash)||!set.getJSONObject("graph").getString("sha256").equals(graphSha)||!configuration.getJSONArray("inputs").toString().equals(sources.toString())||!configuration.getJSONArray("outputs").toString().equals(targets.toString()))throw new IOException("Активный Layer Set не совпадает с FDB");
        configuration.put("fdb",new JSONObject(fdb.toString()));
        JSONObject key=new JSONObject(set.getString("key")),portable=new JSONObject(fdb.toString());portable.remove("growthState");portable.remove("learningState");key.getJSONObject("configuration").put("fdb",portable);set.put("key",key.toString()).put("layerVersion",2).put("updatedAt",System.currentTimeMillis());return set;
    }
}
