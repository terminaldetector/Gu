package org.node.flyconsole;
import java.io.*;
public final class Graph {
 public final long[] ids; public final int[] offsets, targets; public final float[] weights;
 public Graph(long[] ids,int[] offsets,int[] targets,float[] weights){this.ids=ids;this.offsets=offsets;this.targets=targets;this.weights=weights;}
 private volatile String digest;
 public synchronized String fingerprint(){
  if(digest!=null)return digest;
  try{java.security.MessageDigest md=java.security.MessageDigest.getInstance("SHA-256");java.nio.ByteBuffer b=java.nio.ByteBuffer.allocate(8192);
   b.putInt(ids.length).putInt(targets.length);
   for(long id:ids){if(b.remaining()<8){md.update(b.array(),0,b.position());b.clear();}b.putLong(id);}
   for(int[] values:new int[][]{offsets,targets})for(int v:values){if(b.remaining()<4){md.update(b.array(),0,b.position());b.clear();}b.putInt(v);}
   for(float v:weights){if(b.remaining()<4){md.update(b.array(),0,b.position());b.clear();}b.putFloat(v);}
   md.update(b.array(),0,b.position());StringBuilder result=new StringBuilder();for(byte v:md.digest())result.append(String.format(java.util.Locale.US,"%02x",v&255));digest=result.toString();return digest;
  }catch(java.security.NoSuchAlgorithmException ex){throw new IllegalStateException(ex);}
 }
 public long memoryBytes(){return 8L*ids.length+4L*offsets.length+8L*targets.length+104L*ids.length;}
 public static Graph read(InputStream input,long budget) throws IOException {
  BufferedInputStream buffered=new BufferedInputStream(input);buffered.mark(2);int first=buffered.read(),second=buffered.read();buffered.reset();
  DataInputStream d=new DataInputStream(first==31&&second==139?new BufferedInputStream(new java.util.zip.GZIPInputStream(buffered),65536):buffered);
  if(d.readInt()!=0x464C5931)throw new IOException("Ожидается FLY1: сначала преобразуйте Feather/Parquet");
  int n=d.readInt(),m=d.readInt();
  if(n<1||n>1000000||m<0||m>100000000||116L*n+8L*m+4>budget)throw new IOException("Граф превышает безопасный бюджет памяти");
  long[] ids=new long[n];int[] off=new int[n+1],tar=new int[m];float[] wei=new float[m];
  for(int i=0;i<n;i++){ids[i]=d.readLong();if(i>0&&ids[i]<=ids[i-1])throw new IOException("ID должны возрастать");}
  for(int i=0;i<=n;i++){off[i]=d.readInt();if(off[i]<0||off[i]>m||(i>0&&off[i]<off[i-1]))throw new IOException("Повреждены offsets");}
  if(off[0]!=0||off[n]!=m)throw new IOException("Неверная длина CSR");
  for(int i=0;i<m;i++){tar[i]=d.readInt();if(tar[i]<0||tar[i]>=n)throw new IOException("Неверный target");}
  for(int i=0;i<m;i++){wei[i]=d.readFloat();if(!Float.isFinite(wei[i]))throw new IOException("Неверный вес");}
  if(d.read()!=-1)throw new IOException("Лишние данные"); return new Graph(ids,off,tar,wei);
 }
 public static Graph demo(){return new Graph(new long[]{1,2,3,4},new int[]{0,1,2,3,3},new int[]{1,2,3},new float[]{12,12,-12});}
}
