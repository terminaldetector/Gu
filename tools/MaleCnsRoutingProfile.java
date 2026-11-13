package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Male CNS routing PROFILE, stage 2 of 2 (directive 2026-11-13, M2.1): outputs
 *  chosen from the MEASURED response to the profile's own 256 inputs.
 *  usage: MaleCnsRoutingProfile GRAPH.fly.gz STAGE1.json ATLAS.json OUT_PROFILE.json
 *
 *  Protocol, production engine and full graph: a weak background on all 16
 *  groups (as a real frame drives everything), then each group raised on top of
 *  it; per descending neuron, the response to group g is the spike count minus
 *  the background-only count, averaged over seeds. Outputs: greedily the
 *  descending neurons with the largest spread of responses across groups (they
 *  tell image regions apart), skipping any whose response profile correlates
 *  > 0.9 with one already chosen, among neurons that respond at all. The
 *  profile's sha256 covers groups, sources, outputs and revision - it becomes
 *  part of the FDB checkpoint identity. */
public final class MaleCnsRoutingProfile {
    static final String REVISION=RoutingProfile.REVISION;
    static final double BACKGROUND_HZ=100,RAISED_HZ=500;static final int WINDOW_MS=50;static final long[] SEEDS={11,23,37};
    public static void main(String[] args)throws Exception{
        Graph g=Graph.read(new FileInputStream(args[0]),1_500_000_000L);
        JSONObject stage1=new JSONObject(new String(Files.readAllBytes(Paths.get(args[1])),StandardCharsets.UTF_8));
        JSONObject atlas=new JSONObject(new String(Files.readAllBytes(Paths.get(args[2])),StandardCharsets.UTF_8));
        JSONArray groups=stage1.getJSONArray("groups");if(groups.length()!=16)throw new IllegalArgumentException("16 groups");
        int[] stim=new int[256],groupOf=new int[256];
        for(int c=0;c<16;c++){JSONArray ns=groups.getJSONObject(c).getJSONArray("neurons");if(ns.length()!=16)throw new IllegalArgumentException("16 per group");
            for(int j=0;j<16;j++){int k=Arrays.binarySearch(g.ids,Long.parseLong(ns.getString(j)));if(k<0)throw new IllegalArgumentException("neuron not in graph");stim[c*16+j]=k;groupOf[c*16+j]=c;}}
        JSONArray dnIds=atlas.getJSONObject("sets").getJSONArray("descending");int[] dn=new int[dnIds.length()];
        for(int i=0;i<dn.length;i++)dn[i]=Arrays.binarySearch(g.ids,Long.parseLong(dnIds.getString(i)));
        Engine e=new Engine(g);Engine.Options o=new Engine.Options();
        double[][] resp=new double[16][dn.length];double[] base=new double[dn.length];
        long t0=System.nanoTime();
        for(long seed:SEEDS){
            double[] rates=new double[256];Arrays.fill(rates,BACKGROUND_HZ);
            e.reset(seed);Engine.Result b=e.advance(stim,rates,WINDOW_MS,o,new AtomicBoolean());
            for(int i=0;i<dn.length;i++)base[i]+=b.counts[dn[i]]/(double)SEEDS.length;
            for(int c=0;c<16;c++){
                for(int k=0;k<256;k++)rates[k]=groupOf[k]==c?RAISED_HZ:BACKGROUND_HZ;
                e.reset(seed);Engine.Result r=e.advance(stim,rates,WINDOW_MS,o,new AtomicBoolean());
                for(int i=0;i<dn.length;i++)resp[c][i]+=r.counts[dn[i]]/(double)SEEDS.length;
            }
        }
        double seconds=(System.nanoTime()-t0)/1e9;
        int responding=0;double[] spread=new double[dn.length],mean=new double[dn.length];
        for(int i=0;i<dn.length;i++){double s=0,s2=0;for(int c=0;c<16;c++){double v=resp[c][i]-base[i];s+=v;s2+=v*v;}mean[i]=s/16;spread[i]=Math.sqrt(Math.max(0,s2/16-mean[i]*mean[i]));if(resp[0][i]+base[i]>0||spread[i]>0)responding++;}
        Integer[] order=new Integer[dn.length];for(int i=0;i<order.length;i++)order[i]=i;Arrays.sort(order,(a,b)->Double.compare(spread[b],spread[a]));
        List<Integer> chosen=new ArrayList<>();
        for(int i:order){if(chosen.size()==12)break;if(spread[i]<=0)break;boolean dup=false;
            for(int j:chosen)if(Math.abs(corr(resp,base,i,j))>0.9){dup=true;break;}
            if(!dup)chosen.add(i);}
        if(chosen.size()<12)throw new IllegalStateException("only "+chosen.size()+" descending neurons tell the groups apart");
        JSONArray sources=new JSONArray(),outputs=new JSONArray(),outInfo=new JSONArray(),groupsOut=new JSONArray();
        for(int c=0;c<16;c++){JSONObject src=groups.getJSONObject(c);sources.put(src.getJSONArray("neurons").getString(0));
            groupsOut.put(new JSONObject().put("cell",c).put("eye",src.getString("eye")).put("centre",src.getJSONArray("centre")).put("neurons",src.getJSONArray("neurons")).put("types",src.getJSONArray("types")));}
        for(int i:chosen){outputs.put(Long.toString(g.ids[dn[i]]));JSONArray byGroup=new JSONArray();for(int c=0;c<16;c++)byGroup.put(Math.round((resp[c][i]-base[i])*100)/100.0);
            outInfo.put(new JSONObject().put("id",Long.toString(g.ids[dn[i]])).put("background",Math.round(base[i]*100)/100.0).put("spread",Math.round(spread[i]*100)/100.0).put("responseByGroup",byGroup));}
        /* the same canonical text and hash the app and the bridge recompute (RoutingProfile) */
        String sha=RoutingProfile.sha256(RoutingProfile.canonical(REVISION,g.fingerprint(),sources,outputs,groupsOut));
        JSONObject profile=new JSONObject().put("type","male-cns-routing-profile").put("version",1).put("revision",REVISION).put("profile_sha256",sha)
            .put("graph_sha256",g.fingerprint()).put("annotations_sha256",stage1.getString("annotations_sha256"))
            .put("inputs",new JSONObject().put("cells",16).put("neuronsPerCell",16).put("rateHzPerUnit",500).put("map","image 4x4, left two columns -> left eye, right two -> right eye; patch = 16 LC/LPLC neurons nearest the cell centre in the eye's principal-axis frame"))
            .put("groups",groupsOut).put("sources",sources).put("outputs",outputs)
            .put("outputSelection",new JSONObject().put("protocol","background "+BACKGROUND_HZ+" Hz on all 256, one group raised to "+RAISED_HZ+" Hz, "+WINDOW_MS+" ms, seeds "+Arrays.toString(SEEDS)+"; response = count - background count")
                .put("rule","largest spread across groups, |corr| <= 0.9 with any chosen").put("descendingResponding",responding).put("of",dn.length).put("outputs",outInfo).put("measureSeconds",Math.round(seconds)));
        Files.write(Paths.get(args[3]),profile.toString(1).getBytes(StandardCharsets.UTF_8));
        System.out.println("profile "+sha.substring(0,16)+": "+responding+"/"+dn.length+" descending neurons respond; outputs spread "+chosen.stream().map(i->String.format("%.1f",spread[i])).reduce((a,b)->a+" "+b).get()+" ("+Math.round(seconds)+" s)");
    }
    static double corr(double[][] r,double[] base,int a,int b){double ma=0,mb=0;for(int c=0;c<16;c++){ma+=r[c][a]-base[a];mb+=r[c][b]-base[b];}ma/=16;mb/=16;double sab=0,saa=0,sbb=0;for(int c=0;c<16;c++){double x=r[c][a]-base[a]-ma,y=r[c][b]-base[b]-mb;sab+=x*y;saa+=x*x;sbb+=y*y;}return saa>0&&sbb>0?sab/Math.sqrt(saa*sbb):0;}
}
