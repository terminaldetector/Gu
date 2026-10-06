#!/usr/bin/env python3
"""Convert measured connectivity to FLY1 CSR. Does not download or invent data."""
import argparse, hashlib, json, struct
from pathlib import Path
import numpy as np
import pandas as pd
p=argparse.ArgumentParser()
p.add_argument('source',type=Path);p.add_argument('output',type=Path)
p.add_argument('--max-neurons',type=int,help='Explicit induced subset, smallest IDs; NOT whole brain')
p.add_argument('--root-ids',type=Path,help='FlyWire proofread_root_ids_783.npy: preserve isolated neurons')
a=p.parse_args()
if a.max_neurons is not None and a.max_neurons<1:p.error('max-neurons must be positive')
df=pd.read_feather(a.source) if a.source.suffix=='.feather' else pd.read_parquet(a.source)
if 'Presynaptic_Index' in df:
 p.error('Use FlyWire ID data rather than index-only Shiu Parquet; index-only files require a separate completeness mapping')
required=['pre_pt_root_id','post_pt_root_id','syn_count']
if not set(required)<=set(df):p.error('Missing columns: '+str(required))
ids=np.unique(np.concatenate([df.pre_pt_root_id.to_numpy(dtype=np.int64),df.post_pt_root_id.to_numpy(dtype=np.int64)]))
if a.root_ids:ids=np.unique(np.concatenate([ids,np.load(a.root_ids).astype(np.int64)]))
if a.max_neurons:ids=ids[:a.max_neurons];df=df[df.pre_pt_root_id.isin(ids)&df.post_pt_root_id.isin(ids)].copy()
nt=['ach','gaba','glut','oct','ser','da'];cols=[x+'_avg' for x in nt]
if not set(cols)<=set(df):p.error('Missing neurotransmitter probabilities; refusing to guess signs')
prob=df[cols].to_numpy(dtype=float)
if not np.isfinite(prob).all() or (prob<0).any() or (prob>1).any():p.error('Invalid NT probabilities')
counts=df.syn_count.to_numpy(dtype=float)
if not np.isfinite(counts).all() or (counts<1).any():p.error('Invalid synapse counts')
# Infer presynaptic transmitter by synapse-count-weighted probabilities across outgoing rows.
# Signs are model assumptions: ACh +, GABA/glut -, modulatory classes 0.
weighted=pd.DataFrame(prob*counts[:,None],columns=nt);weighted['id']=df.pre_pt_root_id.to_numpy()
classes=weighted.groupby('id')[nt].sum().idxmax(axis=1)
signs=classes.map({'ach':1,'gaba':-1,'glut':-1,'oct':0,'ser':0,'da':0})
df['weight']=counts*.275*df.pre_pt_root_id.map(signs).to_numpy()
edges=df.groupby(['pre_pt_root_id','post_pt_root_id'],sort=True).weight.sum().reset_index()
edges=edges[edges.weight!=0]
pre=np.searchsorted(ids,edges.pre_pt_root_id);post=np.searchsorted(ids,edges.post_pt_root_id)
off=np.concatenate([[0],np.cumsum(np.bincount(pre,minlength=len(ids)))])
if len(edges)>2147483647:p.error('Too many edges')
with a.output.open('wb') as f:
 f.write(struct.pack('>III',0x464c5931,len(ids),len(edges)))
 for arr,dtype in [(ids,'>i8'),(off,'>i4'),(post,'>i4'),(edges.weight.to_numpy(),'>f4')]:f.write(np.asarray(arr,dtype=dtype).tobytes())
meta={'source':str(a.source),'source_sha256':hashlib.file_digest(a.source.open('rb'),'sha256').hexdigest(),'neurons':len(ids),'edges':len(edges),'subset':bool(a.max_neurons),'isolates_preserved':bool(a.root_ids),'bytes':a.output.stat().st_size,'estimated_runtime_bytes':116*len(ids)+8*len(edges)+4,'model':'LIF 0.1 ms; NT weighted argmax; modulatory edges omitted; not Brian2-validated','first_id':str(ids[0])}
a.output.with_suffix('.json').write_text(json.dumps(meta,indent=2))
print(json.dumps(meta,indent=2))
