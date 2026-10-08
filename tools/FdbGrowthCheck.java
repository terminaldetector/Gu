package org.node.flyconsole;
public final class FdbGrowthCheck {
    private static void require(boolean x,String message){if(!x)throw new AssertionError(message);}
    private static Engine.Result result(int... counts){return new Engine.Result(counts,0,10,10,0);}
    public static void main(String[] args){
        Graph g=new Graph(new long[]{1,2,3},new int[]{0,0,0,0},new int[0],new float[0]);
        GraphDelta layer=new GraphDelta(3);
        FdbGrowth growth=new FdbGrowth(g,layer,new int[]{0},new int[]{1,2},2,1,2,120,true,false,7);
        require(growth.observe(result(1,0,0),0,new int[0],false)==0,"interval");
        require(growth.observe(result(1,0,0),0,new int[0],false)==1,"exploration grows real edge");
        Engine.Options o=new Engine.Options();o.delta=layer;
        Engine.Result baseline=new Engine(g).advance(new int[]{0},new double[]{1000},100,new Engine.Options(),new java.util.concurrent.atomic.AtomicBoolean());
        Engine.Result changed=new Engine(g).advance(new int[]{0},new double[]{1000},100,o,new java.util.concurrent.atomic.AtomicBoolean());
        int target=layer.edges().get(0).target;
        require(baseline.counts[target]==0&&changed.counts[target]>0,"grown edge must execute in actual LIF engine");
        long plasticVersion=layer.version();
        require(layer.setGrowthWeight(0,target,32f),"grown weight updates");
        require(layer.version()==plasticVersion+1,"weight revision propagates to runtimes");
        require(layer.outgoing(0).get(0).weight==32f&&layer.edges().get(0).weight==32f,"adjacency and storage agree");
        require(!layer.setGrowthWeight(0,target,32f),"unchanged weight is not a mutation");
        Engine.Result weaker=new Engine(g).advance(new int[]{0},new double[]{1000},100,o,new java.util.concurrent.atomic.AtomicBoolean());
        require(weaker.counts[target]<=changed.counts[target],"lower learned synapse cannot increase firing in this isolated excitatory fixture");
        long cp=layer.checkpoint();
        layer.setGrowthWeight(0,target,0f);
        require(layer.outgoing(0).get(0).weight==0f,"synapse can be silenced");
        layer.rollback(cp);
        require(layer.outgoing(0).get(0).weight==32f,"plastic synapse rollback");
        boolean rejected=false;
        try{layer.setGrowthWeight(0,target,Float.NaN);}catch(IllegalArgumentException expected){rejected=true;}
        require(rejected,"reject non-finite plasticity");
        long version=layer.version();growth.observe(result(1,1,1),1,new int[0],true);require(layer.version()==version,"frozen");
        for(int i=0;i<12;i++)growth.observe(result(1,1,1),1,new int[0],false);
        require(layer.growthCount()==2,"cap and no duplicates");
        GraphDelta repeat=new GraphDelta(3);FdbGrowth same=new FdbGrowth(g,repeat,new int[]{0},new int[]{1,2},2,1,2,120,true,false,7);
        same.observe(result(1,0,0),0,new int[0],false);same.observe(result(1,0,0),0,new int[0],false);
        require(repeat.edges().get(0).target==target,"seed repeatability");
        GraphDelta gated=new GraphDelta(3);FdbGrowth gate=new FdbGrowth(g,gated,new int[]{0},new int[]{1},1,1,1,8,true,true,1);
        require(gate.observe(result(1,0,0),0,new int[0],false)==0,"reward gate");
        require(gate.observe(result(1,0,0),1,new int[]{1},false)==0,"target lesion");
        require(gate.observe(result(1,0,0),1,new int[0],false)==1,"positive reward");
        GraphDelta hebb=new GraphDelta(3);FdbGrowth h=new FdbGrowth(g,hebb,new int[]{0},new int[]{1},1,1,1,8,false,false,1);
        require(h.observe(result(1,0,0),0,new int[0],false)==0,"no coactivity without explore");
        require(h.observe(result(0,1,0),0,new int[0],false)==1,"previous-window source, current-window target");
        GraphDelta original=new GraphDelta(3),resume=new GraphDelta(3);
        FdbGrowth first=new FdbGrowth(g,original,new int[]{0},new int[]{1,2},3,1,2,8,true,false,9);
        first.observe(result(1,0,0),0,new int[0],false);first.observe(result(1,0,0),0,new int[0],false);
        FdbGrowth second=new FdbGrowth(g,resume,new int[]{0},new int[]{1,2},3,1,2,8,true,false,99);
        second.restore(first.windows(),first.rng(),first.previous());
        require(first.observe(result(0,1,1),1,new int[0],false)==1&&second.observe(result(0,1,1),1,new int[0],false)==1,"checkpoint resumes scheduled window");
        require(original.edges().get(0).target==resume.edges().get(0).target,"checkpoint preserves seeded candidate and previous activity");
        require(first.previous().length==1,"checkpoint copies source activity, not entire connectome");
        long at=first.windows(),rng=first.rng();first.observe(result(1,1,1),1,new int[0],true);require(first.windows()==at&&first.rng()==rng,"eval freezes growth clock and RNG");
        System.out.println("PASS: structural growth, seeded exploration, caps, reward gate, lesions, frozen state and actual CPU output");
    }
}
