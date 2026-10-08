#!/usr/bin/env python3
import hashlib,subprocess,sys,tempfile,urllib.request
from pathlib import Path
base='https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/'
files={'Connectivity_783.parquet':('d386555d1a5f40ebfa1380bcb05b1fab044855fd',100804642),'Completeness_783.csv':('b5a26b82b69a3c2e7fd99cd6810c36fc8f0e492b',3327347)}
with tempfile.TemporaryDirectory() as t:
 p=Path(t)
 for name,(sha,size) in files.items():
  with urllib.request.urlopen(base+name,timeout=120) as r: data=r.read()
  blob=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
  if blob!=sha or len(data)!=size:raise RuntimeError('Source changed: '+name)
  (p/name).write_bytes(data)
 subprocess.run([sys.executable,'tools/convert_shiu.py',str(p/'Connectivity_783.parquet'),str(p/'Completeness_783.csv'),'app/src/main/assets/brain.fly.gz'],check=True)
subprocess.run([sys.executable,'tools/bundle_male_cns.py'],check=True)
