package org.node.flyconsole;
import org.json.*;import java.io.*;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;
/** Headless harness calls the production CPU and learner against actual WASM game frames. */
public final class FdbGameBridge {
 public static void main(String[] args)throws Exception{
  /* GRAPH AND PORTS. With a graph path the bridge reads the graph's own manifest
     (male-cns.fly.gz -> male-cns.fly.json), checks the pinned SHA-256 and binds
     the manifest's default_inputs/default_outputs - the same ports the Android
     app binds (ConnectomeStore.ports): this is the commercial path. With no path
     (or --fixture) it is the 30-neuron mechanism fixture, labelled NOT_COMMERCIAL;
     a graph without a manifest gets technical ports and is NOT_COMMERCIAL too. */
  boolean fixture=args.length==0||args[0].equals("--fixture");
  Graph graph=fixture?FdbLearningCheck.graph():Graph.read(new FileInputStream(args[0]),1_500_000_000L);int[] in=new int[16],out=new int[12];
  String portSource="technical",graphLabel=fixture?"mechanism-fixture":"graph";boolean commercial=false;double rateScale=500;
  File manifestFile=fixture?null:new File(args[0].replaceAll("\\.gz$","").replaceAll("\\.fly$","")+".fly.json");
  if(manifestFile!=null&&manifestFile.isFile()){
   JSONObject meta=new JSONObject(new String(java.nio.file.Files.readAllBytes(manifestFile.toPath()),java.nio.charset.StandardCharsets.UTF_8));
   String pinned=meta.optString("graph_sha256","");if(!pinned.isEmpty()&&!pinned.equals(graph.fingerprint()))throw new IOException("graph SHA-256 does not match its manifest");
   JSONArray mi=meta.getJSONArray("default_inputs"),mo=meta.getJSONArray("default_outputs");if(mi.length()!=16||mo.length()<12)throw new IOException("manifest ports");
   HashSet<Integer> unique=new HashSet<>();
   for(int list=0;list<2;list++){JSONArray ids=list==0?mi:mo;int[] idx=list==0?in:out;for(int i=0;i<idx.length;i++){int k=Arrays.binarySearch(graph.ids,Long.parseLong(ids.getString(i)));if(k<0||!unique.add(k))throw new IOException("manifest port not in graph");idx[i]=k;}}
   portSource="manifest";graphLabel=meta.optString("model_id","graph");commercial=true;
  }else{for(int i=0;i<16;i++)in[i]=i;for(int i=0;i<12;i++)out[i]=graph.ids.length-12+i;}
  /* ROUTING PROFILE - the Male CNS ports the Android app binds (RoutingProfile,
     app/src/main/assets/male-cns-routing-v1.json): 16 image cells -> 16 groups of
     16 visual projection neurons -> the full graph -> 12 descending outputs chosen
     from their measured response. Loaded automatically from next to the graph
     (the asset), or from --routing PATH. Only graph + manifest + this profile is
     the COMMERCIAL path; --manifest-ports keeps the manifest's own ports (whose
     motor outputs never spike) for diagnostics, NOT_COMMERCIAL. The learner's 16
     sources are the groups' first neurons, so FdbLearning is unchanged, and it
     carries the profile's sha256 into every checkpoint. */
  int[] stim=in,stimGroup=new int[16];for(int i=0;i<16;i++)stimGroup[i]=i;String sensor="";
  int argRouting=Arrays.asList(args).indexOf("--routing");boolean manifestPorts=Arrays.asList(args).contains("--manifest-ports");
  File profileFile=argRouting>=0?new File(args[argRouting+1]):fixture?null:new File(new File(args[0]).getParentFile(),RoutingProfile.ASSET);
  if(!fixture&&!manifestPorts&&profileFile!=null&&profileFile.isFile()){
   RoutingProfile rp=RoutingProfile.read(new JSONObject(new String(java.nio.file.Files.readAllBytes(profileFile.toPath()),java.nio.charset.StandardCharsets.UTF_8)),graph);
   stim=rp.stimulus;stimGroup=rp.stimulusGroup;System.arraycopy(rp.sources,0,in,0,16);System.arraycopy(rp.outputs,0,out,0,12);sensor=rp.sha256;
   portSource=rp.revision;commercial=commercial&&argRouting<0;rateScale=rp.rateHzPerUnit;
  }else if(!fixture&&portSource.equals("manifest"))commercial=false;
  final int[] stimFinal=stim,stimGroupFinal=stimGroup;final String sensorFinal=sensor;final double rateFinal=rateScale;
  final String portsFinal=portSource,labelFinal=graphLabel;final boolean commercialFinal=commercial;
  if(args.length==0&&"1".equals(System.getenv("FDB_EXPANDED_FIXTURE"))){
   ArrayList<Integer> ts=new ArrayList<>();ArrayList<Float> ws=new ArrayList<>();int[] offsets=new int[31];for(int i=0;i<30;i++){offsets[i]=ts.size();if(i<16){ts.add(16+i%2);ws.add(8f);}else if(i==16||i==17){ts.add(out[i-16+6]);ws.add(16f);}}offsets[30]=ts.size();int[] targets=new int[ts.size()];float[] weights=new float[ts.size()];for(int i=0;i<ts.size();i++){targets[i]=ts.get(i);weights[i]=ws.get(i);}graph=new Graph(graph.ids,offsets,targets,weights);
  }
  String plasticity="base";int cap=128;
  Engine engine=null;GraphDelta layer=null;FdbLearning learner=null;long counter=0;int seed=1;double[] statSum=null,statSq=null;int statN=0;
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(System.in))){String line;while((line=reader.readLine())!=null){JSONObject q=new JSONObject(line),r=new JSONObject();String op=q.getString("op");
   if(op.equals("init")){seed=q.getInt("seed");layer=new GraphDelta(graph.ids.length);String mode=q.getString("mode");if(mode.equals("fixed")){for(int source:in)layer.addEdge(source,out[6],8);}
    plasticity=q.optString("plasticityMode","base");cap=plasticity.equals("wexo")||plasticity.equals("expanded")?2048:128;learner=new FdbLearning(graph,layer,in,out,.1,cap,127,true,plasticity);learner.sensorProfile(sensorFinal);learner.seed(seed);engine=new Engine(graph);engine.reset(seed);counter=0;r.put("neurons",graph.ids.length).put("baseEdges",graph.targets.length).put("graphSha",graph.fingerprint()).put("model",labelFinal).put("ports",portsFinal).put("stimulated",stimFinal.length).put("sensorProfile",sensorFinal).put("commercial",commercialFinal).put("label",commercialFinal?"COMMERCIAL":"NOT_COMMERCIAL");
   }else if(op.equals("reset")){engine.reset(seed);learner.boundary();}
   else if(op.equals("decide")){JSONArray retina=q.getJSONArray("retina");double[] rates=new double[stimFinal.length];for(int i=0;i<rates.length;i++)rates[i]=retina.getDouble(stimGroupFinal[i])*rateFinal;Engine.Options options=new Engine.Options();options.delta=layer;
    long started=System.nanoTime();Engine.Result result=engine.advance(stimFinal,rates,q.optInt("windowMs",20),options,new AtomicBoolean());int[] actions={0,64,128};if(q.has("actions")){JSONArray list=q.getJSONArray("actions");actions=new int[list.length()];for(int i=0;i<actions.length;i++)actions[i]=list.getInt(i);}
    /* stats: per-neuron activity statistics over the decisions that ask for them (the
       population readout's choice of neurons); activityHash: a digest of every
       neuron's spike count in the window - equal hashes mean the brain did exactly
       the same thing */
    if(q.optBoolean("stats",false)){if(statSum==null||statSum.length!=result.counts.length){statSum=new double[result.counts.length];statSq=new double[result.counts.length];statN=0;}
     for(int i=0;i<result.counts.length;i++){double a=Math.min(1,result.counts[i]*10.0/result.steps);statSum[i]+=a;statSq[i]+=a*a;}statN++;}
    long ah=0xcbf29ce484222325L;for(int c:result.counts){ah^=c;ah*=0x100000001b3L;}r.put("activityHash",Long.toHexString(ah));
    FdbLearning.Decision decision=learner.decide("game-"+(counter++),result,actions,4095,30,q.optDouble("epsilon",.1),q.getBoolean("train"),null,q.has("sample")?q.getDouble("sample"):Double.NaN,q.has("skill")?q.getString("skill"):null);r.put("id",decision.id).put("mask",decision.mask).put("scores",new JSONArray(decision.scores)).put("brainMask",decision.brainMask).put("skillProposal",decision.skillProposal).put("skillDecided",decision.skillDecided).put("wallMs",result.wallSeconds*1000).put("spikes",result.spikes).put("decisionWallMs",(System.nanoTime()-started)/1e6);
   }else if(op.equals("reward")){
    /* typed credit: "tier" VERIFIED trains, PROVISIONAL only joins the traces unpaid;
       an untyped reward is the old mechanism tests' VERIFIED */
    int changed=learner.feedback(q.getString("id"),q.getInt("mask"),q.getDouble("reward"),q.getDouble("seconds"),q.getInt("frames"),q.optBoolean("valid",true),q.optBoolean("frozen",false),null,q.optString("tier",FdbLearning.VERIFIED));r.put("changed",changed).put("tier",q.optString("tier",FdbLearning.VERIFIED));}
   else if(op.equals("carry")){r.put("accepted",learner.carry(q.getString("id"),q.getInt("mask"),q.getDouble("seconds"),q.getInt("frames"),q.optBoolean("valid",true),q.optBoolean("accumulate",true),null));}
   else if(op.equals("credit")){learner.creditProfile(q.getString("profile"));}
   else if(op.equals("readout")){learner.readoutProfile(q.getString("profile"));}
   else if(op.equals("skill")){learner.skillProfile(q.getString("profile"));}
   else if(op.equals("imitate")){r.put("accepted",learner.imitate(q.getString("id"),q.getInt("mask")));}
   /* population (action-pop-v1): given neurons, or the "size" neurons whose activity
      varied most over the decisions taken with stats:true (then the statistics clear) */
   else if(op.equals("population")){int[] pop;
    if(q.has("neurons")){JSONArray a=q.getJSONArray("neurons");pop=new int[a.length()];for(int i=0;i<pop.length;i++)pop[i]=a.getInt(i);}
    else{int size=q.getInt("size");if(statSum==null||statN<2)throw new IllegalStateException("no activity statistics");
     ArrayList<double[]> v=new ArrayList<>();for(int i=0;i<statSum.length;i++){double m=statSum[i]/statN,var=statSq[i]/statN-m*m;if(var>1e-12)v.add(new double[]{var,i});}
     v.sort((x,y)->x[0]!=y[0]?Double.compare(y[0],x[0]):Double.compare(x[1],y[1]));r.put("varying",v.size());
     pop=new int[Math.min(size,v.size())];for(int i=0;i<pop.length;i++)pop[i]=(int)v.get(i)[1];Arrays.sort(pop);statSum=null;statSq=null;statN=0;}
    learner.readoutPopulation(pop);r.put("population",pop.length);}
   else if(op.equals("fit")){double[] f=learner.fitImitation(q.optInt("epochs",200),q.optDouble("margin",1),q.optDouble("rate",.05));r.put("met",f[0]).put("epochs",(int)f[1]).put("fitUpdates",(long)f[2]).put("demonstrations",learner.imitationSetSize());}
   else if(op.equals("demonstrate")){JSONArray steps=q.getJSONArray("steps");for(int i=0;i<steps.length();i++){JSONArray st=steps.getJSONArray(i);learner.demonstrate(st.getString(0),st.getInt(1));}r.put("skills",learner.skillCount()).put("imitations",learner.imitations());}
   /* the production answer to an UNKNOWN interval: clear the temporal link, pay nothing */
   else if(op.equals("boundary")){learner.boundary();}
   /* a prior toward one output, so an untrained layer has a habit to unlearn */
   else if(op.equals("prior")){int target=out[q.getInt("output")];for(int source:in)layer.addEdge(source,target,(float)q.optDouble("weight",8));}
   else if(op.equals("checkpoint")){JSONObject state=FdbCheckpoint.save(learner,graph,in,out);GraphDelta restored=new GraphDelta(graph.ids.length);for(GraphDelta.Edge e:layer.edges())restored.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:layer.deltas())restored.addWeightDelta(e.source,e.target,e.weight);FdbCheckpoint.restoreThresholds(restored,new JSONObject().put("neuronDynamics",FdbCheckpoint.thresholdState(layer,graph)),graph);FdbLearning next=new FdbLearning(graph,restored,in,out,.1,cap,127,true,plasticity);next.creditProfile(learner.creditProfile());next.readoutProfile(learner.readoutProfile());next.sensorProfile(learner.sensorProfile());next.skillProfile(learner.skillProfile());FdbCheckpoint.restore(next,new JSONObject(state.toString()),graph,in,out);next.boundary();learner=next;layer=restored;engine.reset(seed);r.put("format",4);}
   else if(!op.equals("state"))throw new IllegalArgumentException(op);
   r.put("plasticityMode",plasticity).put("baseUpdates",learner.baseUpdates()).put("neuronUpdates",learner.neuronUpdates()).put("budgetClips",learner.budgetClips()).put("thresholdParameters",layer.thresholds().size()).put("deltas",layer.deltaCount()).put("edges",layer.growthCount()).put("born",learner.born()).put("pruned",learner.pruned()).put("updates",learner.automatic()).put("layerBytesEstimate",layer.memoryBytes()+learner.memoryBytes()).put("graphAndEngineBytesEstimate",graph.memoryBytes()).put("rng",learner.rng()).put("carried",learner.carried()).put("paused",learner.paused()).put("provisionalSeen",learner.provisionalSeen()).put("verifiedPaid",learner.verifiedPaid()).put("pending",learner.pendingCount()).put("readoutProfile",learner.readoutProfile()).put("skillProfile",learner.skillProfile()).put("skills",learner.skillCount()).put("imitations",learner.imitations()).put("readoutUpdates",learner.readoutUpdates()).put("population",learner.readoutPopulation().length).put("imitationSet",learner.imitationSetSize()).put("creditProfile",learner.creditProfile());if(op.equals("state"))r.put("weights",layer.genome().substring(layer.genome().indexOf(";d="))).put("learningState",FdbCheckpoint.save(learner,graph,in,out));System.out.println(r.toString());
  }}
 }
}
