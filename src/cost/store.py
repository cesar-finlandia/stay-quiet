# Requirement IDs: COST-02, COST-03, COST-04, GOV-RES-02, GOV-RES-04
"""In-memory CostStore — DP-I §3.4/§3.5.

Pure bookkeeping (COST-REU-01): imports stdlib + src.cost only. Accumulates
UsageRecords, aggregates ProviderTotals per scope (§4.2), checks budgets with
edge-triggered warning emission (§3.5/§6.1), and offers opt-in atomic JSON
snapshot persistence (§7 corruption row). render_summary lands in step 4.

Every public function is outer try/except bounded (GOV-RES-04): check_budget
returns [] and render_summary returns the minimal fallback line on internal
error; accumulation never implicitly clears on a budget cross.
"""

from __future__ import annotations

import json
import os
import threading

import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from .config import sanitize_budget_config
from .types import BudgetScope, BudgetWarning, CostBudgetConfig, ProviderTotals, UsageRecord

__all__ = ["CostStore", "create_cost_store", "get_default_store"]

_FALLBACK_SUMMARY = "(cost summary unavailable)"
_GLOBAL_KEY = "_global"
_UNIT_ABBREV = {"tokens": "tokens", "requests": "requests", "estimated_cost": "USD"}
# Truncated units for the summary Budget column — DP-I §4.5 rule 2.
_UNIT_SHORT = {"tokens": "tok", "requests": "reqs", "estimated_cost": "USD"}
_BAR_WIDTH = 8
_BAR_FULL, _BAR_PARTIAL, _BAR_EMPTY = "█", "▊", "░"
_ANSI_YELLOW, _ANSI_RED, _ANSI_RESET = "\033[33m", "\033[31m", "\033[0m"
_DISCLAIMER_NOTE = (
    "Note: figures are local estimates via CTX-02; verify against provider "
    "dashboard before any cost claim (NONGOAL-11)."
)


def _no_color() -> bool:
    try:
        return bool(os.environ.get("NO_COLOR"))
    except Exception:
        return True


def _render_bar(utilization: float) -> str:
    """8-char block bar at utilization resolution — DP-I §4.5 rule 3."""
    try:
        frac = max(0.0, min(1.0, float(utilization)))
        scaled = frac * _BAR_WIDTH
        filled = int(scaled)
        cells = [_BAR_FULL] * filled
        if filled < _BAR_WIDTH and scaled - filled > 1e-9:
            cells.append(_BAR_PARTIAL)
        while len(cells) < _BAR_WIDTH:
            cells.append(_BAR_EMPTY)
        return "".join(cells)
    except Exception:
        return _BAR_EMPTY * _BAR_WIDTH


def _colorize(text: str, utilization: float, threshold: float) -> str:
    """ANSI yellow at >= threshold, red at >= 1.0; NO_COLOR disables all."""
    try:
        if _no_color():
            return text
        if utilization >= 1.0:
            return f"{_ANSI_RED}{text}{_ANSI_RESET}"
        if threshold > 0 and utilization >= threshold:
            return f"{_ANSI_YELLOW}{text}{_ANSI_RESET}"
        return text
    except Exception:
        return text


def _wrap_footer(text: str, width: int) -> List[str]:
    """Hard-wrap footer text to the table inner width (stdlib only)."""
    import textwrap

    lines: List[str] = []
    for para in text.split("\n"):
        wrapped = textwrap.wrap(para, width=max(10, width)) or [""]
        lines.extend(wrapped)
    return lines


def _warn(msg: str) -> None:
    """Single warn channel — mirrors DP-I §7 `warn:` lines. Never throws."""
    try:
        import sys

        print("warn: " + msg, file=sys.stderr)
    except Exception:
        pass


def _utc_now_iso() -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    except Exception:
        return ""


