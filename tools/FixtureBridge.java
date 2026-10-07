package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;
/** Test-only fixture. A 24-node graph drives Right through measured engine code. */
public final class FixtureBridge {
 public static void main(String[] args)throws Exception {
  long[] ids=new long[24];int[] offsets=new int[25],targets=new int[16];float[] weights=new float[16];
  for(int i=0;i<24;i++){ids[i]=i+1;offsets[i]=Math.min(i,16);}offsets[24]=16;
  for(int i=0;i<16;i++){targets[i]=23;weights[i]=30;}
  Graph graph=new Graph(ids,offsets,targets,weights);Engine engine=new Engine(graph);
  int[] inputs=new int[16],outputs=new int[8];for(int i=0;i<16;i++)inputs[i]=i;for(int i=0;i<8;i++)outputs[i]=16+i;
  Experiment experiment=new Experiment(inputs,outputs);AtomicBoolean cancel=new AtomicBoolean();long sequence=0;
  BufferedReader reader=new BufferedReader(new InputStreamReader(System.in));String line;
  while((line=reader.readLine())!=null){JSONObject request=new JSONObject(line);String op=request.getString("op");JSONObject reply=new JSONObject();
   if(op.equals("configure")){
    JSONObject p=request.getJSONObject("data");experiment.mode=p.getString("mode");experiment.maxHz=p.getDouble("maxHz");experiment.thresholdHz=p.getDouble("thresholdHz");experiment.windowMs=p.getInt("windowMs");experiment.options.gain=p.getDouble("gain");experiment.options.disableInhibition=p.getBoolean("disableInhibition");experiment.seedPermutation(p.getLong("seed"));engine.reset(experiment.seed);sequence=0;reply.put("mode",experiment.mode).put("configVersion",1);
   }else{
    JSONObject p=request.getJSONObject("data");double[] brightness=new double[16];for(int i=0;i<16;i++)brightness[i]=p.getJSONArray("retina").getDouble(i);
    Engine.Result r=engine.advance(experiment.inputs,experiment.rates(brightness),experiment.windowMs,experiment.options,cancel);
    JSONArray out=new JSONArray();for(int idx:experiment.outputs)out.put(r.counts[idx]*10000.0/r.steps);
    reply.put("token",p.getLong("token")).put("generation",p.getLong("generation")).put("buttons",experiment.buttons(r)).put("spikes",r.spikes).put("active",r.active).put("wallMs",r.wallSeconds*1000).put("simMs",r.endTick*.1).put("steps",r.steps).put("outputs",out).put("sequence",++sequence);
   }
   System.out.println(reply);System.out.flush();
  }
 }
}
