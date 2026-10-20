package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;

/** Worker-owned durable Current binding, independent of Android/UI lifecycle. */
final class FdbLayerBinding {
    private String layerId="",identity="";
    private long configuration=-1;
    private boolean dirty;

    static JSONObject context(String system,String rom,String graph,JSONArray inputs,JSONArray outputs)throws Exception {
        return new JSONObject().put("system",system).put("romHash",rom).put("graph",graph).put("inputs",inputs).put("outputs",outputs);
    }
    private static String identity(JSONObject context)throws Exception {
        String system=context.getString("system"),rom=context.getString("romHash"),graph=context.getString("graph");
        if(!RomImport.validSystem(system)||!rom.matches("[a-f0-9]{64}")||!graph.matches("[a-f0-9]{64}"))throw new IOException("FDB Current: неверный контекст игры / графа");
        return context(system,rom,graph,context.getJSONArray("inputs"),context.getJSONArray("outputs")).toString();
    }
    synchronized void invalidate(){layerId="";identity="";configuration=-1;dirty=false;}
    synchronized String id(){return layerId;}
    synchronized boolean bound(){return !layerId.isEmpty();}
    synchronized void bind(LayerSetStore store,String id,JSONObject current,long version,JSONObject requested,long expected,JSONObject state)throws Exception {
        String key=identity(current);
        if(version!=expected||!key.equals(identity(requested)))throw new IOException("FDB Current: контекст или конфигурация изменились");
        if(id==null||id.isEmpty()||id.equals("null"))throw new IOException("FDB Current: отсутствует durable Layer Set");
        invalidate();
        write(store,id,current,state);layerId=id;identity=key;configuration=version;
    }
    private void requireIdentity(String id,JSONObject current,long version)throws Exception {
        if(!bound()||!layerId.equals(id)||configuration!=version||!identity.equals(identity(current)))throw new IOException("FDB Current не привязан к этой игре и конфигурации; сначала сохраните и подтвердите Current");
    }
    synchronized void requireMutation(String id,JSONObject current,long version)throws Exception {
        requireIdentity(id,current,version);if(dirty)throw new IOException("FDB Current: предыдущее сохранение не подтверждено");
    }
    synchronized void persist(LayerSetStore store,String id,JSONObject current,long version,JSONObject state)throws Exception {
        requireIdentity(id,current,version);
        try{write(store,id,current,state);dirty=false;}catch(Exception error){dirty=true;throw error;}
    }
    private static void write(LayerSetStore store,String id,JSONObject context,JSONObject state)throws Exception {
        store.updateFdb(id,context.getString("system"),context.getString("romHash"),context.getString("graph"),context.getJSONArray("inputs"),context.getJSONArray("outputs"),state);
    }
}