class CostStore:
    """Session store for UsageRecords — source of truth for COST-02/03/04.

    Thread safety: one re-entrant lock guards records/budget state so sync
    wrappers sharing one store accumulate atomically (DP-I §3.4).
    """

    def __init__(self, opts: Optional[dict] = None) -> None:
        opts = opts if isinstance(opts, dict) else {}
        self._lock = threading.RLock()
        self._records: List[UsageRecord] = []
        self._budget_config = sanitize_budget_config(opts.get("budget_config"))
        self._persist_path: Optional[str] = (
            str(opts.get("persist_path")) if opts.get("persist_path") else None
        )
        # Edge-trigger state per (scope, level) — True while warning is active/emitted.
        self._fired: Dict[tuple, bool] = {}
        # Keys (scope, level) whose crossing is fresh since last check_budget —
        # consumed by emit_warning so callback listeners fire exactly once per
        # threshold crossing (DP-I §3.5 edge-trigger).
        self._fresh_edges: set = set()
        self._warning_listeners: List[Callable[[BudgetWarning], Any]] = []
        if self._persist_path:
            self._load_persisted(self._persist_path)

    # --- aggregation (DP-I §4.2) -----------------------------------------

    @staticmethod
    def _aggregate(records: List[UsageRecord], provider: str) -> ProviderTotals:
        """Pure §4.2 reduction: non-null token sums, ALL records counted."""
        totals: ProviderTotals = {
            "provider": provider,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_tokens": 0,
            "request_count": 0,
            "estimated_cost_usd": None,
            "unmetered_count": 0,
        }
        cost_sum = 0.0
        cost_seen = False
        for rec in records:
            it = rec.get("input_tokens")
            ot = rec.get("output_tokens")
            tt = rec.get("total_tokens")
            if isinstance(it, (int, float)) and not isinstance(it, bool):
                totals["total_input_tokens"] += int(it)
            if isinstance(ot, (int, float)) and not isinstance(ot, bool):
                totals["total_output_tokens"] += int(ot)
            if isinstance(tt, (int, float)) and not isinstance(tt, bool):
                totals["total_tokens"] += int(tt)  # unmetered records contribute 0
            totals["request_count"] += int(rec.get("request_count") or 0)
            if rec.get("unmetered"):
                totals["unmetered_count"] += 1
            est = rec.get("estimated_cost_usd")
            if isinstance(est, (int, float)) and not isinstance(est, bool):
                cost_sum += float(est)
                cost_seen = True
        totals["estimated_cost_usd"] = round(cost_sum, 6) if cost_seen else None
        return totals

    def totals_by_provider(self) -> Dict[str, ProviderTotals]:
        try:
            groups: Dict[str, List[UsageRecord]] = {}
            with self._lock:
                for rec in self._records:
                    key = str(rec.get("provider") or "_unattributed")
                    groups.setdefault(key, []).append(rec)
            return {k: self._aggregate(v, k) for k, v in sorted(groups.items())}
        except Exception as exc:
            _warn(f"[COST] internal error — totals_by_provider: {exc}")
            return {}

    def global_totals(self) -> ProviderTotals:
        try:
            with self._lock:
                records = list(self._records)
            return self._aggregate(records, _GLOBAL_KEY)
        except Exception as exc:
            _warn(f"[COST] internal error — global_totals: {exc}")
            return {
                "provider": _GLOBAL_KEY,
                "total_input_tokens": 0,
                "total_output_tokens": 0,
                "total_tokens": 0,
                "request_count": 0,
                "estimated_cost_usd": None,
                "unmetered_count": 0,
            }

    # --- budget check (DP-I §3.5/§6.1/§6.2) ------------------------------

    def check_budget(self, config: Optional[CostBudgetConfig] = None) -> List[BudgetWarning]:
        """Active warnings — pure data, no side effect beyond edge state.

        Poll path semantics (documented per handout verify step): each call
        recomputes crossings; a scope+level that has fired stays reported by
        the poll path while cumulative remains >= threshold*budget, but the
        callback registry (emit_warning) fires only on the crossing edge.
        """
        try:
            cfg = config if config is not None else self._budget_config
            effective = sanitize_budget_config(cfg)
            warnings: List[BudgetWarning] = []
            with self._lock:
                self._fresh_edges.clear()  # edges are fresh only until next poll
                gtotals = self._aggregate(list(self._records), _GLOBAL_KEY)
                ptotals = self.totals_by_provider()
                scopes: List[tuple] = []
                gscope = effective.get("global")
                if gscope:
                    scopes.append(("global", gscope, gtotals))
                for prov, pscope in (effective.get("per_provider") or {}).items():
                    scopes.append((prov, pscope, ptotals.get(prov, self._aggregate([], prov))))
                for scope_name, scope_cfg, tot in scopes:
                    w = self._check_scope(scope_name, scope_cfg, tot)
                    warnings.extend(w)
            return warnings
        except Exception as exc:
            _warn(f"[COST] internal error — check_budget: {exc}")
            return []

    def _check_scope(self, scope_name: str, scope_cfg: BudgetScope, tot: ProviderTotals) -> List[BudgetWarning]:
        """One scope's crossing check per DP-I §3.5/§4.4 — builds the warning."""
        try:
            budget = float(scope_cfg.get("budget") or 0)
            if budget <= 0:
                return []
            unit = scope_cfg.get("unit") or "tokens"
            if unit == "requests":
                cumulative = float(tot["request_count"])
            elif unit == "estimated_cost":
                cumulative = float(tot["estimated_cost_usd"] or 0)  # null → 0 (§6.2)
            else:
                unit = "tokens"
                cumulative = float(tot["total_tokens"])
            thresholds = [(scope_cfg.get("threshold") or 0.8, "warning")]
            crit = scope_cfg.get("critical_threshold")
            if crit is not None and float(crit) > thresholds[0][0]:
                thresholds.append((float(crit), "critical"))
            out: List[BudgetWarning] = []
            for frac, level in thresholds:
                if budget * frac <= 0:
                    continue
                crossed = cumulative >= budget * frac
                key = (scope_name, level)
                if crossed:
                    edge = not self._fired.get(key, False)
                    self._fired[key] = True
                    if edge:
                        self._fresh_edges.add(key)
                    out.append(
                        self._build_warning(scope_name, level, frac, budget, unit, cumulative, tot)
                    )
                else:
                    self._fired[key] = False  # dropped below — re-cross will re-emit
            return out
        except Exception as exc:
            _warn(f"[COST] internal error — check_budget({scope_name}): {exc}")
            return []

    def _build_warning(self, scope_name, level, frac, budget, unit, cumulative, tot):
        utilization = cumulative / budget if budget else 0.0
        remaining = budget - cumulative
        pct = round(utilization * 100)
        thr_pct = round(frac * 100)
        message = (
            f"[COST] {scope_name} at {pct}% ({cumulative:g}/{budget:g} {_UNIT_ABBREV[unit]}"
            f") — threshold {thr_pct}%"
        )
        warning: BudgetWarning = {
            "scope": scope_name,
            "level": level,
            "threshold": frac,
            "budget": budget,
            "unit": unit,
            "cumulative": cumulative,
            "utilization": utilization,
            "remaining": remaining,
            "provider_totals": dict(tot),
            "timestamp": _utc_now_iso(),
            "message": message,
            "once_per_threshold": True,
        }
        return warning

    # --- warning registry + config surface (DP-I §3.5/§6.3) --------------

    def on_warning(self, cb: Callable[[BudgetWarning], Any]) -> None:
        """Register a listener; invoked by emit_warning on each fresh crossing."""
        try:
            if callable(cb):
                with self._lock:
                    self._warning_listeners.append(cb)
        except Exception as exc:
            _warn(f"[COST] internal error — on_warning: {exc}")

    def emit_warning(self, warning: BudgetWarning) -> None:
        """Fan out to listeners only when (scope, level) is a fresh crossing.

        Listener errors are swallowed (GOV-RES-04). Poll-path repeats of an
        active warning do not re-notify listeners.
        """
        try:
            if not isinstance(warning, dict):
                return
            key = (warning.get("scope"), warning.get("level"))
            with self._lock:
                fresh = key in self._fresh_edges
                self._fresh_edges.discard(key)
                listeners = list(self._warning_listeners)
            if fresh:
                for cb in listeners:
                    try:
                        cb(warning)
                    except Exception as exc:
                        _warn(f"[COST] warning listener error (swallowed): {exc}")
        except Exception as exc:
            _warn(f"[COST] internal error — emit_warning: {exc}")

    def acknowledge_warning(self, scope: str, level: str = "warning") -> None:
        """Clear edge-trigger state so the next crossing re-emits (DP-I §6.3)."""
        try:
            with self._lock:
                self._fired.pop((scope, level), None)
                self._fresh_edges.discard((scope, level))
        except Exception as exc:
            _warn(f"[COST] internal error — acknowledge_warning: {exc}")

    def set_budget_config(self, cfg: CostBudgetConfig) -> None:
        try:
            with self._lock:
                self._budget_config = sanitize_budget_config(cfg)
        except Exception as exc:
            _warn(f"[COST] internal error — set_budget_config: {exc}")

    def get_budget_config(self) -> CostBudgetConfig:
        try:
            with self._lock:
                return dict(self._budget_config)
        except Exception:
            return {}

    # --- reset + snapshot persistence (§7 corruption row) -----------------

    def reset(self) -> None:
        """Explicit clear — never invoked implicitly (DP-I §3.4)."""
        try:
            with self._lock:
                self._records.clear()
                self._fired.clear()
                self._fresh_edges.clear()
            path = self._persist_path
            if path:
                self._persist(path)
        except Exception as exc:
            _warn(f"[COST] internal error — reset: {exc}")

    def to_json(self) -> dict:
        """CostStoreSnapshot per contracts/cost-store-snapshot.schema.json."""
        try:
            with self._lock:
                records = [dict(r) for r in self._records]
            for rec in records:
                rec.pop("raw_usage_ref", None)  # not persisted by default (§4.2)
            return {
                "version": "1.0.0",
                "records": records,
                "totals_by_provider": self.totals_by_provider(),
                "global_totals": self.global_totals(),
            }
        except Exception as exc:
            _warn(f"[COST] internal error — to_json: {exc}")
            return {"version": "1.0.0", "records": [], "totals_by_provider": {}, "global_totals": self.global_totals()}

    def load_snapshot(self, snap: Any) -> None:
        """Replace state from a snapshot; corrupt input → warn + discard (GOV-RES-02)."""
        try:
            records = self._validate_snapshot(snap)
            if records is None:
                return
            with self._lock:
                self._records = records
                self._fired.clear()
                self._fresh_edges.clear()
            path = self._persist_path
            if path:
                self._persist(path)
        except Exception as exc:
            _warn(f"[COST] store snapshot corrupt — starting fresh ({exc})")

    @staticmethod
    def _validate_snapshot(snap: Any) -> Optional[List[UsageRecord]]:
        """Local guard mirroring the contract; returns records or None if corrupt."""
        try:
            import jsonschema  # optional — local guard is authoritative fallback
        except ImportError:
            jsonschema = None
        schema_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "..", "contracts", "cost-store-snapshot.schema.json",
        )
        if jsonschema is not None and os.path.exists(schema_path):
            try:
                with open(os.path.normpath(schema_path), "r", encoding="utf-8") as fh:
                    schema = json.load(fh)
                jsonschema.validate(snap, schema)
            except Exception as exc:
                _warn(f"[COST] store snapshot corrupt — starting fresh ({exc})")
                return None
        else:
            bad = CostStore._local_snapshot_check(snap)
            if bad:
                _warn(f"[COST] store snapshot corrupt — starting fresh ({bad})")
                return None
        records = []
        for rec in snap.get("records", []):
            clean = {
                "id": str(rec.get("id") or uuid.uuid4()),
                "timestamp": str(rec.get("timestamp") or ""),
                "provider": str(rec.get("provider") or "_unattributed").strip().lower(),
                "label": str(rec.get("label") or ""),
                "model_profile": str(rec.get("model_profile") or ""),
                "input_tokens": rec.get("input_tokens"),
                "output_tokens": rec.get("output_tokens"),
                "total_tokens": rec.get("total_tokens"),
                "request_count": max(1, int(rec.get("request_count") or 1)),
                "estimated_cost_usd": rec.get("estimated_cost_usd"),
                "unmetered": bool(rec.get("unmetered", False)),
                "unmetered_reason": str(rec.get("unmetered_reason") or ""),
                "raw_usage_ref": None,
            }
            records.append(clean)  # type: ignore[arg-type]
        return records

    @staticmethod
    def _local_snapshot_check(snap: Any) -> str:
        if not isinstance(snap, dict):
            return "snapshot not an object"
        if snap.get("version") != "1.0.0":
            return f"unsupported version {snap.get('version')!r}"
        if not isinstance(snap.get("records"), list):
            return "records not a list"
        if not isinstance(snap.get("totals_by_provider"), dict):
            return "totals_by_provider not an object"
        gt = snap.get("global_totals")
        if not isinstance(gt, dict) or gt.get("provider") != "_global":
            return "global_totals missing or provider != '_global'"
        return ""

    def _persist(self, path: str) -> None:
        """Atomic snapshot write — tmp file + rename (DP-I §8.3)."""
        try:
            snap = self.to_json()
            tmp = f"{path}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(snap, fh)
            os.replace(tmp, path)  # atomic on POSIX + Windows
        except Exception as exc:
            _warn(f"[COST] persist failed (non-fatal): {exc}")

    # --- summary (COST-04, DP-I §3.7/§4.5) --------------------------------

    def render_summary(self, config: Optional[CostBudgetConfig] = None) -> str:
        """Pure-function §4.5 table over store snapshot + budget config.

        No I/O, no mutation of accumulation state; deterministic for identical
        input. Outer try/except returns the minimal fallback line (GOV-RES-04).
        """  # Requirement IDs: COST-04
        try:
            with self._lock:
                records = [dict(r) for r in self._records]
                cfg = config if config is not None else self._budget_config
            effective = sanitize_budget_config(cfg)
            warnings = self.check_budget(config)
            return _build_summary(records, effective, warnings)
        except Exception as exc:
            try:
                _warn(f"[COST] internal error — render_summary: {exc}")
            except Exception:
                pass
            return _FALLBACK_SUMMARY

    def _load_persisted(self, path: str) -> None:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                snap = json.load(fh)
            self.load_snapshot(snap)
        except FileNotFoundError:
            pass  # first run with a fresh persist_path — nothing to restore
        except Exception as exc:
            _warn(f"[COST] store snapshot corrupt — starting fresh ({exc})")

    # --- accumulation (DP-I §3.4) ----------------------------------------

    def append(self, record: UsageRecord) -> None:
        """Additive append — never resets, never throws (GOV-RES-04)."""
        try:
            if not isinstance(record, dict):
                _warn("[COST] internal error — append got non-dict record")
                return
            with self._lock:
                self._records.append(record)  # type: ignore[arg-type]
                path = self._persist_path
            if path:
                self._persist(path)
        except Exception as exc:
            _warn(f"[COST] internal error — append failed: {exc}")

    def get_all(self) -> List[UsageRecord]:
        try:
            with self._lock:
                return list(self._records)
        except Exception:
            return []

    def get_by_provider(self, provider: str) -> List[UsageRecord]:
        try:
            key = (provider or "").strip().lower()
            with self._lock:
                return [r for r in self._records if r.get("provider") == key]
        except Exception:
            return []


