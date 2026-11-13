#!/usr/bin/env python3
"""Production data bundle: Male CNS v1.0 only (directive 2026-11-13).

FlyWire v783 is no longer downloaded, converted or packaged. The historical
converters (convert_shiu.py, convert.py) stay in the repository for the
scientific record and are not part of the production toolchain."""
import subprocess,sys
subprocess.run([sys.executable,'tools/bundle_male_cns.py'],check=True)
