package org.node.flyconsole;

import java.util.List;

/** Deterministic regression checks for action-attributed sparse eligibility.
 * Existing contrastive credit and the non-mutating freeze contract must survive
 * zero-credit filtering; no commercial-game learning claim is made here. */
public final class FdbSparseCreditCheck {
    private static void check(boolean ok,String message) {
        if(!ok)throw new AssertionError(message);
    }

    private static Engine.Result counts(int sourceSpikes) {
        int[] counts=new int[30];
        counts[0]=sourceSpikes;
        counts[16]=10;
        return new Engine.Result(counts,sourceSpikes+10,200,100,0);
    }

    public static void main(String[] args) {
        Graph graph=FdbLearningCheck.graph();
        GraphDelta delta=new GraphDelta(30);
        // One edge targets a motor port absent from both tested actions;
        // another targets the chosen port but has a silent presynaptic neuron.
        delta.addEdge(0,26,2);
        delta.addEdge(1,16,2);
        FdbLearning learning=new FdbLearning(graph,delta,
            FdbLearningCheck.sources(),FdbLearningCheck.targets(),.1,16,127);
        learning.seed(123);

        // A motor output may fire without any eligible presynaptic activity.
        FdbLearning.Decision silent=learning.decide("silent",counts(0),
            new int[]{0,1},4095,100,0,true,null);
        long version=delta.version();
        learning.feedback(silent.id,silent.mask,1,.1,6,true,false,null);
        check(learning.traces().isEmpty(),"silent presynaptic neurons must not allocate traces");
        check(delta.version()==version,"no active credit must leave weights unchanged");

        // Whichever action the seeded policy samples, the policy-gradient
        // contrast changes sign; only the active (0 -> motor 16) path is valid.
        FdbLearning.Decision active=learning.decide("active",counts(100),
            new int[]{0,1},4095,100,0,true,null);
        learning.feedback(active.id,active.mask,1,.1,6,true,false,null);
        List<FdbLearning.Trace> traces=learning.traces();
        check(traces.size()==1,"only active nonzero-credit paths allocate traces");
        FdbLearning.Trace trace=traces.get(0);
        check(trace.source==0&&trace.target==16,"unselected motor and silent Wexo paths must not receive credit");
        check(active.mask==1?trace.eligibility>0:trace.eligibility<0,
            "selected-action contrast must retain signed eligibility");

        learning.boundary();
        check(learning.traces().size()==1&&learning.traces().get(0).eligibility==0,
            "boundary keeps structural evidence but clears temporal eligibility");
        long observations=learning.observations(),rng=learning.rng();
        version=delta.version();
        learning.decide("eval",counts(100),new int[]{0,1},4095,100,0,false,null);
        check(delta.version()==version&&learning.observations()==observations&&learning.rng()==rng,
            "evaluation must not learn or consume decision RNG");
        System.out.println("PASS FDB sparse credit: inactive and zero-gradient exclusion, signed chosen-action eligibility, boundary and evaluation");
    }
}
