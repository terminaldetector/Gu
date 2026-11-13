package org.node.flyconsole;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Does visual stimulation reach the descending and motor levels of the FULL
 *  Male CNS in the production LIF engine? (directive 2026-11-13, section 3.1:
 *  "select dynamically active circuits from the observed response").
 *  usage: MaleCnsActivityProbe GRAPH.fly.gz ROUTING.json [PHOTORECEPTOR_IDS.txt]
 *  Stimulates (a) the manifest's 16 default inputs, (b) 256 photoreceptors from
 *  the routing atlas, at several rates and windows, and counts spikes in every
 *  descending and motor neuron. Nothing is cut from the graph. */
public final class MaleCnsActivityProbe {
    public static void main(String[] args)throws Exception{
        Graph g=Graph.read(new FileInputStream(args[0]),1_500_000_000L);
        JSONObject atlas=new JSONObject(new String(Files.readAllBytes(Paths.get(args[1]))));
        JSONObject sets=atlas.getJSONObject("sets");
        int[] dn=indices(g,sets.getJSONArray("descending")),motor=indices(g,sets.getJSONArray("motor"));
        /* 256 photoreceptors: the first R1-R6 cells of the graph's own order, from the manifest's input types */
        List<Integer> r16=new ArrayList<>();JSONObject manifest=new JSONObject(new String(Files.readAllBytes(Paths.get(args[0].replaceAll("\\.gz$","").replaceAll("\\.fly$","")+".fly.json"))));
        JSONArray inTypes=manifest.getJSONArray("default_input_types"),inIds=manifest.getJSONArray("default_inputs");
        for(int i=0;i<inIds.length();i++)r16.add(Arrays.binarySearch(g.ids,Long.parseLong(inIds.getString(i))));
        if(args.length>2)for(String id:new String(Files.readAllBytes(Paths.get(args[2]))).trim().split("\\s+"))if(r16.size()<256)r16.add(Arrays.binarySearch(g.ids,Long.parseLong(id)));
        int[] many=r16.stream().mapToInt(Integer::intValue).toArray();
        JSONObject man=new JSONObject(new String(Files.readAllBytes(Paths.get(args[0].replaceAll("\\.gz$","").replaceAll("\\.fly$","")+".fly.json"))));
        int[] ports=indices(g,man.getJSONArray("default_inputs"));
        JSONArray vp=sets.getJSONArray("visualProjection");List<Integer> loom=new ArrayList<>(),lc=new ArrayList<>();
        for(int i=0;i<vp.length();i++){JSONArray v=vp.getJSONArray(i);String t=v.optString(1);int k=Arrays.binarySearch(g.ids,Long.parseLong(v.getString(0)));
            if((t.equals("LPLC2")||t.equals("LC4"))&&loom.size()<256)loom.add(k);
            if((t.startsWith("LC")||t.startsWith("LPLC"))&&lc.size()<256&&i%7==0)lc.add(k);}
        int[] looming=loom.stream().mapToInt(Integer::intValue).toArray(),lcMix=lc.stream().mapToInt(Integer::intValue).toArray();
        Engine e=new Engine(g);Engine.Options o=new Engine.Options();
        JSONArray rows=new JSONArray();
        for(Object[] set:new Object[][]{{"manifest-16",ports},{"photoreceptors-256",many},{"looming-VPN-LPLC2+LC4-256",looming},{"LC/LPLC-mixed-256",lcMix}})
            for(double rate:new double[]{200,500})for(int window:new int[]{50,200}){
                e.reset(11);int[] in=(int[])set[1];double[] rates=new double[in.length];Arrays.fill(rates,rate);
                long t=System.nanoTime();Engine.Result r=e.advance(in,rates,window,o,new AtomicBoolean());double ms=(System.nanoTime()-t)/1e6;
                int dnActive=0,motorActive=0;long dnSpikes=0,motorSpikes=0;TreeMap<Integer,Integer> top=new TreeMap<>(Collections.reverseOrder());
                for(int i:dn){if(r.counts[i]>0){dnActive++;dnSpikes+=r.counts[i];}}
                for(int i:motor){if(r.counts[i]>0){motorActive++;motorSpikes+=r.counts[i];}}
                JSONArray topDn=new JSONArray();Integer[] order=Arrays.stream(dn).boxed().sorted((x,y)->r.counts[y]-r.counts[x]).limit(6).toArray(Integer[]::new);
                for(int i:order)if(r.counts[i]>0)topDn.put(new JSONObject().put("id",Long.toString(g.ids[i])).put("spikes",r.counts[i]));
                JSONObject row=new JSONObject().put("stimulus",set[0]).put("topDescending",topDn).put("neurons",in.length).put("rateHz",rate).put("windowMs",window)
                    .put("totalSpikes",r.spikes).put("activeNeurons",r.active).put("descendingActive",dnActive).put("descendingSpikes",dnSpikes)
                    .put("motorActive",motorActive).put("motorSpikes",motorSpikes).put("wallMs",Math.round(ms));
                rows.put(row);System.out.println(row);
            }
        System.out.println(new JSONObject().put("kind","male-cns-activity-probe").put("graphSha",g.fingerprint()).put("descending",dn.length).put("motor",motor.length).put("rows",rows.length()));
    }
    static int[] indices(Graph g,JSONArray ids){int[] out=new int[ids.length()];for(int i=0;i<out.length;i++){out[i]=Arrays.binarySearch(g.ids,Long.parseLong(ids.getString(i)));if(out[i]<0)throw new IllegalArgumentException("id not in graph");}return out;}
}
