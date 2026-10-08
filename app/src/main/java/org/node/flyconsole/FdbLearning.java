package org.node.flyconsole;

/** Explicit consolidation of labelled controller experience into synthetic FDB edges.
 * This is a supervised adapter over the immutable graph, not biological plasticity. */
public final class FdbLearning {
    private final Graph graph;
    private final GraphDelta layer;
    private final int[] sources,targets;
    private final double rate;
    private final float maxWeight;
    private final int maxEdges;
    private long observations,human,automatic;
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight){
        if(sources.length!=16||targets.length<1||targets.length>12||!Double.isFinite(rate)||rate<.001||rate>.2||maxEdges<1||maxEdges>1024||!Float.isFinite(maxWeight)||maxWeight<=0||maxWeight>127)throw new IllegalArgumentException("FDB learning parameters");
        this.graph=graph;this.layer=layer;this.sources=sources.clone();this.targets=targets.clone();this.rate=rate;this.maxEdges=maxEdges;this.maxWeight=maxWeight;
        for(int i:sources)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning source");
        for(int i:targets)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning target");
    }
    public int observe(double[] retina,int mask,double reward,boolean demonstration,int[] lesions,boolean frozen){
        if(retina.length!=16||mask<0||mask>=(1<<targets.length)||(mask&48)==48||(mask&192)==192||!Double.isFinite(reward)||Math.abs(reward)>20)throw new IllegalArgumentException("FDB labelled experience");
        for(double v:retina)if(!Double.isFinite(v)||v<0||v>1)throw new IllegalArgumentException("FDB experience retina");
        if(frozen||(!demonstration&&reward==0))return 0;
        int changed=0;
        for(int i=0;i<sources.length;i++){
            int source=sources[i];if(lesioned(source,lesions)||retina[i]<.01)continue;
            for(int j=0;j<targets.length;j++){
                int target=targets[j];boolean pressed=(mask&(1<<j))!=0;
                if(source==target||lesioned(target,lesions)||baseEdge(source,target)||(!demonstration&&reward<0&&!pressed))continue;
                float desired=(pressed&&(demonstration||reward>0))?(float)(maxWeight*retina[i]):0f;
                if(layer.hasEdge(source,target)){
                    float old=0;for(GraphDelta.Edge edge:layer.outgoing(source))if(edge.target==target){old=edge.weight;break;}
                    float next=(float)Math.max(0,Math.min(maxWeight,old+rate*(desired-old)));
                    if(Math.abs(next-old)>.0001f&&layer.setGrowthWeight(source,target,next))changed++;
                }else if(desired>0&&layer.growthCount()<maxEdges){layer.addEdge(source,target,(float)(rate*desired));changed++;}
            }
        }
        observations++;if(demonstration)human++;else automatic++;return changed;
    }
    public long observations(){return observations;}public long human(){return human;}public long automatic(){return automatic;}
    public void restore(long observations,long human,long automatic){
        if(observations<0||observations>9007199254740991L||human<0||automatic<0||human>observations||automatic!=observations-human)throw new IllegalArgumentException("FDB learning checkpoint");
        this.observations=observations;this.human=human;this.automatic=automatic;
    }
    private boolean baseEdge(int source,int target){for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target)return true;return false;}
    private static boolean lesioned(int i,int[] lesions){if(lesions!=null)for(int x:lesions)if(x==i)return true;return false;}
}