def create_cost_store(opts: Optional[dict] = None) -> CostStore:
    """Factory per DP-I §3.4: opts may carry persist_path and budget_config."""
    try:
        return CostStore(opts)
    except Exception as exc:
        _warn(f"[COST] internal error — create_cost_store: {exc}")
        return CostStore({})


# --- COST-04 renderer (DP-I §4.5) — dependency-free string building ------


def _budget_cell(scope: Optional[BudgetScope], unit_short: Dict[str, str]) -> str:
    """Budget + truncated unit, or '—' when no BudgetScope exists for a row."""
    try:
        if not scope or not float(scope.get("budget") or 0) > 0:
            return "—"
        unit = scope.get("unit") or "tokens"
        return f"{float(scope['budget']):g} {unit_short.get(unit, 'tok')}"
    except Exception:
        return "—"


def _warning_line(w: BudgetWarning) -> str:
    """One ⚠ line per active warning — DP-I §4.5 example format."""
    try:
        scope = str(w.get("scope") or "?")
        frac = float(w.get("threshold") or 0)
        util = float(w.get("utilization") or 0)
        budget = float(w.get("budget") or 0)
        remaining = float(w.get("remaining") or 0)
        unit_full = _UNIT_ABBREV.get(str(w.get("unit") or "tokens"), "tokens")
        pct = round(util * 100)
        thr_pct = round(frac * 100)
        if level := str(w.get("level") or "warning"):
            verb = "approaching" if level == "warning" else f"{level} —"
        else:
            verb = "approaching"
        tail = (
            f"~{remaining:g} {unit_full} remaining"
            if remaining > 0
            else f"over budget by {-remaining:g} {unit_full}"
        )
        return f"⚠ {scope} {verb} {thr_pct}% threshold ({pct}% now — {tail})".replace("  ", " ")
    except Exception:
        return "⚠ budget warning"


