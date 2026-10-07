package org.node.flyconsole;

import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES30;
import android.opengl.GLES31;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * OpenGL ES 3.1 compute backend for the sparse LIF graph.
 * CSR is immutable; state remains in SSBOs and weights are float32; delayed events use signed q24.8 accumulation.
 */
public final class GpuLifEngine implements AutoCloseable {
    private static final int LOCAL = 64;
    private static final String STEP =
        "#version 310 es\n" +
        "layout(local_size_x=64) in;\n" +
        "layout(std430,binding=0) buffer V{float v[];};\n" +
        "layout(std430,binding=1) buffer I{float c[];};\n" +
        "layout(std430,binding=2) buffer R{int r[];};\n" +
        "layout(std430,binding=3) buffer PI{int pi[];};\n" +
        "layout(std430,binding=4) readonly buffer X{uint extra[];};\n" +
        "layout(std430,binding=5) buffer C{int counts[];};\n" +
        "layout(std430,binding=6) readonly buffer O{int off[];};\n" +
        "layout(std430,binding=7) readonly buffer T{int target[];};\n" +
        "layout(std430,binding=8) readonly buffer W{float weight[];};\n" +
        "layout(std430,binding=9) readonly buffer L{uint lesion[];};\n" +
        "uniform int N,tick,seed,edges,inputCount,inputIds[256];\n" +
        "uniform float inputProb[256],gain; uniform int disableInhibition;\n" +
        "uint h32(uint x){x+=0x9e3779b9u;x=(x^(x>>16u))*0x85ebca6bu;x=(x^(x>>13u))*0xc2b2ae35u;return x^(x>>16u);}\n" +
        "void main(){uint u=gl_GlobalInvocationID.x;if(u>=uint(N))return;int i=int(u);\n" +
        "int due=(tick%19)*N+i;\n" +
        "if(lesion[i]!=0u){v[i]=-52.;c[i]=0.;r[i]=0;pi[due]=0;return;}\n" +
        "float x=v[i],cur=c[i]+float(pi[due])/256.;pi[due]=0;bool driven=false;\n" +
        "for(int k=0;k<inputCount;k++)if(inputIds[k]==i)driven=true;\n" +
        "if(r[i]>0){r[i]--;}else{x=-52.+(x+52.)*0.9950124791926823+cur*0.004937935295309022;cur*=0.9801986733067553;}\n" +
        "for(int k=0;k<inputCount;k++)if(inputIds[k]==i){uint q=h32(uint(seed)^(uint(tick)*1103515245u)^(u*2654435761u));if(float(q&16777215u)/16777216.<inputProb[k])x+=68.75;}\n" +
        "if(x>-45.){x=-52.;cur=0.;r[i]=driven?0:22;counts[i]++;int future=((tick+18)%19)*N;for(int e=off[i];e<off[i+1]&&e<edges;e++){float w=weight[e];if(lesion[target[e]]!=0u||(disableInhibition!=0&&w<0.))continue;atomicAdd(pi[future+target[e]],int(round(w*gain*256.)));}for(uint e=extra[i];e<extra[i+1];e+=2u){int t=int(extra[e]);float w=uintBitsToFloat(extra[e+1u]);if(lesion[t]!=0u||(disableInhibition!=0&&w<0.))continue;atomicAdd(pi[future+t],int(round(w*gain*256.)));}}\n" +
        "v[i]=x;c[i]=cur;}\n";
    private static final String CLEAR =
        "#version 310 es\nlayout(local_size_x=64) in;layout(std430,binding=0) buffer X{int x[];};uniform int N;void main(){uint i=gl_GlobalInvocationID.x;if(i<uint(N))x[i]=0;}\n";

    private final Graph graph;
    private final int n, edges;
    private final int[] buffers = new int[10];
    private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
    private EGLContext context = EGL14.EGL_NO_CONTEXT;
    private EGLSurface surface = EGL14.EGL_NO_SURFACE;
    private int stepProgram, clearProgram, tickLocation;
    private int seed;
    private long tick;
    private boolean closed;
    private GraphDelta uploadedLayer;
    private long uploadedVersion=-1;
    private final double[] incomingMagnitude;
    private final java.util.HashSet<Integer> patchedWeights=new java.util.HashSet<>();

