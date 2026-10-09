package org.node.flyconsole;

import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** An owned CPU instance of the existing engine and FDB learner; only W0 may be shared. */
public final class DualAgentContext {
    final String id,modelId,layerId;
    final Graph graph;
    final Engine engine;
    final Experiment experiment;
    final GraphDelta layer;
    final FdbLearning learning;
    final JSONObject configuration;
    final boolean learningEnabled;
    private final JSONObject learningConfiguration,rewardProfile;
    private final JSONArray actionSet;
    private final boolean teamReward;
    private JSONObject growthConfiguration;
    private FdbGrowth growth;
    private long sequence;
    private boolean wasLearning;

    static long integer(JSONObject o,String key,long min,long max)throws Exception {
        Object v=o.get(key);if(!(v instanceof Number))throw new IllegalArgumentException("Integer required: "+key);
        double d=((Number)v).doubleValue();long n=((Number)v).longValue();if(!Double.isFinite(d)||d!=n||n<min||n>max)throw new IllegalArgumentException("Integer range: "+key);return n;
    }
    static double number(JSONObject o,String key,double min,double max)throws Exception {
        Object v=o.get(key);if(!(v instanceof Number))throw new IllegalArgumentException("Number required: "+key);double n=((Number)v).doubleValue();if(!Double.isFinite(n)||n<min||n>max)throw new IllegalArgumentException("Number range: "+key);return n;
    }
    private static boolean bool(JSONObject o,String key,boolean fallback)throws Exception {if(!o.has(key))return fallback;if(!(o.get(key) instanceof Boolean))throw new IllegalArgumentException("Boolean required: "+key);return o.getBoolean(key);}
    private static int index(Graph graph,Object value){if(!(value instanceof String))throw new IllegalArgumentException("Neuron ID must be string");int i=Arrays.binarySearch(graph.ids,Long.parseLong((String)value));if(i<0)throw new IllegalArgumentException("Unknown neuron ID");return i;}
    static JSONArray ids(Graph graph,int[] indices){JSONArray a=new JSONArray();for(int i:indices)a.put(Long.toString(graph.ids[i]));return a;}
    private static int[] ports(Graph graph,JSONArray a,int count)throws Exception {if(a.length()!=count)throw new IllegalArgumentException("Port count");int[] p=new int[count];Set<Integer> unique=new HashSet<>();for(int i=0;i<count;i++){p[i]=index(graph,a.get(i));if(!unique.add(p[i]))throw new IllegalArgumentException("Duplicate port");}return p;}

