package org.node.flyconsole;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
public final class FdbLearningCheck {
 static void require(boolean value,String why){if(!value)throw new AssertionError(why);}
 static Graph graph(){long[] ids=new long[30];for(int i=0;i<30;i++)ids[i]=i+1;return new Graph(ids,new int[31],new int[0],new float[0]);}
 static int[] sources(){int[] a=new int[16];for(int i=0;i<a.length;i++)a[i]=i;return a;}
 static int[] targets(){int[] a=new int[12];for(int i=0;i<a.length;i++)a[i]=16+i;return a;}
 static Engine.Result active(){int[] c=new int[30];c[0]=100;c[28]=100;return new Engine.Result(c,200,100,100,0);}
 static FdbLearning learner(Graph g,GraphDelta d){return new FdbLearning(g,d,sources(),targets(),.2,16,127);}
 static float weight(GraphDelta d,int source,int target){for(GraphDelta.Edge e:d.outgoing(source))if(e.target==target)return e.weight;return Float.NaN;}
 public static void main(String[] args){
  Graph g=graph();GraphDelta d=new GraphDelta(30);FdbLearning l=learner(g,d);double[] retina=new double[16];retina[0]=1;
  for(int i=0;i<40;i++)l.observe(retina,2048,0,true,new int[0],false);
  require(d.growthCount()==1&&weight(d,0,27)>120,"teacher aligns all 12 output bits");
  Engine.Options o=new Engine.Options();o.delta=d;
  Engine.Result baseline=new Engine(g).advance(new int[]{0},new double[]{1000},100,new Engine.Options(),new AtomicBoolean());
  Engine.Result trained=new Engine(g).advance(new int[]{0},new double[]{1000},100,o,new AtomicBoolean());
  require(baseline.counts[27]==0&&trained.counts[27]>0,"weights affect actual CPU dynamics");
  long rev=d.version(),count=l.observations();l.observe(retina,2048,1,false,new int[0],false);require(d.version()==rev&&l.observations()==count,"unattributed old automatic packets are rejected");
  d.removeEdge(0,27);require(d.version()>rev&&d.outgoing(0).isEmpty(),"removal clears adjacency and revision");
  require(new Engine(g).advance(new int[]{0},new double[]{1000},100,o,new AtomicBoolean()).counts[27]==0,"removed edge ceases CPU effect after a fresh dynamic state");
  d=new GraphDelta(30);l=learner(g,d);d.addEdge(0,16,1);d.addEdge(0,26,7);l.seed(123);
  for(int i=0;i<40;i++){FdbLearning.Decision a=l.decide("good-"+i,active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,a.mask==1?1:-1,.1,6,true,false,null);}
  require(weight(d,0,16)>1&&weight(d,0,26)==7,"reward changes action paths, not arbitrary active disconnected edges");
  for(int i=0;i<200;i++){FdbLearning.Decision a=l.decide("bad-"+i,active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,a.mask==1?-1:1,.1,6,true,false,null);}
  require(l.pruned()>0&&(!d.hasEdge(0,16)||weight(d,0,16)<2),"sustained negative action contribution prunes existing topology");
  require(d.growthCount()<=16,"bounded births");
  l.boundary();rev=d.version();count=l.observations();long rng=l.rng();
  for(int i=0;i<10;i++)l.decide("eval-"+i,active(),new int[]{0,1},4095,100,0,false,null);
  require(d.version()==rev&&l.observations()==count&&l.rng()==rng,"evaluation freezes weights, counters and RNG");
  FdbLearning.Decision a=l.decide("intervention",active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,1,.1,6,false,false,null);require(d.version()==rev&&l.rejected()==1,"manual intervention cannot receive credit");
  a=l.decide("late-rejected",active(),new int[]{0,1},4095,100,0,true,null);FdbLearning.Decision newer=l.decide("newer",active(),new int[]{0,1},4095,100,0,true,null);
  l.feedback(a.id,a.mask,1,.1,6,false,false,null);long automatic=l.automatic();l.feedback(newer.id,newer.mask,0,.1,6,true,false,null);require(l.automatic()==automatic+1,"rejecting the preceding outcome preserves already-produced next decision");
  rev=d.version();count=l.observations();
  a=l.decide("frozen",active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,1,.1,6,true,true,null);require(d.version()==rev&&l.observations()==count,"frozen feedback is inert");l.boundary();
  d=new GraphDelta(30);d.addEdge(0,28,10);d.addEdge(28,16,50);l=learner(g,d);
  for(int i=0;i<8;i++){a=l.decide("path-"+i,active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,a.mask==1?1:-1,.1,6,true,false,null);}
  require(weight(d,0,28)>10&&weight(d,28,16)>50,"credit travels through a bounded existing exogenous internal path");
  int[] offsets=new int[31];Arrays.fill(offsets,1);offsets[0]=0;Graph base=new Graph(g.ids,offsets,new int[]{16},new float[]{3});GraphDelta bd=new GraphDelta(30);bd.addWeightDelta(0,16,2);l=learner(base,bd);l.observe(retina,1,0,true,null,false);
  for(int i=0;i<10;i++){a=l.decide("base-"+i,active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask,1,.1,6,true,false,null);}
  require(base.weights[0]==3&&bd.weightDelta(0,16)==2&&!bd.hasEdge(0,16),"W0 and explicit delta are preserved, births do not duplicate base edges");
  System.out.println("PASS: FDB action-specific eligibility, delayed rewards, negative evidence pruning, CPU removal, bounded internal credit, frozen RNG, interventions, immutable W0 / explicit delta");
 }
}
