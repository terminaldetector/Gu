package org.node.flyconsole;
import org.json.*;

public final class FrozenFdbCheck {
    static JSONObject state(Graph g,GraphDelta delta,FdbLearning learner)throws Exception {
        JSONArray edges=new JSONArray(),weights=new JSONArray();for(GraphDelta.Edge e:delta.edges())edges.put(new JSONObject().put("source",e.source).put("target",e.target).put("weight",e.weight));for(GraphDelta.Edge e:delta.deltas())weights.put(new JSONObject().put("source",e.source).put("target",e.target).put("weight",e.weight));
        return new JSONObject().put("edges",edges).put("deltas",weights).put("neuronDynamics",FdbCheckpoint.thresholdState(delta,g)).put("learningState",FdbCheckpoint.save(learner,g,FdbLearningCheck.sources(),FdbLearningCheck.targets()));
    }
    public static void main(String[] args)throws Exception {
        int windows=0;
        for(String profile:new String[]{"single-v1","dual-v1","dual-rate-v1"}){
            Graph g=FdbLearningCheck.graph();GraphDelta delta=new GraphDelta(30);delta.addEdge(0,16,10);delta.setThresholdOffset(16,-1);
            FdbLearning learner=FdbLearningCheck.learner(g,delta);learner.creditProfile(profile);
            for(int i=0;i<5;i++){FdbLearning.Decision d=learner.decide("train-"+i,FdbLearningCheck.active(),new int[]{0,1},4095,100,.2,true,null);learner.feedback(d.id,d.mask,1,.1,6,true,false,null);}
            String before=CheckpointDigest.of(state(g,delta,learner));
            for(int i=0;i<20;i++){learner.decide("eval-"+i,FdbLearningCheck.active(),new int[]{0,1},4095,100,0,false,null);learner.feedback("unknown",0,0,.1,6,true,true,null);if(!before.equals(CheckpointDigest.of(state(g,delta,learner))))throw new AssertionError("full frozen state changed: "+profile);windows++;}
            delta.setThresholdOffset(16,-2);if(before.equals(CheckpointDigest.of(state(g,delta,learner))))throw new AssertionError("threshold mutation escaped full digest");
        }
        System.out.println("PASS: "+windows+" real FDB frozen windows across three credit profiles; learned weights, Wexo, thresholds, traces, RNG, baseline and counters covered");
    }
}
