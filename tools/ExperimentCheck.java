package org.node.flyconsole;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
public final class ExperimentCheck {
    static Graph graph() {
        long[] ids = new long[24]; int[] offsets = new int[25], targets = new int[16]; float[] weights = new float[16];
        for (int i=0;i<24;i++){ids[i]=i+1;offsets[i]=Math.min(i,16);}
        offsets[24]=16;
        for(int i=0;i<16;i++){targets[i]=16+i%8;weights[i]=30;}
        return new Graph(ids,offsets,targets,weights);
    }
    public static void main(String[] args) {
        Graph graph = graph(); Engine engine = new Engine(graph); Experiment experiment = Experiment.automatic(graph);
        AtomicBoolean cancel = new AtomicBoolean(); double[] screen = new double[16]; Arrays.fill(screen,1);
        double[] rates = experiment.rates(screen);
        Engine.Result a = engine.advance(experiment.inputs,rates,100,experiment.options,cancel);
        if(a.active<17 || a.spikes<1)throw new AssertionError("screen must propagate through graph");
        engine.reset(1); Engine.Result repeat = engine.advance(experiment.inputs,rates,100,experiment.options,cancel);
        if(!Arrays.equals(a.counts,repeat.counts))throw new AssertionError("seed replay");
        engine.reset(1); experiment.options.gain=0;
        Engine.Result disconnected = engine.advance(experiment.inputs,rates,100,experiment.options,cancel);
        for(int output:experiment.outputs)if(disconnected.counts[output]!=0)throw new AssertionError("zero gain");
        engine.reset(1); experiment.options.gain=1; experiment.options.lesions=new int[]{experiment.outputs[0]};
        Engine.Result lesioned=engine.advance(experiment.inputs,rates,100,experiment.options,cancel);
        if(lesioned.counts[experiment.outputs[0]]!=0)throw new AssertionError("lesion output");
        experiment.mode="observe";if(experiment.buttons(a)!=0)throw new AssertionError("observe must not control NES");
        experiment.mode="closed";int mask=experiment.buttons(a);if(mask==0)throw new AssertionError("closed loop buttons");
        if((mask&48)==48||(mask&192)==192)throw new AssertionError("opposing buttons");
        experiment.mode="sham";for(double rate:experiment.rates(screen))if(rate!=0)throw new AssertionError("sham input");
        experiment.mode="observe";experiment.scramble=true;experiment.seedPermutation(42);
        double[] gradient=new double[16];for(int i=0;i<16;i++)gradient[i]=i/16.0;
        double[] shuffled=experiment.rates(gradient);experiment.seedPermutation(42);
        if(!Arrays.equals(shuffled,experiment.rates(gradient)))throw new AssertionError("shuffle seed");
        engine.reset(7);experiment.options.lesions=new int[0];
        Engine.Result whole=engine.advance(experiment.inputs,rates,40,experiment.options,cancel);
        engine.reset(7);Engine.Result first=engine.advance(experiment.inputs,rates,20,experiment.options,cancel);
        Engine.Result second=engine.advance(experiment.inputs,rates,20,experiment.options,cancel);
        for(int i=0;i<whole.counts.length;i++)if(whole.counts[i]!=first.counts[i]+second.counts[i])throw new AssertionError("incremental state");
        cancel.set(true);if(engine.advance(experiment.inputs,rates,20,experiment.options,cancel).steps!=0)throw new AssertionError("stop");
        Graph inhibitory = new Graph(new long[]{1,2,3},new int[]{0,2,3,3},new int[]{1,2,2},new float[]{30,30,-1000});
        Engine ie = new Engine(inhibitory);Engine.Options io = new Engine.Options();cancel.set(false);
        Engine.Result normal = ie.advance(new int[]{0},new double[]{150},100,io,cancel);
        ie.reset(1);io.disableInhibition=true;
        Engine.Result disinhibited = ie.advance(new int[]{0},new double[]{150},100,io,cancel);
        if(disinhibited.counts[2]<=normal.counts[2])throw new AssertionError("negative edges intervention");
        System.out.println("PASS: screen-to-spikes-to-buttons, seed, sham, observe, gain, ablation, shuffle, incremental state, cancellation");
    }
}
