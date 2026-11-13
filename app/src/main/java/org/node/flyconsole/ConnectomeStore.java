package org.node.flyconsole;

import android.content.Context;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.*;

/** The production connectome is Male CNS v1.0 and nothing else; acquisition is offline at APK build.
 * FlyWire v783 was removed from the product (directive 2026-11-13): it is neither bundled, nor read,
 * nor substituted. A stored "flywire-v783" selection is LEGACY and resolves to Male CNS - its
 * model-bound layers are not migrated. An imported graph is a developer/instrumentation path:
 * used only when explicitly selected, never chosen automatically. */
final class ConnectomeStore {
    static final String MALE="male-cns-v1.0",IMPORTED="imported";
    /** recognised only to explain it: never loaded */
    static final String LEGACY_FLYWIRE="flywire-v783";
    static boolean valid(String id){return MALE.equals(id)||IMPORTED.equals(id);}
    static boolean legacy(String id){return LEGACY_FLYWIRE.equals(id);}
    static String selected(Context c){String id=c.getSharedPreferences("connectome-model",0).getString("selected",null);return IMPORTED.equals(id)?IMPORTED:MALE;}
    static boolean legacySelection(Context c){return legacy(c.getSharedPreferences("connectome-model",0).getString("selected",null));}
    static void select(Context c,String id)throws IOException{if(!valid(id))throw new IOException(removed(id));if(!c.getSharedPreferences("connectome-model",0).edit().putString("selected",id).commit())throw new IOException("Выбор модели не сохранён");}
    private static String importedSha(Context c){return c.getSharedPreferences("connectome-model",0).getString("importedSha","");}
    private static File importedFile(Context c)throws IOException {
        String sha=importedSha(c);if(sha.isEmpty())return new File(c.getFilesDir(),"connectome.fly");
        if(!sha.matches("[a-f0-9]{64}"))throw new IOException("Invalid imported graph identity");
        return new File(new File(c.getFilesDir(),"synthetic-graphs"),sha+".fly");
    }
    static boolean hasImported(Context c){try{return importedFile(c).isFile();}catch(IOException ex){return false;}}
    /** Content-addressed files plus one atomic preference commit keep the previous selection intact on failure. */
    static synchronized void installSynthetic(Context c,Graph graph)throws Exception {
        String sha=graph.fingerprint();File dir=new File(c.getFilesDir(),"synthetic-graphs");
        if(!dir.isDirectory()&&!dir.mkdirs())throw new IOException("Cannot create graph directory");
        File target=new File(dir,sha+".fly"),tmp=File.createTempFile("graph-",".tmp",dir);
        try {
            try(FileOutputStream out=new FileOutputStream(tmp)){graph.write(out);out.getFD().sync();}
            java.nio.file.Files.move(tmp.toPath(),target.toPath(),java.nio.file.StandardCopyOption.ATOMIC_MOVE,java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            if(!c.getSharedPreferences("connectome-model",0).edit().putString("selected",IMPORTED).putString("importedSha",sha).commit())throw new IOException("Graph selection was not saved");
            GraphCache.installNamed(graph,IMPORTED,title(IMPORTED));
        }finally{tmp.delete();}
    }
    static void selectLegacyImport(Context c)throws IOException {
        if(!c.getSharedPreferences("connectome-model",0).edit().putString("selected",IMPORTED).remove("importedSha").commit())throw new IOException("Graph selection was not saved");
    }
    static InputStream source(Context c,String id)throws IOException{
        if(IMPORTED.equals(id))return new FileInputStream(importedFile(c));
        if(MALE.equals(id)){try{return c.getAssets().open("male-cns.fly.gz");}catch(IOException ex){return c.getAssets().open("male-cns.fly");}}
        throw new IOException(removed(id));
    }
    static String removed(String id){return legacy(id)?"FlyWire v783 удалён из продукта; встроена только модель Male CNS v1.0":"Неизвестная модель коннектома";}
    static JSONObject manifest(Context c,String id)throws Exception{
        if(IMPORTED.equals(id)){
            JSONObject meta=new JSONObject().put("model_id",id).put("name","Imported graph").put("dynamics","Independent LIF; synthetic or importer-supplied graph");
            String sha=importedSha(c);if(!sha.isEmpty())meta.put("graph_sha256",sha);
            return meta;
        }
        if(!MALE.equals(id))throw new IOException(removed(id));
        try(InputStream in=c.getAssets().open("male-cns.fly.json");ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>1048576)throw new IOException("Паспорт модели слишком велик");out.write(buffer,0,n);}
            return new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8)).put("model_id",id);
        }
    }
    static Graph load(Context c,long budget)throws Exception{return load(c,selected(c),budget);}
    static String title(String id){return IMPORTED.equals(id)?"Imported graph":"Male CNS v1.0 / Traced neurons";}
    static Graph candidate(Context c,String id,long budget)throws Exception{
        if(!valid(id))throw new IOException(removed(id));JSONObject meta=manifest(c,id);
        return GraphCache.readNamed(()->source(c,id),budget,meta.optString("graph_sha256",""));
    }
    static Graph load(Context c,String id,long budget)throws Exception{
        if(!valid(id))throw new IOException(removed(id));
        JSONObject meta=manifest(c,id);
        return GraphCache.loadNamed(id,()->source(c,id),budget,title(id),meta.optString("graph_sha256",""));
    }
    static Experiment ports(Context c,Graph graph,int count)throws Exception{
        return ports(c,graph,count,GraphCache.modelId);
    }
    static Experiment ports(Context c,Graph graph,int count,String id)throws Exception{
        if(!MALE.equals(id))return Experiment.automatic(graph,count);
        /* Male CNS: the routing profile (16 image cells -> 256 visual projection neurons
           -> 12 descending outputs), the same file the headless bridge reads. The
           manifest's default ports are not used: its motor outputs never spike. */
        try(InputStream in=c.getAssets().open(RoutingProfile.ASSET);ByteArrayOutputStream buffer=new ByteArrayOutputStream()){
            byte[] chunk=new byte[8192];int n;while((n=in.read(chunk))!=-1){if(buffer.size()+n>4194304)throw new IOException("Профиль маршрутизации слишком велик");buffer.write(chunk,0,n);}
            return RoutingProfile.read(new JSONObject(new String(buffer.toByteArray(),StandardCharsets.UTF_8)),graph).experiment(count);
        }
    }
    /** the manifest's default ports - kept for diagnostics only, not used by the agent */
    static Experiment manifestPorts(Context c,Graph graph,int count)throws Exception{
        JSONObject meta=manifest(c,MALE);JSONArray inputs=meta.getJSONArray("default_inputs"),outputs=meta.getJSONArray("default_outputs");
        if(inputs.length()!=16||outputs.length()<count)throw new IOException("Неверные порты Male CNS");
        int[] in=new int[16],out=new int[count];java.util.HashSet<Integer> unique=new java.util.HashSet<>();
        for(int list=0;list<2;list++){JSONArray ids=list==0?inputs:outputs;int[] indices=list==0?in:out;for(int i=0;i<indices.length;i++){int index=java.util.Arrays.binarySearch(graph.ids,Long.parseLong(ids.getString(i)));if(index<0||!unique.add(index))throw new IOException("Порт не принадлежит выбранной модели");indices[i]=index;}}
        return new Experiment(in,out);
    }
}
