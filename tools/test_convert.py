import sys,subprocess
from pathlib import Path
import pandas as pd
p=Path(sys.argv[1]);d=pd.DataFrame({'pre_pt_root_id':[1,1,2],'post_pt_root_id':[2,2,3],'syn_count':[4,6,7]})
for nt in ['ach','gaba','glut','oct','ser','da']:d[nt+'_avg']=[int(nt=='ach'),int(nt=='ach'),int(nt=='gaba')]
d.to_feather(p/'test.feather')
subprocess.run([sys.executable,'tools/convert.py',str(p/'test.feather'),str(p/'test.fly')],check=True)