    public GpuLifEngine(Graph graph) {
        if (graph == null || graph.ids.length == 0) throw new IllegalArgumentException("Пустой граф");
        this.graph = graph; this.n = graph.ids.length; this.edges = graph.targets.length;this.incomingMagnitude=new double[n];
        for(int e=0;e<edges;e++)incomingMagnitude[graph.targets[e]]+=Math.abs(graph.weights[e]);
        for(double sum:incomingMagnitude)if(!Double.isFinite(sum)||sum>4_000_000)throw new IllegalArgumentException("GPU delayed-event accumulator range exceeded");
        try {
            createContext();
            stepProgram = link(STEP);
            tickLocation=GLES31.glGetUniformLocation(stepProgram,"tick");
            clearProgram = link(CLEAR);
            GLES31.glGenBuffers(buffers.length, buffers, 0);
            uploadStatic();
            reset(1L);
        } catch (Throwable ex) {
            close();
            if (ex instanceof RuntimeException) throw (RuntimeException)ex;
            throw new IllegalStateException("GPU init: " + ex.getMessage(), ex);
        }
    }

    public String backendName() { return "gpu-gles31-f32-q24.8-events"; }

    public synchronized void reset(long newSeed) {
        ensureOpen();
        seed = (int)(newSeed ^ (newSeed >>> 32)); tick = 0L;
        uploadFloat(0, filled(n, -52f)); uploadFloat(1, new float[n]);
        uploadInt(2, new int[n]); uploadInt(3, new int[Math.multiplyExact(n,19)]);
        uploadInt(5, new int[n]); uploadInt(9, new int[n]);checkGl("state reset");
    }

    public synchronized Engine.Result advance(int[] inputs, double[] rates, int durationMs,
                                               Engine.Options options, AtomicBoolean cancel) {
        ensureOpen();
        if (inputs == null || rates == null || inputs.length != rates.length || inputs.length > 256)
            throw new IllegalArgumentException("GPU вход должен содержать до 256 пар");
        if (durationMs < 1 || durationMs > 10000) throw new IllegalArgumentException("Неверная длительность");
        if (options == null) options = new Engine.Options();
        if (options.gain < 0 || options.gain > 2 || !Double.isFinite(options.gain))
            throw new IllegalArgumentException("Неверный gain");
        syncLayer(options.delta);
        uploadInputs(inputs, rates);
        uploadInt(9, lesionWords(options.lesions));
        clear(5);
        long started = System.nanoTime();
        int steps = durationMs * 10, done = 0;
        GLES31.glUseProgram(stepProgram); bindAll(); setUniforms(options);
        for (; done < steps && (cancel == null || !cancel.get()); done++, tick++) {
            GLES31.glUniform1i(tickLocation, (int)tick);
            GLES31.glDispatchCompute((n + LOCAL - 1) / LOCAL, 1, 1);
            GLES31.glMemoryBarrier(GLES31.GL_SHADER_STORAGE_BARRIER_BIT);

        }
        GLES31.glMemoryBarrier(GLES31.GL_SHADER_STORAGE_BARRIER_BIT | GLES31.GL_BUFFER_UPDATE_BARRIER_BIT);
        checkGl("compute steps");
        int[] counts = readInts(5, n); long spikes = 0;
        for (int c : counts) spikes += c;
        return new Engine.Result(counts, spikes, tick, done, (System.nanoTime()-started)/1e9);
    }

