package org.node.flyconsole;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** One selected connectome for the existing engines; acquisition is offline at APK build. */
final class ConnectomeStore {
    static final String FLYWIRE="flywire-v783",MALE="male-cns-v1.0",IMPORTED="imported";
    static boolean valid(String id){return FLYWIRE.equals(id)||MALE.equals(id)||IMPORTED.equals(id);}
    static String selected(Context c){String id=c.getSharedPreferences("connectome-model",0).getString("selected",null);return valid(id)?id:new File(c.getFilesDir(),"connectome.fly").exists()?IMPORTED:FLYWIRE;}
    static void select(Context c,String id)throws IOException{if(!valid(id))throw new IOException("Неизвестная модель коннектома");if(!c.getSharedPreferences("connectome-model",0).edit().putString("selected",id).commit())throw new IOException("Выбор модели не сохранён");}
    static InputStream source(Context c,String id)throws IOException{
        if(IMPORTED.equals(id))return new FileInputStream(new File(c.getFilesDir(),"connectome.fly"));
        if(MALE.equals(id)){try{return c.getAssets().open("male-cns.fly.gz");}catch(IOException ex){return c.getAssets().open("male-cns.fly");}}
        try{return c.getAssets().open("brain.fly.gz");}catch(IOException ex){return c.getAssets().open("brain.fly");}
    }
    static JSONObject manifest(Context c,String id)throws Exception{
        if(IMPORTED.equals(id))return new JSONObject().put("model_id",id).put("name","Imported graph").put("dynamics","Independent LIF; source and biological interpretation supplied by importer");
        try(InputStream in=c.getAssets().open(MALE.equals(id)?"male-cns.fly.json":"brain.fly.json");ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>1048576)throw new IOException("Паспорт модели слишком велик");out.write(buffer,0,n);}
            return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8)).put("model_id",id);
        }
    }
    static Graph load(Context c,long budget)throws Exception{return load(c,selected(c),budget);}
    static String title(String id){return MALE.equals(id)?"Male CNS v1.0 / Traced neurons":IMPORTED.equals(id)?"Imported graph":"FlyWire v783 / Shiu signed model";}
    static Graph candidate(Context c,String id,long budget)throws Exception{
        if(!valid(id))throw new IOException("Неизвестная модель коннектома");JSONObject meta=manifest(c,id);
        return GraphCache.readNamed(()->source(c,id),budget,meta.optString("graph_sha256",""));
    }
    static Graph load(Context c,String id,long budget)throws Exception{
        if(!valid(id))throw new IOException("Неизвестная модель коннектома");
        JSONObject meta;try{meta=manifest(c,id);}catch(IOException ex){if(MALE.equals(id))throw ex;meta=new JSONObject();}
        return GraphCache.loadNamed(id,()->source(c,id),budget,title(id),meta.optString("graph_sha256",""));
    }
    static Experiment ports(Context c,Graph graph,int count)throws Exception{
        return ports(c,graph,count,GraphCache.modelId);
    }
    static Experiment ports(Context c,Graph graph,int count,String id)throws Exception{
        if(!MALE.equals(id))return Experiment.automatic(graph,count);
        JSONObject meta=manifest(c,MALE);JSONArray inputs=meta.getJSONArray("default_inputs"),outputs=meta.getJSONArray("default_outputs");
        if(inputs.length()!=16||outputs.length()<count)throw new IOException("Неверные порты Male CNS");
        int[] in=new int[16],out=new int[count];java.util.HashSet<Integer> unique=new java.util.HashSet<>();
        for(int list=0;list<2;list++){JSONArray ids=list==0?inputs:outputs;int[] indices=list==0?in:out;for(int i=0;i<indices.length;i++){int index=java.util.Arrays.binarySearch(graph.ids,Long.parseLong(ids.getString(i)));if(index<0||!unique.add(index))throw new IOException("Порт не принадлежит выбранной модели");indices[i]=index;}}
        return new Experiment(in,out);
    }
}
