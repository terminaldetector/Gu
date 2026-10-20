package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

/** App-private bounded checkpoints; each replacement is atomic. No ROM or base graph bytes. */
final class LayerSetStore {
    static final int MAX_BYTES=4*1024*1024,MAX_SETS=32,TOTAL_BYTES=32*1024*1024;
    private static final int MAX_STORED_BYTES=((MAX_BYTES+2)/3)*4+2048;
    private final File directory;
    LayerSetStore(File directory)throws IOException {this.directory=directory;if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Не удалось открыть Layer Set");}
    private File file(String id){if(id==null||!id.matches("[-a-f0-9]{36}"))throw new IllegalArgumentException("Неверный ID Layer Set");return new File(directory,id+".json");}
    private File recovery(String id){file(id);return new File(directory,id+".recovery.json");}
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
        if(set.has("storageRecovery"))result.put("storageRecovery",set.getJSONObject("storageRecovery"));
        return result.put("graphSha256",set.getJSONObject("graph").getString("sha256")).put("updates",policy.getLong("updates")).put("episodes",policy.getLong("episodes")).put("fdbEdges",length(fdb,"edges")).put("fdbDeltas",length(fdb,"deltas"));
    }
    private static int length(JSONObject obj,String key){JSONArray a=obj==null?null:obj.optJSONArray(key);return a==null?0:a.length();}
    private static String sha256(byte[] bytes)throws Exception {
        byte[] digest=MessageDigest.getInstance("SHA-256").digest(bytes);StringBuilder result=new StringBuilder(64);
        for(byte value:digest)result.append(String.format("%02x",value&255));return result.toString();
    }
    private static byte[] encode(JSONObject set,JSONObject recovery)throws Exception {
        JSONObject portable=new JSONObject(set.toString());portable.remove("storageRecovery");byte[] payload=portable.toString().getBytes(StandardCharsets.UTF_8);
        if(payload.length>MAX_BYTES)throw new IOException("Layer Set превышает 4 МиБ");
        JSONObject envelope=new JSONObject().put("storageVersion",1).put("sha256",sha256(payload)).put("payload",Base64.getEncoder().encodeToString(payload));
        if(recovery!=null)envelope.put("recovery",recovery);
        return envelope.toString().getBytes(StandardCharsets.UTF_8);
    }
    private JSONObject read(File path,String id)throws Exception {
        if(!path.isFile()||path.length()>MAX_STORED_BYTES)throw new IOException("Layer Set отсутствует или слишком велик");
        byte[] bytes=Files.readAllBytes(path.toPath());if(bytes.length>MAX_STORED_BYTES)throw new IOException("Layer Set слишком велик");
        JSONObject document=new JSONObject(new String(bytes,StandardCharsets.UTF_8)),set,recovered=null;
        if(document.has("storageVersion")){
            if(document.getInt("storageVersion")!=1)throw new IOException("Неизвестная версия хранилища Layer Set");
            byte[] payload=Base64.getDecoder().decode(document.getString("payload"));
            if(payload.length>MAX_BYTES||!sha256(payload).equals(document.getString("sha256")))throw new IOException("SHA256 Layer Set не совпадает");
            set=new JSONObject(new String(payload,StandardCharsets.UTF_8));recovered=document.optJSONObject("recovery");
        }else{if(bytes.length>MAX_BYTES)throw new IOException("Layer Set превышает 4 МиБ");set=document;}
        validate(set);summary(set);if(!id.equals(set.getString("id")))throw new IOException("ID файла не совпадает");
        if(recovered!=null)set.put("storageRecovery",new JSONObject(recovered.toString()));return set;
    }
    private void atomicWrite(File target,byte[] bytes)throws IOException {
        File temp=File.createTempFile("layer-",".tmp",directory);
        try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}Files.move(temp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{if(temp.exists())temp.delete();}
    }
    private Set<String> identities()throws IOException {
        File[] files=directory.listFiles();if(files==null)throw new IOException("Layer Set недоступны");Set<String> ids=new HashSet<>();
        for(File path:files)if(path.getName().matches("[-a-f0-9]{36}(\\.recovery)?\\.json"))ids.add(path.getName().substring(0,36));return ids;
    }
    private long occupiedExcept(File first,File second)throws IOException {
        File[] files=directory.listFiles();if(files==null)throw new IOException("Layer Set недоступны");long total=0;
        for(File path:files)if(path.getName().matches("[-a-f0-9]{36}(\\.recovery)?\\.json")&&!path.equals(first)&&!path.equals(second))total+=path.length();return total;
    }
    synchronized JSONObject get(String id)throws Exception {
        File path=file(id);
        try{return read(path,id);}catch(Exception damaged){
            JSONObject set;
            try{set=read(recovery(id),id);}catch(Exception unavailable){IOException error=new IOException("Layer Set и Recovery недоступны: "+damaged.getMessage());error.addSuppressed(unavailable);throw error;}
            JSONObject notice=new JSONObject().put("restored",true).put("reason",String.valueOf(damaged.getMessage()));set.put("storageRecovery",notice);
            byte[] bytes=encode(set,notice);
            try{if(occupiedExcept(path,null)+bytes.length>TOTAL_BYTES)throw new IOException("Хранилище Layer Set заполнено");atomicWrite(path,bytes);}
            catch(IOException repair){notice.put("repairError",String.valueOf(repair.getMessage()));}
            return set;
        }
    }
    synchronized JSONArray list()throws Exception {
        JSONArray result=new JSONArray();
        for(String id:identities()){try{result.put(summary(get(id)));}catch(Exception ignored){/* Both current and recovery are unusable; leave bytes for diagnosis. */}}
        return result;
    }
    synchronized JSONObject save(JSONObject set)throws Exception {
        validate(set);String id=set.getString("id");File target=file(id),backup=recovery(id);JSONObject metadata=summary(set);
        // Validate the preceding generation before touching its recovery. Never back up corrupt bytes.
        JSONObject old=target.exists()||backup.exists()?get(id):null;
        if(old!=null&&"dual-neural".equals(old.optString("actorKind"))&&(!"dual-neural".equals(set.optString("actorKind"))||!old.getString("actorSlot").equals(set.optString("actorSlot"))||!old.getString("modelId").equals(set.optString("modelId"))))throw new IOException("Dual Layer Set belongs to its actor slot");
        // Automatic FDB saves must not erase a recovery warning before the UI can observe it.
        JSONObject notice=old==null?set.optJSONObject("storageRecovery"):old.optJSONObject("storageRecovery");
        byte[] bytes=encode(set,notice),prior=old==null?bytes:encode(old,notice);
        Set<String> ids=identities();if(!ids.contains(id)&&ids.size()>=MAX_SETS)throw new IOException("Максимум 32 Layer Set");
        if(occupiedExcept(target,backup)+(long)bytes.length+prior.length>TOTAL_BYTES)throw new IOException("Хранилище Layer Set заполнено (включая Recovery)");
        atomicWrite(backup,prior);atomicWrite(target,bytes);
        if(old!=null&&old.has("storageRecovery"))metadata.put("storageRecovery",old.getJSONObject("storageRecovery"));return metadata;
    }
    synchronized void delete(String id)throws IOException {
        // If current cannot be removed, keep its sole valid recovery intact as well.
        File backup=recovery(id),path=file(id);if(path.exists()&&!path.delete())throw new IOException("Не удалось удалить Layer Set");
        if(backup.exists()&&!backup.delete())throw new IOException("Не удалось удалить Recovery Layer Set");
    }
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
