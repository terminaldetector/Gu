package org.node.flyconsole;

import org.json.*;
import java.io.IOException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Frozen CPU evaluator. W0 is shared; LIF, delta, learner, traces and RNG are owned. */
final class IsolatedFdbContext {
    final Experiment experiment;
    final Engine engine;
    final GraphDelta layer;
    final FdbLearning learning;
    private final Graph graph;
    private final JSONObject original;

    static long estimatedBytes(Graph graph){return 160L*graph.ids.length+8L*1024*1024;}
    private static int[] ports(Graph graph,JSONArray ids)throws Exception {
        int[] values=new int[ids.length()];Set<Integer> seen=new HashSet<>();
        for(int i=0;i<values.length;i++){values[i]=Arrays.binarySearch(graph.ids,Long.parseLong(ids.getString(i)));if(values[i]<0||!seen.add(values[i]))throw new IOException("Порты контрольной модели повреждены");}return values;
    }
    IsolatedFdbContext(Graph graph,JSONObject checkpoint)throws Exception {
        JSONObject config=checkpoint.getJSONObject("configuration");boolean wide=RomImport.wide(checkpoint.getString("system"));
        this.graph=graph;original=new JSONObject(config.getJSONObject("fdb").toString());
        if(!graph.fingerprint().equals(original.getString("graph_sha256")))throw new IOException("Контрольная модель другого коннектома");
        experiment=new Experiment(ports(graph,config.getJSONArray("inputs")),ports(graph,config.getJSONArray("outputs")));
        for(int a:experiment.inputs)for(int b:experiment.outputs)if(a==b)throw new IOException("Порты контрольной модели пересекаются");
        experiment.mode=config.getString("mode");experiment.maxHz=config.getDouble("maxHz");experiment.thresholdHz=config.getDouble("thresholdHz");experiment.windowMs=config.getInt("windowMs");
        experiment.options.gain=config.getDouble("gain");experiment.options.disableInhibition=config.getBoolean("disableInhibition");experiment.scramble=config.getBoolean("scramble");experiment.seedPermutation(config.getLong("seed"));
        experiment.options.lesions=ports(graph,config.getJSONArray("lesions"));String systemButtons=config.optString("systemButtons","auto");if(!systemButtons.matches("auto|blocked"))throw new IOException("Управление контрольной модели");experiment.agentButtonMask=systemButtons.equals("blocked")?(wide?2039:243):(wide?4095:255);
        layer=new GraphDelta(graph.ids.length,2048);FdbCheckpoint.restoreLinks(layer,original,graph);FdbCheckpoint.restoreThresholds(layer,original,graph);experiment.options.delta=layer;
        JSONObject lc=original.getJSONObject("learning");learning=new FdbLearning(graph,layer,experiment.inputs,experiment.outputs,lc.getDouble("rate"),lc.getInt("maxEdges"),(float)lc.getDouble("maxWeight"),lc.optBoolean("trainBase",true),lc.optString("plasticityMode","base"));learning.creditProfile(lc.optString("creditProfile","single-v1"));
        FdbCheckpoint.restore(learning,original.getJSONObject("learningState"),graph,experiment.inputs,experiment.outputs);
        // No boundary/reset here: an evaluator must restore the exact registered checkpoint.
        if(!CheckpointDigest.of(original).equals(CheckpointDigest.of(state())))throw new IOException("Контрольный checkpoint требует миграции; сравнение запрещено");
        engine=new Engine(graph);
    }
    JSONObject state()throws Exception {
        JSONObject state=new JSONObject(original.toString()).put("neuronDynamics",FdbCheckpoint.thresholdState(layer,graph));
        for(String kind:new String[]{"deltas","edges"}){JSONArray links=new JSONArray();for(GraphDelta.Edge e:kind.equals("deltas")?layer.deltas():layer.edges())links.put(new JSONObject().put("source",Long.toString(graph.ids[e.source])).put("target",Long.toString(graph.ids[e.target])).put("weight",e.weight));state.put(kind,links);}
        return state.put("learningState",FdbCheckpoint.save(learning,graph,experiment.inputs,experiment.outputs));
    }
    JSONObject sample(JSONObject request,AtomicBoolean cancel)throws Exception {
        JSONArray pixels=request.getJSONArray("retina");if(pixels.length()!=16)throw new IOException("Нужно 16 наблюдений");double[] retina=new double[16];for(int i=0;i<16;i++)retina[i]=pixels.getDouble(i);
        Engine.Result result=engine.advance(experiment.inputs,experiment.rates(retina),experiment.windowMs,experiment.options,cancel);
        if(cancel.get()||result.steps!=experiment.windowMs*10)throw new IOException("Изолированная проверка прервана");
        JSONArray values=request.getJSONArray("actions");if(values.length()<2||values.length()>64)throw new IOException("Набор контрольных действий");int[] actions=new int[values.length()];for(int i=0;i<actions.length;i++)actions[i]=values.getInt(i);
        String id=request.getLong("generation")+":"+request.getLong("token");FdbLearning.Decision decision=learning.decide(id,result,actions,experiment.agentButtonMask,experiment.thresholdHz,0,false,experiment.options.lesions);
        JSONArray hz=new JSONArray(),groups=new JSONArray();for(int output:experiment.outputs)hz.put(result.counts[output]*10000.0/result.steps);
        for(int k=0;k<16;k++){long count=0;int active=0,start=(int)((long)k*graph.ids.length/16),end=(int)((long)(k+1)*graph.ids.length/16);for(int i=start;i<end;i++){count+=result.counts[i];if(result.counts[i]>0)active++;}groups.put(new JSONObject().put("spikes",count).put("active",active).put("neurons",end-start).put("hz",end==start?0:count*10000.0/result.steps/(end-start)));}
        return new JSONObject().put("token",request.getLong("token")).put("generation",request.getLong("generation")).put("buttons",experiment.buttons(result)).put("outputs",hz).put("neuralGroups",groups).put("spikes",result.spikes).put("active",result.active).put("wallMs",result.wallSeconds*1000).put("simMs",result.endTick*.1).put("steps",result.steps).put("backend","cpu").put("fdbDecision",new JSONObject().put("id",decision.id).put("mask",decision.mask).put("probability",decision.probability));
    }
}
