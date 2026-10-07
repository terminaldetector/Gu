#!/usr/bin/env python3
from pathlib import Path
p=Path("app/src/main/java/org/node/flyconsole/GpuLifEngine.java").read_text()
assert "#version 310 es" in p
for b in range(10): assert "binding=%d"%b in p, b
assert "q16.8" in p and "glDispatchCompute" in p and "glMemoryBarrier" in p
assert "gpu-gles31-q16.8" in p
print("GPU shader contract checks passed")
