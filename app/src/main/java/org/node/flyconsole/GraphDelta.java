package org.node.flyconsole;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;

/**
 * Bounded mutable FDB layer kept outside the immutable connectome.
 * It can add weight deltas and new edges, checkpoint, rollback and expose a
 * compact growth genome. It is intentionally separate from LoRA-style
 * parameter replacement: the base CSR never changes.
 */
public final class GraphDelta {
    public static final int DEFAULT_MAX_GROWTH = 65536;
    public static final class Edge {
        public final int source, target;
        public final float weight;
        Edge(int source, int target, float weight) { this.source=source; this.target=target; this.weight=weight; }
    }
    private static final class Snapshot {
        final HashMap<Long,Float> deltas;
        final ArrayList<Edge> edges;
        final long version;
        Snapshot(HashMap<Long,Float> d, ArrayList<Edge> e, long v) {
            deltas=new HashMap<>(d); edges=new ArrayList<>(e); version=v;
        }
    }
    private final int neuronCount;
    private final int maxGrowth;
    private final HashMap<Long,Float> weightDeltas = new HashMap<>();
    private final ArrayList<Edge> growth = new ArrayList<>();
    private final HashMap<Integer,ArrayList<Edge>> bySource = new HashMap<>();
    private long version;
    public GraphDelta(int neuronCount) { this(neuronCount, DEFAULT_MAX_GROWTH); }
    public GraphDelta(int neuronCount, int maxGrowth) {
        if(neuronCount<1||maxGrowth<0||maxGrowth>1_000_000) throw new IllegalArgumentException("Неверный лимит FDB");
        this.neuronCount=neuronCount;this.maxGrowth=maxGrowth;
    }
    private void check(int source,int target){if(source<0||source>=neuronCount||target<0||target>=neuronCount)throw new IllegalArgumentException("Неверная вершина FDB");}
    private static long key(int source,int target){return (((long)source)<<32)^(target&0xffffffffL);}
    public synchronized long version(){return version;}
    public synchronized int growthCount(){return growth.size();}
    public synchronized int deltaCount(){return weightDeltas.size();}
    public synchronized List<Edge> deltas(){
        ArrayList<Edge> out=new ArrayList<>();
        for(java.util.Map.Entry<Long,Float> e:new java.util.TreeMap<>(weightDeltas).entrySet())out.add(new Edge((int)(e.getKey()>>32),(int)(long)e.getKey(),e.getValue()));
        return out;
    }
    public synchronized List<Edge> edges(){return new ArrayList<>(growth);}
    public synchronized boolean hasEdge(int source,int target){
        for(Edge e:outgoing(source))if(e.target==target)return true;return false;
    }
    public synchronized void addWeightDelta(int source,int target,float amount){
        check(source,target);if(!Float.isFinite(amount))throw new IllegalArgumentException("Неверная дельта FDB");
        long k=key(source,target);float next=weightDeltas.containsKey(k)?weightDeltas.get(k)+amount:amount;
        if(!Float.isFinite(next)||Math.abs(next)>32768f)throw new IllegalArgumentException("Дельта вне q16.8 диапазона");
        if(!weightDeltas.containsKey(k)&&next!=0f&&weightDeltas.size()>=maxGrowth)throw new IllegalStateException("Лимит дельт FDB достигнут");
        if(next==0f)weightDeltas.remove(k);else weightDeltas.put(k,next);version++;
    }
    public synchronized float weightDelta(int source,int target){Float x=weightDeltas.get(key(source,target));return x==null?0f:x;}
    public synchronized int addEdge(int source,int target,float weight){
        check(source,target);if(!Float.isFinite(weight)||Math.abs(weight)>128f)throw new IllegalArgumentException("Вес FDB вне границ");
        if(source==target||hasEdge(source,target))throw new IllegalArgumentException("FDB: петля или повторная связь");
        if(growth.size()>=maxGrowth)throw new IllegalStateException("Лимит роста FDB достигнут");
        Edge edge=new Edge(source,target,weight);growth.add(edge);
        ArrayList<Edge> list=bySource.get(source);if(list==null){list=new ArrayList<>();bySource.put(source,list);}list.add(edge);version++;return growth.size()-1;
    }
    public synchronized List<Edge> outgoing(int source){
        ArrayList<Edge> list=bySource.get(source);return list==null?Collections.<Edge>emptyList():new ArrayList<>(list);
    }
    public synchronized long checkpoint(){
        if(checkpoints.size()>=16)throw new IllegalStateException("Лимит 16 контрольных точек FDB");
        checkpoints.add(new Snapshot(weightDeltas,growth,version));return checkpoints.size()-1;
    }
    public synchronized void rollback(long token){
        if(token<0||token>=checkpoints.size())throw new IllegalArgumentException("Неизвестная контрольная точка FDB");
        Snapshot s=checkpoints.get((int)token);weightDeltas.clear();weightDeltas.putAll(s.deltas);growth.clear();growth.addAll(s.edges);bySource.clear();
        for(Edge e:growth){ArrayList<Edge> list=bySource.get(e.source);if(list==null){list=new ArrayList<>();bySource.put(e.source,list);}list.add(e);}version++;
    }
    public synchronized String genome(){
        StringBuilder out=new StringBuilder("FDB1;v=").append(version).append(";d=");
        boolean first=true;for(java.util.Map.Entry<Long,Float> e:new java.util.TreeMap<>(weightDeltas).entrySet()){if(!first)out.append('|');first=false;out.append((int)(e.getKey()>>32)).append(':').append((int)(long)e.getKey()).append(':').append(String.format(Locale.US,"%.6g",e.getValue()));}
        out.append(";e=");for(int i=0;i<growth.size();i++){if(i>0)out.append('|');Edge e=growth.get(i);out.append(e.source).append(':').append(e.target).append(':').append(String.format(Locale.US,"%.6g",e.weight));}return out.toString();
    }
    private final ArrayList<Snapshot> checkpoints = new ArrayList<>();
}
