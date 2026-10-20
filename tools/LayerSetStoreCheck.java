package org.node.flyconsole;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public final class LayerSetStoreCheck {
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static JSONObject fixture(String id)throws Exception {return new JSONObject().put("type","fly-layer-set").put("layerVersion",1).put("id",id).put("name","MK P2").put("notes","").put("system","sega").put("romHash",String.format("%064d",1)).put("graph",new JSONObject().put("sha256",String.format("%064d",2))).put("createdAt",100).put("updatedAt",200).put("configuration",new JSONObject().put("fdb",new JSONObject().put("edges",new JSONArray().put(new JSONObject().put("source","1").put("target","2").put("weight",8))))).put("profile",new JSONObject()).put("runtime",new JSONObject()).put("policy",new JSONObject().put("updates",18).put("episodes",3).put("weights",new JSONArray().put(new JSONArray().put(.4)))).put("journal",new JSONArray());}
    private static void erase(File path)throws Exception {if(path.isDirectory())for(File child:path.listFiles())erase(child);Files.deleteIfExists(path.toPath());}
    private static void recoveryChecks()throws Exception {
        File root=Files.createTempDirectory("fly-recovery-").toFile();String id=UUID.randomUUID().toString();LayerSetStore store=new LayerSetStore(root);
        File current=new File(root,id+".json"),backup=new File(root,id+".recovery.json");
        try{
            String initialId=UUID.randomUUID().toString();store.save(fixture(initialId));Files.write(new File(root,initialId+".json").toPath(),new byte[]{0});
            require(store.get(initialId).getString("name").equals("MK P2"),"even the first model has a redundant safe checkpoint");store.delete(initialId);
            require(!new File(root,initialId+".recovery.json").exists(),"explicit delete removes recovery too");
            JSONObject legacy=fixture(id);Files.write(current.toPath(),legacy.toString().getBytes(StandardCharsets.UTF_8));
            require(store.get(id).getString("name").equals("MK P2"),"legacy raw files remain readable");
            store.save(fixture(id).put("name","generation two"));
            JSONObject envelope=new JSONObject(new String(Files.readAllBytes(current.toPath()),StandardCharsets.UTF_8));
            require(envelope.getInt("storageVersion")==1&&backup.isFile(),"writes use verified envelope and durable recovery");
            JSONObject changed=new JSONObject(new String(Base64.getDecoder().decode(envelope.getString("payload")),StandardCharsets.UTF_8));changed.getJSONObject("policy").put("updates",999);
            envelope.put("payload",Base64.getEncoder().encodeToString(changed.toString().getBytes(StandardCharsets.UTF_8)));Files.write(current.toPath(),envelope.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject restored=store.get(id);require(restored.getString("name").equals("MK P2")&&restored.getJSONObject("policy").getInt("updates")==18,"valid JSON tampering cannot replace verified model");
            require(restored.getJSONObject("storageRecovery").getBoolean("restored")&&restored.getJSONObject("storageRecovery").getString("reason").contains("SHA256"),"recovery is explicit");
            require(new LayerSetStore(root).get(id).has("storageRecovery")&&store.list().getJSONObject(0).has("storageRecovery"),"repair warning survives reopen and listing");
            store.save(fixture(id).put("name","generation three"));require(new LayerSetStore(root).get(id).has("storageRecovery"),"automatic checkpoint replacement retains recovery diagnostic");Files.write(current.toPath(),new byte[]{0});
            store.save(fixture(id).put("name","generation four"));Files.write(current.toPath(),new byte[]{0});
            require(store.get(id).getString("name").equals("MK P2"),"corrupted current never replaces sole valid recovery");
            Files.delete(current.toPath());require(store.list().length()==1&&current.isFile(),"orphan recovery restores missing current during listing");
            byte[] primary=Files.readAllBytes(current.toPath());Files.write(backup.toPath(),new byte[]{0});Files.write(current.toPath(),new byte[]{0});
            boolean rejected=false;try{store.save(fixture(id));}catch(Exception expected){rejected=true;}
            require(rejected&&Files.size(current.toPath())==1&&Files.size(backup.toPath())==1,"both corrupt generations fail closed without destroying diagnosis");
            Files.write(current.toPath(),primary);Files.delete(backup.toPath());backup.mkdir();Files.write(new File(backup,"block").toPath(),new byte[]{1});
            rejected=false;try{store.save(fixture(id).put("name","must not commit"));}catch(Exception expected){rejected=true;}
            require(rejected&&store.get(id).getString("name").equals("MK P2"),"failed atomic backup preserves current");
            for(File child:root.listFiles())require(!child.getName().endsWith(".tmp"),"failure cleans temporary file");
            erase(backup);store.save(fixture(id));Files.delete(current.toPath());current.mkdir();Files.write(new File(current,"block").toPath(),new byte[]{1});
            require(store.get(id).getJSONObject("storageRecovery").has("repairError"),"verified recovery remains readable when repairing current fails");
            rejected=false;try{store.save(fixture(id).put("name","failed primary"));}catch(Exception expected){rejected=true;}
            require(rejected&&store.get(id).getString("name").equals("MK P2"),"failed atomic current retains verified backup");
        }finally{erase(root);}
        root=Files.createTempDirectory("fly-quota-").toFile();store=new LayerSetStore(root);
        try{
            char[] chars=new char[2*1024*1024];java.util.Arrays.fill(chars,'x');String padding=new String(chars);
            for(int i=0;i<5;i++)store.save(fixture(UUID.randomUUID().toString()).put("runtime",new JSONObject().put("padding",padding)));
            long occupied=0;for(File file:root.listFiles())occupied+=file.length();require(occupied<LayerSetStore.TOTAL_BYTES,"fixtures fit before quota");
            boolean rejected=false;String rejectedId=UUID.randomUUID().toString();try{store.save(fixture(rejectedId).put("runtime",new JSONObject().put("padding",padding)));}catch(Exception expected){rejected=true;}
            require(rejected&&!new File(root,rejectedId+".json").exists()&&!new File(root,rejectedId+".recovery.json").exists(),"physical quota includes envelopes and recovery before any new write");
            require(store.list().length()==5,"quota rejection keeps all working models");
            for(File file:root.listFiles())if(file.getName().endsWith(".recovery.json")){Files.write(new File(root,file.getName().replace(".recovery.json",".json")).toPath(),new byte[]{0});break;}
            require(store.list().length()==5,"recovery still succeeds near quota");
        }finally{erase(root);}
    }
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("fly-layers-").toFile();String id=UUID.randomUUID().toString();LayerSetStore store=new LayerSetStore(root);
        JSONObject first=fixture(id);store.save(first);require(store.list().length()==1,"list");LayerSetStore reopened=new LayerSetStore(root);
        require(reopened.get(id).getJSONObject("policy").getJSONArray("weights").getJSONArray(0).getDouble(0)==.4,"weights survive reopen");require(store.list().getJSONObject(0).getInt("fdbEdges")==1,"layer metadata");
        String prior=reopened.get(id).toString();JSONObject bad=new JSONObject(first.toString()).put("name","");boolean rejected=false;try{store.save(bad);}catch(Exception expected){rejected=true;}require(rejected&&prior.equals(store.get(id).toString()),"failed replacement retains old file");
        rejected=false;try{store.get("../escape");}catch(Exception expected){rejected=true;}require(rejected,"path rejection");
        first.put("name","Pulseman");store.save(first);require("Pulseman".equals(reopened.get(id).getString("name")),"atomic update");
        for(int i=1;i<LayerSetStore.MAX_SETS;i++)store.save(fixture(UUID.randomUUID().toString()));rejected=false;try{store.save(fixture(UUID.randomUUID().toString()));}catch(Exception expected){rejected=true;}require(rejected,"bounded set count");
        store.delete(id);require(store.list().length()==31,"delete only requested set");for(File f:root.listFiles())f.delete();root.delete();
        recoveryChecks();
        System.out.println("PASS: Layer Set legacy migration, SHA256 integrity, durable recovery/reopen, failed writes, corrupt generations, physical storage quota and atomic replacement");
    }
}
