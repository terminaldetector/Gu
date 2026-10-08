package org.node.flyconsole;



/** Experimental window-based structural plasticity, not a biological learning claim. */
public final class FdbGrowth {
    private final Graph graph;
    private final GraphDelta layer;
    private final int[] sources, targets;
    private final int interval, perWindow, maxEdges;
    private final float initialWeight;
    private final boolean explore, rewardGate;
    private long random;
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
        this.explore=explore;this.rewardGate=rewardGate;this.random=(seed&0xffffffffL)==0?1:seed&0xffffffffL;
    }
    public void reset(long seed){windows=0;previous=null;random=(seed&0xffffffffL)==0?1:seed&0xffffffffL;}
    public int observe(Engine.Result result, double reward, int[] lesions, boolean frozen) {
        if(result.steps==0||frozen)return 0;
        if(result.counts.length!=graph.ids.length||!Double.isFinite(reward))throw new IllegalArgumentException("FDB observation");
        int[] pre=previous;previous=new int[sources.length];for(int k=0;k<sources.length;k++)previous[k]=result.counts[sources[k]];windows++;
        if(windows%interval!=0||(rewardGate&&reward<=0)||layer.growthCount()>=maxEdges)return 0;
        int added=0;
        // Rotating seeded traversal avoids a permanent preference for the first button.
        int start=sources.length==0?0:nextInt(sources.length);
        for(int k=0;k<sources.length&&added<perWindow&&layer.growthCount()<maxEdges;k++) {
            int source=sources[(start+k)%sources.length];
            if((pre==null?result.counts[source]:pre[(start+k)%sources.length])==0||lesioned(source,lesions))continue;
            int first=targets.length==0?0:nextInt(targets.length);
            for(int j=0;j<targets.length;j++) {
                int target=targets[(first+j)%targets.length];
                if(source==target||lesioned(target,lesions)||layer.hasEdge(source,target)||baseEdge(source,target))continue;
                if(result.counts[target]==0&&!explore)continue;
                layer.addEdge(source,target,initialWeight);added++;break;
            }
        }
        return added;
    }
    private int nextInt(int bound){random^=(random<<13)&0xffffffffL;random^=random>>>17;random^=(random<<5)&0xffffffffL;random&=0xffffffffL;return (int)(random%bound);}
    public long windows(){return windows;}
    public long rng(){return random;}
    public int[] previous(){return previous==null?null:previous.clone();}
    public void restore(long at,long rng,int[] prior){
        if(at<0||at>Integer.MAX_VALUE||rng<1||rng>0xffffffffL||prior!=null&&prior.length!=sources.length)throw new IllegalArgumentException("FDB growth checkpoint");
        if(prior!=null)for(int n:prior)if(n<0)throw new IllegalArgumentException("FDB activity checkpoint");
        windows=(int)at;random=rng;previous=prior==null?null:prior.clone();
    }
    private boolean baseEdge(int source,int target){for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target)return true;return false;}
    private static boolean lesioned(int i,int[] lesions){if(lesions!=null)for(int x:lesions)if(x==i)return true;return false;}
}
