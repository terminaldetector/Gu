package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.*;
/** Declarative ZIP package. Nothing is extracted to a filesystem or executed natively. */
public final class LabModule {
 public static JSONObject read(InputStream input)throws Exception{
  JSONObject files=new JSONObject();int count=0,total=0;Set<String> names=new HashSet<>();
  try(ZipInputStream zip=new ZipInputStream(input)){ZipEntry entry;while((entry=zip.getNextEntry())!=null){
   String name=entry.getName();if(entry.isDirectory()&&name.endsWith("/"))name=name.substring(0,name.length()-1);if(!name.matches("[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*")||name.contains("..")||name.length()>160)throw new IOException("Неверный путь ZIP");
   if(++count>64)throw new IOException("Больше 64 записей ZIP");if(entry.isDirectory())continue;if(!names.add(name))throw new IOException("Повтор файла или больше 64 файлов");
   if(!(name.endsWith(".js")||name.endsWith(".json")||name.endsWith(".txt")||name.endsWith(".md")))throw new IOException("Только JS/JSON/TXT/MD модули");
   ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[4096];int n;while((n=zip.read(b))!=-1){total+=n;if(total>1048576||out.size()+n>262144)throw new IOException("Модуль больше лимита 1 МиБ / файл 256 КиБ");out.write(b,0,n);}
   files.put(name,new String(out.toByteArray(),StandardCharsets.UTF_8));
  }}
  JSONObject manifest=new JSONObject(files.getString("module.json"));String id=manifest.getString("id"),entry=manifest.getString("entry");
  if(!id.matches("[a-z][a-z0-9_-]{0,47}")||manifest.getInt("api")!=1||!entry.endsWith(".js")||!files.has(entry))throw new IOException("Неверный module.json: id/api/entry");
  String title=manifest.optString("name",id);if(title.length()>80)throw new IOException("Имя длиннее 80 символов");
  return new JSONObject().put("id",id).put("name",title).put("api",1).put("entry",entry).put("files",files);
 }
}