    private void createContext() {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (display == EGL14.EGL_NO_DISPLAY) throw new IllegalStateException("EGL display unavailable");
        int[] ver = new int[2];
        if (!EGL14.eglInitialize(display, ver, 0, ver, 1)) throw new IllegalStateException("EGL initialize failed");
        int[] attrs = {EGL14.EGL_RENDERABLE_TYPE,0x40,EGL14.EGL_SURFACE_TYPE,EGL14.EGL_PBUFFER_BIT,
            EGL14.EGL_RED_SIZE,8,EGL14.EGL_GREEN_SIZE,8,EGL14.EGL_BLUE_SIZE,8,EGL14.EGL_ALPHA_SIZE,8,EGL14.EGL_NONE};
        EGLConfig[] cfg = new EGLConfig[1]; int[] count = new int[1];
        if (!EGL14.eglChooseConfig(display, attrs, 0, cfg, 0, 1, count, 0) || count[0] == 0)
            throw new IllegalStateException("EGL ES 3.1 config unavailable");
        int[] ca = {EGL14.EGL_CONTEXT_CLIENT_VERSION,3,EGL14.EGL_NONE};
        context = EGL14.eglCreateContext(display,cfg[0],EGL14.EGL_NO_CONTEXT,ca,0);
        if (context == EGL14.EGL_NO_CONTEXT) throw new IllegalStateException("EGL context unavailable");
        int[] sa = {EGL14.EGL_WIDTH,1,EGL14.EGL_HEIGHT,1,EGL14.EGL_NONE};
        surface = EGL14.eglCreatePbufferSurface(display,cfg[0],sa,0);
        if (surface == EGL14.EGL_NO_SURFACE || !EGL14.eglMakeCurrent(display,surface,surface,context))
            throw new IllegalStateException("EGL makeCurrent failed");
        String gl = GLES31.glGetString(GLES31.GL_VERSION);
        int[] limits=new int[1];
        GLES31.glGetIntegerv(GLES31.GL_MAJOR_VERSION,limits,0);int major=limits[0];
        GLES31.glGetIntegerv(GLES31.GL_MINOR_VERSION,limits,0);int minor=limits[0];
        if(major<3||(major==3&&minor<1))throw new IllegalStateException("OpenGL ES 3.1 required: "+gl);
        GLES31.glGetIntegerv(GLES31.GL_MAX_COMPUTE_SHADER_STORAGE_BLOCKS,limits,0);
        if(limits[0]<10)throw new IllegalStateException("GPU requires 10 compute SSBO blocks; device supports "+limits[0]);
        GLES31.glGetIntegerv(GLES31.GL_MAX_SHADER_STORAGE_BUFFER_BINDINGS,limits,0);
        if(limits[0]<10)throw new IllegalStateException("GPU requires 10 SSBO bindings");
        GLES31.glGetIntegerv(GLES31.GL_MAX_SHADER_STORAGE_BLOCK_SIZE,limits,0);
        long largest=Math.max(4L*edges,76L*n);
        if(largest>limits[0])throw new IllegalStateException("GPU buffer exceeds device SSBO size limit");
    }

