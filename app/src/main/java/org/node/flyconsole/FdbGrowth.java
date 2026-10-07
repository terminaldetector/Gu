package org.node.flyconsole;

import java.util.Random;

/** Experimental window-based structural plasticity, not a biological learning claim. */
public final class FdbGrowth {
    private final Graph graph;
    private final GraphDelta layer;
    private final int[] sources, targets;
    private final int interval, perWindow, maxEdges;
    private final float initialWeight;
    private final boolean explore, rewardGate;
    private final Random random;
    private int windows;
    private int[] previous;
    public FdbGrowth(Graph graph, GraphDelta layer, int[] sources, int[] targets,
                     int interval, int perWindow, int maxEdges, float initialWeight,
                     boolean explore, boolean rewardGate, long seed) {
        if(interval<1||interval>1000||perWindow<1||perWindow>8||maxEdges<1||maxEdges>1024||!Float.isFinite(initialWeight)||initialWeight<=0||initialWeight>127)
            throw new IllegalArgumentException("FDB growth: interval 1..1000, perWindow 1..8, maxEdges 1..1024, weight (0..127]");
        this.graph=graph;this.layer=layer;this.sources=sources.clone();this.targets=targets.clone();
        for(int i:sources)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB source");
        for(int i:targets)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB target");
        this.interval=interval;this.perWindow=perWindow;this.maxEdges=maxEdges;this.initialWeight=initialWeight;
        this.explore=explore;this.rewardGate=rewardGate;this.random=new Random(seed);
    }
    public void reset(long seed){windows=0;previous=null;random.setSeed(seed);}
    public int observe(Engine.Result result, double reward, int[] lesions, boolean frozen) {
        if(result.steps==0||frozen)return 0;
        if(result.counts.length!=graph.ids.length||!Double.isFinite(reward))throw new IllegalArgumentException("FDB observation");
        int[] pre=previous==null?result.counts:previous;
        previous=result.counts.clone();windows++;
        if(windows%interval!=0||(rewardGate&&reward<=0)||layer.growthCount()>=maxEdges)return 0;
        int added=0;
        // Rotating seeded traversal avoids a permanent preference for the first button.
        int start=sources.length==0?0:random.nextInt(sources.length);
        for(int k=0;k<sources.length&&added<perWindow&&layer.growthCount()<maxEdges;k++) {
            int source=sources[(start+k)%sources.length];
            if(pre[source]==0||lesioned(source,lesions))continue;
            int first=targets.length==0?0:random.nextInt(targets.length);
            for(int j=0;j<targets.length;j++) {
                int target=targets[(first+j)%targets.length];
                if(source==target||lesioned(target,lesions)||layer.hasEdge(source,target)||baseEdge(source,target))continue;
                if(result.counts[target]==0&&!explore)continue;
                layer.addEdge(source,target,initialWeight);added++;break;
            }
        }
        return added;
    }
    private boolean baseEdge(int source,int target){for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target)return true;return false;}
    private static boolean lesioned(int i,int[] lesions){if(lesions!=null)for(int x:lesions)if(x==i)return true;return false;}
}
