package org.node.flyconsole;
import java.io.*;import java.util.concurrent.atomic.AtomicBoolean;
public class EngineCheck {
 public static void main(String[] a)throws Exception{
  Graph graph=Graph.demo();Engine e=new Engine(graph);AtomicBoolean stop=new AtomicBoolean();
  String silent=e.run(1,0,100,stop);if(!silent.contains("\n0 импульсов"))throw new AssertionError(silent);
  e.reset();String active=e.run(1,150,1000,stop);if(active.contains("\n0 импульсов"))throw new AssertionError(active);
  stop.set(true);if(!e.run(1,150,1000,stop).contains("0.0 ms"))throw new AssertionError("cancel");
  try{Graph.read(new ByteArrayInputStream(new byte[12]),1000);throw new AssertionError("bad header");}catch(IOException expected){}
  try(InputStream in=new FileInputStream(a[0])){Graph real=Graph.read(in,10000000);if(real.ids.length!=3||real.targets.length!=2)throw new AssertionError("converter");if(real.weights[0]<=0||real.weights[1]>=0)throw new AssertionError("sign");}
  try(InputStream in=new FileInputStream(a[0])){Graph.read(in,1);throw new AssertionError("budget");}catch(IOException expected){}
  System.out.println("PASS: silence, stimulation, cancellation, invalid format, memory cap, converter IDs/signs");System.out.println(active);
 }
}
