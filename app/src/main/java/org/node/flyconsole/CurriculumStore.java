package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** Durable trajectory groups. Related starts can never become independent train/test evidence. */
final class CurriculumStore {
    static final long MAX_BYTES=4L*1024*1024;
    private static final Object LOCK=new Object();
    private final File root;
    private final Map<String,JSONObject> trainedCache=new HashMap<>();
    private String trainedStamp="";
    CurriculumStore(File root)throws IOException {this.root=root;if(!root.isDirectory()&&!root.mkdirs())throw new IOException("Каталог отрезков недоступен");}
    private static void hash(String value)throws IOException {if(value==null||!value.matches("[a-f0-9]{64}"))throw new IOException("Неверный SHA256 отрезка");}
    private static void origin(String value)throws IOException {if(value==null||!value.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}"))throw new IOException("Неверное происхождение отрезка");}
    private static String context(JSONObject c)throws Exception {if(!RomImport.validSystem(c.getString("system")))throw new IOException("Платформа отрезка");hash(c.getString("romHash"));hash(c.getString("graphSha256"));return CheckpointDigest.of(new JSONObject().put("system",c.getString("system")).put("romHash",c.getString("romHash")).put("graphSha256",c.getString("graphSha256")));}
    private JSONObject read(File file)throws Exception {
        if(!file.isFile()||file.length()>MAX_BYTES)throw new IOException("Каталог отрезков повреждён / превышает лимит");
        JSONObject box=new JSONObject(new String(Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8)),data=box.getJSONObject("data");
        if(box.getInt("version")!=1||data.getInt("version")!=1||!CheckpointDigest.of(data).equals(box.getString("sha256")))throw new IOException("SHA256 каталога отрезков не совпадает");
        JSONArray contexts=data.getJSONArray("contexts");if(contexts.length()>32)throw new IOException("Лимит контекстов отрезков");Set<String> keys=new HashSet<>();
        for(int i=0;i<contexts.length();i++){
            JSONObject row=contexts.getJSONObject(i);if(!row.getString("key").equals(context(row.getJSONObject("context")))||!keys.add(row.getString("key")))throw new IOException("Контекст отрезков повреждён");
            JSONArray groups=row.getJSONArray("groups");if(groups.length()>128)throw new IOException("Лимит групп отрезков");Set<String> origins=new HashSet<>(),states=new HashSet<>();
            for(int j=0;j<groups.length();j++){
                JSONObject g=groups.getJSONObject(j);origin(g.getString("id"));if(!g.getString("role").matches("train|control|excluded")||!(g.get("trained") instanceof Boolean))throw new IOException("Неверная группа отрезков");
                JSONArray oo=g.getJSONArray("origins"),ss=g.getJSONArray("states");if(oo.length()<1||oo.length()>256||ss.length()<1||ss.length()>512)throw new IOException("Лимит происхождений / стартов");
                for(int k=0;k<oo.length();k++){origin(oo.getString(k));if(!origins.add(oo.getString(k)))throw new IOException("Повтор происхождения");}
                for(int k=0;k<ss.length();k++){hash(ss.getString(k));if(!states.add(ss.getString(k)))throw new IOException("Старт в разных группах");}
                if(g.getString("role").equals("control")&&g.getBoolean("trained"))throw new IOException("Обученная группа не может быть контрольной");
            }
        }
        return data;
    }
    private JSONObject load()throws Exception {
        File primary=new File(root,"catalog.json"),backup=new File(root,"catalog.recovery.json");
        if(!primary.exists()&&!backup.exists())return new JSONObject().put("version",1).put("revision",0).put("contexts",new JSONArray());
        try{return read(primary);}catch(Exception first){try{return read(backup).put("degraded",true);}catch(Exception both){throw new IOException("Оба каталога отрезков повреждены; обучение заблокировано",first);}}
    }
    private static byte[] envelope(JSONObject data)throws Exception {return new JSONObject().put("version",1).put("sha256",CheckpointDigest.of(data)).put("data",data).toString().getBytes(StandardCharsets.UTF_8);}
    private static void atomic(File file,byte[] bytes)throws IOException {File tmp=File.createTempFile("curriculum-",".tmp",file.getParentFile());try{try(FileOutputStream out=new FileOutputStream(tmp)){out.write(bytes);out.getFD().sync();}Files.move(tmp.toPath(),file.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{Files.deleteIfExists(tmp.toPath());}}
    private void save(JSONObject previous,JSONObject next)throws Exception {
        writable(previous);next.put("revision",previous.getLong("revision")+1);byte[] old=envelope(previous),fresh=envelope(next);if(old.length+fresh.length>MAX_BYTES)throw new IOException("Каталог отрезков заполнен; прежние группы сохранены");
        atomic(new File(root,"catalog.recovery.json"),old);atomic(new File(root,"catalog.json"),fresh);
        trainedCache.clear();trainedStamp="";
    }
    private static void writable(JSONObject data)throws IOException {if(data.optBoolean("degraded"))throw new IOException("Каталог восстановлен из резерва: происхождение последних отрезков неизвестно; обучение заблокировано");}
    private static boolean has(JSONArray array,String value)throws Exception {for(int i=0;i<array.length();i++)if(value.equals(array.getString(i)))return true;return false;}
    private static JSONObject findContext(JSONObject data,JSONObject c)throws Exception {String key=context(c);JSONArray rows=data.getJSONArray("contexts");for(int i=0;i<rows.length();i++)if(rows.getJSONObject(i).getString("key").equals(key))return rows.getJSONObject(i);return null;}
    private static JSONObject findOrigin(JSONObject row,String origin)throws Exception {JSONArray groups=row.getJSONArray("groups");for(int i=0;i<groups.length();i++)if(has(groups.getJSONObject(i).getJSONArray("origins"),origin))return groups.getJSONObject(i);return null;}
    private static JSONObject response(JSONObject data,JSONObject group)throws Exception {return new JSONObject().put("groupId",group.getString("id")).put("role",group.getString("role")).put("trained",group.getBoolean("trained")).put("revision",data.getLong("revision")).put("degraded",data.optBoolean("degraded"));}
    JSONObject register(JSONObject c,String origin,String stateHash)throws Exception {synchronized(LOCK){
        origin(origin);hash(stateHash);JSONObject previous=load();writable(previous);JSONObject next=new JSONObject(previous.toString()),row=findContext(next,c);
        if(row==null){JSONArray contexts=next.getJSONArray("contexts");if(contexts.length()>=32)throw new IOException("Максимум 32 контекста отрезков");row=new JSONObject().put("key",context(c)).put("context",c).put("nextGroup",0).put("groups",new JSONArray());contexts.put(row);}
        JSONArray groups=row.getJSONArray("groups");JSONObject group=findOrigin(row,origin),sameState=null;
        for(int i=0;i<groups.length();i++)if(has(groups.getJSONObject(i).getJSONArray("states"),stateHash)){sameState=groups.getJSONObject(i);break;}
        if(group==null&&sameState!=null){group=sameState;if(group.getJSONArray("origins").length()>=256)throw new IOException("Лимит происхождений группы");group.getJSONArray("origins").put(origin);}
        else if(group==null){if(groups.length()>=128)throw new IOException("Максимум 128 групп");int ordinal=row.getInt("nextGroup");row.put("nextGroup",ordinal+1);group=new JSONObject().put("id",UUID.randomUUID().toString()).put("role",ordinal%3==2?"control":"train").put("trained",false).put("origins",new JSONArray().put(origin)).put("states",new JSONArray());groups.put(group);}
        if(sameState!=null&&sameState!=group){
            if(!sameState.getString("role").equals(group.getString("role")))group.put("role","excluded");
            group.put("trained",group.getBoolean("trained")||sameState.getBoolean("trained"));
            for(String field:new String[]{"origins","states"}){JSONArray target=group.getJSONArray(field),from=sameState.getJSONArray(field);for(int i=0;i<from.length();i++)if(!has(target,from.getString(i)))target.put(from.getString(i));if(target.length()>(field.equals("origins")?256:512))throw new IOException("Лимит объединённой группы");}
            for(int i=groups.length()-1;i>=0;i--)if(groups.getJSONObject(i)==sameState)groups.remove(i);
        }
        if(!has(group.getJSONArray("states"),stateHash)){if(group.getJSONArray("states").length()>=512)throw new IOException("Лимит стартов группы");group.getJSONArray("states").put(stateHash);}
        if(CheckpointDigest.of(previous).equals(CheckpointDigest.of(next)))return response(previous,group);
        save(previous,next);return response(next,group);
    }}
    JSONObject role(JSONObject c,String origin)throws Exception {synchronized(LOCK){origin(origin);JSONObject data=load(),row=findContext(data,c),group=row==null?null:findOrigin(row,origin);if(group==null)throw new IOException("Происхождение не зарегистрировано");return response(data,group);}}
    JSONObject start(JSONObject c,String origin,String stateHash)throws Exception {synchronized(LOCK){hash(stateHash);JSONObject data=load(),row=findContext(data,c),group=row==null?null:findOrigin(row,origin);if(group==null||!has(group.getJSONArray("states"),stateHash))throw new IOException("Контрольный старт не зарегистрирован в этой группе");return response(data,group);}}
    private String stamp()throws IOException {java.nio.file.attribute.BasicFileAttributes a=Files.readAttributes(new File(root,"catalog.json").toPath(),java.nio.file.attribute.BasicFileAttributes.class);return a.fileKey()+":"+a.size()+":"+a.lastModifiedTime();}
    JSONObject training(JSONObject c,String origin)throws Exception {synchronized(LOCK){
        origin(origin);String key=context(c)+":"+origin,currentStamp=stamp();
        if(!currentStamp.equals(trainedStamp)){trainedCache.clear();trainedStamp=currentStamp;}
        if(trainedCache.containsKey(key))return new JSONObject(trainedCache.get(key).toString());
        JSONObject previous=load();writable(previous);JSONObject next=new JSONObject(previous.toString()),row=findContext(next,c),group=row==null?null:findOrigin(row,origin);
        if(group==null||!group.getString("role").equals("train"))throw new IOException("Контрольный / исключённый отрезок: пластичность запрещена");
        JSONObject result;if(!group.getBoolean("trained")){group.put("trained",true);save(previous,next);result=response(next,group);}else result=response(previous,group);
        trainedStamp=stamp();trainedCache.put(key,result);return new JSONObject(result.toString());
    }}
    JSONObject describe(JSONObject c)throws Exception {synchronized(LOCK){JSONObject data=load(),row=findContext(data,c);return new JSONObject().put("revision",data.getLong("revision")).put("degraded",data.optBoolean("degraded")).put("groups",row==null?new JSONArray():new JSONArray(row.getJSONArray("groups").toString()));}}
}
