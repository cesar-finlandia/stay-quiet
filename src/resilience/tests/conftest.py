# Requirement IDs: RES-AC-02, RES-RES-02, XCUT-08
# Fixtures for the AC-02 pytest entry (src/resilience/tests/test_offline.py).
# Mirrors tests/resilience/conftest.py: bootstraps the repo root onto sys.path
# so the re-exported tests import ONLY ``src.resilience`` and provides the
# fresh per-test cache root.
import sys
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


@pytest.fixture()
def tmp_cache_dir():
    """Fresh per-test cache root under the OS temp dir — never repo .cache/ (GOV-RES-03)."""
    with tempfile.TemporaryDirectory(prefix="res-ac-") as d:
        yield d
