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
  System.out.println("GraphDelta checks passed");
 }
}
