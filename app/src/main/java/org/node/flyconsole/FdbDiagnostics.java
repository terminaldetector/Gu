package org.node.flyconsole;
import org.json.*;import java.util.*;
/** On-demand bounded report; neuron identities never pass through JS Number. */
public final class FdbDiagnostics {
 public static JSONObject report(Graph g,GraphDelta d,FdbLearning l)throws Exception{
  Map<String,FdbLearning.Trace> traces=new HashMap<>();for(FdbLearning.Trace t:l.traces())traces.put(t.source+":"+t.target,t);
  JSONArray roots=new JSONArray(),extras=new JSONArray(),thresholds=new JSONArray(),events=new JSONArray();
  for(String kind:new String[]{"root","wexo"}){
   List<GraphDelta.Edge> edges=kind.equals("root")?d.deltas():d.edges();edges.sort((a,b)->{int c=Float.compare(Math.abs(b.weight),Math.abs(a.weight));return c!=0?c:a.source!=b.source?Integer.compare(a.source,b.source):Integer.compare(a.target,b.target);});
   for(GraphDelta.Edge e:edges.subList(0,Math.min(20,edges.size()))){JSONObject item=new JSONObject().put("source",Long.toString(g.ids[e.source])).put("target",Long.toString(g.ids[e.target])).put("weight",e.weight);FdbLearning.Trace t=traces.get(e.source+":"+e.target);
    if(t!=null)item.put("utility",t.utility).put("support",t.support).put("evidence",t.evidence).put("fastEligibility",t.eligibility).put("slowEligibility",t.slowEligibility);
    if(kind.equals("root")){float base=0;for(int i=g.offsets[e.source];i<g.offsets[e.source+1];i++)if(g.targets[i]==e.target){base=g.weights[i];break;}item.put("w0",base).put("effectiveWeight",base+e.weight);roots.put(item);}else extras.put(item);
   }
  }
  List<Map.Entry<Integer,Float>> offsets=new ArrayList<>(d.thresholds().entrySet());offsets.sort((a,b)->{int c=Float.compare(Math.abs(b.getValue()),Math.abs(a.getValue()));return c!=0?c:Integer.compare(a.getKey(),b.getKey());});for(Map.Entry<Integer,Float> e:offsets.subList(0,Math.min(20,offsets.size())))thresholds.put(new JSONObject().put("neuron",Long.toString(g.ids[e.getKey()])).put("offsetMv",e.getValue()));
  for(FdbLearning.Outcome e:l.recentOutcomes())events.put(new JSONObject().put("decision",e.id).put("executedMask",e.mask).put("accepted",e.accepted).put("reward",e.reward).put("advantage",e.advantage).put("changed",e.changed).put("budget",e.budget).put("births",e.births).put("removals",e.removals));
  return new JSONObject().put("type","fly-fdb-diagnostics").put("version",1).put("graphSha",g.fingerprint()).put("creditProfile",l.creditProfile()).put("plasticityMode",l.plasticityMode()).put("rootTop20",roots).put("wexoTop20",extras).put("thresholdTop20",thresholds).put("recent100",events).put("budgetClips",l.budgetClips()).put("limitations","Weight magnitude and eligibility are proxies, not measured causal contribution. Diagnostic history is session-local; Layer Set restores knowledge, not the live episode.");
 }
}
