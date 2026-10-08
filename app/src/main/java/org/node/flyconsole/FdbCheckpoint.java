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
    public static JSONObject save(FdbLearning learner,Graph graph,int[] sources,int[] targets)throws Exception{
        JSONObject state=new JSONObject().put("version",2).put("algorithm","action-conditioned window eligibility").put("observations",learner.observations()).put("human",learner.human()).put("automatic",learner.automatic()).put("sources",ids(graph,sources)).put("targets",ids(graph,targets)).put("rng",learner.rng()).put("baseline",learner.baseline()).put("born",learner.born()).put("pruned",learner.pruned()).put("rejected",learner.rejected());
        JSONArray traces=new JSONArray();for(FdbLearning.Trace t:learner.traces())traces.put(new JSONObject().put("source",Long.toString(graph.ids[t.source])).put("target",Long.toString(graph.ids[t.target])).put("eligibility",t.eligibility).put("utility",t.utility).put("support",t.support).put("evidence",t.evidence).put("bad",t.bad));return state.put("traces",traces);
    }
    public static void restore(FdbLearning learner,JSONObject state,Graph graph,int[] sources,int[] targets)throws Exception{
        long version=integer(state,"version",1,2),max=9007199254740991L;
        if(!ids(graph,sources).toString().equals(state.getJSONArray("sources").toString())||!ids(graph,targets).toString().equals(state.getJSONArray("targets").toString()))throw new IllegalArgumentException("FDB checkpoint belongs to other ports");
        long observations=integer(state,"observations",0,max),human=integer(state,"human",0,max),automatic=integer(state,"automatic",0,max);
        if(version==1){learner.restore(observations,human,automatic);return;}
        if(!"action-conditioned window eligibility".equals(state.getString("algorithm")))throw new IllegalArgumentException("FDB learning algorithm");
        JSONArray a=state.getJSONArray("traces");if(a.length()>1216)throw new IllegalArgumentException("FDB trace limit");List<FdbLearning.Trace> traces=new ArrayList<>();
        for(int i=0;i<a.length();i++){JSONObject v=a.getJSONObject(i);FdbLearning.Trace t=new FdbLearning.Trace(index(graph,v,"source"),index(graph,v,"target"));t.eligibility=number(v,"eligibility",-2,2);t.utility=number(v,"utility",-4,4);t.support=number(v,"support",0,4);t.evidence=integer(v,"evidence",0,max);t.bad=(int)integer(v,"bad",0,Integer.MAX_VALUE);traces.add(t);}
        learner.restore(observations,human,automatic,integer(state,"rng",1,0xffffffffL),number(state,"baseline",-20,20),integer(state,"born",0,max),integer(state,"pruned",0,max),integer(state,"rejected",0,max),traces);
    }
}
