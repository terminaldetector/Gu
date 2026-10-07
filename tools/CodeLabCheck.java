package org.node.flyconsole;
import org.json.*;import java.io.*;import java.util.zip.*;import java.util.concurrent.atomic.AtomicBoolean;
public final class CodeLabCheck {
 static byte[] zip(String... rows)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();try(ZipOutputStream z=new ZipOutputStream(b)){for(int i=0;i<rows.length;i+=2){z.putNextEntry(new ZipEntry(rows[i]));z.write(rows[i+1].getBytes("UTF-8"));z.closeEntry();}}return b.toByteArray();}
 static void rejected(byte[] b)throws Exception{try{LabModule.read(new ByteArrayInputStream(b));throw new AssertionError("accepted invalid ZIP");}catch(IOException|JSONException expected){}}
 public static void main(String[] args)throws Exception{
  if(args.length==0){String m="{\"id\":\"test\",\"api\":1,\"entry\":\"src/main.js\"}";
   JSONObject p=LabModule.read(new ByteArrayInputStream(zip("module.json",m,"src/","","src/main.js","module.exports=42")));if(!p.getString("id").equals("test"))throw new AssertionError();
   rejected(zip("../escape.js","x"));rejected(zip("module.json",m,"src/main.js","x","payload.so","binary"));rejected(zip("module.json","{\"id\":\"x\",\"api\":2,\"entry\":\"x.js\"}","x.js","x"));rejected(zip("module.json",m,"src/main.js",new String(new char[262145]).replace('\0','x')));System.out.println("PASS: module ZIP, traversal/native-file/size/API rejection");return;
  }
  Graph graph=Graph.demo();Engine engine=new Engine(graph);AtomicBoolean cancel=new AtomicBoolean();BufferedReader in=new BufferedReader(new InputStreamReader(System.in));String line;
  while((line=in.readLine())!=null){JSONObject p=new JSONObject(line);JSONObject reply=new JSONObject();try{if(p.getString("method").equals("info")){JSONArray ids=new JSONArray();for(long id:graph.ids)ids.put(Long.toString(id));reply.put("data",new JSONObject().put("ids",ids).put("neurons",graph.ids.length).put("edges",graph.targets.length));}else reply.put("data",InferenceProgram.run(engine,graph,p.getJSONObject("payload").toString(),cancel));}catch(Exception ex){reply.put("error",ex.getMessage());}System.out.println(reply);System.out.flush();}
 }
}
