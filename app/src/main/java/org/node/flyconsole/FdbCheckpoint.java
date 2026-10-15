package org.node.flyconsole;

import org.json.*;
import java.util.*;

/** Versioned codec for the existing FDB learner, not another inference engine. */
public final class FdbCheckpoint {
    private static long integer(JSONObject o,String key,long min,long max)throws Exception{
        Object v=o.get(key);if(!(v instanceof Number))throw new IllegalArgumentException("FDB integer: "+key);double d=((Number)v).doubleValue();long n=((Number)v).longValue();if(!Double.isFinite(d)||d!=n||n<min||n>max)throw new IllegalArgumentException("FDB integer: "+key);return n;
    }
    private static double number(JSONObject o,String key,double min,double max)throws Exception{Object v=o.get(key);if(!(v instanceof Number))throw new IllegalArgumentException("FDB number: "+key);double n=((Number)v).doubleValue();if(!Double.isFinite(n)||n<min||n>max)throw new IllegalArgumentException("FDB number: "+key);return n;}
    private static JSONArray ids(Graph g,int[] indices){JSONArray a=new JSONArray();for(int i:indices)a.put(Long.toString(g.ids[i]));return a;}
    private static int index(Graph g,JSONObject t,String key)throws Exception{Object v=t.get(key);if(!(v instanceof String))throw new IllegalArgumentException("FDB trace ID must be string");int i=Arrays.binarySearch(g.ids,Long.parseLong((String)v));if(i<0)throw new IllegalArgumentException("Unknown FDB trace ID");return i;}
    /** Shared strict decoder for solo and dual contexts: no additive duplicate entries or W0/Wexo aliasing. */
    public static void restoreLinks(GraphDelta layer,JSONObject fdb,Graph graph)throws Exception {
        for(String kind:new String[]{"deltas","edges"}){
            if(!fdb.has(kind))continue;JSONArray links=fdb.getJSONArray(kind);if(links.length()>2048)throw new IllegalArgumentException("FDB link limit");
            Set<Long> seen=new HashSet<>();
            for(int k=0;k<links.length();k++){
                JSONObject link=links.getJSONObject(k);int s=index(graph,link,"source"),t=index(graph,link,"target");
                long key=((long)s<<32)|(t&0xffffffffL);if(s==t||!seen.add(key))throw new IllegalArgumentException("FDB duplicate / self edge");
                float w=(float)number(link,"weight",-127,127);boolean base=false;
                for(int j=graph.offsets[s];j<graph.offsets[s+1];j++)if(graph.targets[j]==t){base=true;break;}
                if(kind.equals("deltas")){if(!base)throw new IllegalArgumentException("FDB delta requires W0 edge");layer.addWeightDelta(s,t,w);}
                else {if(base)throw new IllegalArgumentException("Wexo must not duplicate W0");layer.addEdge(s,t,w);}
            }
        }
    }
    public static void restoreThresholds(GraphDelta layer,JSONObject fdb,Graph graph)throws Exception{
        if(!fdb.has("neuronDynamics"))return;JSONObject d=fdb.getJSONObject("neuronDynamics");integer(d,"version",1,1);JSONArray a=d.getJSONArray("thresholdOffsets");if(a.length()>2048)throw new IllegalArgumentException("Threshold offset limit");
        TreeMap<Integer,Float> values=new TreeMap<>();for(int i=0;i<a.length();i++){JSONObject t=a.getJSONObject(i);int n=index(graph,t,"neuron");float v=(float)number(t,"offsetMv",-5,5);if(values.put(n,v)!=null)throw new IllegalArgumentException("Duplicate threshold offset");}
        synchronized(layer){for(int n:layer.thresholds().keySet())if(!values.containsKey(n))layer.setThresholdOffset(n,0);for(Map.Entry<Integer,Float> e:values.entrySet())layer.setThresholdOffset(e.getKey(),e.getValue());}
    }
    public static JSONObject thresholdState(GraphDelta layer,Graph graph)throws Exception{
        JSONArray a=new JSONArray();for(Map.Entry<Integer,Float> e:layer.thresholds().entrySet())a.put(new JSONObject().put("neuron",Long.toString(graph.ids[e.getKey()])).put("offsetMv",e.getValue()));
        return new JSONObject().put("version",1).put("thresholdOffsets",a);
    }
    public static JSONObject save(FdbLearning learner,Graph graph,int[] sources,int[] targets)throws Exception{
        JSONObject state=new JSONObject().put("version",5).put("graph_sha256",graph.fingerprint()).put("algorithm","dual-timescale action-path eligibility v5").put("plasticityMode",learner.plasticityMode()).put("projectionVersion",2).put("baseProjectionSha",learner.baseProjectionSha()).put("neuronUpdates",learner.neuronUpdates()).put("budgetClips",learner.budgetClips()).put("lastBudget",learner.lastBudget()).put("neuronCandidates",ids(graph,learner.neuronCandidates())).put("observations",learner.observations()).put("human",learner.human()).put("automatic",learner.automatic()).put("sources",ids(graph,sources)).put("targets",ids(graph,targets)).put("rng",learner.rng()).put("baseline",learner.baseline()).put("born",learner.born()).put("pruned",learner.pruned()).put("rejected",learner.rejected()).put("baseUpdates",learner.baseUpdates()).put("baseCandidates",learner.baseCandidates());
        JSONArray traces=new JSONArray();for(FdbLearning.Trace t:learner.traces())traces.put(new JSONObject().put("source",Long.toString(graph.ids[t.source])).put("target",Long.toString(graph.ids[t.target])).put("eligibility",t.eligibility).put("slowEligibility",t.slowEligibility).put("utility",t.utility).put("support",t.support).put("evidence",t.evidence).put("bad",t.bad));JSONArray nt=new JSONArray();for(FdbLearning.NeuronTrace t:learner.neuronTraces())nt.put(new JSONObject().put("neuron",Long.toString(graph.ids[t.neuron])).put("eligibility",t.eligibility).put("slowEligibility",t.slowEligibility));JSONObject leaders=new JSONObject();
        for(String kind:new String[]{"root","wexo","threshold"}){
            JSONArray top=new JSONArray();
            for(FdbLearning.PlasticityLeader leader:learner.topPlasticity(kind,20))
                top.put(new JSONObject().put("source",Long.toString(graph.ids[leader.source])).put("target",Long.toString(graph.ids[leader.target])).put("value",leader.value));
            leaders.put(kind,top);
        }
        return state.put("traces",traces).put("neuronTraces",nt).put("plasticityTop20",leaders);
    }
    public static void restore(FdbLearning learner,JSONObject state,Graph graph,int[] sources,int[] targets)throws Exception{
        if(state.has("graph_sha256")&&!graph.fingerprint().equals(state.getString("graph_sha256")))throw new IllegalArgumentException("FDB checkpoint graph mismatch");
        long version=integer(state,"version",1,5),max=9007199254740991L;
        if(!ids(graph,sources).toString().equals(state.getJSONArray("sources").toString())||!ids(graph,targets).toString().equals(state.getJSONArray("targets").toString()))throw new IllegalArgumentException("FDB checkpoint belongs to other ports");
        long observations=integer(state,"observations",0,max),human=integer(state,"human",0,max),automatic=integer(state,"automatic",0,max);
        if(version==1){learner.restore(observations,human,automatic);return;}
        if(!(version==2?"action-conditioned window eligibility":version==3?"mixed-path eligibility v3":version==4?"bounded mixed plasticity v4":"dual-timescale action-path eligibility v5").equals(state.getString("algorithm")))throw new IllegalArgumentException("FDB learning algorithm");
        long baseUpdates=version>=3?integer(state,"baseUpdates",0,max):0;
        String previous=version>=4?FdbLearning.validateMode(state.getString("plasticityMode")):"base";
        boolean same=previous.equals(learner.plasticityMode());
        if(version>=4){
            long projection=state.has("projectionVersion")?integer(state,"projectionVersion",1,2):1;
            String fingerprint=state.getString("baseProjectionSha");if(!fingerprint.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("Root projection fingerprint mismatch");
            if(same&&!fingerprint.equals(learner.baseProjectionSha())){
                // Only migrate the exact historical selector, never an arbitrary mismatched graph/projection.
                if(projection!=1||!fingerprint.equals(learner.legacyBaseProjectionSha()))throw new IllegalArgumentException("Root projection fingerprint mismatch");
                same=false; // Learned weights stay intact; stale eligibility and neuron projection do not carry over.
            }
        }
        if(version>=3){long candidates=integer(state,"baseCandidates",0,version==3?512:2048);if(same&&candidates!=learner.baseCandidates())throw new IllegalArgumentException("FDB base projection mismatch");}
        long nu=version>=4?integer(state,"neuronUpdates",0,max):0,bc=version>=4?integer(state,"budgetClips",0,max):0;double budget=version>=4?number(state,"lastBudget",0,1.000001):0;
        List<FdbLearning.NeuronTrace> neurons=new ArrayList<>();
        if(version>=4){
            JSONArray nc=state.getJSONArray("neuronCandidates");if(nc.length()>256)throw new IllegalArgumentException("Neuron candidate limit");Set<Integer> unique=new HashSet<>();for(int i=0;i<nc.length();i++){JSONObject v=new JSONObject().put("neuron",nc.get(i));if(!unique.add(index(graph,v,"neuron")))throw new IllegalArgumentException("Duplicate neuron candidate");}
            if(same&&!ids(graph,learner.neuronCandidates()).toString().equals(nc.toString()))throw new IllegalArgumentException("Neuron projection mismatch");
            JSONArray nt=state.getJSONArray("neuronTraces");if(nt.length()>256)throw new IllegalArgumentException("Neuron trace limit");Set<Integer> seen=new HashSet<>();for(int i=0;i<nt.length();i++){JSONObject v=nt.getJSONObject(i);int n=index(graph,v,"neuron");double e=number(v,"eligibility",-2,2),slow=version>=5?number(v,"slowEligibility",-2,2):0;if(!unique.contains(n)||!seen.add(n))throw new IllegalArgumentException("Neuron trace mismatch");if(same)neurons.add(new FdbLearning.NeuronTrace(n,version<5&&learner.plasticityMode().equals("expanded")?0:e,slow));}
        }
        JSONArray a=state.getJSONArray("traces");if(a.length()>(version==2?1216:FdbLearning.MAX_TRACES))throw new IllegalArgumentException("FDB trace limit");List<FdbLearning.Trace> traces=new ArrayList<>();
        for(int i=0;i<a.length();i++){JSONObject v=a.getJSONObject(i);FdbLearning.Trace t=new FdbLearning.Trace(index(graph,v,"source"),index(graph,v,"target"));t.eligibility=number(v,"eligibility",-2,2);t.slowEligibility=version>=5?number(v,"slowEligibility",-2,2):0;if(version==2||!same||version<5&&learner.plasticityMode().equals("expanded")){t.eligibility=0;t.slowEligibility=0;}t.utility=number(v,"utility",-4,4);t.support=number(v,"support",version==2?0:-4,4);t.evidence=integer(v,"evidence",0,max);t.bad=(int)integer(v,"bad",0,Integer.MAX_VALUE);traces.add(t);}
        learner.restore(observations,human,automatic,integer(state,"rng",1,0xffffffffL),number(state,"baseline",-20,20),integer(state,"born",0,max),integer(state,"pruned",0,max),integer(state,"rejected",0,max),traces);
        learner.restoreBaseUpdates(baseUpdates);learner.restoreDynamics(nu,bc,budget,neurons);
    }
}
