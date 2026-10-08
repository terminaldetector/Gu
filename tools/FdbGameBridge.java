package org.node.flyconsole;
import org.json.*;import java.io.*;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;
/** Headless harness calls the production CPU and learner against actual WASM game frames. */
public final class FdbGameBridge {
 public static void main(String[] args)throws Exception{
  Graph graph=args.length>0?Graph.read(new FileInputStream(args[0]),1_500_000_000L):FdbLearningCheck.graph();int[] in=new int[16],out=new int[12];for(int i=0;i<16;i++)in[i]=i;for(int i=0;i<12;i++)out[i]=graph.ids.length-12+i;
  Engine engine=null;GraphDelta layer=null;FdbLearning learner=null;long counter=0;int seed=1;
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(System.in))){String line;while((line=reader.readLine())!=null){JSONObject q=new JSONObject(line),r=new JSONObject();String op=q.getString("op");
   if(op.equals("init")){seed=q.getInt("seed");layer=new GraphDelta(graph.ids.length);String mode=q.getString("mode");if(mode.equals("fixed")){for(int source:in)layer.addEdge(source,out[6],8);}
    learner=new FdbLearning(graph,layer,in,out,.1,128,127);learner.seed(seed);engine=new Engine(graph);engine.reset(seed);counter=0;r.put("neurons",graph.ids.length).put("baseEdges",graph.targets.length).put("graphSha",graph.fingerprint());
   }else if(op.equals("reset")){engine.reset(seed);learner.boundary();}
   else if(op.equals("decide")){double[] rates=new double[16];JSONArray retina=q.getJSONArray("retina");for(int i=0;i<16;i++)rates[i]=retina.getDouble(i)*500;Engine.Options options=new Engine.Options();options.delta=layer;
    Engine.Result result=engine.advance(in,rates,q.optInt("windowMs",20),options,new AtomicBoolean());FdbLearning.Decision decision=learner.decide("game-"+(counter++),result,new int[]{0,64,128},4095,30,.1,q.getBoolean("train"),null);r.put("id",decision.id).put("mask",decision.mask).put("wallMs",result.wallSeconds*1000).put("spikes",result.spikes);
   }else if(op.equals("reward")){int changed=learner.feedback(q.getString("id"),q.getInt("mask"),q.getDouble("reward"),q.getDouble("seconds"),q.getInt("frames"),true,false,null);r.put("changed",changed);}
   else if(op.equals("checkpoint")){JSONObject state=FdbCheckpoint.save(learner,graph,in,out);GraphDelta restored=new GraphDelta(graph.ids.length);for(GraphDelta.Edge e:layer.edges())restored.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:layer.deltas())restored.addWeightDelta(e.source,e.target,e.weight);FdbLearning next=new FdbLearning(graph,restored,in,out,.1,128,127);FdbCheckpoint.restore(next,new JSONObject(state.toString()),graph,in,out);next.boundary();learner=next;layer=restored;engine.reset(seed);r.put("format",2);}
   else if(!op.equals("state"))throw new IllegalArgumentException(op);
   r.put("edges",layer.growthCount()).put("born",learner.born()).put("pruned",learner.pruned()).put("updates",learner.automatic()).put("layerBytesEstimate",layer.memoryBytes()+learner.memoryBytes()).put("graphAndEngineBytesEstimate",graph.memoryBytes()).put("rng",learner.rng());System.out.println(r.toString());
  }}
 }
}
