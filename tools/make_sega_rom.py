"""Original MIT Genesis diagnostic: RGB backdrop, Right/Left score, B PSG tone."""
import struct,json,base64
from pathlib import Path
rom=bytearray(65536);pc=0x200;labels={};fix=[]
def words(*values):
 global pc
 for v in values:struct.pack_into('>H',rom,pc,v&65535);pc+=2
def long(v):words(v>>16,v)
def label(n):labels[n]=pc
def branch(code,n):
 words(code,0);fix.append((pc-2,n))
def mw(v,addr):words(0x33fc,v);long(addr)
def mb(v,addr):words(0x13fc,v);long(addr)
def ml(v,addr):words(0x23fc);long(v);long(addr)
struct.pack_into('>II',rom,0,0xffff00,0x200)
for i in range(2,64):struct.pack_into('>I',rom,i*4,0x200)
for off,length,text in [(0x100,16,'SEGA MEGA DRIVE'),(0x110,16,'(C)FLY 2026'),(0x120,48,'FLY LAB ORIGINAL DIAGNOSTIC'),(0x150,48,'FLY LAB ORIGINAL DIAGNOSTIC'),(0x180,14,'GM FLY00000-00'),(0x190,16,'J'),(0x1f0,16,'U')]:rom[off:off+length]=text.encode().ljust(length,b' ')
struct.pack_into('>IIII',rom,0x1a0,0,len(rom)-1,0xff0000,0xffffff)
words(0x46fc,0x2700)
for r in [0x8004,0x8104,0x8230,0x8407,0x8578,0x8f02,0x8700]:mw(r,0xc00004)
ml(0x40000000,0xc00004);words(0x203c);long(0);words(0x323c,0x3fff);label('clear');words(0x23c0);long(0xc00000);branch(0x51c9,'clear')
mw(0x8144,0xc00004);words(0x4279);long(0xff0000)
mb(0x40,0xa10009);mb(0x40,0xa10003)
for value in [0x85,0x10,0x9f,0xbf,0xdf,0xff]:mb(value,0xc00011)
label('endblank');words(0x3039);long(0xc00004);words(0x0800,3);branch(0x6600,'endblank')
label('blank');words(0x3039);long(0xc00004);words(0x0800,3);branch(0x6700,'blank')
words(0x1039);long(0xa10003);words(0x0800,3);branch(0x6600,'left');words(0x5279);long(0xff0000)
label('left');words(0x0800,2);branch(0x6600,'tone');words(0x5379);long(0xff0000)
label('tone');words(0x0800,4);branch(0x6600,'quiet');mb(0x90,0xc00011);branch(0x6000,'colour')
label('quiet');mb(0x9f,0xc00011)
label('colour');ml(0xc0000000,0xc00004);words(0x3039);long(0xff0000);words(0x0240,0x000e,0x0040,0x00e0,0x33c0);long(0xc00000);branch(0x6000,'endblank')
for pos,n in fix:struct.pack_into('>h',rom,pos,labels[n]-pos)
checksum=sum(struct.unpack('>'+str((len(rom)-512)//2)+'H',rom[512:]))&65535;struct.pack_into('>H',rom,0x18e,checksum)
out=Path(__file__).resolve().parents[1]/'app/src/main/assets/lab/demo-sega.json';out.write_text(json.dumps({'name':'Fly MD original diagnostic','license':'MIT','base64':base64.b64encode(rom).decode()},separators=(',',':')))
print('Original MD ROM',len(rom),'code bytes',pc-512)
