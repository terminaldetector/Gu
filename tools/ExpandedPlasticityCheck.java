package org.node.flyconsole;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

public final class ExpandedPlasticityCheck {
 static void check(boolean b,String s){if(!b)throw new AssertionError(s);}
 static FdbLearning learner(Graph g,GraphDelta d,String mode){return new FdbLearning(g,d,FdbLearningCheck.sources(),FdbLearningCheck.targets(),.2,mode.equals("wexo")||mode.equals("expanded")?2048:256,32,true,mode);}
 static Engine.Result activity(){int[] c=new int[30];c[0]=100;c[16]=2;return new Engine.Result(c,102,100,100,0);}
 static void train(FdbLearning l,int steps){for(int i=0;i<steps;i++){FdbLearning.Decision a=l.decide("step-"+i,activity(),new int[]{0,1},4095,100,.1,true,null);l.feedback(a.id,a.mask,a.mask==1?1:-1,.1,6,true,false,null);check(l.lastBudget()<=1.000001,"combined decision change is bounded");}}
 static Graph large(){
  int n=11200;long[] ids=new long[n];int[] off=new int[n+1];ArrayList<Integer> targets=new ArrayList<>();ArrayList<Float> weights=new ArrayList<>();
  for(int i=0;i<n;i++){ids[i]=i+1;off[i]=targets.size();int t=i>=100&&i<292?16+(i-100)%12:i>=1000&&i<4072?100+(i-1000)/16:i>=5000&&i<11144?1000+(i-5000)/2:-1;if(t>=0){targets.add(t);weights.add(8f+(i%7));}}
  off[n]=targets.size();int[] ts=new int[targets.size()];float[] ws=new float[ts.length];for(int i=0;i<ts.length;i++){ts[i]=targets.get(i);ws[i]=weights.get(i);}return new Graph(ids,off,ts,ws);
 }
 public static void main(String[] args)throws Exception{
  Graph g=FdbLearningCheck.graph();
  for(String mode:FdbLearning.PLASTICITY_MODES){
   GraphDelta d=new GraphDelta(30,2048);FdbLearning l=learner(g,d,mode);l.seed(23);train(l,100);
   if(mode.equals("expanded")){
    check(l.traces().stream().anyMatch(t->Math.abs(t.slowEligibility)>1e-8),"Expanded has real slow eligibility after actions");
    JSONObject warm=FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
    GraphDelta pre=new GraphDelta(30,2048);for(GraphDelta.Edge e:d.edges())pre.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:d.deltas())pre.addWeightDelta(e.source,e.target,e.weight);for(Map.Entry<Integer,Float> e:d.thresholds().entrySet())pre.setThresholdOffset(e.getKey(),e.getValue());
    FdbLearning loaded=learner(g,pre,"expanded");
    FdbCheckpoint.restore(loaded,new JSONObject(warm.toString()),g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
    check(warm.toString().equals(FdbCheckpoint.save(loaded,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()),"Expanded exact in-flight slow credit roundtrip");
    JSONObject legacy=new JSONObject(warm.toString()).put("version",4).put("algorithm","bounded mixed plasticity v4");
    for(int t=0;t<legacy.getJSONArray("traces").length();t++)legacy.getJSONArray("traces").getJSONObject(t).remove("slowEligibility");
    for(int t=0;t<legacy.getJSONArray("neuronTraces").length();t++)legacy.getJSONArray("neuronTraces").getJSONObject(t).remove("slowEligibility");
    FdbLearning migrated=learner(g,pre,"expanded");
    FdbCheckpoint.restore(migrated,legacy,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
    check(migrated.traces().stream().allMatch(t->t.eligibility==0&&t.slowEligibility==0),"v4 cannot fabricate v5 temporal credit");
   }
   l.boundary();
   check(l.traces().stream().allMatch(t->t.eligibility==0&&t.slowEligibility==0),"boundary clears both eligibilities");
   check(d.growthCount()<=2048&&l.traces().size()<=8192,"bounded graph and trace memory");
   for(float v:d.thresholds().values())check(Math.abs(v)<=5,"threshold trust region");
   check(mode.equals("dynamics")||mode.equals("expanded")?l.neuronUpdates()>0:d.thresholds().isEmpty(),"isolated neuron ablation");
   JSONObject f=new JSONObject().put("neuronDynamics",FdbCheckpoint.thresholdState(d,g));GraphDelta restored=new GraphDelta(30,2048);for(GraphDelta.Edge e:d.edges())restored.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:d.deltas())restored.addWeightDelta(e.source,e.target,e.weight);FdbCheckpoint.restoreThresholds(restored,f,g);
   FdbLearning next=learner(g,restored,mode);FdbCheckpoint.restore(next,FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()),g,FdbLearningCheck.sources(),FdbLearningCheck.targets());train(l,50);train(next,50);
   check(d.genome().substring(d.genome().indexOf(";d=")).equals(restored.genome().substring(restored.genome().indexOf(";d="))),"identical acquired parameters after reload "+mode);
   check(FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString().equals(FdbCheckpoint.save(next,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()),"identical continuation traces "+mode);
   if(mode.equals("expanded")){
    FdbLearning off=learner(g,restored,"base");FdbCheckpoint.restore(off,FdbCheckpoint.save(next,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()),g,FdbLearningCheck.sources(),FdbLearningCheck.targets());check(restored.thresholds().equals(d.thresholds()),"disable keeps acquired neuron parameters");
    String before=FdbCheckpoint.save(next,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString();JSONObject corrupt=new JSONObject(before);corrupt.getJSONArray("neuronTraces").put(new JSONObject().put("neuron","1").put("eligibility",9));boolean rejected=false;try{FdbCheckpoint.restore(next,corrupt,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());}catch(Exception e){rejected=true;}check(rejected&&before.equals(FdbCheckpoint.save(next,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()),"malformed dynamics is atomic");
   }
  }
  // Expanded mode only attributes credit through active ancestors of the chosen motor action.
  Graph paths=FdbPlasticityCheck.graph();GraphDelta actionD=new GraphDelta(30);FdbLearning action=learner(paths,actionD,"expanded");
  int[] counts=FdbPlasticityCheck.activity().counts.clone();counts[16]=100;
  Engine.Result selected=new Engine.Result(counts,400,100,100,0);
  for(int i=0;i<20;i++){FdbLearning.Decision q=action.decide("chosen-"+i,selected,new int[]{0,1},4095,100,0,true,null);check(q.mask==1,"chosen motor is active");action.feedback(q.id,q.mask,1,.1,6,true,false,null);}
  check(actionD.weightDelta(0,28)>0,"active root ancestor receives chosen-action credit");
  check(actionD.weightDelta(1,17)==0&&actionD.weightDelta(2,29)==0,"unselected motors do not update unrelated roots");
  GraphDelta silentD=new GraphDelta(30);FdbLearning silentAction=learner(paths,silentD,"expanded");counts[28]=0;
  for(int i=0;i<20;i++){FdbLearning.Decision q=silentAction.decide("inactive-"+i,new Engine.Result(counts,300,100,100,0),new int[]{0,1},4095,100,0,true,null);silentAction.feedback(q.id,q.mask,1,.1,6,true,false,null);}
  check(silentD.weightDelta(0,28)==0,"inactive intermediate cannot receive expanded credit");
  Graph big=large();GraphDelta layer=new GraphDelta(big.ids.length,2048);FdbLearning expanded=learner(big,layer,"root"),again=learner(big,new GraphDelta(big.ids.length,2048),"root");check(expanded.baseCandidates()==2048,"expanded root fills 2048 candidates");check(expanded.baseProjectionSha().equals(again.baseProjectionSha()),"deterministic root projection");
  int[] all=new int[big.ids.length];Arrays.fill(all,100);Engine.Result active=new Engine.Result(all,100L*all.length,100,100,0);FdbLearning.Decision a=expanded.decide("dense",active,new int[]{0,1},4095,100,0,true,null);expanded.feedback(a.id,a.mask,20,.1,6,true,false,null);check(expanded.lastBudget()<=1.000001&&expanded.budgetClips()>0,"large root projection shares bounded budget");
  GraphDelta full=new GraphDelta(big.ids.length,2048);for(int i=0;i<2048;i++)full.addEdge(i%16,100+i/16,1);
  FdbLearning free=learner(big,full,"wexo");FdbLearning.Decision fd=free.decide("full-exo",active,new int[]{0,1},4095,100,0,true,null);free.feedback(fd.id,fd.mask,1,.1,6,true,false,null);check(full.growthCount()<=2048&&full.growthCount()>1024,"2048 real exogenous links participate within the cap");
  GraphDelta guarded=new GraphDelta(30);guarded.setThresholdOffset(16,-1);FdbLearning dynamics=learner(g,guarded,"dynamics");int[] fast=new int[30];fast[0]=50;fast[16]=35;
  for(int i=0;i<30;i++){FdbLearning.Decision q=dynamics.decide("high-"+i,new Engine.Result(fast,85,1000,1000,0),new int[]{0,1},4095,100,0,true,null);dynamics.feedback(q.id,q.mask,q.mask==1?1:-1,.1,6,true,false,null);}check(guarded.thresholdOffset(16)==-1,"high-rate guard cannot keep lowering threshold");
  GraphDelta offsets=new GraphDelta(30);offsets.setThresholdOffset(16,-5);long checkpoint=offsets.checkpoint();offsets.setThresholdOffset(16,5);offsets.rollback(checkpoint);check(offsets.thresholdOffset(16)==-5,"threshold rollback");
  int[] os=new int[31];Arrays.fill(os,1);os[0]=0;long[] ids=new long[30];for(int i=0;i<30;i++)ids[i]=i+1;Graph direct=new Graph(ids,os,new int[]{16},new float[]{8});Engine.Options o=new Engine.Options();o.delta=offsets;
  int low=new Engine(direct).advance(new int[]{0},new double[]{500},200,o,new AtomicBoolean()).counts[16];offsets.setThresholdOffset(16,5);int high=new Engine(direct).advance(new int[]{0},new double[]{500},200,o,new AtomicBoolean()).counts[16];check(low>high,"threshold offset has CPU dynamic effect every step");
  Engine.Result silent=new Engine(direct).advance(new int[]{0},new double[]{0},1000,o,new AtomicBoolean());check(silent.spikes==0,"offsets do not self-excite a resting graph");
  System.out.println("PASS Expanded FDB: chosen path gate, two-speed v5 exact resumed learning, 2048 roots, shared budget, threshold ±5 mV, disabled retention, corrupt-state atomicity, bounded memory and CPU threshold effect "+low+" > "+high);
 }
}
