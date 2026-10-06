#!/usr/bin/env python3
"""Preserve Shiu v783 supplied signed connectivity, using original FlyWire IDs."""
import argparse,gzip,hashlib,json,struct
from pathlib import Path
import numpy as np
import pandas as pd
p=argparse.ArgumentParser();p.add_argument('connectivity',type=Path);p.add_argument('completeness',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
ids=np.sort(pd.read_csv(a.completeness,index_col=0).index.to_numpy(dtype=np.int64))
if len(ids)==0 or len(np.unique(ids))!=len(ids):p.error('Invalid neuron IDs')
d=pd.read_parquet(a.connectivity,columns=['Presynaptic_ID','Postsynaptic_ID','Excitatory x Connectivity'])
pre=np.searchsorted(ids,d.Presynaptic_ID);post=np.searchsorted(ids,d.Postsynaptic_ID)
if (pre>=len(ids)).any() or (post>=len(ids)).any():p.error('IDs missing from completeness')
if not (ids[pre]==d.Presynaptic_ID).all() or not (ids[post]==d.Postsynaptic_ID).all():p.error('IDs missing from completeness')
weights=d['Excitatory x Connectivity'].to_numpy(dtype=np.float32)*.275
if not np.isfinite(weights).all():p.error('Invalid weights')
order=np.argsort(pre,kind='stable');pre=pre[order];post=post[order];weights=weights[order]
off=np.concatenate([[0],np.cumsum(np.bincount(pre,minlength=len(ids)))])
a.output.parent.mkdir(parents=True,exist_ok=True)
with gzip.open(a.output,'wb',compresslevel=6) as f:
 f.write(struct.pack('>III',0x464c5931,len(ids),len(post)))
 for arr,dtype in [(ids,'>i8'),(off,'>i4'),(post,'>i4'),(weights,'>f4')]:f.write(np.asarray(arr,dtype=dtype).tobytes())
meta={'neurons':len(ids),'edges':len(post),'packed_bytes':12+12*len(ids)+4+8*len(post),'gzip_bytes':a.output.stat().st_size,'runtime_array_budget_bytes':116*len(ids)+8*len(post)+4,'source_sha256':hashlib.file_digest(a.connectivity.open('rb'),'sha256').hexdigest(),'completeness_sha256':hashlib.file_digest(a.completeness.open('rb'),'sha256').hexdigest(),'first_id':str(ids[0]),'source':'philshiu/Drosophila_brain_model Connectivity_783.parquet; original signed weights preserved','dynamics':'independent Android LIF implementation; Brian2 parity unverified'}
a.output.with_suffix('.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta,indent=2))
