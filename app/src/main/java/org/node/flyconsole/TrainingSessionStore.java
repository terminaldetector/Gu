package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;

/** Append-only human observations. Metadata commits the durable prefix of the journal. */
final class TrainingSessionStore {
    static final int MAX_BYTES=32*1024*1024,TOTAL_BYTES=64*1024*1024,MAX_SESSIONS=32;
    private static final String ID="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
    private final File directory;
    TrainingSessionStore(File directory)throws IOException {this.directory=directory;if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Хранилище показа недоступно");}
    private File folder(String id){if(id==null||!id.matches(ID))throw new IllegalArgumentException("Неверный ID сессии");return new File(directory,id);}
    private static long integer(JSONObject o,String key,long minimum,long maximum)throws Exception {
        Object value=o.get(key);if(!(value instanceof Number))throw new IllegalArgumentException("Неверное число: "+key);
        double d=((Number)value).doubleValue();long n=((Number)value).longValue();
        if(!Double.isFinite(d)||d!=n||n<minimum||n>maximum)throw new IllegalArgumentException("Неверное число: "+key);return n;
    }
    private static double number(JSONObject o,String key,double minimum,double maximum)throws Exception {
        Object value=o.get(key);if(!(value instanceof Number))throw new IllegalArgumentException("Неверное число: "+key);double d=((Number)value).doubleValue();
        if(!Double.isFinite(d)||d<minimum||d>maximum)throw new IllegalArgumentException("Неверное число: "+key);return d;
    }
    private static void metadata(JSONObject m)throws Exception {
        if(!"fly-human-session".equals(m.getString("type"))||integer(m,"version",1,1)!=1||!m.getString("id").matches(ID))throw new IllegalArgumentException("Неверная сессия показа");
        String system=m.getString("system"),name=m.getString("name");
        if(!system.matches("nes|sega|gb|snes")||!m.getString("romHash").matches("[a-f0-9]{64}")||!m.getString("graphSha256").matches("[a-f0-9]{64}")||name.trim().isEmpty()||name.length()>100)throw new IllegalArgumentException("Неверная платформа или имя сессии");
        integer(m,"startedAt",0,9007199254740991L);
    }
    private static void events(JSONArray events)throws Exception {
        if(events.length()<1||events.length()>64||events.toString().getBytes(StandardCharsets.UTF_8).length>256*1024)throw new IllegalArgumentException("Неверный пакет показа");
        for(int i=0;i<events.length();i++){
            JSONObject e=events.getJSONObject(i);String kind=e.getString("kind");
            if(!kind.matches("input|sample")||!Boolean.TRUE.equals(e.get("human")))throw new IllegalArgumentException("Неверное событие показа");
            integer(e,"sequence",0,9007199254740991L);integer(e,"frame",0,9007199254740991L);integer(e,"at",0,9007199254740991L);
            number(e,"gameMs",0,9007199254740991L);number(e,"wallMs",0,9007199254740991L);
            int mask=(int)integer(e,"mask",0,4095);if((mask&48)==48||(mask&192)==192)throw new IllegalArgumentException("Противоположные направления");
            if("sample".equals(kind)){
                if(number(e,"seconds",0,1)==0)throw new IllegalArgumentException("Пустое действие");integer(e,"frames",1,1000);
                if(!(e.get("accepted") instanceof Boolean))throw new IllegalArgumentException("Нет результата обучения");
                vector(e.getJSONArray("retina"),16,0,1);vector(e.getJSONArray("features"),45,-2,2);
            }
        }
    }
    private static void vector(JSONArray a,int size,double low,double high)throws Exception {
        if(a.length()!=size)throw new IllegalArgumentException("Неверный размер наблюдения");
        for(int i=0;i<size;i++){Object v=a.get(i);if(!(v instanceof Number))throw new IllegalArgumentException("Неверное наблюдение");double d=((Number)v).doubleValue();if(!Double.isFinite(d)||d<low||d>high)throw new IllegalArgumentException("Неверное наблюдение");}
    }
    private static void atomic(File path,JSONObject data)throws Exception {
        File temp=File.createTempFile("meta-",".tmp",path.getParentFile());
        try{try(FileOutputStream out=new FileOutputStream(temp)){out.write(data.toString().getBytes(StandardCharsets.UTF_8));out.getFD().sync();}Files.move(temp.toPath(),path.toPath(),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}finally{if(temp.exists())temp.delete();}
    }
    synchronized JSONObject get(String id)throws Exception {
        File dir=folder(id),path=new File(dir,"meta.json"),log=new File(dir,"events.jsonl");
        if(!path.isFile()||path.length()>65536)throw new IOException("Сессия отсутствует или повреждена");
        JSONObject m=new JSONObject(new String(Files.readAllBytes(path.toPath()),StandardCharsets.UTF_8));metadata(m);
        for(String key:new String[]{"events","inputChanges","samples","accepted","skipped","nextSeq"})integer(m,key,0,9007199254740991L);
        integer(m,"lastEvent",-1,9007199254740991L);number(m,"gameMs",0,9007199254740991L);number(m,"neutralMs",0,9007199254740991L);vector(m.getJSONArray("buttonMs"),12,0,9007199254740991L);
        if(!id.equals(m.getString("id"))||!log.isFile()||integer(m,"storedBytes",0,MAX_BYTES)>log.length()||m.getLong("accepted")+m.getLong("skipped")!=m.getLong("samples")||m.getLong("samples")+m.getLong("inputChanges")!=m.getLong("events")||m.getLong("lastEvent")!=m.getLong("events")-1||m.getLong("nextSeq")>m.getLong("events")||!m.getString("status").matches("closed|recording"))throw new IOException("Сессия повреждена");return m;
    }
    synchronized JSONArray list()throws Exception {
        JSONArray out=new JSONArray();File[] dirs=directory.listFiles();if(dirs==null)throw new IOException("Хранилище показа недоступно");
        for(File dir:dirs)if(dir.isDirectory()&&dir.getName().matches(ID))try{out.put(get(dir.getName()));}catch(Exception ignored){/* Retain damaged files; never overwrite another recording. */}return out;
    }
    synchronized JSONObject begin(JSONObject session)throws Exception {
        metadata(session);if(session.toString().getBytes(StandardCharsets.UTF_8).length>60*1024)throw new IOException("Описание сессии превышает 60 КиБ");File dir=folder(session.getString("id"));if(dir.exists())throw new IOException("Сессия уже существует");
        int count=0;File[] dirs=directory.listFiles();if(dirs==null)throw new IOException("Хранилище показа недоступно");for(File f:dirs)if(f.isDirectory()&&f.getName().matches(ID))count++;
        if(count>=MAX_SESSIONS)throw new IOException("Хранилище: максимум 32 сессии; экспортируйте сохранённый опыт");
        JSONObject m=new JSONObject(session.toString());for(String k:new String[]{"events","inputChanges","samples","accepted","skipped","gameMs","neutralMs","nextSeq","storedBytes"})m.put(k,0);
        JSONArray buttons=new JSONArray();for(int i=0;i<12;i++)buttons.put(0);m.put("buttonMs",buttons).put("lastEvent",-1).put("status","recording");
        if(!dir.mkdir())throw new IOException("Не удалось создать сессию");File log=new File(dir,"events.jsonl");
        try{if(!log.createNewFile())throw new IOException("Не удалось открыть журнал");atomic(new File(dir,"meta.json"),m);}catch(Exception ex){log.delete();dir.delete();throw ex;}return m;
    }
    synchronized JSONObject append(String id,long sequence,JSONArray batch)throws Exception {
        events(batch);JSONObject m=get(id);String text=batch.toString(),digest=sha256(text.getBytes(StandardCharsets.UTF_8));
        long next=m.getLong("nextSeq");if(sequence==next-1&&digest.equals(m.optString("lastBatchHash")))return m;
        if(sequence!=next||!"recording".equals(m.getString("status")))throw new IOException("Неверная последовательность записи");
        long last=m.getLong("lastEvent");ByteArrayOutputStream payload=new ByteArrayOutputStream();
        for(int i=0;i<batch.length();i++){JSONObject e=batch.getJSONObject(i);if(e.getLong("sequence")!=last+i+1)throw new IOException("Пропущено событие показа");payload.write(e.toString().getBytes(StandardCharsets.UTF_8));payload.write('\n');}
        byte[] data=payload.toByteArray();long committed=m.getLong("storedBytes");if(committed+data.length>MAX_BYTES)throw new IOException("Сессия заполнена; ранее записанное сохранено");
        long total=data.length;File[] dirs=directory.listFiles();if(dirs==null)throw new IOException("Хранилище показа недоступно");for(File dir:dirs){File log=new File(dir,"events.jsonl");if(log.isFile())total+=log.length();}
        if(total>TOTAL_BYTES)throw new IOException("Хранилище показа заполнено; ранее записанное сохранено");
        JSONObject out=new JSONObject(m.toString());JSONArray buttons=out.getJSONArray("buttonMs");
        for(int i=0;i<batch.length();i++){
            JSONObject e=batch.getJSONObject(i);add(out,"events",1);out.put("lastEvent",e.getLong("sequence"));
            if("input".equals(e.getString("kind")))add(out,"inputChanges",1);
            else{double ms=e.getDouble("seconds")*1000;boolean accepted=e.getBoolean("accepted");add(out,"samples",1);add(out,accepted?"accepted":"skipped",1);add(out,"gameMs",ms);
                if(accepted){int mask=e.getInt("mask");if(mask==0)add(out,"neutralMs",ms);for(int b=0;b<12;b++)if((mask&(1<<b))!=0)buttons.put(b,buttons.getDouble(b)+ms);}}
        }
        out.put("nextSeq",next+1).put("storedBytes",committed+data.length).put("lastBatchHash",digest);
        File dir=folder(id);try(RandomAccessFile log=new RandomAccessFile(new File(dir,"events.jsonl"),"rw")){
            log.setLength(committed);log.seek(committed);log.write(data);log.getFD().sync();
            try{atomic(new File(dir,"meta.json"),out);}catch(Exception ex){log.setLength(committed);log.getFD().sync();throw ex;}
        }return out;
    }
    private static void add(JSONObject m,String key,double amount)throws Exception {m.put(key,m.getDouble(key)+amount);}
    synchronized JSONObject close(String id,long endedAt,String reason)throws Exception {
        JSONObject m=get(id);if(endedAt<m.getLong("startedAt")||endedAt>9007199254740991L||reason==null||reason.length()>100)throw new IllegalArgumentException("Неверное завершение сессии");
        if("closed".equals(m.getString("status")))return m;m.put("status","closed").put("endedAt",endedAt).put("reason",reason);atomic(new File(folder(id),"meta.json"),m);return m;
    }
    synchronized void export(String id,OutputStream out)throws Exception {
        JSONObject m=get(id),header=new JSONObject().put("type","fly-human-session-jsonl").put("version",1).put("session",m);
        out.write((header.toString()+"\n").getBytes(StandardCharsets.UTF_8));long remaining=m.getLong("storedBytes");
        try(InputStream in=new FileInputStream(new File(folder(id),"events.jsonl"))){byte[] buffer=new byte[65536];while(remaining>0){int n=in.read(buffer,0,(int)Math.min(buffer.length,remaining));if(n<0)throw new EOFException("Журнал повреждён");out.write(buffer,0,n);remaining-=n;}}out.flush();
    }
    /** Bounded, immutable pages. Cursor offsets refer only to the committed prefix. */
    synchronized JSONObject read(String id,String snapshot,JSONObject cursor)throws Exception {
        JSONObject m=get(id);long committed=m.getLong("storedBytes"),count=m.getLong("events");
        if(!"closed".equals(m.getString("status"))||!snapshot.equals(count+":"+committed))throw new IOException("Сессия изменилась или не завершена");
        long offset=cursor==null?0:integer(cursor,"offset",0,committed),event=cursor==null?0:integer(cursor,"event",0,count);
        if((offset==0)!=(event==0)||(offset==committed)!=(event==count))throw new IOException("Неверный курсор сессии");
        File path=new File(folder(id),"events.jsonl");
        if(offset>0)try(RandomAccessFile f=new RandomAccessFile(path,"r")){f.seek(offset-1);if(f.read()!='\n')throw new IOException("Курсор внутри события");}
        JSONArray page=new JSONArray();int pageBytes=0;
        try(FileInputStream file=new FileInputStream(path)){
            file.getChannel().position(offset);
            try(BufferedInputStream in=new BufferedInputStream(file,8192)){
                while(offset<committed&&page.length()<32){
                    ByteArrayOutputStream line=new ByteArrayOutputStream();long consumed=0;boolean end=false;
                    while(offset+consumed<committed){int b=in.read();if(b<0)throw new EOFException("Журнал повреждён");consumed++;if(b=='\n'){end=true;break;}if(line.size()>=128*1024)throw new IOException("Событие слишком велико для чтения");line.write(b);}
                    if(!end)throw new IOException("Незавершённое событие");
                    if(page.length()>0&&pageBytes+consumed>128*1024)break;
                    JSONObject e=new JSONObject(new String(line.toByteArray(),StandardCharsets.UTF_8));
                    events(new JSONArray().put(e));if(e.getLong("sequence")!=event||event>=count)throw new IOException("Повреждён порядок событий");
                    page.put(e);offset+=consumed;event++;pageBytes+=consumed;
                }
            }
        }
        if((offset==committed)!=(event==count))throw new IOException("Счётчики не совпадают с журналом");
        return new JSONObject().put("events",page).put("next",offset==committed?JSONObject.NULL:new JSONObject().put("offset",offset).put("event",event)).put("snapshot",snapshot);
    }
    synchronized void delete(String id)throws Exception {
        JSONObject m=get(id);if(!"closed".equals(m.getString("status")))throw new IOException("Сначала завершите сессию");
        File dir=folder(id);File[] files=dir.listFiles();if(files==null)throw new IOException("Сессия недоступна");
        for(File f:files)if(!f.getName().equals("meta.json")&&!f.delete())throw new IOException("Не удалось полностью удалить сессию");
        if(!new File(dir,"meta.json").delete()||!dir.delete())throw new IOException("Не удалось полностью удалить сессию");
    }
    private static String sha256(byte[] bytes)throws Exception {StringBuilder s=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))s.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return s.toString();}
}
