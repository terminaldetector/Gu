package org.node.flyconsole;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;

/** The Male CNS sensorimotor routing profile (male-cns-routing-v1.json): 16 image
 *  cells -> 16 groups of 16 visual projection neurons (256 stimulated) -> the full
 *  graph -> 12 descending outputs chosen from their measured response. ONE reader
 *  for the Android app and the headless bridge, so both run the same agent. The
 *  profile's sha256 is recomputed here from its content and becomes part of the
 *  FDB checkpoint identity (FdbLearning.sensorProfile). */
public final class RoutingProfile {
    public static final String ASSET="male-cns-routing-v1.json",REVISION="male-cns-routing-v1";
    public final String sha256,revision;
    public final int[] stimulus,stimulusGroup,sources,outputs;
    public final double rateHzPerUnit;

    private RoutingProfile(String sha,String revision,int[] stimulus,int[] group,int[] sources,int[] outputs,double rate){
        this.sha256=sha;this.revision=revision;this.stimulus=stimulus;this.stimulusGroup=group;this.sources=sources;this.outputs=outputs;this.rateHzPerUnit=rate;
    }

    /** the text the profile's sha256 is taken over: revision, graph, sources, outputs, every group's neurons */
    public static String canonical(String revision,String graphSha,JSONArray sources,JSONArray outputs,JSONArray groups)throws Exception{
        StringBuilder b=new StringBuilder();
        b.append("revision=").append(revision).append('\n').append("graph_sha256=").append(graphSha).append('\n')
         .append("sources=").append(sources.toString()).append('\n').append("outputs=").append(outputs.toString()).append('\n');
        for(int i=0;i<groups.length();i++)b.append("group").append(i).append('=').append(groups.getJSONObject(i).getJSONArray("neurons").toString()).append('\n');
        return b.toString();
    }
    public static String sha256(String text)throws Exception{
        byte[] d=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder h=new StringBuilder();for(byte x:d)h.append(String.format("%02x",x));return h.toString();
    }

    public static RoutingProfile read(JSONObject p,Graph graph)throws Exception{
        if(!"male-cns-routing-profile".equals(p.optString("type"))||p.optInt("version")!=1)throw new IOException("Неверный профиль маршрутизации");
        String revision=p.getString("revision"),graphSha=p.getString("graph_sha256");
        if(!graphSha.equals(graph.fingerprint()))throw new IOException("Профиль маршрутизации принадлежит другому графу");
        JSONArray groups=p.getJSONArray("groups"),sources=p.getJSONArray("sources"),outputs=p.getJSONArray("outputs");
        String sha=sha256(canonical(revision,graphSha,sources,outputs,groups));
        if(!sha.equals(p.getString("profile_sha256")))throw new IOException("SHA256 профиля маршрутизации не совпадает с содержимым");
        if(groups.length()!=16||sources.length()!=16||outputs.length()!=12)throw new IOException("Профиль: нужно 16 групп, 16 источников и 12 выходов");
        int per=groups.getJSONObject(0).getJSONArray("neurons").length();if(per<1||16*per>256)throw new IOException("Профиль: размер группы");
        int[] stimulus=new int[16*per],group=new int[16*per],src=new int[16],out=new int[12];HashSet<Integer> seen=new HashSet<>();
        for(int c=0;c<16;c++){JSONArray ns=groups.getJSONObject(c).getJSONArray("neurons");if(ns.length()!=per)throw new IOException("Профиль: группы разного размера");
            for(int j=0;j<per;j++){int k=index(graph,ns.getString(j));if(!seen.add(k))throw new IOException("Профиль: нейрон в двух группах");stimulus[c*per+j]=k;group[c*per+j]=c;}
            src[c]=index(graph,sources.getString(c));if(src[c]!=stimulus[c*per])throw new IOException("Профиль: источник группы не её первый нейрон");}
        HashSet<Integer> outs=new HashSet<>();for(int i=0;i<12;i++){out[i]=index(graph,outputs.getString(i));if(seen.contains(out[i])||!outs.add(out[i]))throw new IOException("Профиль: выход совпадает со входом или повторяется");}
        double rate=p.getJSONObject("inputs").getDouble("rateHzPerUnit");if(!(rate>0&&rate<=1000))throw new IOException("Профиль: частота");
        return new RoutingProfile(sha,revision,stimulus,group,src,out,rate);
    }
    private static int index(Graph graph,String id)throws IOException{int k=Arrays.binarySearch(graph.ids,Long.parseLong(id));if(k<0)throw new IOException("Профиль: нейрон не принадлежит графу");return k;}

    /** the experiment that runs this profile: learner ports = sources/outputs, stimulus = all 256 */
    public Experiment experiment(int count){if(count!=8&&count!=12)throw new IllegalArgumentException("8/12 outputs");Experiment e=new Experiment(sources,Arrays.copyOf(outputs,count));e.attachProfile(stimulus,stimulusGroup,sha256,rateHzPerUnit);return e;}
}
