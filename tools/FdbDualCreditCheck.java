package org.node.flyconsole;
import java.util.*;import org.json.*;
public final class FdbDualCreditCheck {
 static void check(boolean b,String m){if(!b)throw new AssertionError(m);}
 static FdbLearning learner(Graph g,GraphDelta d,String p){FdbLearning l=FdbLearningCheck.learner(g,d);l.creditProfile(p);l.seed(23);return l;}
 static JSONObject save(FdbLearning l,Graph g)throws Exception{return FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());}
 static void step(FdbLearning l,int i,Engine.Result r,double reward){FdbLearning.Decision d=l.decide("d"+i,r,new int[]{0,1},4095,100,0,true,null);l.feedback(d.id,d.mask,reward,.5,30,true,false,null);}
 public static void main(String[] args)throws Exception{
  Graph g=FdbLearningCheck.graph();GraphDelta d=new GraphDelta(30);d.addEdge(0,16,10);d.addEdge(0,26,7);FdbLearning l=learner(g,d,"dual-v1");
  step(l,0,FdbLearningCheck.active(),0);check(l.traces().size()==1,"inactive / unrelated candidates do not consume trace cap");
  FdbLearning.Trace t=l.traces().get(0);check(t.slowEligibility!=0&&Math.abs(t.slowEligibility)>Math.abs(t.eligibility),"independent fast and slow");
  Engine.Result silent=new Engine.Result(new int[30],0,100,100,0);
  for(int i=1;i<10;i++)step(l,i,silent,0);
  t=l.traces().get(0);check(Math.abs(t.slowEligibility)>100*Math.abs(t.eligibility),"delayed outcome retains bounded action trace");
  step(l,10,silent,1);check(FdbLearningCheck.weight(d,0,16)!=10&&FdbLearningCheck.weight(d,0,26)==7,"delayed reward changes only eligible historical path");
  JSONObject state=save(l,g);check(state.getInt("version")==5,"v5 only for new profile");
  FdbLearning resumed=learner(g,FdbCheckpointCheck.copy(d),"dual-v1");FdbCheckpoint.restore(resumed,state,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());check(save(resumed,g).toString().equals(state.toString()),"v5 exact lab state roundtrip");
  String before=save(resumed,g).toString();JSONObject bad=new JSONObject(before);bad.getJSONArray("traces").getJSONObject(0).put("slowEligibility",3);
  boolean rejected=false;try{FdbCheckpoint.restore(resumed,bad,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());}catch(Exception e){rejected=true;}check(rejected&&before.equals(save(resumed,g).toString()),"v5 corrupt reject before mutation");
  FdbLearning single=learner(g,FdbCheckpointCheck.copy(d),"single-v1");FdbCheckpoint.restore(single,state,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());check(single.traces().get(0).slowEligibility==0&&single.traces().get(0).eligibility==0,"profile switch retains evidence but clears time");check(save(single,g).getInt("version")==4,"legacy save still v4");
  FdbCheckpoint.restore(resumed,save(single,g),g,FdbLearningCheck.sources(),FdbLearningCheck.targets());check(resumed.traces().get(0).slowEligibility==0,"v4 to v5 fabricates no history");
  l.boundary();check(l.traces().get(0).slowEligibility==0&&l.traces().get(0).eligibility==0,"episode boundary clears both speeds");
  FdbLearning.Decision a=l.decide("lesion",FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);long rev=d.version(),rng=l.rng();l.feedback(a.id,a.mask,1,.1,6,true,false,new int[]{28});check(d.version()==rev&&l.rng()==rng,"changed lesion set invalidates cached path without RNG mutation");
  a=l.decide("old",FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);FdbLearning.Decision next=l.decide("new",FdbLearningCheck.active(),new int[]{0,1},4095,100,0,true,null);l.feedback(a.id,a.mask^1,1,.1,6,true,false,null);long count=l.automatic();l.feedback(next.id,next.mask,0,.1,6,true,false,null);check(l.automatic()==count+1,"old rejected result preserves newer pending action");
  before=save(l,g).toString();for(int i=0;i<10;i++)l.decide("eval"+i,silent,new int[]{0,1},4095,100,0,false,null);l.feedback("none",0,1,.1,6,true,true,null);check(before.equals(save(l,g).toString()),"full evaluation state frozen");
  for(int i=0;i<16;i++)step(l,100+i,silent,0);check(l.traces().get(0).slowEligibility==0,"hard horizon 16 confirmed decisions");
  GraphDelta rd=new GraphDelta(30);FdbLearning rate=new FdbLearning(g,rd,FdbLearningCheck.sources(),FdbLearningCheck.targets(),.2,2048,127,true,"expanded");rate.creditProfile("dual-rate-v1");
  int[] counts=new int[30];counts[0]=10;counts[16]=1;Engine.Result activity=new Engine.Result(counts,11,100,100,0);
  // Equal measurement windows have zero rate difference, even if activity is nonzero.
  for(int i=0;i<20;i++){FdbLearning.Decision q=rate.decide("rate"+i,activity,new int[]{1,2},4095,100,0,true,null);rate.feedback(q.id,q.mask,1,.1,6,true,false,null);}
  check(rd.thresholds().isEmpty(),"constant rates do not fabricate threshold derivative");
  JSONObject rateState=save(rate,g);FdbLearning restoredRate=new FdbLearning(g,new GraphDelta(30),FdbLearningCheck.sources(),FdbLearningCheck.targets(),.2,2048,127,true,"expanded");restoredRate.creditProfile("dual-rate-v1");FdbCheckpoint.restore(restoredRate,rateState,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());check(rateState.toString().equals(save(restoredRate,g).toString()),"exact confirmed rate context roundtrip");restoredRate.boundary();check(restoredRate.previousRates().isEmpty()&&restoredRate.previousMask()==-1,"rate context cannot cross episode boundary");
  GraphDelta atomic=new GraphDelta(30);long oldRevision=atomic.version();JSONObject links=new JSONObject().put("edges",new JSONArray().put(new JSONObject().put("source","1").put("target","17").put("weight",1)).put(new JSONObject().put("source","1").put("target","17").put("weight",2)));rejected=false;try{FdbCheckpoint.restoreLinks(atomic,links,g);}catch(Exception e){rejected=true;}check(rejected&&atomic.version()==oldRevision&&atomic.growthCount()==0,"link decoder validates entire payload before mutation");
  // Worst supported trace table with maximal string IDs remains under the outer 4 MiB envelope budget.
  long[] longIds=new long[30];for(int i=0;i<30;i++)longIds[i]=Long.MAX_VALUE-30+i;Graph sizeGraph=new Graph(longIds,new int[31],new int[0],new float[0]);FdbLearning sizeLearner=learner(sizeGraph,new GraphDelta(30),"dual-v1");
  java.util.List<FdbLearning.Trace> worst=new ArrayList<>();for(int s=0;s<30;s++)for(int target=0;target<30;target++)if(s!=target){FdbLearning.Trace w=new FdbLearning.Trace(s,target);w.eligibility=w.slowEligibility=1.2345678901234567;w.slowAge=15;w.utility=w.support=3.2345678901234567;w.evidence=9007199254740991L;w.bad=Integer.MAX_VALUE;worst.add(w);}
  sizeLearner.restore(0,0,0,1,0,0,0,0,worst);long bytes=save(sizeLearner,sizeGraph).toString().getBytes("UTF-8").length;check(bytes*8192/worst.size()<3*1024*1024,"v5 trace payload has envelope headroom");
  System.out.println("PASS: dual eligibility horizon, delayed credit, lesion/mask/freeze guards, v4/v5 migration, atomic malformed rejection, bounded serialization");
 }
}
