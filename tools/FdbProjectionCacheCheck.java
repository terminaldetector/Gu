package org.node.flyconsole;
import java.lang.reflect.*;import java.util.*;
public final class FdbProjectionCacheCheck {
 @SuppressWarnings("unchecked") static Map<Long,GraphDelta.Edge> paths(FdbLearning l)throws Exception{Field f=FdbLearning.class.getDeclaredField("basePaths");f.setAccessible(true);return (Map<Long,GraphDelta.Edge>)f.get(l);}
 static FdbLearning make(Graph g,int[] out,String mode){return new FdbLearning(g,new GraphDelta(g.ids.length),FdbLearningCheck.sources(),out,.05,256,32,true,mode);}
 public static void main(String[] args)throws Exception{
  Graph g=ExpandedPlasticityCheck.large();long start=System.nanoTime();FdbLearning first=make(g,FdbLearningCheck.targets(),"root");long cold=System.nanoTime()-start;
  start=System.nanoTime();FdbLearning second=make(g,FdbLearningCheck.targets(),"expanded");long warm=System.nanoTime()-start;
  Map<Long,GraphDelta.Edge> a=paths(first),b=paths(second);if(a==b||a.isEmpty()||a.values().iterator().next()!=b.values().iterator().next())throw new AssertionError("reuse immutable projection records but not learner map");
  if(!first.baseProjectionSha().equals(second.baseProjectionSha()))throw new AssertionError("cache changed selection");
  first.seed(99);if(second.rng()==first.rng())throw new AssertionError("RNG leaked between learners");
  Graph other=new Graph(g.ids.clone(),g.offsets.clone(),g.targets.clone(),g.weights.clone());if(paths(make(other,FdbLearningCheck.targets(),"root")).values().iterator().next()==a.values().iterator().next())throw new AssertionError("graph identities aliased");
  int[] ports=FdbLearningCheck.targets();ports[0]=29;FdbLearning changed=make(g,ports,"root");if(changed.baseProjectionSha().equals(first.baseProjectionSha()))throw new AssertionError("changed ports reused projection");
  if(paths(make(g,FdbLearningCheck.targets(),"base")).size()>512)throw new AssertionError("base/expanded cache collision");
  a.clear();if(paths(make(g,FdbLearningCheck.targets(),"root")).isEmpty())throw new AssertionError("mutable map leaked into cache");
  for(int i=0;i<12;i++){ports=FdbLearningCheck.targets();ports[0]=30+i;make(g,ports,"root");}
  Field f=FdbLearning.class.getDeclaredField("projectionCache");f.setAccessible(true);if(((Map<?,?>)((Map<?,?>)f.get(null)).get(g)).size()>8)throw new AssertionError("cache is unbounded");
  System.out.println("PASS projection cache: graph/ports/limit isolation, private maps/RNG, 8-entry bound; fixture coldMs="+cold/1e6+" warmMs="+warm/1e6+" (not phone latency)");
 }
}
