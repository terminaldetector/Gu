package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/** RoutingProfile (directive M2.1): one reader for the app and the bridge.
 *  No arguments: a synthetic graph and profile - sha recomputed, tampering and a
 *  foreign graph refused, 16 -> N expansion with the profile's rate, the profile
 *  kept on the same ports and dropped on others, and a checkpoint never restored
 *  through another sensor profile (and byte-identical without one).
 *  With GRAPH PROFILE: the real Male CNS asset validates against the real graph. */
public final class RoutingProfileCheck {
    static void require(boolean ok,String what){if(!ok)throw new AssertionError(what);}
    static boolean refuses(Callable c){try{c.run();return false;}catch(Exception e){return true;}}
    interface Callable{void run()throws Exception;}
    public static void main(String[] args)throws Exception{
        if(args.length==2){
            Graph g=Graph.read(new FileInputStream(args[0]),1_500_000_000L);
            RoutingProfile p=RoutingProfile.read(new JSONObject(new String(Files.readAllBytes(Paths.get(args[1])),StandardCharsets.UTF_8)),g);
            Experiment e=p.experiment(12);
            require(e.stimulusInputs().length==256&&e.inputs.length==16&&e.outputs.length==12,"256 stimulated, 16 sources, 12 outputs");
            System.out.println("PASS: the Male CNS routing profile "+p.sha256.substring(0,16)+" validates against the full graph: 256 stimulated neurons, 16 sources, 12 descending outputs");
            return;
        }
        int n=300;long[] ids=new long[n];int[] off=new int[n+1];for(int i=0;i<n;i++)ids[i]=1000+i;
        List<Integer> t=new ArrayList<>();List<Float> w=new ArrayList<>();
        for(int i=0;i<n;i++){off[i]=t.size();for(int k=1;k<=3;k++){t.add((i*7+k*13)%n);w.add((float)(k%2==0?-2:3));}}
        off[n]=t.size();int[] tar=t.stream().mapToInt(Integer::intValue).toArray();float[] wei=new float[w.size()];for(int i=0;i<wei.length;i++)wei[i]=w.get(i);
        Graph g=new Graph(ids,off,tar,wei);
        JSONArray groups=new JSONArray(),sources=new JSONArray(),outputs=new JSONArray();
        for(int c=0;c<16;c++){JSONArray ns=new JSONArray();for(int j=0;j<4;j++)ns.put(Long.toString(ids[c*4+j]));groups.put(new JSONObject().put("cell",c).put("neurons",ns));sources.put(ns.getString(0));}
        for(int i=0;i<12;i++)outputs.put(Long.toString(ids[200+i]));
        String sha=RoutingProfile.sha256(RoutingProfile.canonical(RoutingProfile.REVISION,g.fingerprint(),sources,outputs,groups));
        JSONObject profile=new JSONObject().put("type","male-cns-routing-profile").put("version",1).put("revision",RoutingProfile.REVISION).put("profile_sha256",sha)
            .put("graph_sha256",g.fingerprint()).put("inputs",new JSONObject().put("rateHzPerUnit",400)).put("groups",groups).put("sources",sources).put("outputs",outputs);
        RoutingProfile p=RoutingProfile.read(profile,g);
        require(p.sha256.equals(sha),"sha recomputed from the content");
        Experiment e=p.experiment(12);
        require(e.stimulusInputs().length==64&&e.sensorProfile().equals(sha),"64 stimulated neurons, profile carried");
        double[] port=new double[16];for(int i=0;i<16;i++)port[i]=i;
        double[] r=e.stimulusRates(port);require(r.length==64&&r[0]==0&&r[5]==1&&r[63]==15,"each port rate drives its whole group");
        double[] bright=new double[16];Arrays.fill(bright,.5);require(e.rates(bright)[0]==200,"the profile's rate (400 Hz per unit) replaces maxHz: "+e.rates(bright)[0]);
        require(p.experiment(8).outputs.length==8,"8-button consoles take the first 8 outputs");
        /* tampering, foreign graph */
        JSONObject tampered=new JSONObject(profile.toString());tampered.getJSONArray("groups").getJSONObject(3).getJSONArray("neurons").put(1,Long.toString(ids[250]));
        require(refuses(()->RoutingProfile.read(tampered,g)),"a profile whose content does not match its sha256 is refused");
        Graph other=new Graph(ids,off,tar,Arrays.copyOf(wei,wei.length));other.weights[0]=99;
        require(refuses(()->RoutingProfile.read(profile,other)),"a profile is refused on any other graph");
        /* reconfiguration */
        Experiment same=new Experiment(e.inputs,e.outputs);same.keepProfileFrom(e);require(same.sensorProfile().equals(sha)&&same.stimulusInputs().length==64,"same ports keep the profile");
        int[] moved=e.inputs.clone();moved[0]=ids.length-1;Experiment diff=new Experiment(moved,e.outputs);diff.keepProfileFrom(e);
        require(diff.sensorProfile().isEmpty()&&diff.stimulusInputs().length==16,"other ports drop it: no silent reuse");
        /* checkpoint identity */
        GraphDelta layer=new GraphDelta(n);FdbLearning withProfile=new FdbLearning(g,layer,e.inputs,e.outputs,.1,128,127);withProfile.sensorProfile(sha);
        JSONObject state=FdbCheckpoint.save(withProfile,g,e.inputs,e.outputs);require(sha.equals(state.optString("sensorProfile")),"the checkpoint records the profile");
        FdbLearning plain=new FdbLearning(g,new GraphDelta(n),e.inputs,e.outputs,.1,128,127);
        require(refuses(()->FdbCheckpoint.restore(plain,new JSONObject(state.toString()),g,e.inputs,e.outputs)),"not restored without the profile");
        FdbLearning again=new FdbLearning(g,new GraphDelta(n),e.inputs,e.outputs,.1,128,127);again.sensorProfile(sha);
        FdbCheckpoint.restore(again,new JSONObject(state.toString()),g,e.inputs,e.outputs);
        require(!FdbCheckpoint.save(plain,g,e.inputs,e.outputs).has("sensorProfile"),"without a profile the checkpoint has no sensor key (unchanged format)");
        System.out.println("PASS: routing profile - sha recomputed, tampering and foreign graphs refused, 16 -> N expansion at the profile's rate, kept on the same ports and dropped on others, checkpoint identity enforced");
    }
}
