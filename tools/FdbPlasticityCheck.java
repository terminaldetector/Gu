package org.node.flyconsole;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

/** Behavioural and causal checks of the production mixed root/exogenous learner. */
public final class FdbPlasticityCheck {
 static void require(boolean b,String why){if(!b)throw new AssertionError(why);}
 static Graph graph(){
  long[] ids=new long[30];for(int i=0;i<30;i++)ids[i]=i+1;
  int[] offsets=new int[31];for(int i=0;i<=30;i++)offsets[i]=i==0?0:i==1?1:i==2?2:i<=28?3:4;
  return new Graph(ids,offsets,new int[]{28,17,29,16},new float[]{8,-20,30,16});
 }
 static FdbLearning make(Graph g,GraphDelta layer,boolean root){return new FdbLearning(g,layer,FdbLearningCheck.sources(),FdbLearningCheck.targets(),.2,32,127,root);}
 static Engine.Result activity(){int[] n=new int[30];n[0]=n[1]=n[2]=n[28]=100;return new Engine.Result(n,400,100,100,0);}
 static void train(FdbLearning l,int n,String prefix){for(int i=0;i<n;i++){FdbLearning.Decision d=l.decide(prefix+i,activity(),new int[]{0,1},4095,100,0,true,null);l.feedback(d.id,d.mask,d.mask==1?1:-1,.1,6,true,false,null);}}
 static GraphDelta copy(GraphDelta d){GraphDelta n=new GraphDelta(30);for(GraphDelta.Edge e:d.edges())n.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:d.deltas())n.addWeightDelta(e.source,e.target,e.weight);return n;}
 public static void main(String[] args)throws Exception{
  Graph g=graph();float[] original=g.weights.clone();GraphDelta d=new GraphDelta(30);FdbLearning l=make(g,d,true);l.seed(17);train(l,100,"root-");
  require(d.weightDelta(0,28)>0&&d.weightDelta(28,16)>0,"active mixed internal W0 paths receive action-conditioned credit");
  require(d.weightDelta(1,17)==0&&d.weightDelta(2,29)==0,"unrelated active base synapses receive no credit");
  require(d.weightDelta(0,28)<=4&&d.weightDelta(28,16)<=8,"root deltas remain within half of W0");
  require(Arrays.equals(original,g.weights)&&l.baseUpdates()>0,"root learning leaves the reference W0 immutable");
  GraphDelta silent=new GraphDelta(30);FdbLearning noPath=make(g,silent,true);int[] inactive=activity().counts.clone();inactive[28]=0;
  for(int i=0;i<30;i++){FdbLearning.Decision q=noPath.decide("silent-"+i,new Engine.Result(inactive,300,100,100,0),new int[]{0,1},4095,100,0,true,null);noPath.feedback(q.id,q.mask,q.mask==1?1:-1,.1,6,true,false,null);}
  require(silent.weightDelta(0,28)==0&&silent.weightDelta(28,16)==0,"silent intermediate cannot invent root path credit");
  GraphDelta inhibition=new GraphDelta(30);FdbLearning signedRoot=make(g,inhibition,true);
  for(int i=0;i<60;i++){FdbLearning.Decision q=signedRoot.decide("signed-"+i,activity(),new int[]{0,2},4095,100,0,true,null);signedRoot.feedback(q.id,q.mask,q.mask==2?1:-1,.1,6,true,false,null);}
  require(inhibition.weightDelta(1,17)>0&&inhibition.weightDelta(1,17)<=10&&g.weights[1]+inhibition.weightDelta(1,17)<0,"inhibitory roots learn without changing sign");
  GraphDelta off=new GraphDelta(30);FdbLearning fixed=make(g,off,false);train(fixed,50,"off-");require(off.deltaCount()==0,"Wexo-only switch prevents root updates");
  long revision=d.version(),updates=l.baseUpdates(),rng=l.rng();String saved=FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString();
  for(int i=0;i<20;i++)l.decide("eval-"+i,activity(),new int[]{0,1},4095,100,0,false,null);
  require(d.version()==revision&&l.baseUpdates()==updates&&l.rng()==rng&&saved.equals(FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()),"evaluation changes no learning state");
  FdbLearning.Decision bad=l.decide("mismatch",activity(),new int[]{0,1},4095,100,0,true,null);l.feedback(bad.id,bad.mask^1,20,.1,6,true,false,null);require(d.version()==revision,"non-executed action cannot modify root or Wexo");
  l.boundary();GraphDelta restored=copy(d);FdbLearning next=make(g,restored,true);FdbCheckpoint.restore(next,FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()),g,FdbLearningCheck.sources(),FdbLearningCheck.targets());
  train(l,30,"continued-");train(next,30,"continued-");require(d.genome().substring(d.genome().indexOf(";d=")).equals(restored.genome().substring(restored.genome().indexOf(";d="))),"root/exo weights continue identically after loading");require(FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString().equals(FdbCheckpoint.save(next,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()),"v3 carries the full continuation state");
  JSONObject v2=new JSONObject(FdbCheckpoint.save(l,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()).toString()).put("version",2).put("algorithm","action-conditioned window eligibility");for(int i=0;i<v2.getJSONArray("traces").length();i++){JSONObject t=v2.getJSONArray("traces").getJSONObject(i);t.put("support",Math.max(0,t.getDouble("support")));}
  FdbLearning migrated=make(g,copy(d),true);FdbCheckpoint.restore(migrated,v2,g,FdbLearningCheck.sources(),FdbLearningCheck.targets());for(FdbLearning.Trace t:migrated.traces())require(t.eligibility==0,"old credit is cleared on algorithm migration");require(migrated.automatic()==l.automatic()&&migrated.baseUpdates()==0,"v2 counters migrate without fabricated root history");
  // Human teaching can adapt an existing sensory synapse, without duplicating it in Wexo.
  int[] offsets=new int[31];Arrays.fill(offsets,1);offsets[0]=0;Graph direct=new Graph(g.ids,offsets,new int[]{16},new float[]{8});GraphDelta taught=new GraphDelta(30);FdbLearning teacher=make(direct,taught,true);double[] retina=new double[16];retina[0]=1;
  for(int i=0;i<80;i++)teacher.observe(retina,1,0,true,null,false);
  require(taught.weightDelta(0,16)>3.9&&!taught.hasEdge(0,16),"demonstration trains existing roots without duplicate edges");
  Engine.Options options=new Engine.Options();int baseline=new Engine(direct).advance(new int[]{0},new double[]{500},200,options,new AtomicBoolean()).counts[16];options.delta=taught;int learned=new Engine(direct).advance(new int[]{0},new double[]{500},200,options,new AtomicBoolean()).counts[16];require(learned>baseline,"learned roots measurably alter production CPU output spikes");
  // Structural growth requires several attributable outcomes, and can learn inhibition.
  Graph empty=FdbLearningCheck.graph();GraphDelta negative=new GraphDelta(30);FdbLearning inhibitor=make(empty,negative,true);inhibitor.seed(17);
  FdbLearning.Decision one=inhibitor.decide("one",activity(),new int[]{0,1},4095,100,0,true,null);inhibitor.feedback(one.id,one.mask,one.mask==1?-1:1,.1,6,true,false,null);require(negative.growthCount()==0,"one reward cannot create permanent topology");
  for(int i=0;i<60;i++){FdbLearning.Decision a=inhibitor.decide("inhibit-"+i,activity(),new int[]{0,1},4095,100,0,true,null);inhibitor.feedback(a.id,a.mask,a.mask==1?-1:1,.1,6,true,false,null);}
  require(negative.edges().stream().anyMatch(e->e.target==16&&e.weight<0),"consistent counter-evidence acquires inhibitory weights");
  for(GraphDelta.Edge e:negative.edges())require(Math.abs(e.weight)<=127,"bounded synthetic strength");
  System.out.println("PASS: mixed root paths, unrelated-edge exclusion, trust region, Wexo-only, eval and intervention guards, v3/v2 continuation, inhibitory growth; CPU output "+baseline+" -> "+learned+" spikes from learned root weights");
 }
}
