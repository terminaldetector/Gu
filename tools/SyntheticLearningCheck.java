package org.node.flyconsole;
import java.nio.file.*;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;import org.json.*;
/** Exercise each shipped topology through the production learner and checkpoint codec. */
public final class SyntheticLearningCheck {
 static JSONObject state(Graph g,GraphDelta d,FdbLearning l,Experiment e)throws Exception{
  JSONArray roots=new JSONArray(),edges=new JSONArray();for(GraphDelta.Edge x:d.deltas())roots.put(link(g,x));for(GraphDelta.Edge x:d.edges())edges.put(link(g,x));
  return new JSONObject().put("deltas",roots).put("edges",edges).put("neuronDynamics",FdbCheckpoint.thresholdState(d,g)).put("learningState",FdbCheckpoint.save(l,g,e.inputs,e.outputs));
 }
 static JSONObject link(Graph g,GraphDelta.Edge e)throws Exception{return new JSONObject().put("source",Long.toString(g.ids[e.source])).put("target",Long.toString(g.ids[e.target])).put("weight",e.weight);}
 public static void main(String[] paths)throws Exception{
  for(String path:paths){Graph g=SyntheticGraphJson.read(new JSONObject(Files.readString(Paths.get(path))),64*1024*1024);String sha=g.fingerprint();float[] original=g.weights.clone();
   for(int ports:new int[]{8,12}){Experiment e=Experiment.automatic(g,ports);GraphDelta d=new GraphDelta(g.ids.length,2048);FdbLearning l=new FdbLearning(g,d,e.inputs,e.outputs,.05,2048,127,true,"expanded");double[] retina=new double[16];Arrays.fill(retina,.8);for(int i=0;i<20;i++)l.observe(retina,1,0,true,null,false);
    if(d.deltaCount()+d.growthCount()==0)throw new AssertionError("starter cannot acquire any weights");
    JSONObject saved=state(g,d,l,e);GraphDelta copy=new GraphDelta(g.ids.length,2048);FdbCheckpoint.restoreLinks(copy,saved,g);FdbCheckpoint.restoreThresholds(copy,saved,g);FdbLearning resumed=new FdbLearning(g,copy,e.inputs,e.outputs,.05,2048,127,true,"expanded");FdbCheckpoint.restore(resumed,saved.getJSONObject("learningState"),g,e.inputs,e.outputs);
    for(int i=0;i<5;i++){l.observe(retina,2,0,true,null,false);resumed.observe(retina,2,0,true,null,false);}
    if(!state(g,d,l,e).toString().equals(state(g,copy,resumed,e).toString()))throw new AssertionError("starter continuation changed acquired state");
    Engine.Options a=new Engine.Options(),b=new Engine.Options();a.delta=d;b.delta=copy;double[] hz=new double[16];Arrays.fill(hz,150);
    if(!Arrays.equals(new Engine(g).advance(e.inputs,hz,20,a,new AtomicBoolean()).counts,new Engine(g).advance(e.inputs,hz,20,b,new AtomicBoolean()).counts))throw new AssertionError("checkpoint does not reproduce CPU output");
    String before=state(g,d,l,e).toString();l.observe(retina,1,0,true,null,true);if(!before.equals(state(g,d,l,e).toString()))throw new AssertionError("freeze changed learning");
    if(!Arrays.equals(original,g.weights)||!sha.equals(g.fingerprint()))throw new AssertionError("training changed W0");
    System.out.println(path+" ports="+ports+": acquisition, continuation, CPU replay, freeze, immutable W0 PASS; delta="+d.deltaCount()+" Wexo="+d.growthCount());
   }
  }
 }
}
