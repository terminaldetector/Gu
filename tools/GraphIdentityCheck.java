package org.node.flyconsole;
import java.io.*;
public final class GraphIdentityCheck {
 static void require(boolean b,String message){if(!b)throw new AssertionError(message);}
 static byte[] bytes(Graph g)throws Exception{ByteArrayOutputStream b=new ByteArrayOutputStream();g.write(b);return b.toByteArray();}
 public static void main(String[] args)throws Exception{
  Graph female=Graph.demo(),male=new Graph(new long[]{10,20},new int[]{0,1,1},new int[]{1},new float[]{7});
  GraphCache.installNamed(female,"flywire-v783","female");GraphCache.rememberNamed("male-cns-v1.0",male);
  require(GraphCache.identity(male).equals("male-cns-v1.0"),"non-current actor identity");
  require(GraphCache.findNamed("male-cns-v1.0",female.fingerprint())==null,"wrong SHA must miss");
  byte[] data=bytes(male);
  GraphCache.installNamed(female,"male-cns-v1.0","stale fixture");
  Graph restored=GraphCache.loadNamed("male-cns-v1.0",()->new ByteArrayInputStream(data),100000,"male",male.fingerprint());
  require(restored.fingerprint().equals(male.fingerprint()),"current cache must check expected SHA");
  GraphCache.rememberNamed("flywire-v783",female);
  require(GraphCache.identity(female).equals("flywire-v783"),"global selection must not relabel other graph");
  require(GraphCache.findNamed("flywire-v783",female.fingerprint())==female,"independent cache entries");
  try{GraphCache.loadNamed("male-cns-v1.0",()->new ByteArrayInputStream(data),100000,"male",female.fingerprint());throw new AssertionError("wrong source digest accepted");}catch(IOException expected){}
  require(GraphCache.current==restored,"failed load keeps current model");
  System.out.println("Graph identity / SHA cache checks passed");
 }
}
