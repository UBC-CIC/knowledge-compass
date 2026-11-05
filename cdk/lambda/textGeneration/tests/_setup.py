"""
Shared test setup; import it before any module that imports `kc_shared`.

Puts the shared layer source (cdk/layers/shared_python/python) on sys.path, the
way Lambda mounts the layer at /opt/python.
"""

import os
import sys

SHARED_LAYER = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "layers", "shared_python", "python")
)
if SHARED_LAYER not in sys.path:
    sys.path.append(SHARED_LAYER)
