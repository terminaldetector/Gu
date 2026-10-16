package org.node.flyconsole;

import java.util.*;

/** Sparse, transactional upload planner. No GL calls, no mutation of W0.
 * A plan is committed only after all driver uploads succeed. Lists and revisions
 * are captured under one layer lock, including threshold state. */
final class GpuLayerSync {
    static final class Span {
        final int word; final int[] bits;
        Span(int word,int[] bits){this.word=word;this.bits=bits;}
    }
    static final class Plan {
        GraphDelta layer;long version,root,topology,weight,threshold;
        Map<Integer,Float> roots,thresholds;
        List<GraphDelta.Edge> extras;
        int[] positions,overlay;
        List<Span> rootSpans=Collections.emptyList(),extraSpans=Collections.emptyList(),thresholdSpans=Collections.emptyList();
    }
    private final Graph graph;
    private final double[] magnitude;
    private Plan current;
    GpuLayerSync(Graph graph,double[] magnitude){this.graph=graph;this.magnitude=magnitude;}
    void resetThresholds(){if(current!=null){current.threshold=-1;current.version=-1;current.thresholds=Collections.emptyMap();}}
    private static long pair(GraphDelta.Edge e){return ((long)e.source<<32)|(e.target&0xffffffffL);}
    Plan prepare(GraphDelta layer){
        Plan p=new Plan();p.layer=layer;
        List<GraphDelta.Edge> deltas=null;
        boolean rootDirty,topologyDirty,weightDirty,thresholdDirty;
        // The null case still restores all previously changed values.
        Object lock=layer==null?this:layer;
        synchronized(lock){
            p.version=layer==null?0:layer.version();
            if(current!=null&&current.layer==layer&&current.version==p.version)return null;
            boolean switched=current==null||current.layer!=layer;
            p.root=layer==null?0:layer.rootRevision();p.topology=layer==null?0:layer.topologyRevision();
            p.weight=layer==null?0:layer.weightRevision();p.threshold=layer==null?0:layer.thresholdRevision();
            rootDirty=switched||p.root!=current.root;topologyDirty=switched||p.topology!=current.topology;
            weightDirty=topologyDirty||p.weight!=current.weight;thresholdDirty=switched||p.threshold!=current.threshold;
            if(rootDirty)deltas=layer==null?Collections.emptyList():layer.deltas();
            p.extras=weightDirty?(layer==null?Collections.emptyList():layer.edges()):current.extras;
            p.thresholds=thresholdDirty?(layer==null?Collections.emptyMap():layer.thresholds()):current.thresholds;
        }
        Map<Integer,Float> oldRoots=current==null?Collections.emptyMap():current.roots;
        p.roots=rootDirty?new TreeMap<>():current.roots;
        if(rootDirty)for(GraphDelta.Edge d:deltas){
            boolean found=false;
            for(int i=graph.offsets[d.source];i<graph.offsets[d.source+1];i++)if(graph.targets[i]==d.target){
                float w=graph.weights[i]+d.weight;if(!Float.isFinite(w))throw new IllegalArgumentException("GPU nonfinite root");p.roots.put(i,w);found=true;
            }
            if(!found)throw new IllegalArgumentException("FDB delta requires base edge");
        }
        // Check only affected destinations. The immutable base magnitude was validated at init.
        if(rootDirty||weightDirty){
            Map<Integer,Double> adjustment=new HashMap<>();
            for(Map.Entry<Integer,Float> e:p.roots.entrySet()){int i=e.getKey(),t=graph.targets[i];adjustment.put(t,adjustment.getOrDefault(t,0.0)+Math.abs(e.getValue())-Math.abs(graph.weights[i]));}
            for(GraphDelta.Edge e:p.extras)adjustment.put(e.target,adjustment.getOrDefault(e.target,0.0)+Math.abs(e.weight));
            for(Map.Entry<Integer,Double> e:adjustment.entrySet()){double sum=magnitude[e.getKey()]+e.getValue();if(!Double.isFinite(sum)||sum>4_000_000)throw new IllegalArgumentException("FDB exceeds GPU delayed-event range");}
        }
        if(rootDirty){TreeMap<Integer,Integer> changed=new TreeMap<>();
            for(Map.Entry<Integer,Float> e:p.roots.entrySet())if(!e.getValue().equals(oldRoots.get(e.getKey())))changed.put(e.getKey(),Float.floatToIntBits(e.getValue()));
            for(int i:oldRoots.keySet())if(!p.roots.containsKey(i))changed.put(i,Float.floatToIntBits(graph.weights[i]));
            p.rootSpans=spans(changed);
        }
        // Across replacement/rollback the layout may actually be identical. Do not
        // rebuild an N-neuron adjacency merely because the layer instance changed.
        boolean same=current!=null&&p.extras.size()==current.extras.size();
        if(topologyDirty)for(int i=0;same&&i<p.extras.size();i++)same=pair(p.extras.get(i))==pair(current.extras.get(i));
        if(!topologyDirty)same=true;
        if(!same){
            int n=graph.ids.length;p.overlay=new int[n+1+p.extras.size()*2];int[] counts=new int[n];
            for(GraphDelta.Edge e:p.extras)counts[e.source]++;
            p.overlay[0]=n+1;for(int i=0;i<n;i++)p.overlay[i+1]=p.overlay[i]+2*counts[i];
            int[] cursor=Arrays.copyOf(p.overlay,n);p.positions=new int[p.extras.size()];
            for(int i=0;i<p.extras.size();i++){GraphDelta.Edge e=p.extras.get(i);int pos=cursor[e.source];p.overlay[pos]=e.target;p.overlay[pos+1]=Float.floatToIntBits(e.weight);p.positions[i]=pos+1;cursor[e.source]+=2;}
        }else{
            p.positions=current.positions;
            if(weightDirty){TreeMap<Integer,Integer> changed=new TreeMap<>();
                for(int i=0;i<p.extras.size();i++)if(p.extras.get(i).weight!=current.extras.get(i).weight)changed.put(p.positions[i],Float.floatToIntBits(p.extras.get(i).weight));
                p.extraSpans=spans(changed);
            }
        }
        if(thresholdDirty){Map<Integer,Float> old=current==null?Collections.emptyMap():current.thresholds;TreeMap<Integer,Integer> changed=new TreeMap<>();int n=graph.ids.length;
            for(Map.Entry<Integer,Float> e:p.thresholds.entrySet())if(!e.getValue().equals(old.get(e.getKey())))changed.put(n+e.getKey(),Float.floatToIntBits(e.getValue()));
            for(int i:old.keySet())if(!p.thresholds.containsKey(i))changed.put(n+i,0);
            p.thresholdSpans=spans(changed);
        }
        return p;
    }
    void commit(Plan plan){current=plan;plan.overlay=null;plan.rootSpans=Collections.emptyList();plan.extraSpans=Collections.emptyList();plan.thresholdSpans=Collections.emptyList();}
    static List<Span> spans(SortedMap<Integer,Integer> values){
        List<Span> spans=new ArrayList<>();if(values.isEmpty())return spans;
        int start=-1,last=-2;ArrayList<Integer> words=new ArrayList<>();
        for(Map.Entry<Integer,Integer> e:values.entrySet()){
            if(e.getKey()!=last+1&&!words.isEmpty()){spans.add(new Span(start,toArray(words)));words.clear();}
            if(words.isEmpty())start=e.getKey();words.add(e.getValue());last=e.getKey();
        }
        spans.add(new Span(start,toArray(words)));return spans;
    }
    private static int[] toArray(List<Integer> a){int[] out=new int[a.size()];for(int i=0;i<out.length;i++)out[i]=a.get(i);return out;}
}
