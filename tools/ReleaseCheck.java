package org.node.flyconsole;
import java.io.*;import java.nio.file.*;import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;import org.json.*;
/** Regression checks for state-preserving validation and shared model loading. */
public final class ReleaseCheck {
 static void reject(Engine e,Graph g,String source)throws Exception{try{InferenceProgram.run(e,g,source,new AtomicBoolean());throw new AssertionError("accepted invalid "+source);}catch(IllegalArgumentException|JSONException expected){}}
 public static void main(String[] args)throws Exception{
  Graph g=Graph.demo();Engine e=new Engine(g);String valid="{\"seed\":2,\"steps\":[{\"ms\":20,\"inputs\":[],\"outputs\":[\"1\"]}]}";
  for(String p:new String[]{valid.replace("20","20.5"),valid.replace("\"seed\":2","\"seed\":2.5"),valid.replace("\"seed\":2","\"seed\":\"2\""),valid.replace("\"seed\":2","\"reset\":\"true\""),valid.replace("\"seed\":2","\"disableInhibition\":1"),valid.replace("\"seed\":2","\"gain\":\"1\""),valid.replace("\"seed\":2","\"lesions\":false")})reject(e,g,p);
  long tick=InferenceProgram.run(e,g,valid,new AtomicBoolean()).getJSONArray("results").getJSONObject(0).getLong("end_tick");
  reject(e,g,valid.replace("20","-1"));InferenceProgram.run(e,g,valid,new AtomicBoolean(true));
  JSONObject next=InferenceProgram.run(e,g,valid.replace("\"seed\":2","\"reset\":false"),new AtomicBoolean());if(next.getJSONArray("results").getJSONObject(0).getLong("end_tick")!=tick*2)throw new AssertionError("invalid/cancelled request reset state");
  int n=256;long[] ids=new long[n];for(int i=0;i<n;i++)ids[i]=i+1;Graph wide=new Graph(ids,new int[n+1],new int[0],new float[0]);JSONArray inputs=new JSONArray();for(long id:ids)inputs.put(new JSONObject().put("id",Long.toString(id)).put("hz",150));JSONObject p=new JSONObject().put("steps",new JSONArray().put(new JSONObject().put("ms",1).put("inputs",inputs).put("outputs",new JSONArray())));InferenceProgram.run(new Engine(wide),wide,p.toString(),new AtomicBoolean());
  ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream d=new DataOutputStream(bytes);d.writeInt(0x464c5931);d.writeInt(4);d.writeInt(3);for(long id:g.ids)d.writeLong(id);for(int v:g.offsets)d.writeInt(v);for(int v:g.targets)d.writeInt(v);for(float v:g.weights)d.writeFloat(v);d.close();
  AtomicInteger opens=new AtomicInteger();Path invalid=Files.createTempFile("fly-invalid-",".fly");Files.write(invalid,new byte[12]);ExecutorService pool=Executors.newFixedThreadPool(4);List<Future<Graph>> tasks=new ArrayList<>();
  for(int i=0;i<4;i++)tasks.add(pool.submit(()->GraphCache.load(invalid.toFile(),()->{opens.incrementAndGet();return new ByteArrayInputStream(bytes.toByteArray());},1000000)));
  Graph shared=tasks.get(0).get();for(Future<Graph> task:tasks)if(task.get()!=shared)throw new AssertionError("duplicate graph");pool.shutdown();Files.delete(invalid);if(opens.get()!=1||GraphCache.notice.isEmpty()||!shared.fingerprint().equals(g.fingerprint()))throw new AssertionError("cache/fallback/fingerprint");
  if(g.fingerprint().equals(new Graph(g.ids,g.offsets,g.targets,new float[]{12,12,-11}).fingerprint()))throw new AssertionError("weights identity");
  System.out.println("PASS: strict numbers/booleans, invalid/cancelled state preservation, 256 inputs, concurrent graph cache, fallback notice, SHA identity");
 }
}
