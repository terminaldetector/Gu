package org.node.flyconsole;
import java.util.*;import java.nio.file.*;import java.util.concurrent.atomic.AtomicBoolean;import org.json.*;
/** Controlled task fixtures, not ROM gameplay. All actions come from the production LIF+Decision. */
public final class FdbTemporalExperiment {
 static final int[] INPUTS=FdbLearningCheck.sources(),OUTPUTS=FdbLearningCheck.targets();
 static Graph graph(){long[] ids=new long[30];for(int i=0;i<30;i++)ids[i]=9007199254740993L+i;int[] off=new int[31];for(int i=1;i<31;i++)off[i]=i==1?2:i==2?4:5;return new Graph(ids,off,new int[]{16,17,16,17,18},new float[]{20,20,20,20,20});}
 static final class Run {
  final Graph graph=graph();final GraphDelta delta=new GraphDelta(30,2048);final FdbLearning learner;final Engine engine;final Engine.Options options=new Engine.Options();final List<Double> timings=new ArrayList<>();int decision;final long seed;
  Run(long seed,String profile){this.seed=seed;engine=new Engine(graph);learner=new FdbLearning(graph,delta,INPUTS,OUTPUTS,.1,2048,127,true,"expanded");learner.creditProfile(profile);learner.seed(seed);options.delta=delta;}
  FdbLearning.Decision decide(int cue,boolean train,boolean distract,double rate){double[] rates=new double[16];rates[cue]=rate;long at=System.nanoTime();Engine.Result r=engine.advance(INPUTS,rates,30,options,new AtomicBoolean());FdbLearning.Decision d=learner.decide("t"+(decision++),r,distract?new int[]{0,4}:new int[]{1,2},4095,100,train?.1:0,train,null);timings.add((System.nanoTime()-at)/1e6);return d;}
  void feedback(FdbLearning.Decision d,double r,boolean train){if(train)learner.feedback(d.id,d.mask,r,.5,30,true,false,null);}
  boolean episode(String task,int episode,boolean train,boolean heldout){learner.boundary();engine.reset(seed*1009+episode+(heldout?100000:0));int cue=episode%2;double hz=heldout?450:500;boolean reverse=task.equals("reversal")&&(heldout||episode>=40);int expected=(cue^(reverse?1:0))==0?1:2;
   FdbLearning.Decision first=decide(cue,train,false,hz);boolean ok=first.mask==expected;
   int delay=task.equals("delay10")?10:task.equals("delay5")?5:0;
   if(delay>0){feedback(first,0,train);for(int i=1;i<=delay;i++){FdbLearning.Decision filler=decide(2,train,true,hz);feedback(filler,i==delay?(ok?1:-1):0,train);}}
   else if(task.equals("sequence")||task.equals("hold")){feedback(first,0,train);for(int i=1;i<3;i++){int next=task.equals("sequence")?(cue+i)%2:cue;FdbLearning.Decision d=decide(next,train,false,hz);ok&=d.mask==(next==0?1:2);feedback(d,i==2?(ok?1:-1):0,train);}}
   else feedback(first,ok?1:-1,train);
   return ok;
  }
 }
 static double percentile(List<Double> values,double q){List<Double> v=new ArrayList<>(values);Collections.sort(v);return v.get(Math.max(0,(int)Math.ceil(q*v.size())-1));}
 public static void main(String[] args)throws Exception{
  JSONArray rows=new JSONArray();StringBuilder csv=new StringBuilder("task,seed,profile,train_success,heldout_success,decisions_to_80,p50_ms,p95_ms,p99_ms,deltas,wexo,thresholds\n");
  for(String task:new String[]{"immediate","sequence","hold","delay5","delay10","reversal"})for(int seed:new int[]{11,23,37,53,71})for(String profile:new String[]{"single-v1","dual-v1","dual-rate-v1","frozen"}){
   Run r=new Run(seed,profile.equals("frozen")?"single-v1":profile);int success=0,window=0,to80=-1;JSONArray curve=new JSONArray();
   for(int e=0;e<80;e++){boolean ok=r.episode(task,e,!profile.equals("frozen"),false);success+=ok?1:0;window+=ok?1:0;if(e%20==19){curve.put(new JSONObject().put("episodes",e+1).put("decisions",r.decision).put("success",window/20.0));if(window>=16&&to80<0)to80=r.decision;window=0;}}
   r.learner.boundary();JSONObject state=FdbCheckpoint.save(r.learner,r.graph,INPUTS,OUTPUTS);String original=state.toString();int held=0;for(int e=0;e<40;e++)held+=r.episode(task,e,false,true)?1:0;
   if(!original.equals(FdbCheckpoint.save(r.learner,r.graph,INPUTS,OUTPUTS).toString()))throw new AssertionError("evaluation mutated learning");
   Run restored=new Run(seed,r.learner.creditProfile());for(GraphDelta.Edge edge:r.delta.deltas())restored.delta.addWeightDelta(edge.source,edge.target,edge.weight);for(GraphDelta.Edge edge:r.delta.edges())restored.delta.addEdge(edge.source,edge.target,edge.weight);for(Map.Entry<Integer,Float> t:r.delta.thresholds().entrySet())restored.delta.setThresholdOffset(t.getKey(),t.getValue());FdbCheckpoint.restore(restored.learner,state,r.graph,INPUTS,OUTPUTS);restored.learner.boundary();int reload=0;for(int e=0;e<40;e++)reload+=restored.episode(task,e,false,true)?1:0;if(held!=reload)throw new AssertionError("reload heldout mismatch");
   JSONObject row=new JSONObject().put("task",task).put("seed",seed).put("profile",profile).put("trainSuccess",success/80.0).put("heldoutSuccess",held/40.0).put("decisionsTo80",to80<0?JSONObject.NULL:to80).put("curve",curve).put("cpuDecisionP50Ms",percentile(r.timings,.5)).put("cpuDecisionP95Ms",percentile(r.timings,.95)).put("cpuDecisionP99Ms",percentile(r.timings,.99)).put("deltas",r.delta.deltaCount()).put("wexo",r.delta.growthCount()).put("thresholds",r.delta.thresholds().size()).put("born",r.learner.born()).put("pruned",r.learner.pruned()).put("budgetClips",r.learner.budgetClips()).put("checkpointBytes",original.getBytes("UTF-8").length).put("estimatedLayerLearnerBytes",r.delta.memoryBytes()+r.learner.memoryBytes()).put("reloadParity",true);
   rows.put(row);csv.append(task+","+seed+","+profile+","+success/80.0+","+held/40.0+","+(to80<0?"not reached":to80)+","+row.getDouble("cpuDecisionP50Ms")+","+row.getDouble("cpuDecisionP95Ms")+","+row.getDouble("cpuDecisionP99Ms")+","+r.delta.deltaCount()+","+r.delta.growthCount()+","+r.delta.thresholds().size()+"\n");
  }
  JSONObject report=new JSONObject().put("type","fdb-temporal-ablation-v1").put("graphSha",graph().fingerprint()).put("seeds",new JSONArray(new int[]{11,23,37,53,71})).put("limitations","Host CPU fixture; not a ROM. Held-out start/500->450Hz shift shares task semantics; not cross-game transfer. Frozen control uses identical decision engine. 80 episodes train, 40 held-out. No post-hoc seed selection.").put("rows",rows);
  Path prefix=Paths.get(args.length==0?"/tmp/fdb-temporal":args[0]);Files.write(Paths.get(prefix+".json"),report.toString(2).getBytes("UTF-8"));Files.write(Paths.get(prefix+".csv"),csv.toString().getBytes("UTF-8"));System.out.println("PASS: 120 paired temporal ablations, independent held-out starts, frozen state, reload parity; "+prefix);
 }
}
