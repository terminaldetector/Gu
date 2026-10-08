package org.node.flyconsole;

import java.io.FileInputStream;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

/** Full official graph load and CPU integration; no miniature substitute. */
public final class MaleCnsGraphCheck {
 public static void main(String[] args) throws Exception {
  if(args.length!=1)throw new IllegalArgumentException("Expected male-cns.fly.gz path");
  Graph graph;
  try(FileInputStream file=new FileInputStream(args[0])){graph=Graph.read(file,256L*1024*1024);}
  if(graph.ids.length!=165122||graph.targets.length!=25563197)throw new AssertionError("official graph universe");
  if(!graph.fingerprint().equals("90d9baae7627a521b08d5112eeb27057994b213bb2ecbc00aae1fb1c52e1cb56"))throw new AssertionError("Male CNS graph SHA256");
  if(graph.memoryBytes()!=223659732L)throw new AssertionError("runtime memory passport");
  int source=Arrays.binarySearch(graph.ids,11139L),target=Arrays.binarySearch(graph.ids,164190L);
  if(source<0||target<0)throw new AssertionError("retinal/motor ports");
  Engine engine=new Engine(graph);engine.reset(17);
  Engine.Options options=new Engine.Options();
  Engine.Result baseline=engine.advance(new int[]{source},new double[]{1000},50,options,new AtomicBoolean());
  GraphDelta acquired=new GraphDelta(graph.ids.length,4);acquired.addEdge(source,target,120);
  options.delta=acquired;engine.reset(17);
  Engine.Result modified=engine.advance(new int[]{source},new double[]{1000},50,options,new AtomicBoolean());
  if(modified.counts[target]<=baseline.counts[target])throw new AssertionError("actual Wexo has no motor effect");
  acquired.removeEdge(source,target);engine.reset(17);
  Engine.Result removed=engine.advance(new int[]{source},new double[]{1000},50,options,new AtomicBoolean());
  if(!Arrays.equals(baseline.counts,removed.counts))throw new AssertionError("remove restores baseline");
  try(FileInputStream file=new FileInputStream(args[0])){
   try{Graph.read(file,64L*1024*1024);throw new AssertionError("unsafe heap accepted");}
   catch(java.io.IOException expected){if(!expected.getMessage().contains("бюджет"))throw expected;}
  }
  System.out.println("PASS full Male CNS: 165122 neurons, 25563197 edges, pinned fingerprint, heap preflight, CPU motor spikes "+baseline.counts[target]+" -> "+modified.counts[target]+" -> "+removed.counts[target]);
 }
}
