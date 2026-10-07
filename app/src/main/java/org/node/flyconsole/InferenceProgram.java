package org.node.flyconsole;
import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Bounded JSON experiment DSL: no eval, networking or language-model responses. */
public final class InferenceProgram {
 private static final class Step {int ms;int[] inputs,outputs;double[] rates;String[] labels;}
 public static JSONObject run(Engine engine,Graph graph,String source,AtomicBoolean cancel) throws Exception {
  if(source.length()>262144)throw new IllegalArgumentException("Программа больше 256 КиБ");
  JSONObject p=new JSONObject(source);long seed=p.optLong("seed",1);
  if(seed<0||seed>2147483647L)throw new IllegalArgumentException("Seed 0–2147483647");
  Engine.Options options=new Engine.Options();options.gain=p.optDouble("gain",1);options.disableInhibition=p.optBoolean("disableInhibition",false);
  if(!Double.isFinite(options.gain)||options.gain<0||options.gain>2)throw new IllegalArgumentException("Gain 0–2");
  JSONArray lesions=p.optJSONArray("lesions");if(lesions==null)lesions=new JSONArray();options.lesions=indices(engine,lesions,256);
  JSONArray raw=p.getJSONArray("steps");if(raw.length()<1||raw.length()>64)throw new IllegalArgumentException("1–64 шагов");
  ArrayList<Step> plan=new ArrayList<>();int total=0;
  for(int i=0;i<raw.length();i++){
   JSONObject r=raw.getJSONObject(i);Step s=new Step();s.ms=r.getInt("ms");if(s.ms<1||s.ms>10000||(total+=s.ms)>10000)throw new IllegalArgumentException("Суммарное время 1–10000 мс");
   JSONArray inputs=r.getJSONArray("inputs");if(inputs.length()>256)throw new IllegalArgumentException("Не более 256 входов");s.inputs=new int[inputs.length()];s.rates=new double[inputs.length()];
   HashSet<Integer> used=new HashSet<>();for(int j=0;j<inputs.length();j++){JSONObject v=inputs.getJSONObject(j);s.inputs[j]=engine.index(parseId(v.get("id")));s.rates[j]=v.getDouble("hz");if(!used.add(s.inputs[j])||!Double.isFinite(s.rates[j])||s.rates[j]<0||s.rates[j]>1000)throw new IllegalArgumentException("Повтор ID или Hz вне 0–1000");}
   JSONArray outputs=r.getJSONArray("outputs");if(outputs.length()>256)throw new IllegalArgumentException("Не более 256 выходов");s.outputs=new int[outputs.length()];s.labels=new String[outputs.length()];used.clear();HashSet<String> labels=new HashSet<>();
   for(int j=0;j<outputs.length();j++){Object value=outputs.get(j);String label;if(value instanceof JSONObject){JSONObject v=(JSONObject)value;s.outputs[j]=engine.index(parseId(v.get("id")));label=v.optString("label",Long.toString(graph.ids[s.outputs[j]]));}else{s.outputs[j]=engine.index(parseId(value));label=Long.toString(graph.ids[s.outputs[j]]);}if(label.length()<1||label.length()>80||!used.add(s.outputs[j])||!labels.add(label))throw new IllegalArgumentException("Неверные/повторяющиеся выходы или labels");s.labels[j]=label;}
   plan.add(s);
  }
  if(p.optBoolean("reset",true))engine.reset(seed);
  JSONArray results=new JSONArray();long totalSpikes=0;
  for(int i=0;i<plan.size()&&!cancel.get();i++){
   Step s=plan.get(i);Engine.Result result=engine.advance(s.inputs,s.rates,s.ms,options,cancel);totalSpikes+=result.spikes;
   JSONObject row=new JSONObject();row.put("step",i).put("requested_ms",s.ms).put("computed_ms",result.steps*.1).put("end_tick",result.endTick).put("spikes",result.spikes).put("active",result.active).put("wall_ms",result.wallSeconds*1000);
   JSONObject channels=new JSONObject();for(int j=0;j<s.outputs.length;j++){int count=result.counts[s.outputs[j]];channels.put(s.labels[j],new JSONObject().put("id",Long.toString(graph.ids[s.outputs[j]])).put("spikes",count).put("hz",result.steps==0?0:count*10000.0/result.steps));}row.put("outputs",channels);results.put(row);
  }
  return new JSONObject().put("format","fly-inference-v1").put("model","Java LIF / FlyWire; Brian2 parity unverified").put("dt_ms",.1).put("neurons",graph.ids.length).put("edges",graph.targets.length).put("seed",seed).put("reset",p.optBoolean("reset",true)).put("cancelled",cancel.get()).put("total_spikes",totalSpikes).put("results",results);
 }
 private static long parseId(Object value){if(!(value instanceof String))throw new IllegalArgumentException("ID передавайте строкой, чтобы сохранить 64 бита");return Long.parseLong((String)value);}
 private static int[] indices(Engine engine,JSONArray ids,int limit)throws Exception{if(ids.length()>limit)throw new IllegalArgumentException("Слишком много ID");int[] a=new int[ids.length()];HashSet<Integer> used=new HashSet<>();for(int i=0;i<a.length;i++){a[i]=engine.index(parseId(ids.get(i)));if(!used.add(a[i]))throw new IllegalArgumentException("Повтор ID");}return a;}
}
