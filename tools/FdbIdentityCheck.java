package org.node.flyconsole;
import org.json.*;import java.util.*;
/** Distinct identities with identical dimensions exercise model isolation, not biological validity. */
public final class FdbIdentityCheck {
 interface Task{void run()throws Exception;}
 static void reject(Task t)throws Exception{try{t.run();throw new AssertionError("invalid FDB accepted");}catch(IllegalArgumentException expected){}}
 static JSONObject edge(String s,String t,double w)throws Exception{return new JSONObject().put("source",s).put("target",t).put("weight",w);}
 public static void main(String[] args)throws Exception{
  Graph empty=FdbLearningCheck.graph();int[] off=new int[31];Arrays.fill(off,1);off[0]=0;
  Graph base=new Graph(empty.ids.clone(),off,new int[]{16},new float[]{1});
  JSONObject good=new JSONObject().put("deltas",new JSONArray().put(edge("1","17",2))).put("edges",new JSONArray().put(edge("2","18",3)));
  GraphDelta layer=new GraphDelta(30);FdbCheckpoint.restoreLinks(layer,good,base);
  if(layer.deltaCount()!=1||layer.growthCount()!=1)throw new AssertionError("both weight classes restore");
  reject(()->FdbCheckpoint.restoreLinks(new GraphDelta(30),new JSONObject().put("edges",new JSONArray().put(edge("1","17",1))),base));
  reject(()->FdbCheckpoint.restoreLinks(new GraphDelta(30),new JSONObject().put("deltas",new JSONArray().put(edge("2","18",1))),base));
  for(String kind:new String[]{"edges","deltas"}){
   JSONObject e=kind.equals("edges")?edge("2","18",1):edge("1","17",1);
   reject(()->FdbCheckpoint.restoreLinks(new GraphDelta(30),new JSONObject().put(kind,new JSONArray().put(e).put(e)),base));
  }
  reject(()->FdbCheckpoint.restoreLinks(new GraphDelta(30),new JSONObject().put("edges",new JSONArray().put(edge("2","2",1))),base));
  reject(()->FdbCheckpoint.restoreLinks(new GraphDelta(30),new JSONObject().put("edges",new JSONArray().put(edge("999","18",1))),base));
  GraphDelta d=new GraphDelta(30);FdbLearning a=FdbLearningCheck.learner(empty,d);JSONObject saved=FdbCheckpoint.save(a,empty,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  FdbLearning other=FdbLearningCheck.learner(base,new GraphDelta(30));String before=FdbCheckpoint.save(other,base,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString();
  reject(()->FdbCheckpoint.restore(other,saved,base,FdbLearningCheck.sources(),FdbLearningCheck.targets()));
  if(!before.equals(FdbCheckpoint.save(other,base,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()))throw new AssertionError("cross-model rejection mutated learner");
  long[] large=empty.ids.clone();for(int i=0;i<large.length;i++)large[i]+=72057594000000000L;
  Graph maleStyle=new Graph(large,new int[31],new int[0],new float[0]);GraphDelta isolated=new GraphDelta(30);FdbLearning largeIds=FdbLearningCheck.learner(maleStyle,isolated);
  double[] retina=new double[16];retina[0]=1;for(int i=0;i<10;i++)largeIds.observe(retina,2048,0,true,new int[0],false);
  JSONObject state=FdbCheckpoint.save(largeIds,maleStyle,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  if(!state.getJSONArray("sources").getString(0).equals(Long.toString(large[0])))throw new AssertionError("64-bit IDs must not become JS numbers");
  FdbLearning restored=FdbLearningCheck.learner(maleStyle,isolated);FdbCheckpoint.restore(restored,state,maleStyle,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  if(restored.observations()!=10||d.growthCount()!=0)throw new AssertionError("isolated exact large-ID continuation");
  System.out.println("PASS: FDB graph SHA guard, W0/Wexo class validation, duplicate/self/unknown rejection and lossless 64-bit model IDs");
 }
}
