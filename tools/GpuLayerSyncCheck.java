package org.node.flyconsole;
import java.util.*;
public final class GpuLayerSyncCheck {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 static int words(List<GpuLayerSync.Span> spans){return spans.stream().mapToInt(s->s.bits.length).sum();}
 public static void main(String[] args){
  int n=2100;long[] ids=new long[n];int[] off=new int[n+1],targets=new int[2048];float[] weights=new float[2048];for(int i=0;i<n;i++){ids[i]=i+1;off[i]=i==0?0:2048;}off[n]=2048;for(int i=0;i<2048;i++){targets[i]=i+1;weights[i]=10;}
  Graph g=new Graph(ids,off,targets,weights);double[] magnitude=new double[n];Arrays.fill(magnitude,10);GpuLayerSync sync=new GpuLayerSync(g,magnitude);GraphDelta d=new GraphDelta(n,2048);
  GpuLayerSync.Plan p=sync.prepare(d);sync.commit(p);check(sync.prepare(d)==null,"unchanged revision skips all planning");
  long topo=d.topologyRevision(),root=d.rootRevision(),weight=d.weightRevision(),threshold=d.thresholdRevision();
  for(int i=0;i<2048;i++)d.addWeightDelta(0,i+1,1);check(d.rootRevision()>root&&d.topologyRevision()==topo&&d.weightRevision()==weight&&d.thresholdRevision()==threshold,"root revision isolated");
  p=sync.prepare(d);check(p.rootSpans.size()==1&&words(p.rootSpans)==2048&&p.overlay==null,"2048 contiguous root updates in one sparse upload");sync.commit(p);
  d.addEdge(1,2099,-12);p=sync.prepare(d);check(p.overlay!=null&&p.rootSpans.isEmpty(),"birth rebuilds only overlay");int pos=p.positions[0];sync.commit(p);topo=d.topologyRevision();
  d.setGrowthWeight(1,2099,-15);check(d.topologyRevision()==topo,"weight update keeps topology revision");p=sync.prepare(d);check(p.overlay==null&&p.extraSpans.size()==1&&p.extraSpans.get(0).word==pos&&Float.intBitsToFloat(p.extraSpans.get(0).bits[0])==-15,"signed Wexo patch preserves layout");sync.commit(p);
  long cp=d.checkpoint();d.setThresholdOffset(2,-5);p=sync.prepare(d);check(p.overlay==null&&p.rootSpans.isEmpty()&&p.extraSpans.isEmpty()&&p.thresholdSpans.size()==1,"threshold change isolated");sync.commit(p);
  d.rollback(cp);p=sync.prepare(d);check(p.overlay==null&&p.thresholdSpans.get(0).bits[0]==0,"rollback monotonic revisions restore thresholds without rebuilding same layout");sync.commit(p);
  d.removeEdge(1,2099);p=sync.prepare(d);check(p.overlay!=null&&p.extras.isEmpty(),"prune rebuilds adjacency");sync.commit(p);
  d.addWeightDelta(0,100,-1);p=sync.prepare(d);check(p.rootSpans.size()==1&&p.rootSpans.get(0).word==99&&Float.intBitsToFloat(p.rootSpans.get(0).bits[0])==10,"removed delta restores W0");
  // No commit simulates an upload failure: retry must contain the same patch.
  check(sync.prepare(d).rootSpans.get(0).word==99,"failed upload remains dirty");sync.commit(p);
  d.setThresholdOffset(3,2);p=sync.prepare(d);d.setThresholdOffset(3,4);check(Float.intBitsToFloat(p.thresholdSpans.get(0).bits[0])==2,"snapshot remains coherent after mutation");sync.commit(p);check(Float.intBitsToFloat(sync.prepare(d).thresholdSpans.get(0).bits[0])==4,"later mutation not lost");
  p=sync.prepare(null);check(words(p.rootSpans)==2047,"detaching layer restores all roots");sync.commit(p);
  for(float w:g.weights)check(w==10,"W0 immutable");
  TreeMap<Integer,Integer> sparse=new TreeMap<>();sparse.put(1,1);sparse.put(2,2);sparse.put(1000,3);check(GpuLayerSync.spans(sparse).size()==2,"no full upload across gaps");
  System.out.println("PASS: GPU planner contiguous roots 2048 -> 1 upload, sparse gaps, Wexo weight-only no adjacency rebuild, threshold isolation, restore, failure retry, atomic snapshots");
 }
}
