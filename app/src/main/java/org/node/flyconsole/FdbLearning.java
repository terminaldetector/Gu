package org.node.flyconsole;

import java.util.*;

/** Existing FDB adapter: supervised seeds plus action-specific, window-rate reward traces.
 * It is a bounded surrogate rule, not millisecond STDP or an exact recurrent gradient. */
public final class FdbLearning {
    public static final int MAX_BASE_EDGES=512, EXPANDED_BASE_EDGES=2048, MAX_TRACES=8192;
    public static final String[] PLASTICITY_MODES={"base","root","dynamics","wexo","expanded"};
    public static String validateMode(String mode){if(!Arrays.asList(PLASTICITY_MODES).contains(mode))throw new IllegalArgumentException("Unknown plasticity mode");return mode;}
    public static final class NeuronTrace {
        public final int neuron;public double eligibility;
        public NeuronTrace(int neuron,double eligibility){this.neuron=neuron;this.eligibility=eligibility;}
    }
    public static final class Trace {
        public final int source,target;
        public double eligibility,slowEligibility,utility,support;
        public int slowAge;
        public long evidence;
        public int bad;
        public Trace(int source,int target){this.source=source;this.target=target;}
        public Trace copy(){Trace t=new Trace(source,target);t.eligibility=eligibility;t.slowEligibility=slowEligibility;t.slowAge=slowAge;t.utility=utility;t.support=support;t.evidence=evidence;t.bad=bad;return t;}
    }
    public static final class Decision {
        public final String id;public final int mask;public final double probability;
        private final LinkedHashMap<Long,Double> gradient;
        private final TreeMap<Integer,Double> neuronGradient=new TreeMap<>();
        private int[] lesions;private int steps;private final TreeMap<Integer,Double> rates=new TreeMap<>();
        private final Set<Integer> blockedDynamics=new HashSet<>();
        private final TreeMap<Integer,double[]> readoutGradient=new TreeMap<>();
        /** every candidate's score (neural + readout) and the action set, for inspection */
        public double[] scores;public int[] actions;
        /** the brain's own choice (no skill bias), the memory's proposal (-1: none), and whether the memory changed the choice */
        public int brainMask=-1,skillProposal=-1;public boolean skillDecided;
        private double[] pure,features,base;
        private Decision(String id,int mask,double probability,LinkedHashMap<Long,Double> gradient){this.id=id;this.mask=mask;this.probability=probability;this.gradient=gradient;}
    }
    private final Graph graph;private final GraphDelta layer;private final int[] sources,targets;
    private final double rate;private final float maxWeight;private final int maxEdges;
    private final boolean trainBase;
    private final String plasticityMode;
    // Independent research profile: the five plasticity modes and default v4 rule stay intact.
    private String creditProfile="single-v1";
    public static String validateCreditProfile(String profile){
        if(!Arrays.asList("single-v1","dual-v1","dual-rate-v1","dual-time-v1").contains(profile))throw new IllegalArgumentException("Unknown FDB credit profile");return profile;
    }
    public void creditProfile(String profile){profile=validateCreditProfile(profile);if(!profile.equals(creditProfile)){boundary();creditProfile=profile;}}
    public String creditProfile(){return creditProfile;}
    /** SENSOR PROFILE: the sha256 of the routing profile the ports run through
     *  (RoutingProfile) - "" for the 16 ports themselves. Part of the checkpoint
     *  identity: a checkpoint made through one profile is not restored through
     *  another, it starts a new layer. */
    private String sensorProfile="";
    public void sensorProfile(String sha){if(sha==null)sha="";if(!sha.isEmpty()&&!sha.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("FDB sensor profile");if(!sha.equals(sensorProfile)){boundary();sensorProfile=sha;}}
    public String sensorProfile(){return sensorProfile;}
    private boolean dualCredit(){return !creditProfile.equals("single-v1");}
    /** ACTION READOUT (opt-in research, "action-v1"). The neural score of an action
     * is the sum over its buttons of (rate/threshold - 1); "press nothing" has no
     * buttons, so it scores 0 and wins every frozen argmax while the outputs are
     * quiet. The readout gives EVERY action in the set, the empty one included, a
     * learned term w_a . phi(state), phi = the input activities and a bias, added
     * to its neural score. It is trained only by the verified feedback that
     * trains the weights, through eligibility traces that decay, carry, pause and
     * clear exactly like theirs; frozen evaluation changes nothing. "none" keeps
     * the decision rule exactly as before. */
    private String readoutProfile="none";
    private final TreeMap<Integer,double[]> readout=new TreeMap<>(),readoutTrace=new TreeMap<>();
    private long readoutUpdates;
    public static final int READOUT_LIMIT=64;private static final double READOUT_RATE=.1;
    /* "action-dn-v1": the readout also sees the OUTPUT neurons' activity - with the
       routing profile these are descending neurons, so what the brain is doing, not
       only what it was shown, decides the action's learned term */
    /* "action-pop-v1" (distillation research): the readout sees a POPULATION of the
       brain's own neurons - up to 4 095 chosen by the caller (in practice: the ones
       whose activity varies most along a verified route) - and is fitted to a
       verified route by fitImitation(); see there. */
    public static String validateReadoutProfile(String profile){if(!"none".equals(profile)&&!"action-v1".equals(profile)&&!"action-dn-v1".equals(profile)&&!"action-pop-v1".equals(profile))throw new IllegalArgumentException("Unknown FDB readout profile");return profile;}
    public void readoutProfile(String profile){profile=validateReadoutProfile(profile);if(!profile.equals(readoutProfile)){boundary();readoutProfile=profile;readout.clear();readoutTrace.clear();readoutUpdates=0;population=new int[0];imitationSet.clear();}}
    public String readoutProfile(){return readoutProfile;}
    private boolean readoutOn(){return readoutProfile.equals("action-v1")||readoutProfile.equals("action-dn-v1")||readoutPop();}
    private boolean readoutDn(){return readoutProfile.equals("action-dn-v1");}
    private boolean readoutPop(){return readoutProfile.equals("action-pop-v1");}
    public int readoutFeatures(){return readoutPop()?population.length+1:sources.length+(readoutDn()?targets.length:0)+1;}
    public static final int POPULATION_LIMIT=4095,IMITATION_LIMIT=20000;private static final double POP_SCORE_CLIP=32;
    private int[] population=new int[0];
    /** the readout's population (action-pop-v1): distinct neuron indices; setting it
     *  starts the readout from zero */
    public void readoutPopulation(int[] neurons){
        if(!readoutPop())throw new IllegalStateException("FDB population readout is off");
        if(neurons==null||neurons.length>POPULATION_LIMIT)throw new IllegalArgumentException("FDB population limit");
        HashSet<Integer> seen=new HashSet<>();for(int n:neurons)if(n<0||n>=graph.ids.length||!seen.add(n))throw new IllegalArgumentException("FDB population");
        boundary();population=neurons.clone();readout.clear();readoutTrace.clear();readoutUpdates=0;imitationSet.clear();
    }
    public int[] readoutPopulation(){return population.clone();}
    public TreeMap<Integer,double[]> readoutWeights(){TreeMap<Integer,double[]> c=new TreeMap<>();for(Map.Entry<Integer,double[]> e:readout.entrySet())c.put(e.getKey(),e.getValue().clone());return c;}
    public TreeMap<Integer,double[]> readoutTraces(){TreeMap<Integer,double[]> c=new TreeMap<>();for(Map.Entry<Integer,double[]> e:readoutTrace.entrySet())c.put(e.getKey(),e.getValue().clone());return c;}
    public long readoutUpdates(){return readoutUpdates;}
    public void restoreReadout(String profile,Map<Integer,double[]> weights,Map<Integer,double[]> traces,long updates){
        if(!validateReadoutProfile(profile).equals(readoutProfile))throw new IllegalArgumentException("FDB readout profile mismatch");
        if(weights.size()>READOUT_LIMIT||traces.size()>READOUT_LIMIT||updates<0)throw new IllegalArgumentException("FDB readout limit");
        for(Map<Integer,double[]> m:Arrays.asList(weights,traces))for(Map.Entry<Integer,double[]> e:m.entrySet()){
            if(e.getKey()<0||e.getKey()>4095||e.getValue().length!=readoutFeatures())throw new IllegalArgumentException("FDB readout shape");
            for(double v:e.getValue())if(!Double.isFinite(v)||Math.abs(v)>4)throw new IllegalArgumentException("FDB readout value");}
        readout.clear();readoutTrace.clear();for(Map.Entry<Integer,double[]> e:weights.entrySet())readout.put(e.getKey(),e.getValue().clone());
        for(Map.Entry<Integer,double[]> e:traces.entrySet())readoutTrace.put(e.getKey(),e.getValue().clone());readoutUpdates=updates;if(!traces.isEmpty())temporalDirty=true;
    }
    /** SKILL MEMORY (opt-in research, "skill-v1"; directive 2026-11-13, 5.4/6). FDB's
     *  episodic layer: for an AGOD state key (cell + dwell, computed by the caller
     *  from what AGOD sees) the action a VERIFIED route took there. It is filled
     *  only by demonstrate() from a route whose replay from a fresh load was checked,
     *  never by reward; at decision time it adds SKILL_BIAS to that action's score -
     *  the neural score and the readout are still computed for every action, and
     *  each decision reports whether the memory proposed the choice. Frozen
     *  decisions never change it. "none" leaves decisions exactly as before. */
    private String skillProfile="none";
    private final HashMap<String,Integer> skills=new HashMap<>();
    private long skillDemos;
    /* the bias is larger than any neural score sum (12 buttons x 4): where the memory
       holds a verified action it decides; everywhere else the brain does. A +6 bias
       was measured too weak on a real cartridge - the first decision left the route
       and no remembered state was met again (4 proposals in 750 decisions). */
    public static final int SKILL_LIMIT=65536;public static final double SKILL_BIAS=100;
    public static String validateSkillProfile(String p){if(!"none".equals(p)&&!"skill-v1".equals(p))throw new IllegalArgumentException("Unknown FDB skill profile");return p;}
    public void skillProfile(String p){p=validateSkillProfile(p);if(!p.equals(skillProfile)){skillProfile=p;skills.clear();skillDemos=0;}}
    public String skillProfile(){return skillProfile;}
    private boolean skillOn(){return skillProfile.equals("skill-v1");}
    public void demonstrate(String key,int mask){
        if(!skillOn())throw new IllegalStateException("FDB skill memory is off");
        if(key==null||key.isEmpty()||key.length()>512||mask<0||mask>4095||(mask&48)==48||(mask&192)==192)throw new IllegalArgumentException("FDB demonstration");
        if(!skills.containsKey(key)&&skills.size()>=SKILL_LIMIT)return;
        skills.put(key,mask);skillDemos++;
    }
    public int skillCount(){return skills.size();}
    public long skillDemos(){return skillDemos;}
    public TreeMap<String,Integer> skillMemory(){return new TreeMap<>(skills);}
    public void restoreSkills(String profile,Map<String,Integer> memory,long demos){
        if(!validateSkillProfile(profile).equals(skillProfile))throw new IllegalArgumentException("FDB skill profile mismatch");
        if(memory.size()>SKILL_LIMIT||demos<0)throw new IllegalArgumentException("FDB skill limit");
        skills.clear();for(Map.Entry<String,Integer> e:memory.entrySet()){int m=e.getValue();if(e.getKey().isEmpty()||e.getKey().length()>512||m<0||m>4095)throw new IllegalArgumentException("FDB skill entry");skills.put(e.getKey(),m);}
        skillDemos=demos;
    }
    private double[] phi(Engine.Result result){double[] f=new double[readoutFeatures()];
        if(readoutPop()){for(int i=0;i<population.length;i++)f[i]=activity(result,population[i]);f[f.length-1]=1;return f;}
        for(int i=0;i<sources.length;i++)f[i]=activity(result,sources[i]);
        if(readoutDn())for(int j=0;j<targets.length;j++)f[sources.length+j]=activity(result,targets[j]);f[f.length-1]=1;return f;}
    /** IMITATION (distillation of a VERIFIED route): move the readout towards the
     *  route's action for the decision just made - the softmax cross-entropy step
     *  w_a += rate * (1[a=route] - p_a) * phi over the decision's own action set. Only
     *  for a decision taken in training on the replayed route; no reward, no
     *  baseline, no weight of W0 or of the plastic layer is touched. */
    private long imitations;public long imitations(){return imitations;}
    private static final double IMITATE_RATE=.2;
    public boolean imitate(String id,int demoMask){
        if(!readoutOn())throw new IllegalStateException("FDB readout is off");
        Decision d=pending.remove(id);if(d==null||d.features==null||d.pure==null)return false;
        int demo=-1;for(int a=0;a<d.actions.length;a++)if(d.actions[a]==demoMask)demo=a;if(demo<0)return false;
        /* the population readout keeps the demonstration for fitImitation() instead of one step */
        if(readoutPop()){if(imitationSet.size()>=IMITATION_LIMIT)return false;float[] f=new float[d.features.length];for(int k=0;k<f.length;k++)f[k]=(float)d.features[k];
            imitationSet.add(new Demo(f,d.actions.clone(),d.base.clone(),demo));imitations++;return true;}
        for(int a=0;a<d.actions.length;a++){if(!Double.isFinite(d.scores[a]))continue;double g=(a==demo?1:0)-d.pure[a];if(g==0)continue;
            double[] w=readout.get(d.actions[a]);if(w==null){if(readout.size()>=READOUT_LIMIT)continue;w=new double[d.features.length];readout.put(d.actions[a],w);}
            for(int k=0;k<w.length;k++)w[k]=Math.max(-4,Math.min(4,w[k]+IMITATE_RATE*g*d.features[k]));}
        imitations++;readoutUpdates++;return true;
    }
    private double readoutScore(int mask,double[] f){double[] w=readout.get(mask);if(w==null)return 0;double s=0;for(int k=0;k<f.length;k++)s+=w[k]*f[k];double c=readoutPop()?POP_SCORE_CLIP:4;return Math.max(-c,Math.min(c,s));}
    /** FITTING A VERIFIED ROUTE (action-pop-v1). The demonstrations are what the brain's
     *  population did at each step of a route replayed from a fresh load, and the
     *  route's action there. The readout is fitted to them - a multi-class margin
     *  perceptron: where the route's action does not beat every other action by the
     *  margin (neural score + readout), it moves towards that action and away from the
     *  strongest rival - until every demonstration is met or the epochs run out. Only
     *  the readout changes: W0, the plastic layer and the traces do not. Returns
     *  {demonstrations met (fraction), epochs run, updates}. */
    private static final class Demo{final float[] f;final int[] actions;final double[] base;final int demo;Demo(float[] f,int[] a,double[] b,int d){this.f=f;actions=a;base=b;demo=d;}}
    private final ArrayList<Demo> imitationSet=new ArrayList<>();
    public int imitationSetSize(){return imitationSet.size();}
    public double[] fitImitation(int epochs,double margin,double rate){
        if(!readoutPop())throw new IllegalStateException("FDB population readout is off");
        if(epochs<1||epochs>10000||!(margin>=0&&margin<=16)||!(rate>0&&rate<=1))throw new IllegalArgumentException("FDB fit");
        int run=0;long updates=0;
        for(;run<epochs;run++){int errors=0;
            for(Demo x:imitationSet){double[] total=total(x);int rival=-1;
                for(int a=0;a<x.actions.length;a++)if(a!=x.demo&&Double.isFinite(total[a])&&(rival<0||total[a]>total[rival]))rival=a;
                if(rival<0||total[x.demo]-total[rival]>=margin)continue;errors++;updates++;
                step(x.actions[x.demo],x.f,rate);step(x.actions[rival],x.f,-rate);}
            if(errors==0){run++;break;}}
        int met=0;for(Demo x:imitationSet){double[] total=total(x);int best=-1;for(int a=0;a<total.length;a++)if(Double.isFinite(total[a])&&(best<0||total[a]>total[best]))best=a;if(best==x.demo)met++;}
        readoutUpdates+=updates;
        return new double[]{imitationSet.isEmpty()?0:met/(double)imitationSet.size(),run,updates};
    }
    private double[] total(Demo x){double[] t=new double[x.actions.length];double[] f=new double[x.f.length];for(int k=0;k<f.length;k++)f[k]=x.f[k];
        for(int a=0;a<t.length;a++)t[a]=Double.isFinite(x.base[a])?x.base[a]+readoutScore(x.actions[a],f):Double.NEGATIVE_INFINITY;return t;}
    private void step(int mask,float[] f,double rate){double[] w=readout.get(mask);if(w==null){if(readout.size()>=READOUT_LIMIT)return;w=new double[f.length];readout.put(mask,w);}
        for(int k=0;k<w.length;k++)w[k]=Math.max(-4,Math.min(4,w[k]+rate*f[k]));}
    private double eligibility(Trace t){return dualCredit()?.5*t.eligibility+.5*t.slowEligibility:t.eligibility;}
    private static int[] lesionSet(int[] lesions){int[] out=lesions==null?new int[0]:lesions.clone();Arrays.sort(out);return out;}
    private final TreeMap<Integer,Double> previousRates=new TreeMap<>();
    private int previousMask=-1,previousSteps;private boolean temporalDirty;
    public Map<Integer,Double> previousRates(){return new TreeMap<>(previousRates);}
    public int previousMask(){return previousMask;}public int previousSteps(){return previousSteps;}
    public void restoreRates(Map<Integer,Double> rates,int mask,int steps){previousRates.clear();previousRates.putAll(rates);previousMask=mask;previousSteps=steps;temporalDirty|=!rates.isEmpty();}
    private void clearTemporal(){previousRates.clear();previousMask=-1;previousSteps=0;if(temporalDirty)for(Trace t:traces.values()){t.eligibility=0;t.slowEligibility=0;t.slowAge=0;}neuronTraces.clear();readoutTrace.clear();temporalDirty=false;}

    private final int baseLimit;
    private final TreeSet<Integer> neuronCandidates=new TreeSet<>();
    private final TreeMap<Integer,Double> neuronTraces=new TreeMap<>();
    private long neuronUpdates,budgetClips;
    private double lastBudget;
    private ArrayList<Change> changes;
    private static final class Change {final int kind,s,t;final float old,next;final double unit;Change(int k,int s,int t,float old,float next,double unit){kind=k;this.s=s;this.t=t;this.old=old;this.next=next;this.unit=unit;}}
    public static final double DECISION_BUDGET=1;
    private void beginBudget(){lastBudget=0;changes=plasticityMode.equals("base")?null:new ArrayList<>();}
    private boolean change(int kind,int s,int t,float old,float next,double unit){
        if(old==next&&kind!=3)return false;if(changes!=null){changes.add(new Change(kind,s,t,old,next,unit));return true;}
        applyChange(new Change(kind,s,t,old,next,unit),1);return true;
    }
    private void applyChange(Change c,double scale){
        float next=(float)(c.old+(c.next-c.old)*scale);
        if(c.kind==0)layer.addWeightDelta(c.s,c.t,next-c.old);
        else if(c.kind==1)layer.setGrowthWeight(c.s,c.t,next);
        else if(c.kind==2){layer.addEdge(c.s,c.t,next);born++;}
        else if(c.kind==3){if(scale==1){layer.removeEdge(c.s,c.t);pruned++;}}
        else {layer.setThresholdOffset(c.s,next);neuronUpdates++;}
    }
    private void finishBudget(){
        if(changes==null)return;double sum=0;for(Change c:changes)sum+=Math.abs((double)c.next-c.old)/c.unit;
        double scale=sum>DECISION_BUDGET?DECISION_BUDGET/sum:1;if(scale<1)budgetClips++;
        for(Change c:changes){if(c.kind==3&&scale<1)continue;applyChange(c,scale);lastBudget+=Math.abs((double)(float)(c.old+(c.next-c.old)*scale)-c.old)/c.unit;}
        changes=null;
    }
    private final LinkedHashMap<Long,GraphDelta.Edge> basePaths=new LinkedHashMap<>();
    private final int[] growthTargets;
    private final String projectionSha;
    private final LinkedHashMap<Long,Trace> traces=new LinkedHashMap<>();
    private final LinkedHashMap<String,Decision> pending=new LinkedHashMap<>();
    private long observations,human,automatic,rng=1,born,pruned,rejected,baseUpdates,carried,paused;
    private double baseline;
    public static final class Outcome {
        public final String id;public final int mask,changed;public final boolean accepted;public final double reward,advantage,budget;public final long births,removals;
        Outcome(String id,int mask,int changed,boolean accepted,double reward,double advantage,double budget,long births,long removals){this.id=id;this.mask=mask;this.changed=changed;this.accepted=accepted;this.reward=reward;this.advantage=advantage;this.budget=budget;this.births=births;this.removals=removals;}
    }
    private final ArrayDeque<Outcome> recent=new ArrayDeque<>();
    public List<Outcome> recentOutcomes(){return new ArrayList<>(recent);}
    private void event(Outcome event){if(recent.size()==100)recent.removeFirst();recent.addLast(event);}

    private static long key(int source,int target){return ((long)source<<32)|(target&0xffffffffL);}
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight){
        this(graph,layer,sources,targets,rate,maxEdges,maxWeight,true);
    }
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight,boolean trainBase){
        this(graph,layer,sources,targets,rate,maxEdges,maxWeight,trainBase,"base");
    }
    public FdbLearning(Graph graph,GraphDelta layer,int[] sources,int[] targets,double rate,int maxEdges,float maxWeight,boolean trainBase,String mode){
        plasticityMode=validateMode(mode);baseLimit=(mode.equals("root")||mode.equals("expanded"))?EXPANDED_BASE_EDGES:MAX_BASE_EDGES;
        if(sources.length!=16||targets.length<1||targets.length>12||!Double.isFinite(rate)||rate<.001||rate>.2||maxEdges<1||maxEdges>((mode.equals("wexo")||mode.equals("expanded"))?2048:1024)||!Float.isFinite(maxWeight)||maxWeight<=0||maxWeight>127)throw new IllegalArgumentException("FDB learning parameters");
        this.graph=graph;this.layer=layer;this.sources=sources.clone();this.targets=targets.clone();this.rate=rate;this.maxEdges=Math.min(maxEdges,layer.capacity());this.maxWeight=maxWeight;this.trainBase=trainBase;
        for(int i:sources)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning source");
        for(int i:targets)if(i<0||i>=graph.ids.length)throw new IllegalArgumentException("FDB learning target");
        Set<Integer> unique=new HashSet<>();for(int i:sources)if(!unique.add(i))throw new IllegalArgumentException("Duplicate FDB source");for(int i:targets)if(!unique.add(i))throw new IllegalArgumentException("Overlapping FDB ports");
        basePaths.putAll(buildBasePaths(false));
        projectionSha=projectionFingerprint(basePaths);
        if(mode.equals("dynamics")||mode.equals("expanded")){
            for(int t:targets)neuronCandidates.add(t);
            for(GraphDelta.Edge e:basePaths.values())if(neuronCandidates.size()<256&&index(sources,e.source)<0)neuronCandidates.add(e.source);
        }
        ArrayList<Integer> ports=new ArrayList<>();for(int t:targets)ports.add(t);
        int growthPortLimit=mode.equals("wexo")||mode.equals("expanded")?128:targets.length+8;
        for(GraphDelta.Edge edge:basePaths.values())if(ports.size()<growthPortLimit&&!unique.contains(edge.source)&&!ports.contains(edge.source))ports.add(edge.source);
        growthTargets=new int[ports.size()];for(int i=0;i<ports.size();i++)growthTargets[i]=ports.get(i);
    }
    /** A deterministic bounded projection of real W0 predecessors. Three CSR scans
     * only at configuration, no full reverse graph or per-frame 25M-edge scan.
     * The projection depends only on W0 and ports, so reload cannot change it. */
    // Values contain only immutable index/weight records, never Graph or learner state.
    // Weak graph ownership prevents retaining an unloaded biological model.
    private static final Map<Graph,LinkedHashMap<String,LinkedHashMap<Long,GraphDelta.Edge>>> projectionCache=new WeakHashMap<>();
    private LinkedHashMap<Long,GraphDelta.Edge> buildBasePaths(boolean legacy){
        String key=baseLimit+":"+legacy+":"+Arrays.toString(targets);
        synchronized(projectionCache){
            LinkedHashMap<String,LinkedHashMap<Long,GraphDelta.Edge>> entries=projectionCache.get(graph);
            if(entries==null){entries=new LinkedHashMap<>(8,.75f,true);projectionCache.put(graph,entries);}
            LinkedHashMap<Long,GraphDelta.Edge> cached=entries.get(key);
            if(cached==null){
                cached=computeBasePaths(legacy);entries.put(key,cached);
                if(entries.size()>8)entries.remove(entries.keySet().iterator().next());
            }
            // Each learner owns its map; ΔW, traces, thresholds and RNG are never cached.
            return new LinkedHashMap<>(cached);
        }
    }
    private LinkedHashMap<Long,GraphDelta.Edge> computeBasePaths(boolean legacy){
        LinkedHashMap<Long,GraphDelta.Edge> basePaths=new LinkedHashMap<>();
        TreeSet<Integer> frontier=new TreeSet<>(),visited=new TreeSet<>();for(int t:targets)frontier.add(t);
        final Comparator<GraphDelta.Edge> order=(a,b)->{int c=Float.compare(Math.abs(b.weight),Math.abs(a.weight));return c!=0?c:Integer.compare(a.source,b.source);};
        for(int hop=0;hop<3&&!frontier.isEmpty()&&basePaths.size()<baseLimit;hop++){
            boolean[] wanted=new boolean[graph.ids.length];TreeMap<Integer,ArrayList<GraphDelta.Edge>> incoming=new TreeMap<>();
            for(int t:frontier){wanted[t]=true;incoming.put(t,new ArrayList<>());}visited.addAll(frontier);
            for(int s=0;s<graph.ids.length;s++)for(int e=graph.offsets[s];e<graph.offsets[s+1];e++){
                int t=graph.targets[e];if(!wanted[t]||s==t||graph.weights[e]==0)continue;
                ArrayList<GraphDelta.Edge> list=incoming.get(t);GraphDelta.Edge edge=new GraphDelta.Edge(s,t,graph.weights[e]);
                int at=Collections.binarySearch(list,edge,order);if(at<0)at=-at-1;
                if(at<(baseLimit==512?8:16)){list.add(at,edge);if(list.size()>(baseLimit==512?8:16))list.remove(legacy?8:(baseLimit==512?8:16));}
            }
            TreeSet<Integer> next=new TreeSet<>();int limit=baseLimit==512?(hop==0?128:hop==1?320:512):(hop==0?256:hop==1?1024:2048);
            // Round robin over targets prevents the first output monopolising the cap.
            for(int rank=0;rank<(baseLimit==512?8:16)&&basePaths.size()<limit;rank++)for(ArrayList<GraphDelta.Edge> list:incoming.values())if(rank<list.size()&&basePaths.size()<limit){
                GraphDelta.Edge e=list.get(rank);basePaths.put(key(e.source,e.target),e);if(!visited.contains(e.source))next.add(e.source);
            }
            frontier=next;
        }
        return basePaths;
    }
    String legacyBaseProjectionSha(){return projectionFingerprint(buildBasePaths(true));}
    private String projectionFingerprint(Map<Long,GraphDelta.Edge> paths){try{
        java.security.MessageDigest md=java.security.MessageDigest.getInstance("SHA-256");
        for(GraphDelta.Edge e:paths.values())md.update((graph.ids[e.source]+":"+graph.ids[e.target]+":"+Float.floatToIntBits(e.weight)+";").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder out=new StringBuilder();for(byte b:md.digest())out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();
    }catch(java.security.NoSuchAlgorithmException e){throw new AssertionError(e);}}
    public String baseProjectionSha(){return projectionSha;}
    private Trace trace(int source,int target){long k=key(source,target);Trace t=traces.get(k);if(t==null){if(traces.size()>=(plasticityMode.equals("base")?2048:MAX_TRACES))return null;t=new Trace(source,target);traces.put(k,t);}return t;}
    private static boolean lesioned(int i,int[] lesions){if(lesions!=null)for(int x:lesions)if(x==i)return true;return false;}
    private boolean baseEdge(int source,int target){for(int e=graph.offsets[source];e<graph.offsets[source+1];e++)if(graph.targets[e]==target)return true;return false;}
    private double random(){long x=rng;x^=(x<<13)&0xffffffffL;x^=x>>>17;x^=(x<<5)&0xffffffffL;rng=x&0xffffffffL;return rng/4294967296.0;}
    public void seed(long seed){rng=(seed&0xffffffffL)==0?1:seed&0xffffffffL;}
    public Decision decide(String id,Engine.Result result,int[] actions,int allowed,double threshold,double epsilon,boolean training,int[] lesions){
        return decide(id,result,actions,allowed,threshold,epsilon,training,lesions,Double.NaN);
    }
    /** frozenSample in [0,1): a FROZEN decision sampled from the policy with a
     * draw supplied by the caller (an evaluation harness's own seeded stream).
     * Nothing in the learner moves: no RNG step, no pending decision, so a
     * sampled evaluation is as frozen as the argmax one. Ignored when training. */
    public Decision decide(String id,Engine.Result result,int[] actions,int allowed,double threshold,double epsilon,boolean training,int[] lesions,double frozenSample){
        return decide(id,result,actions,allowed,threshold,epsilon,training,lesions,frozenSample,null);
    }
    public Decision decide(String id,Engine.Result result,int[] actions,int allowed,double threshold,double epsilon,boolean training,int[] lesions,double frozenSample,String skillKey){
        if(!training&&!Double.isNaN(frozenSample)&&!(frozenSample>=0&&frozenSample<1))throw new IllegalArgumentException("FDB frozen sample");
        if(id==null||id.length()>80||result.counts.length!=graph.ids.length||result.steps<=0||!Double.isFinite(threshold)||threshold<=0||!Double.isFinite(epsilon)||epsilon<0||epsilon>1||actions.length<2||actions.length>64)throw new IllegalArgumentException("FDB decision");
        double[] logits=new double[actions.length],prob=new double[actions.length];int eligible=0,best=-1;double maximum=-Double.MAX_VALUE;
        double[] readoutFeatures=null,neural=new double[actions.length],base=new double[actions.length];
        Integer remembered=skillOn()&&skillKey!=null?skills.get(skillKey):null;int skillProposal=remembered==null?-1:remembered;
        for(int a=0;a<actions.length;a++){neural[a]=Double.NEGATIVE_INFINITY;base[a]=Double.NEGATIVE_INFINITY;}
        Set<Integer> unique=new HashSet<>();
        for(int a=0;a<actions.length;a++){
            int mask=actions[a];if(mask<0||mask>4095||(mask&48)==48||(mask&192)==192||!unique.add(mask))throw new IllegalArgumentException("FDB action set");
            if((mask&~allowed)!=0||mask>=(1<<targets.length)){logits[a]=Double.NEGATIVE_INFINITY;continue;}
            eligible++;double score=0;
            for(int j=0;j<targets.length;j++)if((mask&(1<<j))!=0){double hz=lesioned(targets[j],lesions)?0:result.counts[targets[j]]*10000.0/result.steps;score+=Math.max(-2,Math.min(4,hz/threshold-1));}
            base[a]=score;
            if(readoutOn())score+=readoutScore(mask,readoutFeatures==null?(readoutFeatures=phi(result)):readoutFeatures);
            neural[a]=score;
            if(skillProposal>=0&&mask==skillProposal)score+=SKILL_BIAS;
            logits[a]=score;if(score>maximum){maximum=score;best=a;}
        }
        if(best<0)throw new IllegalArgumentException("FDB has no allowed actions");
        double sum=0;for(int a=0;a<actions.length;a++){prob[a]=Math.exp(logits[a]-maximum);sum+=prob[a];}
        for(int a=0;a<actions.length;a++)prob[a]=prob[a]/sum*(1-epsilon)+(Double.isFinite(logits[a])?epsilon/eligible:0);
        int chosen=best;
        if(training){double sample=random(),acc=0;for(int a=0;a<prob.length;a++){acc+=prob[a];if(sample<acc){chosen=a;break;}}}
        else if(!Double.isNaN(frozenSample)){double acc=0;for(int a=0;a<prob.length;a++){acc+=prob[a];if(frozenSample<acc){chosen=a;break;}}}
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
        // Exact zeros are not evidence and must not exhaust the bounded trace table.
        if(dualCredit())gradient.entrySet().removeIf(e->e.getValue()==0);
        Decision d=new Decision(id,actions[chosen],prob[chosen],gradient);d.lesions=lesionSet(lesions);d.steps=result.steps;
        d.scores=logits.clone();d.actions=actions.clone();
        if(readoutOn()&&training){d.features=readoutFeatures;d.base=base;d.pure=new double[actions.length];for(int a=0;a<actions.length;a++)d.pure[a]=Double.isFinite(logits[a])?Math.exp(logits[a]-maximum)/sum:0;}
        /* what the brain alone (neural score + readout) would have picked, and whether the memory proposed the choice */
        int brainBest=-1;for(int a=0;a<actions.length;a++)if(Double.isFinite(neural[a])&&(brainBest<0||neural[a]>neural[brainBest]))brainBest=a;
        d.brainMask=brainBest>=0?actions[brainBest]:-1;d.skillProposal=skillProposal;d.skillDecided=skillProposal>=0&&actions[chosen]==skillProposal&&d.brainMask!=skillProposal;
        if(readoutOn()&&training){
            double share=prob[chosen]>0?(1-epsilon)*Math.exp(logits[chosen]-maximum)/sum/prob[chosen]:1;
            for(int a=0;a<actions.length;a++)if(Double.isFinite(logits[a])){
                double g=share*((a==chosen?1:0)-Math.exp(logits[a]-maximum)/sum);if(g==0)continue;
                double[] v=new double[readoutFeatures.length];for(int k=0;k<v.length;k++)v[k]=g*readoutFeatures[k];d.readoutGradient.put(actions[a],v);}
        }
        for(int neuron:neuronCandidates)if(!lesioned(neuron,lesions)){
            double hz=result.counts[neuron]*10000.0/result.steps;
            if(hz>250)d.blockedDynamics.add(neuron);d.rates.put(neuron,hz);
            d.neuronGradient.put(neuron,hz>250?0:-activity(result,neuron)*feedback.getOrDefault(neuron,0.0));
        }
        if(training){if(pending.containsKey(id))throw new IllegalArgumentException("Duplicate FDB decision");pending.put(id,d);while(pending.size()>4)pending.remove(pending.keySet().iterator().next());}
        return d;
    }
    private static double activity(Engine.Result r,int neuron){return Math.min(1,r.counts[neuron]*10.0/r.steps);}
    private static int index(int[] values,int value){for(int i=0;i<values.length;i++)if(values[i]==value)return i;return -1;}
    /** TYPED CREDIT (directive 2026-11-13, 5.2). VERIFIED - a verified event (AGOD
     *  broker) or an explicitly configured source - trains the weights and the
     *  action readout. PROVISIONAL - a progress gain AGOD could not verify - does
     *  NOT train FDB: it is AGOD's signal for which frontier to explore; here the
     *  decision only joins the eligibility traces, unpaid (as UNKNOWN does), and is
     *  counted apart. No other tier exists. */
    public static final String VERIFIED="VERIFIED",PROVISIONAL="PROVISIONAL";
    private long provisionalSeen,verifiedPaid;
    public long provisionalSeen(){return provisionalSeen;}
    public long verifiedPaid(){return verifiedPaid;}
    public int feedback(String id,int executedMask,double reward,double gameSeconds,int frames,boolean valid,boolean frozen,int[] lesions,String tier){
        if(PROVISIONAL.equals(tier)){
            if(!Double.isFinite(reward)||Math.abs(reward)>20||!Double.isFinite(gameSeconds)||gameSeconds<=0||gameSeconds>2||frames<1||frames>240)throw new IllegalArgumentException("FDB feedback");
            if(frozen)return 0;
            if(carry(id,executedMask,gameSeconds,frames,valid,true,lesions)){carried--;provisionalSeen++;}
            return 0;
        }
        if(!VERIFIED.equals(tier))throw new IllegalArgumentException("FDB credit tier");
        int changed=feedback(id,executedMask,reward,gameSeconds,frames,valid,frozen,lesions);
        if(!frozen)verifiedPaid++;
        return changed;
    }
    /** Reward applies to the cached decision's activity, only after real game execution. */
    public int feedback(String id,int executedMask,double reward,double gameSeconds,int frames,boolean valid,boolean frozen,int[] lesions){
        if(!Double.isFinite(reward)||Math.abs(reward)>20||!Double.isFinite(gameSeconds)||gameSeconds<=0||gameSeconds>2||frames<1||frames>240)throw new IllegalArgumentException("FDB feedback");
        if(frozen)return 0;
        Decision d=pending.remove(id);
        // The worker may already have cached the next decision. Reject this interval,
        // not those later decisions; otherwise one intervention poisons every future step.
        if(!valid||d==null||d.mask!=executedMask||!Arrays.equals(d.lesions,lesionSet(lesions))){rejected++;clearTemporal();event(new Outcome(id,executedMask,0,false,reward,0,0,0,0));return 0;}
        long birthsBefore=born,removalsBefore=pruned,revisionBefore=layer.version();temporalDirty=true;beginBudget();
        double decay=accumulate(d,gameSeconds,lesions);
        double advantage=Math.max(-2,Math.min(2,reward-baseline));baseline+=.05*(reward-baseline);int changed=0,removed=0,created=0;
        for(Trace t:traces.values()){
            if(lesioned(t.source,lesions)||lesioned(t.target,lesions)||Math.abs(eligibility(t))<1e-6)continue;
            double credit=advantage*eligibility(t);GraphDelta.Edge base=basePaths.get(key(t.source,t.target));
            if(base!=null){if(trainBase&&adaptBase(base,credit))changed++;continue;}
            double oldWeight=weight(t.source,t.target),utilityCredit=oldWeight<0?-credit:credit;
            if(Math.abs(credit)>1e-6)t.evidence++;t.utility=.9*t.utility+.1*utilityCredit;t.support=Math.max(-4,Math.min(4,t.support+credit));
            if(utilityCredit<-.0001)t.bad=t.bad==Integer.MAX_VALUE?t.bad:t.bad+1;else if(utilityCredit>.0001)t.bad=0;
            if(layer.hasEdge(t.source,t.target)){
                float old=weight(t.source,t.target);
                double step=rate*maxWeight*credit/(1+2*Math.max(0,t.utility));
                if(old*step>0)step*=Math.max(.05,1-Math.abs(old)/maxWeight);
                float next=(float)(old>=0?Math.max(0,Math.min(maxWeight,old+step)):Math.max(-maxWeight,Math.min(-.000001,old+step)));
                if(removed<1&&t.evidence>=12&&t.bad>=6&&Math.abs(next)<.5&&t.utility<-.001){change(3,t.source,t.target,old,0,maxWeight);removed++;changed++;t.eligibility=0;t.slowEligibility=0;t.slowAge=0;t.support=0;}
                else if(Math.abs(next-old)>.0001f&&change(1,t.source,t.target,old,next,maxWeight))changed++;
            }else if(created<2&&t.evidence>=3&&Math.abs(t.support)>=.25&&credit*t.support>0&&layer.growthCount()+(changes==null?0:created)<maxEdges&&!baseEdge(t.source,t.target)){
                change(2,t.source,t.target,0,(float)Math.copySign(Math.min(maxWeight,Math.max(.5,rate*maxWeight*Math.abs(t.support))),t.support),maxWeight);changed++;created++;t.support=0;
            }
        }
        if(readoutOn()&&!readoutTrace.isEmpty()){
            for(Map.Entry<Integer,double[]> e:readoutTrace.entrySet()){
                double[] w=readout.get(e.getKey());
                if(w==null){if(readout.size()>=READOUT_LIMIT)continue;w=new double[e.getValue().length];readout.put(e.getKey(),w);}
                for(int k=0;k<w.length;k++)w[k]=Math.max(-4,Math.min(4,w[k]+READOUT_RATE*advantage*e.getValue()[k]));
            }
            readoutUpdates++;
        }
        for(int neuron:neuronCandidates)if(!lesioned(neuron,lesions)){
            float old=layer.thresholdOffset(neuron),next=(float)Math.max(-5,Math.min(5,old+rate*.25*5*advantage*neuronTraces.getOrDefault(neuron,0.0)));
            if(Math.abs(next-old)>.000001&&change(4,neuron,neuron,old,next,5))changed++;
        }
        finishBudget();observations++;automatic++;event(new Outcome(id,executedMask,(int)(layer.version()-revisionBefore),true,reward,advantage,lastBudget,born-birthsBefore,pruned-removalsBefore));return changed;
    }
    private float weight(int source,int target){for(GraphDelta.Edge e:layer.outgoing(source))if(e.target==target)return e.weight;return 0;}
    /** Decay the traces over the interval and fold this decision's credit into them. */
    /** dual-time-v1: two traces by GAME TIME, not by decision count - fast
     * tau 15 frames (a hit, a shot at point blank), slow tau 90 frames (the
     * run-up and the jump that put the player under the bullet). dual-v1's slow
     * trace ages per decision, so its reach depends on how often the agent decides. */
    private static final double FAST_TAU_SECONDS=15/60.0,SLOW_TAU_SECONDS=90/60.0;
    private boolean timeCredit(){return creditProfile.equals("dual-time-v1");}
    private double decayTraces(double gameSeconds){
        double decay=Math.exp(-gameSeconds/(timeCredit()?FAST_TAU_SECONDS:.6));
        for(Trace t:traces.values()){t.eligibility*=decay;t.support*=Math.exp(-gameSeconds/2);
            if(timeCredit()){t.slowAge=0;t.slowEligibility*=Math.exp(-gameSeconds/SLOW_TAU_SECONDS);}
            else if(dualCredit()){t.slowAge=Math.min(16,t.slowAge+1);t.slowEligibility=t.slowAge>=16?0:t.slowEligibility*Math.exp(-1.0/8);}
        }
        for(double[] v:readoutTrace.values())for(int k=0;k<v.length;k++)v[k]*=decay;
        return decay;
    }
    private double accumulate(Decision d,double gameSeconds,int[] lesions){
        double decay=decayTraces(gameSeconds);
        for(Map.Entry<Long,Double> e:d.gradient.entrySet()){
            int source=(int)(e.getKey()>>32),target=(int)(long)e.getKey();if(lesioned(source,lesions)||lesioned(target,lesions))continue;
            Trace t=trace(source,target);if(t!=null){t.eligibility=Math.max(-2,Math.min(2,t.eligibility+e.getValue()*decay));
                if(dualCredit()){t.slowEligibility=Math.max(-2,Math.min(2,t.slowEligibility+e.getValue()));t.slowAge=0;}
            }
        }
        for(Map.Entry<Integer,double[]> e:d.readoutGradient.entrySet()){
            double[] v=readoutTrace.get(e.getKey());
            if(v==null){if(readoutTrace.size()>=READOUT_LIMIT)continue;v=new double[e.getValue().length];readoutTrace.put(e.getKey(),v);}
            for(int k=0;k<v.length;k++)v[k]=Math.max(-2,Math.min(2,v[k]+e.getValue()[k]*decay));
        }
        for(int neuron:neuronCandidates){
            double gradient=d.neuronGradient.getOrDefault(neuron,0.0);
            if(creditProfile.equals("dual-rate-v1")){
                // Consecutive confirmed observation windows with the same action semantics.
                // This is a clipped rate-change proxy, not a causal threshold derivative.
                Double previous=previousRates.get(neuron);
                gradient*=previous!=null&&previousMask==d.mask&&previousSteps==d.steps
                    ?Math.max(-1,Math.min(1,(d.rates.getOrDefault(neuron,0.0)-previous)/250.0)):0;
            }
            neuronTraces.put(neuron,d.blockedDynamics.contains(neuron)?0:Math.max(-2,Math.min(2,neuronTraces.getOrDefault(neuron,0.0)*decay+gradient*decay)));
        }
        if(creditProfile.equals("dual-rate-v1")){previousRates.clear();previousRates.putAll(d.rates);previousMask=d.mask;previousSteps=d.steps;}
        return decay;
    }
    /** An interval with NO verified outcome: the decision joins the eligibility traces
     * and nothing else happens - no reward, no baseline change, no weight or threshold
     * update, no replay record. UNKNOWN stays non-numeric, but a later verified event
     * can reach the decisions that led to it instead of only the last 8 frames.
     * An invalid interval (human input, mask mismatch) still breaks the link. */
    public boolean carry(String id,int executedMask,double gameSeconds,int frames,boolean valid,int[] lesions){
        return carry(id,executedMask,gameSeconds,frames,valid,true,lesions);
    }
    /** accumulate=false PAUSES the traces for an interval in which the player had
     * no control (death animation, respawn, invulnerability, a scene change):
     * time passes and the traces decay, but the decision is not added - its
     * outputs drove nothing - and the traces are not cleared either, so the
     * moves before the loss of control keep their credit for what follows. */
    public boolean carry(String id,int executedMask,double gameSeconds,int frames,boolean valid,boolean accumulate,int[] lesions){
        if(!Double.isFinite(gameSeconds)||gameSeconds<=0||gameSeconds>2||frames<1||frames>240)throw new IllegalArgumentException("FDB carry");
        Decision d=pending.remove(id);
        if(!valid||d==null||d.mask!=executedMask||!Arrays.equals(d.lesions,lesionSet(lesions))){rejected++;clearTemporal();return false;}
        temporalDirty=true;
        if(accumulate){accumulate(d,gameSeconds,lesions);carried++;}
        else{decayTraces(gameSeconds);paused++;}
        return true;
    }
    public long paused(){return paused;}
    /** decisions awaiting their outcome - an evaluation must never add one */
    public int pendingCount(){return pending.size();}
    public long carried(){return carried;}
    /** Slow trust-region updates of effective root weights; W0 and its sign stay intact.
     * Explicit user deltas outside this region are retained, not silently clamped. */
    private boolean adaptBase(GraphDelta.Edge base,double credit){
        double limit=Math.min(127,Math.abs(base.weight)*.5),old=layer.weightDelta(base.source,base.target);
        if(limit==0||Math.abs(old)>limit||Math.abs(credit)<1e-6||old==0&&layer.deltaCount()+(changes==null?0:(int)changes.stream().filter(c->c.kind==0&&c.old==0).count())>=Math.min(layer.capacity(),baseLimit==512?1024:2048))return false;
        float next=(float)Math.max(-limit,Math.min(limit,old+rate*.1*Math.abs(base.weight)*credit));
        if(Math.abs(next-old)<.000001)return false;
        change(0,base.source,base.target,(float)old,next,Math.max(1,Math.abs(base.weight)));baseUpdates++;return true;
    }
    /** Human consolidation remains labelled and independent of global game rewards. */
    public int observe(double[] retina,int mask,double reward,boolean demonstration,int[] lesions,boolean frozen){
        if(retina.length!=16||mask<0||mask>=(1<<targets.length)||(mask&48)==48||(mask&192)==192||!Double.isFinite(reward)||Math.abs(reward)>20)throw new IllegalArgumentException("FDB labelled experience");
        for(double v:retina)if(!Double.isFinite(v)||v<0||v>1)throw new IllegalArgumentException("FDB experience retina");
        // Old reward+retina packets cannot establish neural action causality.
        if(frozen||!demonstration)return 0;boundary();int changed=0,removed=0;beginBudget();
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
                    if(Math.abs(next-old)>.0001f&&change(1,source,target,old,next,maxWeight))changed++;
                    if(t!=null){t.evidence++;t.utility=.9*t.utility+.1*(pressed?1:-1);t.bad=pressed?0:t.bad+1;}
                    if(removed<1&&t!=null&&t.evidence>=12&&t.bad>=6&&next<.5){change(3,source,target,next,0,maxWeight);removed++;changed++;}
                }else if(desired>0&&layer.growthCount()+(changes==null?0:(int)changes.stream().filter(c->c.kind==2).count())<maxEdges){change(2,source,target,0,(float)(rate*desired),maxWeight);changed++;}
            }
        }
        finishBudget();observations++;human++;return changed;
    }
    /** Break the temporal link at pauses/interventions; retained utility/topology still persists. */
    public void boundary(){pending.clear();clearTemporal();}
    public long observations(){return observations;}public long human(){return human;}public long automatic(){return automatic;}
    public long rng(){return rng;}public double baseline(){return baseline;}public long born(){return born;}public long pruned(){return pruned;}public long rejected(){return rejected;}
    public String plasticityMode(){return plasticityMode;}public long neuronUpdates(){return neuronUpdates;}public long budgetClips(){return budgetClips;}public double lastBudget(){return lastBudget;}
    public int[] neuronCandidates(){return neuronCandidates.stream().mapToInt(Integer::intValue).toArray();}
    public List<NeuronTrace> neuronTraces(){ArrayList<NeuronTrace> a=new ArrayList<>();for(Map.Entry<Integer,Double> e:neuronTraces.entrySet())a.add(new NeuronTrace(e.getKey(),e.getValue()));return a;}
    public void restoreDynamics(long updates,long clips,double budget,List<NeuronTrace> values){
        if(updates<0||clips<0||!Double.isFinite(budget)||budget<0||budget>1.000001||values.size()>256)throw new IllegalArgumentException("Dynamics state");
        TreeMap<Integer,Double> next=new TreeMap<>();for(NeuronTrace t:values)if(!neuronCandidates.contains(t.neuron)||!Double.isFinite(t.eligibility)||Math.abs(t.eligibility)>2||next.put(t.neuron,t.eligibility)!=null)throw new IllegalArgumentException("Dynamics trace");
        neuronUpdates=updates;budgetClips=clips;lastBudget=budget;neuronTraces.clear();neuronTraces.putAll(next);temporalDirty|=!next.isEmpty();
    }
    public long baseUpdates(){return baseUpdates;}public int baseCandidates(){return basePaths.size();}public boolean trainsBase(){return trainBase;}
    public void restoreBaseUpdates(long value){if(value<0||value>9007199254740991L)throw new IllegalArgumentException("FDB base updates");baseUpdates=value;}
    public List<Trace> traces(){ArrayList<Trace> out=new ArrayList<>();for(Trace t:traces.values())out.add(t.copy());return out;}
    public long memoryBytes(){return 112L*traces.size()+64L*pending.size()*(maxEdges+baseLimit+sources.length*growthTargets.length)+96L*basePaths.size()+64L*neuronTraces.size()+32L*neuronCandidates.size()+64L*previousRates.size()+160L*recent.size()+64L*pending.size()*neuronCandidates.size();}
    public void restore(long observations,long human,long automatic){
        if(observations<0||observations>9007199254740991L||human<0||automatic<0||human>observations||automatic!=observations-human)throw new IllegalArgumentException("FDB learning checkpoint");
        this.observations=observations;this.human=human;this.automatic=automatic;
    }
    public void restore(long observations,long human,long automatic,long rng,double baseline,long born,long pruned,long rejected,List<Trace> state){
        if(rng<1||rng>0xffffffffL||!Double.isFinite(baseline)||Math.abs(baseline)>20||born<0||pruned<0||rejected<0||state.size()>MAX_TRACES)throw new IllegalArgumentException("FDB trace checkpoint");
        LinkedHashMap<Long,Trace> validated=new LinkedHashMap<>();
        for(Trace t:state){
            if(t.source<0||t.source>=graph.ids.length||t.target<0||t.target>=graph.ids.length||t.source==t.target||!Double.isFinite(t.eligibility)||Math.abs(t.eligibility)>2||!Double.isFinite(t.slowEligibility)||Math.abs(t.slowEligibility)>2||t.slowAge<0||t.slowAge>16||!Double.isFinite(t.utility)||Math.abs(t.utility)>4||!Double.isFinite(t.support)||Math.abs(t.support)>4||t.evidence<0||t.evidence>9007199254740991L||t.bad<0||t.bad>Integer.MAX_VALUE||validated.put(key(t.source,t.target),t.copy())!=null)throw new IllegalArgumentException("FDB trace state");
        }
        restore(observations,human,automatic);this.rng=rng;this.baseline=baseline;this.born=born;this.pruned=pruned;this.rejected=rejected;traces.clear();traces.putAll(validated);pending.clear();temporalDirty=!validated.isEmpty();
    }
}
