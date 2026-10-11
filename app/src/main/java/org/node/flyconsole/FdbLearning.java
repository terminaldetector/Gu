package org.node.flyconsole;

import java.util.*;

/** Existing FDB adapter: supervised seeds plus action-specific, window-rate reward traces.
 * It is a bounded surrogate rule, not millisecond STDP or an exact recurrent gradient. */
public final class FdbLearning {
    public static final int MAX_BASE_EDGES=512, MAX_TRACES=2048;
    public static final class Trace {
        public final int source,target;
        public double eligibility,utility,support;
        public long evidence;
        public int bad;
        public Trace(int source,int target){this.source=source;this.target=target;}
        public Trace copy(){Trace t=new Trace(source,target);t.eligibility=eligibility;t.utility=utility;t.support=support;t.evidence=evidence;t.bad=bad;return t;}
    }
    public static final class Decision {
        public final String id;public final int mask;public final double probability;
        private final LinkedHashMap<Long,Double> gradient;
        private Decision(String id,int mask,double probability,LinkedHashMap<Long,Double> gradient){this.id=id;this.mask=mask;this.probability=probability;this.gradient=gradient;}
    }
    private final Graph graph;private final GraphDelta layer;private final int[] sources,targets;
    private final double rate;private final float maxWeight;private final int maxEdges;
    private final boolean trainBase;
    private final LinkedHashMap<Long,GraphDelta.Edge> basePaths=new LinkedHashMap<>();
    private final int[] growthTargets;
    private final LinkedHashMap<Long,Trace> traces=new LinkedHashMap<>();
    private final LinkedHashMap<String,Decision> pending=new LinkedHashMap<>();
    private long observations,human,automatic,rng=1,born,pruned,rejected,baseUpdates;
    private double baseline;
    private static long key(int source,int target){return ((long)source<<32)|(target&0xffffffffL);}
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight){
        this(graph,layer,sources,targets,rate,maxEdges,maxWeight,true);
    }
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight,boolean trainBase){
        if(sources.length!=16||targets.length<1||targets.length>12||!Double.isFinite(rate)||rate<.001||rate>.2||maxEdges<1||maxEdges>1024||!Float.isFinite(maxWeight)||maxWeight<=0||maxWeight>127)throw new IllegalArgumentException("FDB learning parameters");
        this.graph=graph;this.layer=layer;this.sources=sources.clone();this.targets=targets.clone();this.rate=rate;this.maxEdges=maxEdges;this.maxWeight=maxWeight;this.trainBase=trainBase;
        for(int i:sources)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning source");
        for(int i:targets)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning target");
        Set<Integer> unique=new HashSet<>();for(int i:sources)if(!unique.add(i))throw new IllegalArgumentException("Duplicate FDB source");for(int i:targets)if(!unique.add(i))throw new IllegalArgumentException("Overlapping FDB ports");
        buildBasePaths();
        ArrayList<Integer> ports=new ArrayList<>();for(int t:targets)ports.add(t);
        for(GraphDelta.Edge edge:basePaths.values())if(ports.size()<targets.length+8&&!unique.contains(edge.source)&&!ports.contains(edge.source))ports.add(edge.source);
        growthTargets=new int[ports.size()];for(int i=0;i<ports.size();i++)growthTargets[i]=ports.get(i);
    }
    /** A deterministic bounded projection of real W0 predecessors. Three CSR scans
     * only at configuration, no full reverse graph or per-frame 25M-edge scan.
     * The projection depends only on W0 and ports, so reload cannot change it. */
    private void buildBasePaths(){
        TreeSet<Integer> frontier=new TreeSet<>(),visited=new TreeSet<>();for(int t:targets)frontier.add(t);
        final Comparator<GraphDelta.Edge> order=(a,b)->{int c=Float.compare(Math.abs(b.weight),Math.abs(a.weight));return c!=0?c:Integer.compare(a.source,b.source);};
        for(int hop=0;hop<3&&!frontier.isEmpty()&&basePaths.size()<MAX_BASE_EDGES;hop++){
            boolean[] wanted=new boolean[graph.ids.length];TreeMap<Integer,ArrayList<GraphDelta.Edge>> incoming=new TreeMap<>();
            for(int t:frontier){wanted[t]=true;incoming.put(t,new ArrayList<>());}visited.addAll(frontier);
            for(int s=0;s<graph.ids.length;s++)for(int e=graph.offsets[s];e<graph.offsets[s+1];e++){
                int t=graph.targets[e];if(!wanted[t]||s==t||graph.weights[e]==0)continue;
                ArrayList<GraphDelta.Edge> list=incoming.get(t);GraphDelta.Edge edge=new GraphDelta.Edge(s,t,graph.weights[e]);
                int at=Collections.binarySearch(list,edge,order);if(at<0)at=-at-1;
                if(at<8){list.add(at,edge);if(list.size()>8)list.remove(8);}
            }
            TreeSet<Integer> next=new TreeSet<>();int limit=hop==0?128:hop==1?320:MAX_BASE_EDGES;
            // Round robin over targets prevents the first output monopolising the cap.
            for(int rank=0;rank<8&&basePaths.size()<limit;rank++)for(ArrayList<GraphDelta.Edge> list:incoming.values())if(rank<list.size()&&basePaths.size()<limit){
                GraphDelta.Edge e=list.get(rank);basePaths.put(key(e.source,e.target),e);if(!visited.contains(e.source))next.add(e.source);
            }
            frontier=next;
        }
    }
    private Trace trace(int source,int target){long k=key(source,target);Trace t=traces.get(k);if(t==null){if(traces.size()>=MAX_TRACES)return null;t=new Trace(source,target);traces.put(k,t);}return t;}
    private static boolean lesioned(int i,int[] lesions){if(lesions!=null)for(int x:lesions)if(x==i)return true;return false;}
    private boolean baseEdge(int source,int target){for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target)return true;return false;}
    private double random(){long x=rng;x^=(x<<13)&0xffffffffL;x^=x>>>17;x^=(x<<5)&0xffffffffL;rng=x&0xffffffffL;return rng/4294967296.0;}
    public void seed(long seed){rng=(seed&0xffffffffL)==0?1:seed&0xffffffffL;}
    public Decision decide(String id,Engine.Result result,int[] actions,int allowed,double threshold,double epsilon,boolean training,int[] lesions){
        if(id==null||id.length()>80||result.counts.length!=graph.ids.length||result.steps<=0||!Double.isFinite(threshold)||threshold<=0||!Double.isFinite(epsilon)||epsilon<0||epsilon>1||actions.length<2||actions.length>64)throw new IllegalArgumentException("FDB decision");
        double[] logits=new double[actions.length],prob=new double[actions.length];int eligible=0,best=-1;double maximum=-Double.MAX_VALUE;
        Set<Integer> unique=new HashSet<>();
        for(int a=0;a<actions.length;a++){
            int mask=actions[a];if(mask<0||mask>4095||(mask&48)==48||(mask&192)==192||!unique.add(mask))throw new IllegalArgumentException("FDB action set");
            if((mask&~allowed)!=0||mask>=(1<<targets.length)){logits[a]=Double.NEGATIVE_INFINITY;continue;}
            eligible++;double score=0;
            for(int j=0;j<targets.length;j++)if((mask&(1<<j))!=0){double hz=lesioned(targets[j],lesions)?0:result.counts[targets[j]]*10000.0/result.steps;score+=Math.max(-2,Math.min(4,hz/threshold-1));}
            logits[a]=score;if(score>maximum){maximum=score;best=a;}
        }
        if(best<0)throw new IllegalArgumentException("FDB has no allowed actions");
        double sum=0;for(int a=0;a<actions.length;a++){prob[a]=Math.exp(logits[a]-maximum);sum+=prob[a];}
        for(int a=0;a<actions.length;a++)prob[a]=prob[a]/sum*(1-epsilon)+(Double.isFinite(logits[a])?epsilon/eligible:0);
        int chosen=best;
        if(training){double sample=random(),acc=0;for(int a=0;a<prob.length;a++){acc+=prob[a];if(sample<acc){chosen=a;break;}}}
        HashMap<Integer,Double> feedback=new HashMap<>();
        for(int j=0;j<targets.length;j++){

            // The uniform epsilon component has no weight derivative.
            double policyShare=training&&prob[chosen]>0?(1-epsilon)*Math.exp(logits[chosen]-maximum)/sum/prob[chosen]:1;
            double pureExpected=0;for(int a=0;a<actions.length;a++)if((actions[a]&(1<<j))!=0)pureExpected+=Math.exp(logits[a]-maximum)/sum;
            feedback.put(targets[j],lesioned(targets[j],lesions)?0:policyShare*(((actions[chosen]&(1<<j))!=0?1:0)-pureExpected));
        }
        List<GraphDelta.Edge> edges=layer.edges(),paths=new ArrayList<>(edges);
        for(GraphDelta.Edge e:basePaths.values())paths.add(new GraphDelta.Edge(e.source,e.target,e.weight+layer.weightDelta(e.source,e.target)));
        // Each hop uses only the preceding frontier. Mixed W0/ΔW/Wexo paths carry
        // signed action feedback; fan-out normalisation bounds recurrent amplification.
        HashMap<Integer,Double> norm=new HashMap<>(),frontier=new HashMap<>(feedback);
        for(GraphDelta.Edge e:paths)norm.put(e.source,norm.getOrDefault(e.source,0.0)+Math.abs(e.weight));
        for(int hop=0;hop<3;hop++){
            HashMap<Integer,Double> next=new HashMap<>();
            for(GraphDelta.Edge e:paths)if(result.counts[e.source]>0&&!lesioned(e.source,lesions)&&!lesioned(e.target,lesions)&&index(targets,e.source)<0)
                next.put(e.source,next.getOrDefault(e.source,0.0)+frontier.getOrDefault(e.target,0.0)*e.weight/Math.max(maxWeight,norm.get(e.source)));
            for(Map.Entry<Integer,Double> e:next.entrySet())feedback.put(e.getKey(),Math.max(-1,Math.min(1,feedback.getOrDefault(e.getKey(),0.0)+e.getValue())));
            frontier=next;
        }
        LinkedHashMap<Long,Double> gradient=new LinkedHashMap<>();
        for(GraphDelta.Edge e:edges)if(!lesioned(e.source,lesions)&&!lesioned(e.target,lesions))gradient.put(key(e.source,e.target),activity(result,e.source)*feedback.getOrDefault(e.target,0.0));
        if(trainBase)for(GraphDelta.Edge e:basePaths.values())if(!lesioned(e.source,lesions)&&!lesioned(e.target,lesions))gradient.put(key(e.source,e.target),activity(result,e.source)*feedback.getOrDefault(e.target,0.0));
        for(int source:sources)if(!lesioned(source,lesions))for(int target:growthTargets)if(source!=target&&!lesioned(target,lesions)&&!baseEdge(source,target)&&(index(targets,target)>=0||result.counts[target]>0))gradient.put(key(source,target),activity(result,source)*feedback.getOrDefault(target,0.0));
        Decision d=new Decision(id,actions[chosen],prob[chosen],gradient);
        if(training){if(pending.containsKey(id))throw new IllegalArgumentException("Duplicate FDB decision");pending.put(id,d);while(pending.size()>4)pending.remove(pending.keySet().iterator().next());}
        return d;
    }
    private static double activity(Engine.Result r,int neuron){return Math.min(1,r.counts[neuron]*10.0/r.steps);}
    private static int index(int[] values,int value){for(int i=0;i<values.length;i++)if(values[i]==value)return i;return -1;}
    /** Reward applies to the cached decision's activity, only after real game execution. */
    public int feedback(String id,int executedMask,double reward,double gameSeconds,int frames,boolean valid,boolean frozen,int[] lesions){
        if(!Double.isFinite(reward)||Math.abs(reward)>20||!Double.isFinite(gameSeconds)||gameSeconds<=0||gameSeconds>2||frames<1||frames>240)throw new IllegalArgumentException("FDB feedback");
        if(frozen)return 0;
        Decision d=pending.remove(id);
        // The worker may already have cached the next decision. Reject this interval,
        // not those later decisions; otherwise one intervention poisons every future step.
        if(!valid||d==null||d.mask!=executedMask){rejected++;for(Trace t:traces.values())t.eligibility=0;return 0;}
        double decay=Math.exp(-gameSeconds/.6);
        for(Trace t:traces.values()){t.eligibility*=decay;t.support*=Math.exp(-gameSeconds/2);}
        for(Map.Entry<Long,Double> e:d.gradient.entrySet()){
            int source=(int)(e.getKey()>>32),target=(int)(long)e.getKey();if(lesioned(source,lesions)||lesioned(target,lesions))continue;
            Trace t=trace(source,target);if(t!=null)t.eligibility=Math.max(-2,Math.min(2,t.eligibility+e.getValue()*decay));
        }
        double advantage=Math.max(-2,Math.min(2,reward-baseline));baseline+=.05*(reward-baseline);int changed=0,removed=0,created=0;
        for(Trace t:traces.values()){
            if(lesioned(t.source,lesions)||lesioned(t.target,lesions)||Math.abs(t.eligibility)<1e-6)continue;
            double credit=advantage*t.eligibility;GraphDelta.Edge base=basePaths.get(key(t.source,t.target));
            if(base!=null){if(trainBase&&adaptBase(base,credit))changed++;continue;}
            double oldWeight=weight(t.source,t.target),utilityCredit=oldWeight<0?-credit:credit;
            if(Math.abs(credit)>1e-6)t.evidence++;t.utility=.9*t.utility+.1*utilityCredit;t.support=Math.max(-4,Math.min(4,t.support+credit));
            if(utilityCredit<-.0001)t.bad=t.bad==Integer.MAX_VALUE?t.bad:t.bad+1;else if(utilityCredit>.0001)t.bad=0;
            if(layer.hasEdge(t.source,t.target)){
                float old=weight(t.source,t.target);
                double step=rate*maxWeight*credit/(1+2*Math.max(0,t.utility));
                if(old*step>0)step*=Math.max(.05,1-Math.abs(old)/maxWeight);
                float next=(float)(old>=0?Math.max(0,Math.min(maxWeight,old+step)):Math.max(-maxWeight,Math.min(-.000001,old+step)));
                if(Math.abs(next-old)>.0001f&&layer.setGrowthWeight(t.source,t.target,next))changed++;
                if(removed<1&&t.evidence>=12&&t.bad>=6&&Math.abs(next)<.5&&t.utility<-.001){layer.removeEdge(t.source,t.target);pruned++;removed++;changed++;t.eligibility=0;t.support=0;}
            }else if(created<2&&t.evidence>=3&&Math.abs(t.support)>=.25&&credit*t.support>0&&layer.growthCount()<maxEdges&&!baseEdge(t.source,t.target)){
                layer.addEdge(t.source,t.target,(float)Math.copySign(Math.min(maxWeight,Math.max(.5,rate*maxWeight*Math.abs(t.support))),t.support));born++;changed++;created++;t.support=0;
            }
        }
        observations++;automatic++;return changed;
    }
    private float weight(int source,int target){for(GraphDelta.Edge e:layer.outgoing(source))if(e.target==target)return e.weight;return 0;}
    /** Slow trust-region updates of effective root weights; W0 and its sign stay intact.
     * Explicit user deltas outside this region are retained, not silently clamped. */
    private boolean adaptBase(GraphDelta.Edge base,double credit){
        double limit=Math.min(127,Math.abs(base.weight)*.5),old=layer.weightDelta(base.source,base.target);
        if(limit==0||Math.abs(old)>limit||Math.abs(credit)<1e-6||old==0&&layer.deltaCount()>=1024)return false;
        float next=(float)Math.max(-limit,Math.min(limit,old+rate*.1*Math.abs(base.weight)*credit));
        if(Math.abs(next-old)<.000001)return false;
        layer.addWeightDelta(base.source,base.target,(float)(next-old));baseUpdates++;return true;
    }
    /** Human consolidation remains labelled and independent of global game rewards. */
    public int observe(double[] retina,int mask,double reward,boolean demonstration,int[] lesions,boolean frozen){
        if(retina.length!=16||mask<0||mask>=(1<<targets.length)||(mask&48)==48||(mask&192)==192||!Double.isFinite(reward)||Math.abs(reward)>20)throw new IllegalArgumentException("FDB labelled experience");
        for(double v:retina)if(!Double.isFinite(v)||v<0||v>1)throw new IllegalArgumentException("FDB experience retina");
        // Old reward+retina packets cannot establish neural action causality.
        if(frozen||!demonstration)return 0;int changed=0,removed=0;
        for(int i=0;i<sources.length;i++){
            int source=sources[i];if(lesioned(source,lesions)||retina[i]<.01)continue;
            for(int j=0;j<targets.length;j++){
                int target=targets[j];boolean pressed=(mask&(1<<j))!=0;
                if(source==target||lesioned(target,lesions))continue;
                if(baseEdge(source,target)){GraphDelta.Edge base=basePaths.get(key(source,target));if(trainBase&&base!=null&&adaptBase(base,retina[i]*(pressed?1:-1)))changed++;continue;}
                float desired=pressed?(float)(maxWeight*retina[i]):0;
                Trace t=trace(source,target);
                if(layer.hasEdge(source,target)){
                    float old=weight(source,target);if(old<0)continue; // Human labels must not flip an acquired inhibitory synapse.
                    float next=(float)Math.max(0,Math.min(maxWeight,old+rate*(desired-old)));
                    if(Math.abs(next-old)>.0001f&&layer.setGrowthWeight(source,target,next))changed++;
                    if(t!=null){t.evidence++;t.utility=.9*t.utility+.1*(pressed?1:-1);t.bad=pressed?0:t.bad+1;}
                    if(removed<1&&t!=null&&t.evidence>=12&&t.bad>=6&&next<.5){layer.removeEdge(source,target);pruned++;removed++;changed++;}
                }else if(desired>0&&layer.growthCount()<maxEdges){layer.addEdge(source,target,(float)(rate*desired));born++;changed++;}
            }
        }
        observations++;human++;return changed;
    }
    /** Break the temporal link at pauses/interventions; retained utility/topology still persists. */
    public void boundary(){pending.clear();for(Trace t:traces.values())t.eligibility=0;}
    public long observations(){return observations;}public long human(){return human;}public long automatic(){return automatic;}
    public long rng(){return rng;}public double baseline(){return baseline;}public long born(){return born;}public long pruned(){return pruned;}public long rejected(){return rejected;}
    public long baseUpdates(){return baseUpdates;}public int baseCandidates(){return basePaths.size();}public boolean trainsBase(){return trainBase;}
    public void restoreBaseUpdates(long value){if(value<0||value>9007199254740991L)throw new IllegalArgumentException("FDB base updates");baseUpdates=value;}
    public List<Trace> traces(){ArrayList<Trace> out=new ArrayList<>();for(Trace t:traces.values())out.add(t.copy());return out;}
    public long memoryBytes(){return 96L*traces.size()+64L*pending.size()*(maxEdges+MAX_BASE_EDGES+320)+96L*basePaths.size();}
    public void restore(long observations,long human,long automatic){
        if(observations<0||observations>9007199254740991L||human<0||automatic<0||human>observations||automatic!=observations-human)throw new IllegalArgumentException("FDB learning checkpoint");
        this.observations=observations;this.human=human;this.automatic=automatic;
    }
    public void restore(long observations,long human,long automatic,long rng,double baseline,long born,long pruned,long rejected,List<Trace> state){
        if(rng<1||rng>0xffffffffL||!Double.isFinite(baseline)||Math.abs(baseline)>20||born<0||pruned<0||rejected<0||state.size()>MAX_TRACES)throw new IllegalArgumentException("FDB trace checkpoint");
        LinkedHashMap<Long,Trace> validated=new LinkedHashMap<>();
        for(Trace t:state){
            if(t.source<0||t.source>=graph.ids.length||t.target<0||t.target>=graph.ids.length||t.source==t.target||!Double.isFinite(t.eligibility)||Math.abs(t.eligibility)>2||!Double.isFinite(t.utility)||Math.abs(t.utility)>4||!Double.isFinite(t.support)||Math.abs(t.support)>4||t.evidence<0||t.evidence>9007199254740991L||t.bad<0||t.bad>Integer.MAX_VALUE||validated.put(key(t.source,t.target),t.copy())!=null)throw new IllegalArgumentException("FDB trace state");
        }
        restore(observations,human,automatic);this.rng=rng;this.baseline=baseline;this.born=born;this.pruned=pruned;this.rejected=rejected;traces.clear();traces.putAll(validated);pending.clear();
    }
}
