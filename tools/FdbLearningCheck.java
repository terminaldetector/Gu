package org.node.flyconsole;
public final class FdbLearningCheck {
    private static void require(boolean okay,String why){if(!okay)throw new AssertionError(why);}
    public static void main(String[] args){
        long[] ids=new long[28];for(int i=0;i<28;i++)ids[i]=i+1;
        Graph graph=new Graph(ids,new int[29],new int[0],new float[0]);
        GraphDelta layer=new GraphDelta(28);int[] sources=new int[16],targets=new int[12];
        for(int i=0;i<16;i++)sources[i]=i;for(int i=0;i<12;i++)targets[i]=16+i;
        FdbLearning l=new FdbLearning(graph,layer,sources,targets,.2,16,127);
        double[] retina=new double[16];retina[0]=1;
        for(int i=0;i<40;i++)l.observe(retina,2048,0,true,new int[0],false);
        require(layer.edges().size()==1&&layer.edges().get(0).target==27,"teacher aligns all 12 output bits");
        require(layer.edges().get(0).weight>120,"teacher strengthens actual synthetic edge");
        Engine.Options options=new Engine.Options();options.delta=layer;
        Engine.Result baseline=new Engine(graph).advance(new int[]{0},new double[]{1000},100,new Engine.Options(),new java.util.concurrent.atomic.AtomicBoolean());
        Engine.Result trained=new Engine(graph).advance(new int[]{0},new double[]{1000},100,options,new java.util.concurrent.atomic.AtomicBoolean());
        require(baseline.counts[27]==0&&trained.counts[27]>0,"consolidated edge changes real CPU engine output");
        float old=layer.edges().get(0).weight;
        l.observe(retina,2048,-1,false,new int[0],false);require(layer.edges().get(0).weight<old,"negative reward weakens selected path");
        long revision=layer.version(),count=l.observations();
        l.observe(retina,2048,1,false,new int[0],true);require(layer.version()==revision&&l.observations()==count,"evaluation freezes edge and counters");
        l.observe(retina,1,1,false,new int[]{16},false);require(layer.edges().size()==1,"lesions exclude targets");
        for(int i=0;i<100;i++)l.observe(new double[]{1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},4095&~48&~192,1,false,new int[0],false);
        require(layer.growthCount()==16,"edge cap");for(GraphDelta.Edge e:layer.edges())require(e.weight>=0&&e.weight<=127,"bounded weights");
        FdbLearning restored=new FdbLearning(graph,layer,sources,targets,.2,16,127);restored.restore(l.observations(),l.human(),l.automatic());
        require(restored.human()==40&&restored.observations()==l.observations(),"persist provenance");
        boolean rejected=false;try{restored.restore(1,2,0);}catch(IllegalArgumentException expected){rejected=true;}require(rejected,"reject inconsistent provenance");
        Graph withBase=new Graph(ids,new int[]{0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1},new int[]{16},new float[]{3});
        GraphDelta baseLayer=new GraphDelta(28);new FdbLearning(withBase,baseLayer,sources,targets,.2,16,127).observe(retina,1,0,true,new int[0],false);
        require(baseLayer.growthCount()==0&&baseLayer.deltaCount()==0&&withBase.weights[0]==3,"base connectome immutable");
        System.out.println("PASS: real FDB controller alignment, CPU output, reward depression, lesions, caps, frozen evaluation, checkpoint provenance and base preservation");
    }
}
