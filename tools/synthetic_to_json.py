"""Convert existing FLY1 starter bytes to portable JSON; preserves float32 graph SHA."""
import hashlib,json,struct,sys
from pathlib import Path
source=Path(sys.argv[1]); destination=Path(sys.argv[2]); destination.mkdir(parents=True,exist_ok=True)
for path in sorted(source.glob('*.fly')):
 raw=path.read_bytes();magic,n,m=struct.unpack_from('>III',raw);assert magic==0x464c5931
 cursor=12
 def take(code,count):
  global cursor
  result=list(struct.unpack_from('>'+code*count,raw,cursor));cursor+=struct.calcsize('>'+code*count);return result
 ids=take('q',n);offsets=take('i',n+1);targets=take('i',m);weights=take('f',m)
 assert cursor==len(raw)
 data={'type':'fly-synthetic-graph','version':1,'encoding':'csr-float32','name':path.stem,'graph_sha256':hashlib.sha256(raw[4:]).hexdigest(),'ids':list(map(str,ids)),'offsets':offsets,'targets':targets,'weights':weights,'provenance':{'kind':'synthetic-reservoir','trained':False,'source':'FlyConsole Synthetic Starters v1','note':'Synthetic topology; empirical weight magnitude samples from FlyWire, not Male CNS anatomy. ROM-independent W0. Learned state belongs in a Layer Set.'}}
 target=destination/(path.stem+'.json');target.write_text(json.dumps(data,separators=(',',':'))+'\n');print(target,len(raw),target.stat().st_size)
