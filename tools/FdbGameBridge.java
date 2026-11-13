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
  String portSource="technical",graphLabel=fixture?"mechanism-fixture":"graph";boolean commercial=false;
  File manifestFile=fixture?null:new File(args[0].replaceAll("\\.gz$","").replaceAll("\\.fly$","")+".fly.json");
  if(manifestFile!=null&&manifestFile.isFile()){
   JSONObject meta=new JSONObject(new String(java.nio.file.Files.readAllBytes(manifestFile.toPath()),java.nio.charset.StandardCharsets.UTF_8));
   String pinned=meta.optString("graph_sha256","");if(!pinned.isEmpty()&&!pinned.equals(graph.fingerprint()))throw new IOException("graph SHA-256 does not match its manifest");
   JSONArray mi=meta.getJSONArray("default_inputs"),mo=meta.getJSONArray("default_outputs");if(mi.length()!=16||mo.length()<12)throw new IOException("manifest ports");
   HashSet<Integer> unique=new HashSet<>();
   for(int list=0;list<2;list++){JSONArray ids=list==0?mi:mo;int[] idx=list==0?in:out;for(int i=0;i<idx.length;i++){int k=Arrays.binarySearch(graph.ids,Long.parseLong(ids.getString(i)));if(k<0||!unique.add(k))throw new IOException("manifest port not in graph");idx[i]=k;}}
   portSource="manifest";graphLabel=meta.optString("model_id","graph");commercial=true;
  }else{for(int i=0;i<16;i++)in[i]=i;for(int i=0;i<12;i++)out[i]=graph.ids.length-12+i;}
  /* ROUTING PORTS (--routing ATLAS.json, research): the manifest's photoreceptor
     inputs spike nothing downstream in the spiking engine (histaminergic,
     graded) and its abdominal motor outputs are never reached - measured. The
     atlas (tools/male_cns_routing.py) gives the visual projection neurons and
     the descending neurons vision reaches. Each of the 16 retina cells drives a
     group of 16 projection neurons of one type on one side (left half of the
     image -> left-side neurons); the learner's 16 sources are the groups' first
     neurons, so FdbLearning is unchanged. Outputs: the 12 descending neurons
     vision reaches most, 6 per side. No neuron is named after a button: what a
     descending neuron's activity is worth for an action is learned. */
  int[] stim=in,stimGroup=new int[16];for(int i=0;i<16;i++)stimGroup[i]=i;
  int argRouting=Arrays.asList(args).indexOf("--routing");
  if(argRouting>=0&&!fixture){
   JSONObject atlas=new JSONObject(new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[argRouting+1])),java.nio.charset.StandardCharsets.UTF_8));
   String[] types={"LPLC2","LC4","LPLC1","LC6","LC9","LC11","LC12","LC17"};
   JSONArray vp=atlas.getJSONObject("sets").getJSONArray("visualProjection");
   TreeMap<String,ArrayList<Integer>> byGroup=new TreeMap<>();
   for(int i=0;i<vp.length();i++){JSONArray v=vp.getJSONArray(i);String key=v.optString(1)+"/"+v.optString(2);int k=Arrays.binarySearch(graph.ids,Long.parseLong(v.getString(0)));if(k>=0)byGroup.computeIfAbsent(key,x->new ArrayList<>()).add(k);}
   stim=new int[256];stimGroup=new int[256];
   for(int c=0;c<16;c++){int row=c/4,col=c%4;String key=types[row*2+(col%2)]+"/"+(col<2?"L":"R");ArrayList<Integer> list=byGroup.get(key);
    if(list==null||list.size()<16)throw new IOException("routing group too small: "+key);Collections.sort(list);
    for(int j=0;j<16;j++){stim[c*16+j]=list.get(j);stimGroup[c*16+j]=c;}in[c]=list.get(0);}
   JSONArray dn=atlas.getJSONArray("descendingFromVision");int left=0,right=0,n=0;HashSet<Integer> used=new HashSet<>();for(int x:in)used.add(x);
   for(int i=0;i<dn.length()&&n<12;i++){JSONObject d=dn.getJSONObject(i);String side=d.optString("side","");int k=Arrays.binarySearch(graph.ids,Long.parseLong(d.getString("id")));
    if(k<0||used.contains(k))continue;if(side.equals("L")&&left>=6||side.equals("R")&&right>=6)continue;
    if(side.equals("L"))left++;else if(side.equals("R"))right++;out[n++]=k;used.add(k);}
   if(n<12)throw new IOException("routing: fewer than 12 descending outputs");
   portSource="routing-v1";
   /* the Android app still binds the manifest ports: until it binds these
      same routing ports, a run here is not equivalent to the APK */
   commercial=false;
  }
  final int[] stimFinal=stim,stimGroupFinal=stimGroup;
  final String portsFinal=portSource,labelFinal=graphLabel;final boolean commercialFinal=commercial;
  if(args.length==0&&"1".equals(System.getenv("FDB_EXPANDED_FIXTURE"))){
   ArrayList<Integer> ts=new ArrayList<>();ArrayList<Float> ws=new ArrayList<>();int[] offsets=new int[31];for(int i=0;i<30;i++){offsets[i]=ts.size();if(i<16){ts.add(16+i%2);ws.add(8f);}else if(i==16||i==17){ts.add(out[i-16+6]);ws.add(16f);}}offsets[30]=ts.size();int[] targets=new int[ts.size()];float[] weights=new float[ts.size()];for(int i=0;i<ts.size();i++){targets[i]=ts.get(i);weights[i]=ws.get(i);}graph=new Graph(graph.ids,offsets,targets,weights);
  }
  String plasticity="base";int cap=128;
  Engine engine=null;GraphDelta layer=null;FdbLearning learner=null;long counter=0;int seed=1;
  try(BufferedReader reader=new BufferedReader(new InputStreamReader(System.in))){String line;while((line=reader.readLine())!=null){JSONObject q=new JSONObject(line),r=new JSONObject();String op=q.getString("op");
   if(op.equals("init")){seed=q.getInt("seed");layer=new GraphDelta(graph.ids.length);String mode=q.getString("mode");if(mode.equals("fixed")){for(int source:in)layer.addEdge(source,out[6],8);}
    plasticity=q.optString("plasticityMode","base");cap=plasticity.equals("wexo")||plasticity.equals("expanded")?2048:128;learner=new FdbLearning(graph,layer,in,out,.1,cap,127,true,plasticity);learner.seed(seed);engine=new Engine(graph);engine.reset(seed);counter=0;r.put("neurons",graph.ids.length).put("baseEdges",graph.targets.length).put("graphSha",graph.fingerprint()).put("model",labelFinal).put("ports",portsFinal).put("stimulated",stimFinal.length).put("commercial",commercialFinal).put("label",commercialFinal?"COMMERCIAL":"NOT_COMMERCIAL");
   }else if(op.equals("reset")){engine.reset(seed);learner.boundary();}
   else if(op.equals("decide")){JSONArray retina=q.getJSONArray("retina");double[] rates=new double[stimFinal.length];for(int i=0;i<rates.length;i++)rates[i]=retina.getDouble(stimGroupFinal[i])*500;Engine.Options options=new Engine.Options();options.delta=layer;
    long started=System.nanoTime();Engine.Result result=engine.advance(stimFinal,rates,q.optInt("windowMs",20),options,new AtomicBoolean());int[] actions={0,64,128};if(q.has("actions")){JSONArray list=q.getJSONArray("actions");actions=new int[list.length()];for(int i=0;i<actions.length;i++)actions[i]=list.getInt(i);}
    FdbLearning.Decision decision=learner.decide("game-"+(counter++),result,actions,4095,30,q.optDouble("epsilon",.1),q.getBoolean("train"),null,q.has("sample")?q.getDouble("sample"):Double.NaN);r.put("id",decision.id).put("mask",decision.mask).put("scores",new JSONArray(decision.scores)).put("wallMs",result.wallSeconds*1000).put("spikes",result.spikes).put("decisionWallMs",(System.nanoTime()-started)/1e6);
   }else if(op.equals("reward")){int changed=learner.feedback(q.getString("id"),q.getInt("mask"),q.getDouble("reward"),q.getDouble("seconds"),q.getInt("frames"),q.optBoolean("valid",true),q.optBoolean("frozen",false),null);r.put("changed",changed);}
   else if(op.equals("carry")){r.put("accepted",learner.carry(q.getString("id"),q.getInt("mask"),q.getDouble("seconds"),q.getInt("frames"),q.optBoolean("valid",true),q.optBoolean("accumulate",true),null));}
   else if(op.equals("credit")){learner.creditProfile(q.getString("profile"));}
   else if(op.equals("readout")){learner.readoutProfile(q.getString("profile"));}
   /* the production answer to an UNKNOWN interval: clear the temporal link, pay nothing */
   else if(op.equals("boundary")){learner.boundary();}
   /* a prior toward one output, so an untrained layer has a habit to unlearn */
   else if(op.equals("prior")){int target=out[q.getInt("output")];for(int source:in)layer.addEdge(source,target,(float)q.optDouble("weight",8));}
   else if(op.equals("checkpoint")){JSONObject state=FdbCheckpoint.save(learner,graph,in,out);GraphDelta restored=new GraphDelta(graph.ids.length);for(GraphDelta.Edge e:layer.edges())restored.addEdge(e.source,e.target,e.weight);for(GraphDelta.Edge e:layer.deltas())restored.addWeightDelta(e.source,e.target,e.weight);FdbCheckpoint.restoreThresholds(restored,new JSONObject().put("neuronDynamics",FdbCheckpoint.thresholdState(layer,graph)),graph);FdbLearning next=new FdbLearning(graph,restored,in,out,.1,cap,127,true,plasticity);next.creditProfile(learner.creditProfile());next.readoutProfile(learner.readoutProfile());FdbCheckpoint.restore(next,new JSONObject(state.toString()),graph,in,out);next.boundary();learner=next;layer=restored;engine.reset(seed);r.put("format",4);}
   else if(!op.equals("state"))throw new IllegalArgumentException(op);
   r.put("plasticityMode",plasticity).put("baseUpdates",learner.baseUpdates()).put("neuronUpdates",learner.neuronUpdates()).put("budgetClips",learner.budgetClips()).put("thresholdParameters",layer.thresholds().size()).put("deltas",layer.deltaCount()).put("edges",layer.growthCount()).put("born",learner.born()).put("pruned",learner.pruned()).put("updates",learner.automatic()).put("layerBytesEstimate",layer.memoryBytes()+learner.memoryBytes()).put("graphAndEngineBytesEstimate",graph.memoryBytes()).put("rng",learner.rng()).put("carried",learner.carried()).put("paused",learner.paused()).put("pending",learner.pendingCount()).put("readoutProfile",learner.readoutProfile()).put("readoutUpdates",learner.readoutUpdates()).put("creditProfile",learner.creditProfile());if(op.equals("state"))r.put("weights",layer.genome().substring(layer.genome().indexOf(";d="))).put("learningState",FdbCheckpoint.save(learner,graph,in,out));System.out.println(r.toString());
  }}
 }
}
