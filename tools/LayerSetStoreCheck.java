package org.node.flyconsole;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;

public final class LayerSetStoreCheck {
    private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static JSONObject fixture(String id)throws Exception {return new JSONObject().put("type","fly-layer-set").put("layerVersion",1).put("id",id).put("name","MK P2").put("notes","").put("system","sega").put("romHash",String.format("%064d",1)).put("graph",new JSONObject().put("sha256",String.format("%064d",2))).put("createdAt",100).put("updatedAt",200).put("configuration",new JSONObject().put("fdb",new JSONObject().put("edges",new JSONArray().put(new JSONObject().put("source","1").put("target","2").put("weight",8))))).put("profile",new JSONObject()).put("runtime",new JSONObject()).put("policy",new JSONObject().put("updates",18).put("episodes",3).put("weights",new JSONArray().put(new JSONArray().put(.4)))).put("journal",new JSONArray());}
    public static void main(String[] args)throws Exception {
        File root=Files.createTempDirectory("fly-layers-").toFile();String id=UUID.randomUUID().toString();LayerSetStore store=new LayerSetStore(root);
        JSONObject first=fixture(id);store.save(first);require(store.list().length()==1,"list");LayerSetStore reopened=new LayerSetStore(root);
        require(reopened.get(id).getJSONObject("policy").getJSONArray("weights").getJSONArray(0).getDouble(0)==.4,"weights survive reopen");require(store.list().getJSONObject(0).getInt("fdbEdges")==1,"layer metadata");
        String prior=reopened.get(id).toString();JSONObject bad=new JSONObject(first.toString()).put("name","");boolean rejected=false;try{store.save(bad);}catch(Exception expected){rejected=true;}require(rejected&&prior.equals(store.get(id).toString()),"failed replacement retains old file");
        rejected=false;try{store.get("../escape");}catch(Exception expected){rejected=true;}require(rejected,"path rejection");
        first.put("name","Pulseman");store.save(first);require("Pulseman".equals(reopened.get(id).getString("name")),"atomic update");
        for(int i=1;i<LayerSetStore.MAX_SETS;i++)store.save(fixture(UUID.randomUUID().toString()));rejected=false;try{store.save(fixture(UUID.randomUUID().toString()));}catch(Exception expected){rejected=true;}require(rejected,"bounded set count");
        store.delete(id);require(store.list().length()==31,"delete only requested set");for(File f:root.listFiles())f.delete();root.delete();
        System.out.println("PASS: app-private Layer Set persistence, atomic replacement, path validation and storage limits");
    }
}