    public static DualAgentContext create(String id,String modelId,Graph graph,Experiment defaults,JSONObject descriptor,JSONObject checkpoint,String layerId)throws Exception {
        if(!("p1".equals(id)||"p2".equals(id))||(descriptor.has("id")&&!id.equals(descriptor.getString("id")))||(descriptor.has("modelId")&&!modelId.equals(descriptor.getString("modelId"))))throw new IllegalArgumentException("Agent identity");
        JSONObject config=new JSONObject(descriptor.getJSONObject("config").toString());
        if(!"cpu".equals(config.optString("backend","cpu")))throw new IllegalArgumentException("Two agents require CPU backend");
        long seed=integer(descriptor,"seed",0,2147483647L);if(config.has("seed")&&integer(config,"seed",0,2147483647L)!=seed)throw new IllegalArgumentException("Agent seed mismatch");
        int[] inputs=config.has("inputs")?ports(graph,config.getJSONArray("inputs"),16):defaults.inputs;
        int[] outputs=config.has("outputs")?ports(graph,config.getJSONArray("outputs"),defaults.outputs.length):defaults.outputs;
        Experiment e=new Experiment(inputs,outputs);Set<Integer> unique=new HashSet<>();for(int i:inputs)unique.add(i);for(int i:outputs)if(!unique.add(i))throw new IllegalArgumentException("Overlapping ports");
        e.mode=config.optString("mode","closed");if(!Arrays.asList("closed","observe","sham").contains(e.mode))throw new IllegalArgumentException("Neural mode");
        e.maxHz=config.has("maxHz")?number(config,"maxHz",0,500):150;e.thresholdHz=config.has("thresholdHz")?number(config,"thresholdHz",1,500):30;e.windowMs=config.has("windowMs")?(int)integer(config,"windowMs",1,100):20;
        e.options.gain=config.has("gain")?number(config,"gain",0,2):1;e.options.disableInhibition=bool(config,"disableInhibition",false);e.scramble=bool(config,"scramble",false);e.seedPermutation(seed);
        JSONArray lesions=config.optJSONArray("lesions");if(config.has("lesions")&&lesions==null)throw new IllegalArgumentException("Lesions array");if(lesions!=null){if(lesions.length()>256)throw new IllegalArgumentException("Lesion limit");e.options.lesions=ports(graph,lesions,lesions.length());}
        JSONObject requested=config.optJSONObject("fdb");if(config.has("fdb")&&requested==null)throw new IllegalArgumentException("FDB object required");if(requested==null)requested=new JSONObject();
        JSONObject fdb=requested;
        if(checkpoint!=null){
            if(!"dual-neural".equals(checkpoint.getString("actorKind"))||!id.equals(checkpoint.getString("actorSlot"))||!modelId.equals(checkpoint.getString("modelId"))||!graph.fingerprint().equals(checkpoint.getJSONObject("graph").getString("sha256")))throw new IllegalArgumentException("Checkpoint actor/model mismatch");
            JSONObject saved=checkpoint.getJSONObject("configuration");if(!ids(graph,inputs).toString().equals(saved.getJSONArray("inputs").toString())||!ids(graph,outputs).toString().equals(saved.getJSONArray("outputs").toString()))throw new IllegalArgumentException("Checkpoint port mismatch");
            fdb=new JSONObject(saved.getJSONObject("fdb").toString());if(requested.has("learning"))fdb.put("learning",new JSONObject(requested.getJSONObject("learning").toString()));
        }
        if(fdb.has("version"))integer(fdb,"version",1,2);if(fdb.has("graph_sha256")&&!graph.fingerprint().equals(fdb.getString("graph_sha256")))throw new IllegalArgumentException("FDB graph mismatch");
        GraphDelta layer=new GraphDelta(graph.ids.length,1024);
        for(String kind:new String[]{"deltas","edges"}){JSONArray links=fdb.optJSONArray(kind);if(fdb.has(kind)&&links==null)throw new IllegalArgumentException("FDB array required");if(links==null)continue;if(links.length()>1024)throw new IllegalArgumentException("FDB link limit");for(int k=0;k<links.length();k++){JSONObject link=links.getJSONObject(k);int s=index(graph,link.get("source")),t=index(graph,link.get("target"));float w=(float)number(link,"weight",-127,127);if("deltas".equals(kind)){boolean found=false;for(int j=graph.offsets[s];j<graph.offsets[s+1];j++)if(graph.targets[j]==t){found=true;break;}if(!found)throw new IllegalArgumentException("Delta requires base edge");layer.addWeightDelta(s,t,w);}else layer.addEdge(s,t,w);}}
        JSONObject lc=fdb.optJSONObject("learning");if(fdb.has("learning")&&lc==null)throw new IllegalArgumentException("Learning object required");if(lc==null)lc=new JSONObject().put("enabled",false).put("rate",.05).put("maxEdges",256).put("maxWeight",32);
        boolean enabled=bool(lc,"enabled",false);double rate=lc.has("rate")?number(lc,"rate",.001,.2):.05;int cap=lc.has("maxEdges")?(int)integer(lc,"maxEdges",1,1024):256;float max=(float)(lc.has("maxWeight")?number(lc,"maxWeight",.000001,127):32);
        lc=new JSONObject().put("enabled",enabled).put("rate",rate).put("maxEdges",cap).put("maxWeight",max);FdbLearning learning=new FdbLearning(graph,layer,inputs,outputs,rate,cap,max);learning.seed(seed);
        if(fdb.has("learningState"))FdbCheckpoint.restore(learning,fdb.getJSONObject("learningState"),graph,inputs,outputs);learning.boundary();e.options.delta=layer;
        config.put("backend","cpu").put("seed",seed).put("inputs",ids(graph,inputs)).put("outputs",ids(graph,outputs)).put("mode",e.mode).put("maxHz",e.maxHz).put("thresholdHz",e.thresholdHz).put("windowMs",e.windowMs).put("gain",e.options.gain).put("disableInhibition",e.options.disableInhibition).put("scramble",e.scramble).put("lesions",ids(graph,e.options.lesions));
        DualAgentContext actor=new DualAgentContext(id,modelId,layerId,graph,e,layer,learning,config,lc,descriptor);actor.engine.reset(seed);
        JSONObject gc=fdb.optJSONObject("growth");if(fdb.has("growth")&&gc==null)throw new IllegalArgumentException("Growth object required");if(gc!=null){actor.growthConfiguration=new JSONObject(gc.toString());if(bool(gc,"enabled",false)){actor.growth=new FdbGrowth(graph,layer,inputs,outputs,(int)integer(gc,"interval",1,1000),(int)integer(gc,"perWindow",1,8),(int)integer(gc,"maxEdges",1,1024),(float)number(gc,"initialWeight",.000001,127),bool(gc,"explore",false),bool(gc,"rewardGate",true),seed);JSONObject gs=fdb.optJSONObject("growthState");if(gs!=null){if(integer(gs,"version",1,1)!=1||!ids(graph,inputs).toString().equals(gs.getJSONArray("sources").toString())||!ids(graph,outputs).toString().equals(gs.getJSONArray("targets").toString()))throw new IllegalArgumentException("Growth ports mismatch");JSONArray prior=gs.optJSONArray("previous");int[] counts=prior==null?null:new int[prior.length()];if(prior!=null)for(int i=0;i<counts.length;i++){Object n=prior.get(i);if(!(n instanceof Number)||((Number)n).doubleValue()!=((Number)n).intValue()||((Number)n).intValue()<0)throw new IllegalArgumentException("Growth counts");counts[i]=((Number)n).intValue();}actor.growth.restore(integer(gs,"windows",0,Integer.MAX_VALUE),integer(gs,"rng",1,0xffffffffL),counts);}}}
        return actor;
    }
    private DualAgentContext(String id,String modelId,String layerId,Graph graph,Experiment experiment,GraphDelta layer,FdbLearning learning,JSONObject configuration,JSONObject lc,JSONObject descriptor)throws Exception {
        this.id=id;this.modelId=modelId;this.layerId=layerId;this.graph=graph;this.experiment=experiment;this.layer=layer;this.learning=learning;this.configuration=configuration;learningConfiguration=lc;learningEnabled=lc.getBoolean("enabled");engine=new Engine(graph);
        rewardProfile=new JSONObject(descriptor.optJSONObject("profile")==null?"{}":descriptor.getJSONObject("profile").toString());actionSet=new JSONArray(descriptor.optJSONArray("actions")==null?"[]":descriptor.getJSONArray("actions").toString());teamReward=bool(descriptor,"teamReward",false);
    }
    public void validateRequest(JSONObject request)throws Exception {
        if(!id.equals(request.getString("id")))throw new IllegalArgumentException("Wrong agent slot");String mode=request.getString("mode");if(!("train".equals(mode)||"eval".equals(mode)))throw new IllegalArgumentException("Agent mode");number(request,"epsilon",0,1);bool(request,"frozen",false);
        int allowed=(int)integer(request,"allowedMask",0,4095);JSONArray a=request.getJSONArray("actions");if(a.length()<2||a.length()>64)throw new IllegalArgumentException("Action count");Set<Integer> unique=new HashSet<>();int eligible=0;
        for(int i=0;i<a.length();i++){Object value=a.get(i);if(!(value instanceof Number)||((Number)value).doubleValue()!=((Number)value).intValue())throw new IllegalArgumentException("Action integer");int mask=((Number)value).intValue();if(mask<0||mask>4095||(mask&48)==48||(mask&192)==192||!unique.add(mask))throw new IllegalArgumentException("Action mask");if((mask&~allowed)==0&&(mask>>>experiment.outputs.length)==0)eligible++;}if(eligible<2)throw new IllegalArgumentException("At least two allowed actions required");
        JSONObject outcome=request.optJSONObject("outcome");if(request.has("outcome")&&outcome==null)throw new IllegalArgumentException("Outcome object");if(outcome!=null){Object decision=outcome.get("id");if(!(decision instanceof String)||((String)decision).length()>80)throw new IllegalArgumentException("Decision ID");integer(outcome,"mask",0,(1<<experiment.outputs.length)-1);integer(outcome,"frames",1,240);number(outcome,"gameSeconds",Double.MIN_VALUE,2);number(outcome,"reward",-20,20);bool(outcome,"valid",false);}
    }
    public JSONObject sample(JSONObject request,double[] retina,String decisionId,AtomicBoolean cancel)throws Exception {
        validateRequest(request);if(retina.length!=16)throw new IllegalArgumentException("Retina count");for(double value:retina)if(!Double.isFinite(value)||value<0||value>1)throw new IllegalArgumentException("Retina range");boolean frozen=bool(request,"frozen",false)||"eval".equals(request.getString("mode")),training=learningEnabled&&!frozen;
        if(training&&!wasLearning)learning.boundary();wasLearning=training;int changed=0;JSONObject outcome=request.optJSONObject("outcome");
        if(outcome!=null&&learningEnabled)changed=learning.feedback(outcome.getString("id"),outcome.getInt("mask"),outcome.getDouble("reward"),outcome.getDouble("gameSeconds"),outcome.getInt("frames"),outcome.getBoolean("valid"),frozen,experiment.options.lesions);
        Engine.Result result=engine.advance(experiment.inputs,experiment.rates(retina),experiment.windowMs,experiment.options,cancel);if(cancel.get()||result.steps!=experiment.windowMs*10){boundary();throw new IllegalStateException("Dual simulation interrupted");}
        JSONArray action=request.getJSONArray("actions");int[] actions=new int[action.length()];for(int i=0;i<actions.length;i++)actions[i]=action.getInt(i);
        FdbLearning.Decision d=learning.decide(decisionId,result,actions,request.getInt("allowedMask"),experiment.thresholdHz,training?request.getDouble("epsilon"):0,training,experiment.options.lesions);sequence++;
        JSONArray hz=new JSONArray(),groups=new JSONArray();for(int output:experiment.outputs)hz.put(result.counts[output]*10000.0/result.steps);for(int k=0;k<16;k++){long count=0;int active=0,start=(int)((long)k*graph.ids.length/16),end=(int)((long)(k+1)*graph.ids.length/16);for(int i=start;i<end;i++){count+=result.counts[i];if(result.counts[i]>0)active++;}groups.put(new JSONObject().put("spikes",count).put("active",active).put("neurons",end-start).put("hz",end==start?0:count*10000.0/result.steps/(end-start)));}
        return metadata().put("decision",new JSONObject().put("id",d.id).put("mask",d.mask).put("probability",d.probability)).put("outputsHz",hz).put("outputs",hz).put("neuralGroups",groups).put("adapted",changed).put("spikes",result.spikes).put("active",result.active).put("wallMs",result.wallSeconds*1000).put("simMs",result.steps*.1).put("sequence",sequence);
    }
    public void boundary(){learning.boundary();wasLearning=false;}
    public JSONObject fdbState()throws Exception {
        JSONObject fdb=new JSONObject().put("version",2).put("graph_sha256",graph.fingerprint()).put("learning",new JSONObject(learningConfiguration.toString())).put("learningState",FdbCheckpoint.save(learning,graph,experiment.inputs,experiment.outputs));
        for(String kind:new String[]{"deltas","edges"}){JSONArray links=new JSONArray();for(GraphDelta.Edge e:"deltas".equals(kind)?layer.deltas():layer.edges())links.put(new JSONObject().put("source",Long.toString(graph.ids[e.source])).put("target",Long.toString(graph.ids[e.target])).put("weight",e.weight));fdb.put(kind,links);}
        if(growthConfiguration!=null)fdb.put("growth",new JSONObject(growthConfiguration.toString()));if(growth!=null)fdb.put("growthState",new JSONObject().put("version",1).put("windows",growth.windows()).put("rng",growth.rng()).put("sources",ids(graph,experiment.inputs)).put("targets",ids(graph,experiment.outputs)).put("previous",growth.previous()==null?JSONObject.NULL:new JSONArray(growth.previous())));return fdb;
    }
    public JSONObject metadata()throws Exception {return new JSONObject().put("id",id).put("modelId",modelId).put("graphSha256",graph.fingerprint()).put("neurons",graph.ids.length).put("edges",graph.targets.length).put("inputs",ids(graph,experiment.inputs)).put("outputs",ids(graph,experiment.outputs)).put("layerId",layerId).put("backend","cpu").put("fdbState",fdbState()).put("revision",layer.version()).put("memoryBytes",layer.memoryBytes()+learning.memoryBytes());}
    public JSONObject layerSet(String system,String romHash,long createdAt)throws Exception {
        JSONObject config=new JSONObject(configuration.toString()).put("fdb",fdbState());JSONObject portable=new JSONObject(config.toString());portable.getJSONObject("fdb").remove("learningState");portable.getJSONObject("fdb").remove("growthState");
        JSONObject key=new JSONObject().put("system",system).put("romHash",romHash).put("graphSha256",graph.fingerprint()).put("actorSlot",id).put("modelId",modelId).put("configuration",portable);
        return new JSONObject().put("type","fly-layer-set").put("layerVersion",2).put("id",layerId).put("actorKind","dual-neural").put("actorSlot",id).put("modelId",modelId).put("name",id.toUpperCase(Locale.ROOT)+" · "+modelId).put("notes","").put("system",system).put("romHash",romHash).put("graph",new JSONObject().put("sha256",graph.fingerprint()).put("modelId",modelId).put("neurons",graph.ids.length).put("edges",graph.targets.length)).put("createdAt",createdAt).put("updatedAt",System.currentTimeMillis()).put("key",key.toString()).put("configuration",config).put("profile",new JSONObject(rewardProfile.toString())).put("actions",new JSONArray(actionSet.toString())).put("teamReward",teamReward).put("runtime",new JSONObject().put("backend","cpu").put("seed",experiment.seed).put("liveStateRestored",false)).put("policy",new JSONObject().put("updates",learning.observations()).put("episodes",0)).put("journal",new JSONArray());
    }
}
