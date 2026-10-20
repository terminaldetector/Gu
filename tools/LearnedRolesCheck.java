package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public final class LearnedRolesCheck {
    static void check(boolean x,String m){if(!x)throw new AssertionError(m);}
    static JSONObject set(String id,int count)throws Exception{return new JSONObject().put("type","fly-layer-set").put("layerVersion",2).put("id",id).put("name","Current").put("notes","").put("system","nes").put("romHash","a".repeat(64)).put("graph",new JSONObject().put("sha256","b".repeat(64))).put("createdAt",1).put("updatedAt",count).put("configuration",new JSONObject().put("inputs",new JSONArray().put("1")).put("outputs",new JSONArray().put("2")).put("fdb",new JSONObject().put("deltas",new JSONArray().put(count)).put("edges",new JSONArray()))).put("profile",new JSONObject()).put("runtime",new JSONObject()).put("policy",new JSONObject().put("updates",count).put("episodes",0)).put("journal",new JSONArray());}
    static void erase(File f)throws Exception{if(f.isDirectory())for(File c:f.listFiles())erase(c);Files.deleteIfExists(f.toPath());}
    static void fails(RunnableChecked f,String message)throws Exception{boolean bad=false;try{f.run();}catch(Exception expected){bad=true;}check(bad,message);}
    interface RunnableChecked{void run()throws Exception;}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("learned-roles-").toFile(),layers=new File(root,"mutable"),generations=new File(root,"roles");String id=UUID.randomUUID().toString();
        try{
            LayerSetStore mutable=new LayerSetStore(layers);LearnedRoles store=new LearnedRoles(generations);JSONObject c=LearnedRoles.context(set(id,1));
            check(!store.status(c).getBoolean("available"),"no invented role on first run");
            mutable.save(set(id,1));JSONObject first=store.checkpoint(mutable.get(id));check(first.isNull("best"),"Current never becomes Best without evaluation");
            File dir=generations.listFiles(File::isDirectory)[0];File initial=new File(dir,first.getString("current")+".json");byte[] immutable=Files.readAllBytes(initial.toPath());
            mutable.save(set(id,2));JSONObject second=store.checkpoint(mutable.get(id));check(second.getString("recovery").equals(first.getString("current")),"previous Current is Recovery");check(Arrays.equals(immutable,Files.readAllBytes(initial.toPath())),"prior generation immutable");
            check(store.checkpoint(mutable.get(id)).getString("recovery").equals(first.getString("current")),"identical save cannot rotate away Recovery");
            File recoveryFile=new File(dir,second.getString("recovery")+".json");Files.writeString(recoveryFile.toPath(),"corrupt");check(!store.status(c).getBoolean("recoveryVerified"),"corrupt Recovery explicitly reported while Current remains available");Files.write(recoveryFile.toPath(),immutable);check(store.status(c).getBoolean("recoveryVerified"),"valid Recovery verified");
            check(new LearnedRoles(generations).restore(c).getJSONObject("policy").getInt("updates")==2,"roles survive process reopen");
            mutable.save(set(id,42));check(store.resumeMutable(mutable,c).getJSONObject("policy").getInt("updates")==42,"missing UI pointer resumes newer mutable Current without rollback");
            Files.writeString(new File(layers,id+".json").toPath(),"corrupt");Files.writeString(new File(layers,id+".recovery.json").toPath(),"corrupt");fails(()->mutable.get(id),"both mutable generations broken");
            JSONObject rescued=store.resumeMutable(mutable,c);String restoredId=rescued.getString("id");check(!restoredId.equals(id),"archive fallback materializes new identity");check(mutable.get(restoredId).has("storageRecovery"),"recovery notice persists on materialization");check(mutable.get(restoredId).getJSONObject("policy").getInt("updates")==2,"immutable role restores weights without changing corrupt source");check(new File(layers,id+".json").length()==7,"damaged source retained for diagnosis");
            Files.writeString(new File(dir,second.getString("current")+".json").toPath(),"corrupt");check(store.restore(c).getJSONObject("policy").getInt("updates")==1,"corrupt generation falls back to verified Recovery");
            JSONObject third=store.checkpoint(set(id,3));check(third.getString("recovery").equals(first.getString("current")),"never back up a corrupt current");
            File manifest=new File(dir,"manifest.json");Files.writeString(manifest.toPath(),"corrupt");check(store.restore(c).getJSONObject("policy").getInt("updates")==1,"corrupt manifest falls back to previous verified manifest");
            store.checkpoint(set(id,4));byte[] prior=Files.readAllBytes(manifest.toPath());
            Files.delete(manifest.toPath());manifest.mkdir();Files.writeString(new File(manifest,"block").toPath(),"blocked");fails(()->store.checkpoint(set(id,5)),"failed atomic manifest commit reported");check(store.restore(c).getJSONObject("policy").getInt("updates")==1,"failed commit retains the last reachable verified fallback after primary is replaced by a directory");erase(manifest);Files.write(manifest.toPath(),prior);
            File quota=new File(generations,"quota-fixture");try(RandomAccessFile f=new RandomAccessFile(quota,"rw")){f.setLength(LearnedRoles.MAX_BYTES);}fails(()->store.checkpoint(set(id,6)),"quota failure is explicit");check(store.restore(c).getJSONObject("policy").getInt("updates")==4,"quota does not replace Current");Files.delete(quota.toPath());
            for(int i=7;i<20;i++)store.checkpoint(set(id,i));File[] blobs=dir.listFiles((d,n)->n.matches("[a-f0-9]{64}\\.json"));check(blobs.length<=4,"baseline and fallback generations retained; unreferenced generations pruned");
            check(store.protects(id),"referenced mutable layer protected from deletion");check(!store.protects(UUID.randomUUID().toString()),"unreferenced named layer remains deletable");
            JSONObject other=LearnedRoles.context("nes","c".repeat(64),"b".repeat(64));check(!store.status(other).getBoolean("available"),"roles isolated by ROM");fails(()->store.restore(other),"no cross-ROM recovery");
            byte[] validManifest=Files.readAllBytes(manifest.toPath());JSONObject box=new JSONObject(new String(validManifest,java.nio.charset.StandardCharsets.UTF_8)),forged=new JSONObject(box.getString("payload"));forged.put("best",forged.getString("current"));String payload=forged.toString();byte[] digest=java.security.MessageDigest.getInstance("SHA-256").digest(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));StringBuilder sha=new StringBuilder();for(byte v:digest)sha.append(String.format("%02x",v&255));box.put("payload",payload).put("sha256",sha.toString());Files.writeString(manifest.toPath(),box.toString());
            check(store.status(c).isNull("best")&&store.restore(c).getJSONObject("policy").getInt("updates")==18,"even checksummed unverified Best is rejected; previous manifest remains usable");Files.write(manifest.toPath(),validManifest);
            Files.writeString(manifest.toPath(),"corrupt");Files.writeString(new File(dir,"manifest.recovery.json").toPath(),"corrupt");fails(()->store.restore(c),"both broken manifests fail explicitly rather than invent roles");check(dir.listFiles((d,n)->n.matches("[a-f0-9]{64}\\.json")).length>0,"unrecoverable metadata does not erase generation bytes");
            for(File f:dir.listFiles())check(!f.getName().endsWith(".tmp"),"atomic write cleans temporary files");
            System.out.println("PASS: immutable Current/Recovery, no invented Best, idempotence, process reopen, corrupt mutable files/manifests/generations, failed atomic commit, quota, safe pruning, protected deletion and ROM isolation");
        }finally{erase(root);}
    }
}
