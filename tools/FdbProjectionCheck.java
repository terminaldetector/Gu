package org.node.flyconsole;
import org.json.*;import java.util.*;import java.security.*;import java.nio.charset.StandardCharsets;
public final class FdbProjectionCheck {
 public static void main(String[] args)throws Exception{
  int n=48;long[] ids=new long[n];int[] offsets=new int[n+1],targets=new int[20];float[] weights=new float[20];
  for(int i=0;i<n;i++){ids[i]=i+1;offsets[i]=Math.max(0,i-28);}offsets[n]=20;
  for(int i=0;i<20;i++){targets[i]=16;weights[i]=i+1;}
  Graph g=new Graph(ids,offsets,targets,weights);GraphDelta d=new GraphDelta(n);d.addWeightDelta(47,16,2);
  FdbLearning learner=new FdbLearning(g,d,FdbLearningCheck.sources(),FdbLearningCheck.targets(),.05,2048,127,true,"expanded");
  MessageDigest digest=MessageDigest.getInstance("SHA-256");for(int i=47;i>=32;i--)digest.update((ids[i]+":"+ids[16]+":"+Float.floatToIntBits(weights[i-28])+";").getBytes(StandardCharsets.UTF_8));
  StringBuilder expected=new StringBuilder();for(byte b:digest.digest())expected.append(String.format(Locale.ROOT,"%02x",b&255));
  if(!learner.baseProjectionSha().equals(expected.toString())||learner.baseCandidates()!=16)throw new AssertionError("expanded projection must retain all strongest 16, not delete rank 8");
  if(learner.baseProjectionSha().equals(learner.legacyBaseProjectionSha()))throw new AssertionError("fixture must trigger historical rank-8 bug");
  JSONObject saved=FdbCheckpoint.save(learner,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  JSONObject legacy=new JSONObject(saved.toString()).put("version",4).put("algorithm","bounded mixed plasticity v4").put("baseProjectionSha",learner.legacyBaseProjectionSha());legacy.remove("projectionVersion");
  legacy.getJSONArray("traces").put(new JSONObject().put("source","48").put("target","17").put("eligibility",1).put("utility",1).put("support",1).put("evidence",3).put("bad",0));
  String weightsBefore=d.genome();FdbCheckpoint.restore(learner,legacy,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  if(!weightsBefore.equals(d.genome())||learner.traces().get(0).eligibility!=0)throw new AssertionError("migration must retain acquired weights and clear old credit");
  for(JSONObject corrupt:new JSONObject[]{new JSONObject(saved.toString()).put("baseProjectionSha",learner.legacyBaseProjectionSha()),new JSONObject(legacy.toString()).put("baseProjectionSha",String.format("%064d",0))}){
   try{FdbCheckpoint.restore(learner,corrupt,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());throw new AssertionError("unknown projection accepted");}catch(IllegalArgumentException good){}
  }
  System.out.println("PASS: strongest-16 expanded projection, exact legacy migration preserving weights, stale credit reset and unknown-projection rejection");
 }
}
