package org.node.flyconsole;
public final class GraphDeltaCheck {
 public static void main(String[] args) {
  GraphDelta d=new GraphDelta(4,2);
  d.addWeightDelta(0,1,1.25f);
  if(Math.abs(d.weightDelta(0,1)-1.25f)>1e-6||d.deltaCount()!=1)throw new AssertionError("delta");
  long cp=d.checkpoint();
  d.addEdge(0,2,.5f);
  if(d.growthCount()!=1||d.outgoing(0).size()!=1)throw new AssertionError("growth");
  d.rollback(cp);
  if(d.growthCount()!=0||d.weightDelta(0,1)!=1.25f)throw new AssertionError("rollback");
  if(!d.genome().startsWith("FDB1;"))throw new AssertionError("genome");
  Graph graph=new Graph(new long[]{1,2},new int[]{0,0,0},new int[0],new float[0]);
  Engine.Options options=new Engine.Options();
  Engine.Result baseline=new Engine(graph).advance(new int[]{0},new double[]{1000},100,options,new java.util.concurrent.atomic.AtomicBoolean());
  GraphDelta extra=new GraphDelta(2);extra.addEdge(0,1,120);options.delta=extra;
  Engine.Result modified=new Engine(graph).advance(new int[]{0},new double[]{1000},100,options,new java.util.concurrent.atomic.AtomicBoolean());
  if(baseline.counts[1]!=0||modified.counts[1]==0)throw new AssertionError("growth must affect actual LIF output");
  long before=extra.version(),snap=extra.checkpoint();extra.addEdge(1,0,1);extra.rollback(snap);
  if(extra.version()<=before)throw new AssertionError("rollback versions must be monotonic");
  GraphDelta capped=new GraphDelta(2,1);capped.addWeightDelta(0,1,1);
  try{capped.addWeightDelta(1,0,1);throw new AssertionError("delta cap");}catch(IllegalStateException expected){}
  System.out.println("GraphDelta checks passed");
 }
}
