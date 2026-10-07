#!/usr/bin/env python3
"""Execute the production compute shader in Mesa EGL, compare LIF trajectories."""
import ctypes as C, json, math, os, re
from pathlib import Path
os.environ.setdefault("EGL_PLATFORM","surfaceless")
os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE","1")
egl=C.CDLL("libEGL.so.1"); gl=C.CDLL("libGLESv2.so.2")
def fn(lib,name,restype,*args):
    f=getattr(lib,name);f.restype=restype;f.argtypes=list(args);return f
I=C.c_int; U=C.c_uint; P=C.c_void_p; F=C.c_float
getdisplay=fn(egl,"eglGetDisplay",P,P)
d=getdisplay(None); assert d
assert fn(egl,"eglInitialize",U,P,P,P)(d,None,None)
assert fn(egl,"eglBindAPI",U,U)(0x30A0)
attrs=(I*9)(0x3040,0x40,0x3033,1,0x3024,8,0x3025,8,0x3038)
cfg=P();count=I()
assert fn(egl,"eglChooseConfig",U,P,P,P,I,P)(d,attrs,C.byref(cfg),1,C.byref(count)) and count.value
ctx=fn(egl,"eglCreateContext",P,P,P,P,P)(d,cfg,None,(I*3)(0x3098,3,0x3038)); assert ctx
surf=fn(egl,"eglCreatePbufferSurface",P,P,P,P)(d,cfg,(I*5)(0x3057,1,0x3056,1,0x3038));assert surf
assert fn(egl,"eglMakeCurrent",U,P,P,P,P)(d,surf,surf,ctx)
createShader=fn(gl,"glCreateShader",U,U); shaderSource=fn(gl,"glShaderSource",None,U,I,P,P)
compileShader=fn(gl,"glCompileShader",None,U);shaderStatus=fn(gl,"glGetShaderiv",None,U,U,P)
shaderLog=fn(gl,"glGetShaderInfoLog",None,U,I,P,P)
createProgram=fn(gl,"glCreateProgram",U);attach=fn(gl,"glAttachShader",None,U,U)
link=fn(gl,"glLinkProgram",None,U);programStatus=fn(gl,"glGetProgramiv",None,U,U,P)
use=fn(gl,"glUseProgram",None,U); loc=fn(gl,"glGetUniformLocation",I,U,C.c_char_p)
ui=fn(gl,"glUniform1i",None,I,I);uf=fn(gl,"glUniform1f",None,I,F)
uiv=fn(gl,"glUniform1iv",None,I,I,P);ufv=fn(gl,"glUniform1fv",None,I,I,P)
gen=fn(gl,"glGenBuffers",None,I,P);bind=fn(gl,"glBindBuffer",None,U,U)
base=fn(gl,"glBindBufferBase",None,U,U,U);data=fn(gl,"glBufferData",None,U,C.c_ssize_t,P,U)
dispatch=fn(gl,"glDispatchCompute",None,U,U,U);barrier=fn(gl,"glMemoryBarrier",None,U)
mapping=fn(gl,"glMapBufferRange",P,U,C.c_ssize_t,C.c_ssize_t,U);unmap=fn(gl,"glUnmapBuffer",U,U)
error=fn(gl,"glGetError",U)
java=Path("app/src/main/java/org/node/flyconsole/GpuLifEngine.java").read_text()
block=java.split("private static final String STEP =",1)[1].split("private static final String CLEAR",1)[0]
source="".join(json.loads(x) for x in re.findall(r'"(?:\\.|[^"\\])*"',block)).encode()
sh=createShader(0x91B9);text=C.c_char_p(source);shaderSource(sh,1,C.byref(text),None);compileShader(sh)
ok=I();shaderStatus(sh,0x8B81,C.byref(ok))
if not ok.value:
    log=C.create_string_buffer(8192);shaderLog(sh,8192,None,log);raise AssertionError(log.value.decode())
program=createProgram();attach(program,sh);link(program);programStatus(program,0x8B82,C.byref(ok));assert ok.value
buffers=(U*10)();gen(10,buffers);SSBO=0x90D2
def upload(index,values,typ=I):
    a=(typ*len(values))(*values);bind(SSBO,buffers[index]);data(SSBO,C.sizeof(a),a,0x88E8)
def read(index,length,typ=F):
    bind(SSBO,buffers[index]);p=mapping(SSBO,0,length*4,1);assert p
    values=list((typ*length).from_buffer_copy(C.string_at(p,length*4)));assert unmap(SSBO);return values
def run(weight=120,prob=1,gain=1,disable=0,lesions=(0,0)):
    upload(0,[-52,-52],F);upload(1,[0,0],F);upload(2,[0,0])
    upload(3,[0]*38);upload(5,[0,0]);upload(6,[0,1,1]);upload(7,[1])
    upload(8,[round(weight*256)&65535],U);upload(9,lesions)
    use(program)
    for i in range(10):base(SSBO,i,buffers[3 if i==4 else i])
    for name,val in {"N":2,"seed":1,"edges":1,"inputCount":1,"disableInhibition":disable}.items():ui(loc(program,name.encode()),val)
    uf(loc(program,b"gain"),gain)
    uiv(loc(program,b"inputIds"),1,(I*1)(0));ufv(loc(program,b"inputProb"),1,(F*1)(prob))
    v=[-52.,-52.];cur=[0.,0.];ref=[0,0];counts=[0,0];pending=[[0.,0.] for _ in range(19)]
    ev=math.exp(-.1/20);eg=math.exp(-.1/5);coupling=(ev-eg)/3
    for tick in range(40):
        ui(loc(program,b"tick"),tick);dispatch(1,1,1);barrier(0x2000|0x200)
        assert error()==0,"OpenGL error"
        due=pending[tick%19]
        for i in range(2):
            if lesions[i]:v[i]=-52;cur[i]=0;ref[i]=0;due[i]=0;continue
            cur[i]+=due[i];due[i]=0
            if ref[i]>0:ref[i]-=1
            else:v[i]=-52+(v[i]+52)*ev+cur[i]*coupling;cur[i]*=eg
        if prob and not lesions[0]:v[0]+=68.75
        for i in range(2):
            if lesions[i] or v[i]<=-45:continue
            counts[i]+=1;v[i]=-52;cur[i]=0;ref[i]=0 if i==0 else 22
            if i==0 and not lesions[1] and not(disable and weight<0):pending[(tick+18)%19][1]+=weight*gain
        actual=read(5,2,I)
        assert actual==counts,(tick,actual,counts)
        for label,actual,expected in [("voltage",read(0,2),v),("current",read(1,2),cur)]:
            assert all(abs(a-b)<.005 for a,b in zip(actual,expected)),(label,tick,actual,expected)
    return counts
assert run()==[40,1]
assert run(prob=0)==[0,0]
assert run(gain=0)==[40,0]
assert run(weight=-120,disable=1)==[40,0]
assert run(lesions=(0,1))==[40,0]
print("PASS: actual GLES31 production shader; CPU LIF trajectory, 1.8ms delay, inhibition, gain, lesions, silence")
