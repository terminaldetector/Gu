package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Private, bounded cartridge copies. Only core-accepted cartridges enter the library. */
final class RomLibrary {
    static final long MAX_BYTES=128L*1024*1024;
    static final int MAX_GAMES=32;
    private static final Object LOCK=new Object();
    private final File root;
    RomLibrary(File root)throws IOException {this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Библиотека ROM недоступна");}
    private static String sha(byte[] bytes)throws Exception {StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))s.append(String.format(Locale.ROOT,"%02x",b&255));return s.toString();}
    private static String key(String system,String hash)throws IOException {if(!RomImport.validSystem(system)||hash==null||!hash.matches("[a-f0-9]{64}"))throw new IOException("Неверная идентичность ROM");return system+"-"+hash;}
    private File blob(String system,String hash)throws IOException {return new File(root,key(system,hash)+".rom");}
    private static void atomic(File file,byte[] bytes)throws IOException {
        File tmp=File.createTempFile("rom-",".tmp",file.getParentFile());
        try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{Files.deleteIfExists(tmp.toPath());}
    }
    private long occupied()throws IOException {File[] files=root.listFiles();if(files==null)throw new IOException("Библиотека не читается");long n=0;for(File f:files)n+=f.length();return n;}
    private static JSONObject readIndex(File file)throws Exception {
        if(!file.isFile()||file.length()>128*1024)throw new IOException("Каталог ROM повреждён");
        JSONObject box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));String payload=box.getString("payload");
        if(box.getInt("version")!=1||!sha(payload.getBytes(StandardCharsets.UTF_8)).equals(box.getString("sha256")))throw new IOException("SHA256 каталога ROM не совпадает");
        JSONObject index=new JSONObject(payload);JSONArray games=index.getJSONArray("games");if(index.getInt("version")!=1||games.length()>MAX_GAMES)throw new IOException("Версия / размер каталога ROM");
        Set<String> seen=new HashSet<>();for(int i=0;i<games.length();i++){JSONObject row=games.getJSONObject(i);String k=key(row.getString("system"),row.getString("sha256"));if(!seen.add(k)||row.getString("name").length()>160||row.getLong("bytes")<1||row.getLong("bytes")>RomImport.maxRomBytes(row.getString("system"))||row.getLong("openedAt")<0)throw new IOException("Неверная запись ROM");}
        return index;
    }
    private JSONObject index()throws Exception {
        File primary=new File(root,"index.json"),backup=new File(root,"index.recovery.json");
        if(!primary.exists()&&!backup.exists())return new JSONObject().put("version",1).put("games",new JSONArray());
        try{return readIndex(primary);}catch(Exception bad){try{return readIndex(backup).put("recoveredIndex",true);}catch(Exception both){throw new IOException("Оба каталога ROM повреждены; копии игр сохранены",bad);}}
    }
    private static byte[] envelope(JSONObject value)throws Exception {String payload=value.toString();return new JSONObject().put("version",1).put("payload",payload).put("sha256",sha(payload.getBytes(StandardCharsets.UTF_8))).toString().getBytes(StandardCharsets.UTF_8);}
    private void commit(JSONObject previous,JSONObject next)throws Exception {
        previous.remove("recoveredIndex");next.remove("recoveredIndex");byte[] backup=envelope(previous),current=envelope(next);
        if(occupied()+backup.length+current.length>MAX_BYTES)throw new IOException("Библиотека ROM заполнена; прежний каталог сохранён");
        atomic(new File(root,"index.recovery.json"),backup);atomic(new File(root,"index.json"),current);
    }
    JSONObject offer(String system,byte[] input,String name)throws Exception {synchronized(LOCK){
        byte[] bytes=RomImport.normalize(input,system);String hash=sha(bytes);File file=blob(system,hash);
        if(!file.isFile()||file.length()!=bytes.length||!sha(Files.readAllBytes(file.toPath())).equals(hash)){
            if(occupied()+bytes.length>MAX_BYTES)throw new IOException("Библиотека ROM заполнена; удалите ненужную игру");atomic(file,bytes);
        }
        String title=name==null?system.toUpperCase(Locale.ROOT):name.replaceAll("[\\p{Cntrl}]"," ").trim();if(title.isEmpty())title="ROM";if(title.length()>160)title=title.substring(0,160);
        return new JSONObject().put("system",system).put("sha256",hash).put("name",title).put("bytes",bytes.length).put("openedAt",System.currentTimeMillis());
    }}
    void accept(JSONObject offered)throws Exception {synchronized(LOCK){
        String system=offered.getString("system"),hash=offered.getString("sha256");read(system,hash);
        JSONObject previous=index(),next=new JSONObject(previous.toString());JSONArray games=next.getJSONArray("games");int found=-1;for(int i=0;i<games.length();i++){JSONObject row=games.getJSONObject(i);if(row.getString("system").equals(system)&&row.getString("sha256").equals(hash)){found=i;break;}}
        if(found<0&&games.length()>=MAX_GAMES)throw new IOException("Максимум 32 игры; прежняя библиотека сохранена");
        JSONObject row=new JSONObject(offered.toString()).put("openedAt",System.currentTimeMillis());if(found<0)games.put(row);else games.put(found,row);commit(previous,next);
    }}
    byte[] read(String system,String hash)throws Exception {synchronized(LOCK){File file=blob(system,hash);if(!file.isFile()||file.length()>RomImport.maxRomBytes(system))throw new IOException("Копия ROM отсутствует или превышает лимит");byte[] bytes=Files.readAllBytes(file.toPath());if(!sha(bytes).equals(hash))throw new IOException("Копия ROM повреждена: SHA256 не совпадает");RomImport.normalize(bytes,system);return bytes;}}
    JSONObject list()throws Exception {synchronized(LOCK){return new JSONObject(index().toString());}}
    JSONObject find(String system,String hash)throws Exception {synchronized(LOCK){key(system,hash);JSONArray games=index().getJSONArray("games");for(int i=0;i<games.length();i++){JSONObject row=games.getJSONObject(i);if(row.getString("system").equals(system)&&row.getString("sha256").equals(hash))return new JSONObject(row.toString());}throw new IOException("Игры нет в библиотеке");}}
    JSONObject last(String system)throws Exception {synchronized(LOCK){JSONObject last=null;JSONArray games=index().getJSONArray("games");for(int i=0;i<games.length();i++){JSONObject row=games.getJSONObject(i);if(row.getString("system").equals(system)&&(last==null||row.getLong("openedAt")>=last.getLong("openedAt")))last=row;}return last==null?null:new JSONObject(last.toString());}}
    void delete(String system,String hash)throws Exception {synchronized(LOCK){key(system,hash);JSONObject previous=index(),next=new JSONObject(previous.toString());JSONArray games=next.getJSONArray("games");for(int i=games.length()-1;i>=0;i--){JSONObject row=games.getJSONObject(i);if(row.getString("system").equals(system)&&row.getString("sha256").equals(hash))games.remove(i);}commit(previous,next);Files.deleteIfExists(blob(system,hash).toPath());}}
}