def _unmetered_entries(records: List[UsageRecord]) -> List[str]:
    """Unique `provider/LABEL — reason` entries in record order."""
    seen = set()
    out: List[str] = []
    for rec in records:
        if not rec.get("unmetered"):
            continue
        entry = (
            f"{str(rec.get('provider') or '_unattributed')}/"
            f"{(str(rec.get('label') or '').strip() or '?')} — "
            f"{(str(rec.get('unmetered_reason') or '').strip() or 'unspecified')}"
        )
        if entry not in seen:
            seen.add(entry)
            out.append(entry)
    return out


def _build_summary(records: List[UsageRecord], effective: CostBudgetConfig,
                   warnings: List[BudgetWarning]) -> str:
    """Pure §4.5 table assembly from already-extracted snapshot data."""
    groups: Dict[str, List[UsageRecord]] = {}
    for rec in records:
        groups.setdefault(str(rec.get("provider") or "_unattributed"), []).append(rec)
    rows: List[tuple] = []  # (name, totals, scope_or_None, utilization_or_None)
    per_provider = effective.get("per_provider") or {}
    gscope = effective.get("global")
    all_recs = [r for _, recs in sorted(groups.items()) for r in recs]
    for name in sorted(groups):
        tot = CostStore._aggregate(groups[name], name)
        scope = per_provider.get(name)
        rows.append((name, tot, scope))
    gtot = CostStore._aggregate(all_recs, _GLOBAL_KEY)
    rows.append((_GLOBAL_KEY, gtot, gscope))

    p_w, n_w, o_w, t_w, r_w, b_w = 10, 8, 8, 7, 5, 11

    def cells(name: str, tot: ProviderTotals, scope: Optional[BudgetScope]) -> tuple:
        bud = _budget_cell(scope, _UNIT_SHORT)
        util: Optional[float] = None
        if bud != "—" and scope is not None:
            unit = scope.get("unit") or "tokens"
            cum = {"requests": float(tot["request_count"]),
                   "estimated_cost": float(tot["estimated_cost_usd"] or 0)}.get(
                      unit, float(tot["total_tokens"]))
            util = cum / float(scope["budget"]) if float(scope["budget"]) else 0.0
        return (name[:p_w].ljust(p_w), f"{tot['total_input_tokens']:>{n_w}}",
                f"{tot['total_output_tokens']:>{o_w}}", f"{tot['total_tokens']:>{t_w}}",
                f"{tot['request_count']:>{r_w}}", bud.rjust(b_w), util)

    prepared = [cells(n, t, s) for n, t, s in rows]
    header = (f"| {'Provider':<{p_w}} │ {'In Tok':>{n_w}} │ {'Out Tok':>{o_w}} │ "
              f"{'Total':>{t_w}} │ {'Reqs':>{r_w}} │ {'Budget':>{b_w}} │ Util  Bar |")
    width = len(header)

    def border(fill: str, joins: str) -> str:
        segs = [p_w + 2, n_w + 2, o_w + 2, t_w + 2, r_w + 2, b_w + 2]
        mid = joins.join(fill * s for s in segs)
        return "|" + mid + joins + fill * max(1, width - 2 - len(mid) - len(joins)) + "|"

    lines = [
        "+" + "─" * (width - 2) + "+",
        f"| COST — Usage Summary (local estimate — not billing)".ljust(width - 1) + "|",
        "+" + "─" * (width - 2) + "+",
        header,
        border("─", "┼"),
    ]
    for (name, tot, scope), c in zip(rows, prepared):
        prov, itok, otok, ttok, reqs, bud, util = c
        if util is None:
            util_cell = " " * 6 + " " * _BAR_WIDTH  # no scope → no bar (§4.5 rule 6)
        else:
            thr = float((scope or {}).get("threshold") or 0.8)
            util_cell = _colorize(f"{round(util*100):>3}% {_render_bar(util)}", util, thr)
        lines.append(
            f"| {prov} │ {itok} │ {otok} │ {ttok} │ {reqs} │ {bud} │ {util_cell} |"
        )
    lines.append(border("─", "┴"))
    for w in warnings or []:
        lines.append(("| " + _warning_line(w)).ljust(width - 1) + "|")
    entries = _unmetered_entries(records)
    if entries:
        text = f"Unmetered calls: {sum(1 for r in records if r.get('unmetered'))} ({'; '.join(entries)})"
        for seg in _wrap_footer(text, width - 6):
            lines.append(("| " + seg).ljust(width - 1) + "|")
    for seg in _wrap_footer(_DISCLAIMER_NOTE, width - 6):
        lines.append(("| " + seg).ljust(width - 1) + "|")
    lines.append("+" + "─" * (width - 2) + "+")
    return "\n".join(lines)


_DEFAULT_STORE: Optional[CostStore] = None
_DEFAULT_STORE_LOCK = threading.Lock()


def get_default_store() -> CostStore:
    """Lazily-created process-wide singleton (DP-I §3.4); tests inject their own."""
    global _DEFAULT_STORE
    if _DEFAULT_STORE is None:
        with _DEFAULT_STORE_LOCK:
            if _DEFAULT_STORE is None:
                _DEFAULT_STORE = create_cost_store({})  # never throws (GOV-RES-04)
    return _DEFAULT_STORE
