# Requirement IDs: RES-AC-02, RES-RES-02, XCUT-08
"""Pytest entry point for AC-02 — the offline airplane-mode gate (DP-A §10.2).

Re-exports the AC-02 tests from tests/resilience/test_ac02_offline.py so the
design-plan command ``pytest src/resilience/tests/test_offline.py`` runs
against the curated public package layout (src.resilience). The imported
module installs the airplane-mode guard at import time; run it under
NETWORK=disabled in CI for the full §10.3 gate.
"""
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_MIRROR_DIR = _REPO_ROOT / "tests" / "resilience"
for _p in (str(_REPO_ROOT), str(_MIRROR_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from test_ac02_offline import *  # noqa: F401,F403,E402
from test_ac02_offline import guard as offline_guard  # noqa: F401,E402
