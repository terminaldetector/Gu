package org.node.flyconsole;
import java.util.*;
public final class Engine {
 private final Graph graph; private final double[] v,g; private final int[] refractory; private final float[][] pending;
 private final Random rng=new Random(1); private int tick;
 public Engine(Graph graph){this.graph=graph;int n=graph.ids.length;v=new double[n];g=new double[n];refractory=new int[n];pending=new float[19][n];reset();}
 public void reset(){Arrays.fill(v,-52);Arrays.fill(g,0);Arrays.fill(refractory,0);for(float[] a:pending)Arrays.fill(a,0);tick=0;rng.setSeed(1);}
 public String run(long id,double hz,int durationMs,java.util.concurrent.atomic.AtomicBoolean cancel){
  int input=Arrays.binarySearch(graph.ids,id);if(input<0)throw new IllegalArgumentException("Неизвестный ID");
  long start=System.nanoTime(),spikes=0;int[] counts=new int[v.length];int steps=durationMs*10,done=0;
  double ev=Math.exp(-.1/20),eg=Math.exp(-.1/5),coupling=(ev-eg)/3;
  for(int s=0;s<steps&&!cancel.get();s++,tick++,done++){
   float[] due=pending[tick%19];
   for(int i=0;i<v.length;i++){
    g[i]+=due[i];due[i]=0;
    if(refractory[i]>0){refractory[i]--;continue;}v[i]=-52+(v[i]+52)*ev+g[i]*coupling;g[i]*=eg;
   }
   if(rng.nextDouble()<1-Math.exp(-hz*.0001))v[input]+=.275*250;
   for(int i=0;i<v.length;i++)if(v[i]>-45){
    counts[i]++;spikes++;v[i]=-52;g[i]=0;refractory[i]=i==input?0:22;
    float[] future=pending[(tick+18)%19];for(int e=graph.offsets[i];e<graph.offsets[i+1];e++)future[graph.targets[e]]+=graph.weights[e];
   }
  }
  double wall=(System.nanoTime()-start)/1e9;int active=0;for(int c:counts)if(c>0)active++;
  StringBuilder out=new StringBuilder(String.format(Locale.US,"%s %.1f ms · %.3f s на CPU · ×%.2f\n%d импульсов · %d активных нейронов",cancel.get()?"Остановлено":"Завершено",done*.1,wall,done*.0001/Math.max(wall,1e-9),spikes,active));
  for(int k=0;k<Math.min(8,counts.length);k++){int best=0;for(int i=1;i<counts.length;i++)if(counts[i]>counts[best])best=i;if(counts[best]==0)break;out.append("\n").append(graph.ids[best]).append(": ").append(counts[best]);counts[best]=0;}
  return out.toString();
 }
}
