package org.node.flyconsole;

import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Real file storage plus the production pre-mutation lease, without Activity. */
public final class FdbLayerBindingCheck {
 interface Operation {void run()throws Exception;}
 private static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
 private static void rejects(Operation op,String message)throws Exception{try{op.run();}catch(Exception expected){return;}throw new AssertionError(message);}
 private static void erase(File path)throws Exception{if(path.isDirectory())for(File child:path.listFiles())erase(child);Files.deleteIfExists(path.toPath());}
 private static JSONObject packet(String id,JSONObject context)throws Exception {
  return new JSONObject().put("type","fly-layer-set").put("layerVersion",2).put("id",id).put("name","Current").put("notes","")
   .put("system",context.getString("system")).put("romHash",context.getString("romHash")).put("graph",new JSONObject().put("sha256",context.getString("graph")))
   .put("createdAt",1).put("updatedAt",1).put("configuration",new JSONObject().put("inputs",context.getJSONArray("inputs")).put("outputs",context.getJSONArray("outputs")))
   .put("key",new JSONObject().put("configuration",new JSONObject()).toString()).put("profile",new JSONObject()).put("runtime",new JSONObject())
   .put("policy",new JSONObject().put("updates",0).put("episodes",0)).put("journal",new JSONArray());
 }
 public static void main(String[] args)throws Exception {
  File root=Files.createTempDirectory("gu-current-binding-").toFile();
  try{
   LayerSetStore store=new LayerSetStore(root);FdbLayerBinding binding=new FdbLayerBinding();String id=UUID.randomUUID().toString();
   JSONObject context=FdbLayerBinding.context("nes","a".repeat(64),"b".repeat(64),new JSONArray().put("1"),new JSONArray().put("2"));
   JSONObject state=new JSONObject().put("deltas",new JSONArray()).put("edges",new JSONArray()).put("learningState",new JSONObject().put("baseline",.75).put("rng",123)).put("neuronDynamics",new JSONObject().put("thresholdOffsets",new JSONArray()));
   store.save(packet(id,context));byte[] prior=Files.readAllBytes(new File(root,id+".json").toPath());
   rejects(()->binding.requireMutation(id,context,3),"no mutation before durable bind");
   rejects(()->binding.bind(store,id,context,3,context,2,state),"stale configure ACK rejected");
   JSONObject wrong=new JSONObject(context.toString()).put("romHash","c".repeat(64));
   rejects(()->binding.bind(store,id,context,3,wrong,3,state),"stale ROM bind rejected");
   rejects(()->binding.bind(store,"",context,3,context,3,state),"empty ID rejected");
   rejects(()->binding.bind(store,UUID.randomUUID().toString(),context,3,context,3,state),"missing layer rejected");
   require(!binding.bound()&&Arrays.equals(prior,Files.readAllBytes(new File(root,id+".json").toPath())),"failed bind neither authorizes mutation nor changes saved layer");
   JSONObject otherPorts=new JSONObject(context.toString()).put("inputs",new JSONArray().put("9"));
   rejects(()->binding.bind(store,id,otherPorts,3,otherPorts,3,state),"existing saved ports verified before binding");
   binding.bind(store,id,context,3,context,3,state);binding.requireMutation(id,context,3);
   rejects(()->binding.bind(store,id,context,3,context,2,state),"old bind cannot supersede newer confirmed configuration");
   binding.requireMutation(id,context,3);
   rejects(()->binding.bind(store,id,context,3,wrong,3,state),"old ROM bind cannot revoke current confirmed lease");
   binding.requireMutation(id,context,3);
   require(store.get(id).getJSONObject("configuration").getJSONObject("fdb").getJSONObject("learningState").getDouble("baseline")==.75,"full live FDB durably flushed before binding succeeds");
   byte[] bound=Files.readAllBytes(new File(root,id+".json").toPath());
   for(int i=0;i<20;i++)binding.requireMutation(id,context,3);
   require(Arrays.equals(bound,Files.readAllBytes(new File(root,id+".json").toPath())),"cached inference guard performs no disk writes");
   rejects(()->binding.requireMutation("",context,3),"empty mutation ID cannot silently succeed");
   rejects(()->binding.requireMutation(UUID.randomUUID().toString(),context,3),"other layer ID rejected");
   rejects(()->binding.requireMutation(id,wrong,3),"changed ROM rejected");
   rejects(()->binding.requireMutation(id,context,4),"changed configure generation rejected");
   File backup=new File(root,id+".recovery.json");byte[] safe=Files.readAllBytes(backup.toPath());Files.delete(backup.toPath());require(backup.mkdir(),"inject backup failure");Files.write(new File(backup,"block").toPath(),new byte[]{1});
   rejects(()->binding.persist(store,id,context,3,state),"write failure reported");
   rejects(()->binding.requireMutation(id,context,3),"unconfirmed save blocks further learning");
   require(Arrays.equals(bound,Files.readAllBytes(new File(root,id+".json").toPath())),"failed write preserves last durable Current");
   erase(backup);Files.write(backup.toPath(),safe);binding.persist(store,id,context,3,state);binding.requireMutation(id,context,3);
   binding.invalidate();require(!binding.bound(),"lifecycle reset invalidates cached lease");rejects(()->binding.requireMutation(id,context,3),"old ID cannot restore invalidated lease");
   System.out.println("PASS: durable FDB Current binding, context/generation fences, pre-mutation rejection, full-state flush, cached inference, failed-write gate and recovery");
  }finally{erase(root);}
 }
}
