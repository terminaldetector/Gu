package org.node.flyconsole;
import java.io.*;
/** Serialize first load so concurrent activities never allocate the full graph twice. */
public final class GraphCache {
 private GraphCache(){}
 public interface Source {InputStream open()throws IOException;}
 public static volatile Graph current;
 public static volatile String kind="FlyWire v783 / Shiu signed model";
 public static volatile String notice="";
 public static volatile String modelId="flywire-v783";
 /** Named models share one cache slot, never a silently substituted second graph. */
 public static synchronized Graph loadNamed(String id,Source source,long budget,String description,String expectedSha)throws IOException{
  if(current!=null&&id.equals(modelId))return current;
  Graph loaded=readNamed(source,budget,expectedSha);installNamed(loaded,id,description);return loaded;
 }
 public static Graph readNamed(Source source,long budget,String expectedSha)throws IOException{
  Graph loaded;try(InputStream in=source.open()){loaded=Graph.read(in,budget);}
  if(expectedSha!=null&&!expectedSha.isEmpty()&&!loaded.fingerprint().equals(expectedSha))throw new IOException("SHA256 коннектома не совпадает с паспортом");return loaded;
 }
 public static synchronized void installNamed(Graph loaded,String id,String description){install(loaded,description);modelId=id;}
 public static synchronized Graph load(File model,Source bundled,long budget)throws IOException{
  if(current!=null)return current;Graph loaded;String description;String warning="";
  if(model.exists()){
   try(InputStream in=new FileInputStream(model)){loaded=Graph.read(in,budget);description="Imported graph";}
   catch(IOException ex){try(InputStream in=bundled.open()){loaded=Graph.read(in,budget);description="FlyWire v783 / Shiu signed model";warning="Сохранённый граф не загружен: "+ex.getMessage()+". Используется встроенный.";}}
  }else try(InputStream in=bundled.open()){loaded=Graph.read(in,budget);description="FlyWire v783 / Shiu signed model";}
  loaded.fingerprint();install(loaded,description);notice=warning;return loaded;
 }
 public static synchronized void install(Graph loaded,String description){notice="";kind=description;current=loaded;modelId=description.equals("Imported graph")?"imported":"flywire-v783";}
 public static boolean same(Graph left, Graph right){
  if(left==right)return true;
  if(left==null||right==null)return false;
  try{return left.fingerprint().equals(right.fingerprint());}
  catch(RuntimeException ex){return false;}
 }
}
