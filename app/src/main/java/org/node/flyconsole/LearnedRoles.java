package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Immutable single-agent generations; Best requires a verified, preregistered paired proof. */
final class LearnedRoles {
    static final long MAX_BYTES=32L*1024*1024;
    private static final Object LOCK=new Object();
    private final File root;
    LearnedRoles(File root)throws IOException {this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Каталог поколений недоступен");}
    static JSONObject context(JSONObject set)throws Exception {
        return context(set.getString("system"),set.getString("romHash"),set.getJSONObject("graph").getString("sha256"));
    }
    static JSONObject context(String system,String rom,String graph)throws Exception {
        if(!Arrays.asList("nes","sega","gb","snes").contains(system)||!rom.matches("[a-f0-9]{64}")||!graph.matches("[a-f0-9]{64}"))throw new IOException("Неверный контекст поколений");
        return new JSONObject().put("system",system).put("romHash",rom).put("graphSha256",graph);
    }
    private static String canonical(Object value)throws Exception {
        if(value==null||value==JSONObject.NULL)return "null";
        if(value instanceof JSONObject){JSONObject o=(JSONObject)value;List<String> keys=new ArrayList<>();o.keys().forEachRemaining(keys::add);Collections.sort(keys);StringJoiner j=new StringJoiner(",","{","}");for(String k:keys)j.add(JSONObject.quote(k)+":"+canonical(o.get(k)));return j.toString();}
        if(value instanceof JSONArray){JSONArray a=(JSONArray)value;StringJoiner j=new StringJoiner(",","[","]");for(int i=0;i<a.length();i++)j.add(canonical(a.get(i)));return j.toString();}
        if(value instanceof String)return JSONObject.quote((String)value);
        if(value instanceof Number)return CheckpointDigest.number((Number)value);
        if(value instanceof Boolean)return value.toString();throw new IOException("Неверное значение checkpoint");
    }
    private static String sha(byte[] b)throws Exception {StringBuilder s=new StringBuilder();for(byte v:MessageDigest.getInstance("SHA-256").digest(b))s.append(String.format("%02x",v&255));return s.toString();}
    private File directory(JSONObject c)throws Exception {JSONObject valid=context(c.getString("system"),c.getString("romHash"),c.getString("graphSha256"));return new File(root,sha(canonical(valid).getBytes(StandardCharsets.UTF_8)));}
    private static File generation(File dir,String hash)throws IOException {if(!hash.matches("[a-f0-9]{64}"))throw new IOException("Неверный hash поколения");return new File(dir,hash+".json");}
    private static byte[] envelope(JSONObject data)throws Exception {String payload=canonical(data);return new JSONObject().put("version",1).put("sha256",sha(payload.getBytes(StandardCharsets.UTF_8))).put("payload",payload).toString().getBytes(StandardCharsets.UTF_8);}
    private static JSONObject read(File f,long max)throws Exception {if(!f.isFile()||f.length()>max)throw new IOException("Checkpoint отсутствует или превышает лимит");byte[] bytes=Files.readAllBytes(f.toPath());if(bytes.length>max)throw new IOException("Checkpoint превышает лимит");JSONObject e=new JSONObject(new String(bytes,StandardCharsets.UTF_8));String p=e.getString("payload");if(e.getInt("version")!=1||!sha(p.getBytes(StandardCharsets.UTF_8)).equals(e.getString("sha256")))throw new IOException("SHA256 checkpoint не совпадает");return new JSONObject(p);}
    private static void atomic(File target,byte[] bytes)throws IOException {File tmp=File.createTempFile("pending-",".tmp",target.getParentFile());try{try(FileOutputStream o=new FileOutputStream(tmp)){o.write(bytes);o.getFD().sync();}Files.move(tmp.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{Files.deleteIfExists(tmp.toPath());}}
    private static long occupied(File f)throws IOException {if(f.isFile())return f.length();File[] all=f.listFiles();if(all==null)throw new IOException("Каталог поколений не читается");long n=0;for(File child:all)n+=occupied(child);return n;}
    private JSONObject manifest(File file,JSONObject c)throws Exception {
        JSONObject m=read(file,16384);int schema=m.getInt("schema");if((schema!=1&&schema!=2)||!canonical(m.getJSONObject("context")).equals(canonical(c))||schema==1&&!m.isNull("best"))throw new IOException("Неверный manifest / неподтверждённый Best");
        File dir=file.getParentFile();generation(dir,m.getString("current"));generation(dir,m.getString("recovery"));
        if(schema==2){generation(dir,m.getString("baseline"));for(String role:new String[]{"best","previousBest"})if(!m.isNull(role)){generation(dir,m.getString(role));evidenceFile(dir,m.getString(role+"Evidence"));}}return m;
    }
    private static File evidenceFile(File dir,String hash)throws IOException {if(!hash.matches("[a-f0-9]{64}"))throw new IOException("Неверный hash доказательства Best");return new File(dir,"evidence-"+hash+".json");}
    private JSONObject verifiedEvidence(File dir,JSONObject m,String role,JSONObject c)throws Exception {
        JSONObject set=snapshot(dir,m.getString(role),c);String hash=m.getString(role+"Evidence");Exception error=null;
        for(File file:new File[]{evidenceFile(dir,hash),new File(dir,"evidence-"+hash+".recovery.json")})try{JSONObject evidence=read(file,1024*1024);if(!hash.equals(CheckpointDigest.of(evidence)))throw new IOException("Hash доказательства Best не совпадает");ComparisonStore.verifyEvidence(evidence,set);return evidence;}catch(Exception damaged){error=damaged;}
        throw new IOException("Доказательство "+role+" повреждено; модель сохранена без подтверждения",error);
    }
    private JSONObject snapshot(File dir,String hash,JSONObject c)throws Exception {
        File file=generation(dir,hash);JSONObject set=read(file,2L*LayerSetStore.MAX_BYTES+4096),box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        if(!sha(box.getString("payload").getBytes(StandardCharsets.UTF_8)).equals(hash)||!canonical(context(set)).equals(canonical(c))||!"fly-layer-set".equals(set.getString("type"))||!set.getString("id").matches("[-a-f0-9]{36}"))throw new IOException("Поколение другого контекста или неверный hash");return set;
    }
    private JSONObject select(File dir,JSONObject c)throws Exception {
        Exception failure=null;
        for(String name:new String[]{"manifest.json","manifest.recovery.json"})try{
            JSONObject m=manifest(new File(dir,name),c);
            for(String role:new String[]{"current","recovery","best","baseline"})try{if(!m.has(role)||m.isNull(role))continue;JSONObject set=snapshot(dir,m.getString(role),c);return new JSONObject().put("manifest",m).put("set",set).put("hash",m.getString(role)).put("fallback",!name.equals("manifest.json")||!role.equals("current"));}catch(Exception e){failure=e;}
        }catch(Exception e){failure=e;}
        throw new IOException("Ни одно защищённое поколение не доступно",failure);
    }
    JSONObject checkpoint(JSONObject source)throws Exception {synchronized(LOCK){
        JSONObject set=new JSONObject(source.toString());set.remove("storageRecovery");
        if("dual-neural".equals(set.optString("actorKind")))throw new IOException("Dual checkpoints хранятся отдельно");
        JSONObject c=context(set);File dir=directory(c);byte[] payload=canonical(set).getBytes(StandardCharsets.UTF_8);if(payload.length>LayerSetStore.MAX_BYTES)throw new IOException("Поколение превышает 4 МиБ");
        String hash=sha(payload);JSONObject old=null;boolean exists=new File(dir,"manifest.json").exists()||new File(dir,"manifest.recovery.json").exists();
        if(exists)old=select(dir,c);
        if(old!=null&&hash.equals(old.getString("hash"))&&!old.getBoolean("fallback"))return status(c); // Repeated checkpoints preserve Recovery.
        // Never replace the last valid checkpoint with corrupt bytes.
        if(!dir.isDirectory()){File[] contexts=root.listFiles(File::isDirectory);if(contexts==null||contexts.length>=32)throw new IOException("Максимум 32 контекста поколений");if(!dir.mkdirs())throw new IOException("Каталог контекста недоступен");}
        String previous=old==null?hash:old.getString("hash");
        JSONObject m=old==null?new JSONObject():new JSONObject(old.getJSONObject("manifest").toString());
        if(m.optInt("schema")==1||old==null)m.put("baseline",previous).put("best",JSONObject.NULL).put("previousBest",JSONObject.NULL).put("bestEvidence",JSONObject.NULL).put("previousBestEvidence",JSONObject.NULL);
        m.put("schema",2).put("context",c).put("current",hash).put("recovery",previous);
        File generation=generation(dir,hash);byte[] bytes=envelope(set),metadata=envelope(m);
        if(generation.exists())snapshot(dir,hash,c);
        if(occupied(root)+(generation.exists()?0:bytes.length)+2L*metadata.length>MAX_BYTES)throw new IOException("Каталог поколений заполнен; предыдущие роли сохранены");
        if(!generation.exists())atomic(generation,bytes);
        // A fallback manifest is built from verified data, never copied from corrupt input.
        JSONObject prior=old==null?m:new JSONObject(m.toString()).put("current",previous).put("recovery",previous);
        if(old!=null){JSONObject oldManifest=old.getJSONObject("manifest");try{snapshot(dir,oldManifest.getString("recovery"),c);prior.put("recovery",oldManifest.getString("recovery"));}catch(Exception ignored){}}
        atomic(new File(dir,"manifest.recovery.json"),envelope(prior));atomic(new File(dir,"manifest.json"),metadata);
        JSONObject result=status(c);try{prune(dir,c);}catch(Exception e){result.put("cleanupWarning",e.getMessage());}return result;
    }}
    JSONObject reference(JSONObject c)throws Exception {synchronized(LOCK){
        File dir=directory(c);JSONObject found=select(dir,c),m=found.getJSONObject("manifest");String role=m.isNull("best")?"baseline":"best",hash=role.equals("best")?m.getString("best"):m.optString("baseline",m.getString("recovery"));
        JSONArray coverage=new JSONArray();if(role.equals("best"))coverage=verifiedEvidence(dir,m,"best",c).getJSONObject("reservation").getJSONArray("plan");
        return new JSONObject().put("set",snapshot(dir,hash,c)).put("role",role).put("hash",hash).put("previousBest",m.isNull("best")?JSONObject.NULL:m.getString("best")).put("coverage",new JSONArray(coverage.toString()));
    }}
    JSONObject promote(ComparisonStore.Promotion verified)throws Exception {synchronized(LOCK){
        JSONObject candidate=verified.candidate(),evidence=verified.evidence(),reservation=evidence.getJSONObject("reservation"),c=context(candidate);ComparisonStore.verifyEvidence(evidence,candidate);
        File dir=directory(c);JSONObject found=select(dir,c),old=found.getJSONObject("manifest");if(found.getBoolean("fallback"))throw new IOException("Сначала восстановите Current: продвижение Best при fallback запрещено");
        if(!old.isNull("best")){
            JSONObject priorEvidence=verifiedEvidence(dir,old,"best",c),protocol=reservation.getJSONObject("context"),prior=snapshot(dir,old.getString("best"),c);
            if(!CheckpointDigest.of(prior.getJSONObject("configuration").getJSONObject("fdb")).equals(protocol.getString("referenceDigest"))||!priorEvidence.getJSONObject("reservation").getJSONObject("context").getString("signature").equals(protocol.getString("signature")))throw new IOException("Reference не соответствует прежнему Best / протоколу; прежняя модель сохранена");
        }
        Object expected=reservation.get("previousBest");if(!String.valueOf(expected).equals(String.valueOf(old.get("best"))))throw new IOException("Best изменился после регистрации сравнения");
        if(!CheckpointDigest.of(found.getJSONObject("set").getJSONObject("configuration").getJSONObject("fdb")).equals(reservation.getJSONObject("context").getString("candidateDigest")))throw new IOException("Current изменился после оценки; Best не обновлён");
        String best=sha(canonical(candidate).getBytes(StandardCharsets.UTF_8)),proof=CheckpointDigest.of(evidence);byte[] bytes=envelope(candidate),proofBytes=envelope(evidence);
        if(proofBytes.length>1024*1024)throw new IOException("Доказательство Best превышает лимит; прежние роли сохранены");
        JSONObject next=new JSONObject(old.toString());if(next.getInt("schema")==1)next.put("baseline",old.getString("recovery"));
        next.put("schema",2).put("previousBest",old.get("best")).put("previousBestEvidence",old.opt("bestEvidence")==null?JSONObject.NULL:old.get("bestEvidence")).put("best",best).put("bestEvidence",proof);
        if(occupied(root)+bytes.length+2L*proofBytes.length+2L*envelope(next).length>MAX_BYTES)throw new IOException("Каталог поколений заполнен; прежний Best сохранён");
        File target=generation(dir,best),proofTarget=evidenceFile(dir,proof);if(target.exists())snapshot(dir,best,c);else atomic(target,bytes);
        if(proofTarget.exists()){if(!CheckpointDigest.of(read(proofTarget,1024*1024)).equals(proof))throw new IOException("Доказательство Best повреждено");}else atomic(proofTarget,proofBytes);
        File proofBackup=new File(dir,"evidence-"+proof+".recovery.json");if(!proofBackup.exists())atomic(proofBackup,proofBytes);
        atomic(new File(dir,"manifest.recovery.json"),envelope(old));atomic(new File(dir,"manifest.json"),envelope(next));
        JSONObject result=status(c);try{prune(dir,c);}catch(Exception e){result.put("cleanupWarning",e.getMessage());}return result.put("bestUpdated",true);
    }}
    JSONObject resumeMutable(LayerSetStore mutable,JSONObject c)throws Exception {synchronized(LOCK){
        if(!status(c).getBoolean("available"))return null;
        JSONObject archived=restore(c);
        try{JSONObject live=mutable.get(archived.getString("id"));if(!canonical(context(live)).equals(canonical(c)))throw new IOException("Контекст Current изменился");return live;}
        catch(Exception damaged){
            archived.put("id",UUID.randomUUID().toString()).put("updatedAt",System.currentTimeMillis());
            JSONObject notice=archived.getJSONObject("storageRecovery");notice.put("reason",notice.getString("reason")+"; "+damaged.getMessage());
            mutable.save(archived);return mutable.get(archived.getString("id"));
        }
    }}
    JSONObject restore(JSONObject c)throws Exception {synchronized(LOCK){JSONObject selected=select(directory(c),c);JSONObject set=selected.getJSONObject("set");set.put("storageRecovery",new JSONObject().put("restored",true).put("reason","Восстановлено защищённое поколение "+selected.getString("hash")).put("archiveFallback",selected.getBoolean("fallback")));return set;}}
    JSONObject status(JSONObject c)throws Exception {synchronized(LOCK){File dir=directory(c);if(!new File(dir,"manifest.json").exists()&&!new File(dir,"manifest.recovery.json").exists())return new JSONObject().put("available",false).put("best",JSONObject.NULL);JSONObject found=select(dir,c),m=found.getJSONObject("manifest");boolean recoveryVerified=true;try{snapshot(dir,m.getString("recovery"),c);}catch(Exception damaged){recoveryVerified=false;}boolean bestVerified=!m.isNull("best"),previousVerified=m.has("previousBest")&&!m.isNull("previousBest");if(bestVerified)try{verifiedEvidence(dir,m,"best",c);}catch(Exception bad){bestVerified=false;}if(previousVerified)try{verifiedEvidence(dir,m,"previousBest",c);}catch(Exception bad){previousVerified=false;}return new JSONObject().put("available",true).put("current",found.getString("hash")).put("recovery",m.getString("recovery")).put("recoveryVerified",recoveryVerified).put("best",bestVerified?m.get("best"):JSONObject.NULL).put("bestUnavailable",!m.isNull("best")&&!bestVerified).put("previousBest",previousVerified?m.get("previousBest"):JSONObject.NULL).put("baseline",m.opt("baseline")==null?JSONObject.NULL:m.get("baseline")).put("fallback",found.getBoolean("fallback")).put("layerId",found.getJSONObject("set").getString("id"));}}
    boolean protects(String id)throws Exception {synchronized(LOCK){File[] dirs=root.listFiles(File::isDirectory);if(dirs==null)throw new IOException("Каталог поколений недоступен");for(File dir:dirs)for(String name:new String[]{"manifest.json","manifest.recovery.json"}){File f=new File(dir,name);if(!f.exists())continue;JSONObject m=read(f,16384),c=m.getJSONObject("context");for(String role:new String[]{"current","recovery","baseline","best","previousBest"})if(m.has(role)&&!m.isNull(role)&&snapshot(dir,m.getString(role),c).getString("id").equals(id))return true;}return false;}}
    private void prune(File dir,JSONObject c)throws Exception {Set<String> keep=new HashSet<>();for(String name:new String[]{"manifest.json","manifest.recovery.json"}){JSONObject m=manifest(new File(dir,name),c);for(String role:new String[]{"current","recovery","baseline","best","previousBest"})if(m.has(role)&&!m.isNull(role))keep.add(m.getString(role)+".json");for(String role:new String[]{"bestEvidence","previousBestEvidence"})if(m.has(role)&&!m.isNull(role)){keep.add("evidence-"+m.getString(role)+".json");keep.add("evidence-"+m.getString(role)+".recovery.json");}}File[] files=dir.listFiles();if(files==null)throw new IOException("Каталог недоступен");for(File f:files)if(f.getName().matches("(evidence-)?[a-f0-9]{64}(\\.recovery)?\\.json")&&!keep.contains(f.getName()))Files.delete(f.toPath());}
}
