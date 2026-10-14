package org.node.flyconsole;
import java.io.*;import java.nio.file.*;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;import org.json.*;
public final class SyntheticGraphCheck {
 static void reject(JSONObject p)throws Exception{try{SyntheticGraphJson.read(p,64*1024*1024);throw new AssertionError("invalid graph accepted");}catch(AssertionError e){throw e;}catch(Exception expected){}}
 public static void main(String[] args)throws Exception{
  for(String path:args){JSONObject p=new JSONObject(new String(Files.readAllBytes(Paths.get(path)),"UTF-8"));Graph g=SyntheticGraphJson.read(p,64*1024*1024);
   ByteArrayOutputStream out=new ByteArrayOutputStream();g.write(out);Graph copy=Graph.read(new ByteArrayInputStream(out.toByteArray()),64*1024*1024);
   if(!g.fingerprint().equals(copy.fingerprint()))throw new AssertionError("binary round trip");
   Experiment e=Experiment.automatic(g,12);double[] rates=new double[16];Arrays.fill(rates,150);Engine a=new Engine(g),b=new Engine(copy);
   if(!Arrays.equals(a.advance(e.inputs,rates,100,new Engine.Options(),new AtomicBoolean()).counts,b.advance(e.inputs,rates,100,new Engine.Options(),new AtomicBoolean()).counts))throw new AssertionError("JSON dynamics mismatch");
   reject(new JSONObject(p.toString()).put("graph_sha256",String.join("",Collections.nCopies(64,"0"))));
   JSONObject bad=new JSONObject(p.toString());bad.getJSONArray("ids").put(0,1);reject(bad);
   bad=new JSONObject(p.toString());bad.getJSONArray("offsets").put(0,1);reject(bad);
   bad=new JSONObject(p.toString());bad.getJSONArray("targets").put(0,g.ids.length);reject(bad);
   bad=new JSONObject(p.toString());bad.getJSONArray("weights").put(0,129);reject(bad);
   bad=new JSONObject(p.toString());bad.getJSONArray("targets").put(1,bad.getJSONArray("targets").get(0));reject(bad);
   try{SyntheticGraphJson.read(p,1);throw new AssertionError("budget ignored");}catch(IOException expected){}
   System.out.println(path+": parser, digest, malformed input, memory budget and dynamics passed");
  }
 }
}
