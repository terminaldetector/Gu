package org.node.flyconsole;

import java.io.IOException;
import org.json.*;

/** Portable W0, not a Layer Set. IDs are decimal strings to preserve int64 precision. */
final class SyntheticGraphJson {
    static final String TYPE="fly-synthetic-graph";
    static final int MAX_NODES=16384, MAX_EDGES=262144, MAX_BYTES=8*1024*1024;
    private static int integer(Object value,int min,int max)throws IOException {
        if(!(value instanceof Number))throw new IOException("Expected integer");
        double n=((Number)value).doubleValue();
        if(!Double.isFinite(n)||n!=Math.rint(n)||n<min||n>max)throw new IOException("Integer out of range");
        return (int)n;
    }
    static Graph read(JSONObject data,long budget)throws Exception {
        if(!TYPE.equals(data.optString("type"))||integer(data.get("version"),1,1)!=1||!"csr-float32".equals(data.getString("encoding")))throw new IOException("Unknown synthetic graph format");
        JSONArray ids=data.getJSONArray("ids"),offsets=data.getJSONArray("offsets"),targets=data.getJSONArray("targets"),weights=data.getJSONArray("weights");
        int n=ids.length(),m=targets.length();
        if(n<28||n>MAX_NODES||m>MAX_EDGES||offsets.length()!=n+1||weights.length()!=m||120L*n+8L*m+4>budget)throw new IOException("Graph size / memory budget");
        long[] ii=new long[n];int[] oo=new int[n+1],tt=new int[m];float[] ww=new float[m];
        for(int i=0;i<n;i++){
            Object id=ids.get(i);if(!(id instanceof String)||!((String)id).matches("[1-9][0-9]{0,18}"))throw new IOException("IDs must be positive decimal strings");
            ii[i]=Long.parseLong((String)id);if(i>0&&ii[i]<=ii[i-1])throw new IOException("IDs must increase");
        }
        for(int i=0;i<=n;i++){oo[i]=integer(offsets.get(i),0,m);if(i>0&&oo[i]<oo[i-1])throw new IOException("CSR offsets order");}
        if(oo[0]!=0||oo[n]!=m)throw new IOException("CSR endpoints");
        for(int i=0;i<m;i++){
            tt[i]=integer(targets.get(i),0,n-1);Object weight=weights.get(i);
            if(!(weight instanceof Number))throw new IOException("Weight must be numeric");double w=((Number)weight).doubleValue();
            if(!Double.isFinite(w)||Math.abs(w)>128)throw new IOException("Weight outside ±128");ww[i]=(float)w;
        }
        for(int s=0;s<n;s++)for(int e=oo[s];e<oo[s+1];e++)if(tt[e]==s||e>oo[s]&&tt[e]<=tt[e-1])throw new IOException("Targets must increase; no duplicates or self edges");
        Graph graph=new Graph(ii,oo,tt,ww);
        String sha=data.getString("graph_sha256");if(!sha.matches("[a-f0-9]{64}")||!graph.fingerprint().equals(sha))throw new IOException("Graph SHA256 mismatch");
        // Ensure the standard technical port selector can operate before installation.
        Experiment.automatic(graph,12);
        return graph;
    }
}