    private void uploadStatic() {
        uploadInt(6,graph.offsets);uploadInt(7,graph.targets);uploadFloat(8,graph.weights);
        uploadInt(4,emptyOverlay());checkGl("graph upload");
    }
    private int[] emptyOverlay(){int[] a=new int[n+1];Arrays.fill(a,n+1);return a;}
    private void syncLayer(GraphDelta layer) {
        if(layer==uploadedLayer&&(layer==null||layer.version()==uploadedVersion))return;
        java.util.List<GraphDelta.Edge> deltas=java.util.Collections.emptyList(), extras=java.util.Collections.emptyList();
        long revision=-1;
        if(layer!=null)synchronized(layer){revision=layer.version();deltas=layer.deltas();extras=layer.edges();}
        double[] magnitude=incomingMagnitude.clone();
        for(GraphDelta.Edge d:deltas)for(int e=graph.offsets[d.source];e<graph.offsets[d.source+1];e++)if(graph.targets[e]==d.target)magnitude[d.target]+=Math.abs(graph.weights[e]+d.weight)-Math.abs(graph.weights[e]);
        for(GraphDelta.Edge e:extras)magnitude[e.target]+=Math.abs(e.weight);
        for(double sum:magnitude)if(!Double.isFinite(sum)||sum>4_000_000)throw new IllegalArgumentException("FDB exceeds GPU delayed-event range");
        // Restore previous sparse patches before applying the new revision.
        for(int e:patchedWeights)patchWeight(e,graph.weights[e]);patchedWeights.clear();
        for(GraphDelta.Edge d:deltas) {
            boolean found=false;
            for(int e=graph.offsets[d.source];e<graph.offsets[d.source+1];e++)if(graph.targets[e]==d.target){
                patchWeight(e,graph.weights[e]+d.weight);patchedWeights.add(e);found=true;
            }
            if(!found)throw new IllegalArgumentException("FDB delta requires base edge");
        }
        int[] a=new int[n+1+extras.size()*2], counts=new int[n];
        for(GraphDelta.Edge e:extras)counts[e.source]++;
        a[0]=n+1;for(int i=0;i<n;i++)a[i+1]=a[i]+2*counts[i];
        int[] cursor=Arrays.copyOf(a,n);
        for(GraphDelta.Edge e:extras){int pos=cursor[e.source];a[pos]=e.target;a[pos+1]=Float.floatToIntBits(e.weight);cursor[e.source]+=2;}
        uploadInt(4,a);checkGl("FDB upload");uploadedLayer=layer;uploadedVersion=revision;
    }
    private void patchWeight(int edge,float weight){
        if(!Float.isFinite(weight)||Math.abs(weight)>4_000_000f)throw new IllegalArgumentException("GPU event weight out of range");
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,buffers[8]);
        GLES31.glBufferSubData(GLES31.GL_SHADER_STORAGE_BUFFER,edge*4,4,directFloats(new float[]{weight}));
    }

    private void uploadInputs(int[] inputs,double[] rates) {
        int[] ids=new int[256];float[] p=new float[256];
        for(int i=0;i<inputs.length;i++){
            if(inputs[i]<0||inputs[i]>=n||!Double.isFinite(rates[i])||rates[i]<0||rates[i]>1000)
                throw new IllegalArgumentException("Неверный GPU вход");
            for(int j=0;j<i;j++)if(inputs[j]==inputs[i])throw new IllegalArgumentException("Повторяющийся вход");
            ids[i]=inputs[i];p[i]=(float)(1-Math.exp(-rates[i]*.0001));
        }
        GLES31.glUseProgram(stepProgram);
        GLES31.glUniform1iv(GLES31.glGetUniformLocation(stepProgram,"inputIds[0]"),256,ids,0);
        GLES31.glUniform1fv(GLES31.glGetUniformLocation(stepProgram,"inputProb[0]"),256,p,0);
        GLES31.glUniform1i(GLES31.glGetUniformLocation(stepProgram,"inputCount"),inputs.length);
    }

    private void setUniforms(Engine.Options o) {
        GLES31.glUniform1i(GLES31.glGetUniformLocation(stepProgram,"N"),n);
        GLES31.glUniform1i(GLES31.glGetUniformLocation(stepProgram,"edges"),edges);
        GLES31.glUniform1i(GLES31.glGetUniformLocation(stepProgram,"seed"),seed);
        GLES31.glUniform1f(GLES31.glGetUniformLocation(stepProgram,"gain"),(float)o.gain);
        GLES31.glUniform1i(GLES31.glGetUniformLocation(stepProgram,"disableInhibition"),o.disableInhibition?1:0);
    }
    private void bindAll(){for(int i=0;i<buffers.length;i++)GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,i,buffers[i]);}
    private void clear(int index) {
        GLES31.glUseProgram(clearProgram);GLES31.glBindBufferBase(GLES31.GL_SHADER_STORAGE_BUFFER,0,buffers[index]);
        GLES31.glUniform1i(GLES31.glGetUniformLocation(clearProgram,"N"),n);
        GLES31.glDispatchCompute((n+LOCAL-1)/LOCAL,1,1);GLES31.glMemoryBarrier(GLES31.GL_SHADER_STORAGE_BARRIER_BIT);
        GLES31.glUseProgram(stepProgram);bindAll();
    }
    private int[] lesionWords(int[] lesions){int[] out=new int[n];if(lesions!=null)for(int id:lesions){if(id<0||id>=n)throw new IllegalArgumentException("Неверная абляция");out[id]=1;}return out;}
    private void uploadFloat(int i,float[] a){GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,buffers[i]);GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER,a.length*4,directFloats(a),GLES31.GL_DYNAMIC_DRAW);}
    private void uploadInt(int i,int[] a){GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,buffers[i]);GLES31.glBufferData(GLES31.GL_SHADER_STORAGE_BUFFER,a.length*4,directInts(a),GLES31.GL_DYNAMIC_DRAW);}
    private int[] readInts(int i,int len){
        GLES31.glBindBuffer(GLES31.GL_SHADER_STORAGE_BUFFER,buffers[i]);
        ByteBuffer b=(ByteBuffer)GLES30.glMapBufferRange(GLES31.GL_SHADER_STORAGE_BUFFER,0,len*4,GLES30.GL_MAP_READ_BIT);
        if(b==null)throw new IllegalStateException("GPU readback failed");b.order(ByteOrder.nativeOrder());
        int[] out=new int[len];b.asIntBuffer().get(out);GLES30.glUnmapBuffer(GLES31.GL_SHADER_STORAGE_BUFFER);return out;
    }
    private int link(String src){
        int shader=GLES31.glCreateShader(GLES31.GL_COMPUTE_SHADER);GLES31.glShaderSource(shader,src);GLES31.glCompileShader(shader);
        int[] ok=new int[1];GLES31.glGetShaderiv(shader,GLES31.GL_COMPILE_STATUS,ok,0);
        if(ok[0]==0){String log=GLES31.glGetShaderInfoLog(shader);GLES31.glDeleteShader(shader);throw new IllegalStateException("GPU shader: "+log);}
        int p=GLES31.glCreateProgram();GLES31.glAttachShader(p,shader);GLES31.glLinkProgram(p);GLES31.glGetProgramiv(p,GLES31.GL_LINK_STATUS,ok,0);GLES31.glDeleteShader(shader);
        if(ok[0]==0){String log=GLES31.glGetProgramInfoLog(p);GLES31.glDeleteProgram(p);throw new IllegalStateException("GPU link: "+log);}return p;
    }
    private static float[] filled(int n,float x){float[] a=new float[n];Arrays.fill(a,x);return a;}
    private static FloatBuffer directFloats(float[] a){ByteBuffer b=ByteBuffer.allocateDirect(a.length*4).order(ByteOrder.nativeOrder());FloatBuffer f=b.asFloatBuffer();f.put(a).position(0);return f;}
    private static IntBuffer directInts(int[] a){ByteBuffer b=ByteBuffer.allocateDirect(a.length*4).order(ByteOrder.nativeOrder());IntBuffer i=b.asIntBuffer();i.put(a).position(0);return i;}
    private static void checkGl(String operation){int error=GLES31.glGetError();if(error!=GLES31.GL_NO_ERROR)throw new IllegalStateException(operation+": GLES error "+error);}
    private void ensureOpen(){if(closed)throw new IllegalStateException("GPU backend closed");}
    @Override public synchronized void close(){
        if(closed)return;closed=true;
        if(display!=EGL14.EGL_NO_DISPLAY){
            if(stepProgram!=0)GLES31.glDeleteProgram(stepProgram);if(clearProgram!=0)GLES31.glDeleteProgram(clearProgram);
            GLES31.glDeleteBuffers(buffers.length,buffers,0);
            EGL14.eglMakeCurrent(display,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_SURFACE,EGL14.EGL_NO_CONTEXT);
            if(surface!=EGL14.EGL_NO_SURFACE)EGL14.eglDestroySurface(display,surface);
            if(context!=EGL14.EGL_NO_CONTEXT)EGL14.eglDestroyContext(display,context);EGL14.eglTerminate(display);
        }
        display=EGL14.EGL_NO_DISPLAY;context=EGL14.EGL_NO_CONTEXT;surface=EGL14.EGL_NO_SURFACE;
    }
}

