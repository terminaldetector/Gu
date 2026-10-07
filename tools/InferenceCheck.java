package org.node.flyconsole;
import org.json.*;import java.util.concurrent.atomic.AtomicBoolean;
public final class InferenceCheck {
 public static void main(String[] args)throws Exception{
  Graph graph=Graph.demo();Engine e=new Engine(graph);AtomicBoolean stop=new AtomicBoolean();
  String p="{\"seed\":1,\"steps\":[{\"ms\":100,\"inputs\":[{\"id\":\"1\",\"hz\":1000}],\"outputs\":[{\"id\":\"1\",\"label\":\"input\"},\"2\"]},{\"ms\":20,\"inputs\":[],\"outputs\":[\"1\"]}]}";
  JSONObject a=InferenceProgram.run(e,graph,p,stop),b=InferenceProgram.run(e,graph,p,stop);
  if(a.getLong("total_spikes")<=0||!a.getJSONArray("results").getJSONObject(0).getJSONObject("outputs").has("input"))throw new AssertionError("real named output");
  if(a.getLong("total_spikes")!=b.getLong("total_spikes"))throw new AssertionError("seed reproducibility");
  String invalid=p.replace("\"id\":\"1\"","\"id\":1");try{InferenceProgram.run(e,graph,invalid,stop);throw new AssertionError("64-bit IDs must be strings");}catch(IllegalArgumentException expected){}
  stop.set(true);if(!InferenceProgram.run(e,graph,p,stop).getBoolean("cancelled"))throw new AssertionError("cancelled");
  System.out.println("PASS: programmable actual LIF outputs, seed, silence step, string IDs and cancellation");
 }
}
