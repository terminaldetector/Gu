package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Durable per-ROM/graph/slot identities over the existing Layer Set store. */
final class DualLayerStore {
    static final class Binding {
        final String key,id;final JSONObject checkpoint;final boolean fresh;final long createdAt;
        Binding(String key,String id,JSONObject checkpoint,boolean fresh,long createdAt){this.key=key;this.id=id;this.checkpoint=checkpoint;this.fresh=fresh;this.createdAt=createdAt;}
    }
    private final File indexFile;
    private final LayerSetStore store;
    DualLayerStore(File filesDir)throws IOException {store=new LayerSetStore(new File(filesDir,"layer-sets"));indexFile=new File(filesDir,"dual-agent-bindings.json");}
    private static String key(String system,String rom,String sha,String slot){if(!Arrays.asList("nes","sega","snes").contains(system)||!rom.matches("[a-f0-9]{64}")||!sha.matches("[a-f0-9]{64}")||!("p1".equals(slot)||"p2".equals(slot)))throw new IllegalArgumentException("Dual binding identity");return system+"|"+rom+"|"+sha+"|"+slot;}
    private JSONObject index()throws Exception {
        if(!indexFile.exists())return new JSONObject().put("version",1).put("bindings",new JSONObject());
        if(indexFile.length()>65536)throw new IOException("Dual index exceeds 64 KiB");JSONObject data=new JSONObject(new String(Files.readAllBytes(indexFile.toPath()),StandardCharsets.UTF_8));if(DualAgentContext.integer(data,"version",1,1)!=1||data.getJSONObject("bindings").length()>64)throw new IOException("Invalid dual index");return data;
    }
    synchronized Binding prepare(String system,String rom,String sha,String slot,String model,boolean resume)throws Exception {
        String key=key(system,rom,sha,slot);JSONObject entries=index().getJSONObject("bindings");String id=entries.optString(key,"");long now=System.currentTimeMillis();
        if(resume&&!id.isEmpty()){JSONObject checkpoint=store.get(id);verify(checkpoint,system,rom,sha,slot,model);return new Binding(key,id,checkpoint,false,checkpoint.getLong("createdAt"));}
        return new Binding(key,UUID.randomUUID().toString(),null,true,now);
    }
    private static void verify(JSONObject set,String system,String rom,String sha,String slot,String model)throws Exception {if(!"dual-neural".equals(set.getString("actorKind"))||!slot.equals(set.getString("actorSlot"))||!model.equals(set.getString("modelId"))||!system.equals(set.getString("system"))||!rom.equals(set.getString("romHash"))||!sha.equals(set.getJSONObject("graph").getString("sha256")))throw new IOException("Dual checkpoint ownership mismatch");}
    synchronized void commitPair(Binding[] bindings,DualAgentContext[] agents,String system,String rom)throws Exception {
        if(bindings.length!=2||agents.length!=2||bindings[0].id.equals(bindings[1].id))throw new IllegalArgumentException("Two unique Layer Sets required");
        for(int i=0;i<2;i++){String slot="p"+(i+1);if(!slot.equals(agents[i].id)||!agents[i].layerId.equals(bindings[i].id)||!key(system,rom,agents[i].graph.fingerprint(),slot).equals(bindings[i].key))throw new IllegalArgumentException("Pair Layer Set ownership");}
        JSONObject data=index(),entries=data.getJSONObject("bindings");for(Binding binding:bindings)entries.put(binding.key,binding.id);if(entries.length()>64)throw new IOException("Maximum 64 dual bindings");
        byte[] bytes=data.toString().getBytes(StandardCharsets.UTF_8);if(bytes.length>65536)throw new IOException("Dual index exceeds 64 KiB");List<String> staged=new ArrayList<>();File temp=null;
        try {
            for(int i=0;i<2;i++)if(bindings[i].fresh){store.save(agents[i].layerSet(system,rom,bindings[i].createdAt));staged.add(bindings[i].id);}
            temp=File.createTempFile("dual-index-",".tmp",indexFile.getParentFile());try(FileOutputStream out=new FileOutputStream(temp)){out.write(bytes);out.getFD().sync();}Files.move(temp.toPath(),indexFile.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        }catch(Exception ex){for(String id:staged)try{store.delete(id);}catch(IOException ignored){}throw ex;}finally{if(temp!=null&&temp.exists())temp.delete();}
    }
    synchronized JSONObject save(DualAgentContext agent,String system,String rom,long createdAt)throws Exception {
        JSONObject old=store.get(agent.layerId);verify(old,system,rom,agent.graph.fingerprint(),agent.id,agent.modelId);JSONObject config=old.getJSONObject("configuration");if(!config.getJSONArray("inputs").toString().equals(DualAgentContext.ids(agent.graph,agent.experiment.inputs).toString())||!config.getJSONArray("outputs").toString().equals(DualAgentContext.ids(agent.graph,agent.experiment.outputs).toString()))throw new IOException("Dual checkpoint port ownership");
        JSONObject set=agent.layerSet(system,rom,createdAt).put("name",old.getString("name")).put("notes",old.getString("notes"));return store.save(set);
    }
}
