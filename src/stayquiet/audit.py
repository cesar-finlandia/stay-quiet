# StayQuiet — the ONLY writer of the audit trail (blueprint §2.4 row 26,
# §2.4c rule 4). Append-only JSON Lines on disk plus an in-memory mirror, so a
# dispute can be defended from the file and the UI can render it without I/O.
from __future__ import annotations

import json
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TypedDict

from src.stayquiet.config import repo_root

#: The audit file, relative to the repository root. One JSON object per line.
AUDIT_PATH: Path = repo_root() / "fixtures" / "audit" / "audit.jsonl"


class AuditEntry(TypedDict):
    """One immutable line of the audit trail."""

    entry_id: str      # "AUD-<8 hex>"
    at: str            # ISO-8601 UTC
    action: str        # short verb phrase, e.g. "draft_prepared"
    booking_id: str    # "" when the action is not booking-specific
    detail: str        # one sentence a human can read in a dispute
    trace_id: str
    degraded: bool


_lock = threading.Lock()
_mirror: list[AuditEntry] = []
_warned_not_writable = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def audit_append(
    action: str,
    booking_id: str,
    detail: str,
    *,
    trace_id: str,
    degraded: bool = False,
) -> AuditEntry:
    """Append one entry to the trail and return it.

    Creates the parent directory on first use. A file-system failure is warned to
    stderr and the entry is still added to the in-memory mirror, so the UI never
    loses the trail because the disk is read-only. Never raises.
    """
    global _warned_not_writable
    try:
        entry: AuditEntry = {
            "entry_id": "AUD-" + uuid.uuid4().hex[:8],
            "at": _now(),
            "action": str(action),
            "booking_id": str(booking_id or ""),
            "detail": str(detail),
            "trace_id": str(trace_id),
            "degraded": bool(degraded),
        }
    except Exception:
        entry = {
            "entry_id": "AUD-error",
            "at": _now(),
            "action": str(action),
            "booking_id": "",
            "detail": str(detail),
            "trace_id": str(trace_id),
            "degraded": True,
        }
    with _lock:
        _mirror.append(entry)
    try:
        AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(AUDIT_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as err:
        with _lock:
            if not _warned_not_writable:
                _warned_not_writable = True
                try:
                    print(f"[stayquiet] audit file not writable ({err}); keeping the trail in "
                          f"memory only", file=sys.stderr)
                except Exception:
                    pass
    except Exception:
        pass
    return dict(entry)


def audit_read(limit: int = 200) -> list[AuditEntry]:
    """The newest `limit` entries, newest first.

    Reads the in-memory mirror when it is populated; otherwise reads AUDIT_PATH
    line by line, skipping unparsable lines with one stderr warning per file read.
    Never raises.
    """
    try:
        with _lock:
            if _mirror:
                items = list(_mirror)
            else:
                items = []
        if items:
            return list(reversed(items))[:limit]
        try:
            lines = AUDIT_PATH.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        except OSError:
            return []
        parsed: list[AuditEntry] = []
        skipped = 0
        for line in lines:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                skipped += 1
                continue
            parsed.append(obj)
        if skipped:
            try:
                print(f"[stayquiet] audit file {AUDIT_PATH.name}: skipped {skipped} "
                      f"unparsable lines", file=sys.stderr)
            except Exception:
                pass
        return list(reversed(parsed))[:limit]
    except Exception:
        return []


def audit_reset() -> None:
    """Clear the in-memory mirror and delete AUDIT_PATH. Tests and the recording
    script only."""
    global _warned_not_writable
    with _lock:
        _mirror.clear()
        _warned_not_writable = False
    try:
        AUDIT_PATH.unlink(missing_ok=True)
    except Exception:
        pass
