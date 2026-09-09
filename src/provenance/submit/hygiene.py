# Requirement IDs: SUBMIT-05, SUBMIT-REU-02, SUBMIT-RES-02, SUBMIT-RES-03, 6.19, 6.20
"""Repo Hygiene Guard — Python twin of src/provenance/submit/hygiene.ts
(DP-J §6). Read-only: fs.readFile + regex.test + glob.match ONLY — never a
write/unlink/git-mutation (SUBMIT-RES-02, NONGOAL-16). Flag-only advisory;
every failure degrades to `unavailable` per SUBMIT-RES-03 and NEVER blocks
submission formatting."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from src.provenance.provo.validate import REPO_ROOT, validate

HERE = Path(__file__).resolve().parent
HYGIENE_CONFIG_SCHEMA_PATH = REPO_ROOT / "contracts" / "hygiene-config.schema.json"
DEFAULT_HYGIENE_CONFIG_PATH = HERE.parent / "config" / "hygiene.json"

REPORT_VERSION = "1.0.0"

# Default pattern list (DP-J §6.1 table) — hardcoded fallback; every pattern is
# overridable via config/hygiene.json (SUBMIT-REU-02).
DEFAULT_SECRET_PATTERNS: List[Dict[str, Any]] = [
    {"name": "openai_sk", "regex": r"sk-[A-Za-z0-9]{20,}", "enabled": True},
    {"name": "openai_sk_proj", "regex": r"sk-proj-[A-Za-z0-9_-]{20,}", "enabled": True},
    {"name": "aws_access_key", "regex": r"AKIA[0-9A-Z]{16}", "enabled": True},
    {
        "name": "aws_secret_key",
        "regex": r"(?i)aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{30,}",
        "enabled": True,
    },
    {"name": "github_pat", "regex": r"ghp_[A-Za-z0-9_]{30,}", "enabled": True},
    {"name": "github_oauth", "regex": r"gho_[A-Za-z0-9_]{30,}", "enabled": True},
    {"name": "stripe_sk", "regex": r"sk_(live|test)_[A-Za-z0-9]{20,}", "enabled": True},
    {
        "name": "generic_api_key",
        "regex": r"(?i)(api[_-]?key|apikey)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}['\"]?",
        "enabled": True,
    },
    {
        "name": "private_key_block",
        "regex": r"-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----",
        "enabled": True,
    },
]

# Default credential-filename globs (DP-J §6.1) — mirror ASM-06's generic
# .gitignore so scanner and ignore list are intentionally aligned.
DEFAULT_CREDENTIAL_FILENAMES: List[str] = [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "credentials*.json",
    "*credentials.json",
    "*service-account*.json",
    "secrets*.json",
    ".aws/*",
    ".gcp/*",
    ".azure/*",
]

DEFAULT_IGNORE_PATHS: List[str] = ["examples/dummy-fixtures/**"]

DEFAULT_COMMIT_DISTRIBUTION: Dict[str, Any] = {"bucket": "1h", "threshold": 0.8}

DEFAULT_HYGIENE_CONFIG: Dict[str, Any] = {
    "version": "1.0.0",
    "secretPatterns": [dict(p) for p in DEFAULT_SECRET_PATTERNS],
    "credentialFilenames": list(DEFAULT_CREDENTIAL_FILENAMES),
    "ignorePaths": list(DEFAULT_IGNORE_PATHS),
    "commitDistribution": dict(DEFAULT_COMMIT_DISTRIBUTION),
}

BUCKET_SECONDS = {"1h": 3600, "6h": 21600, "1d": 86400}

GIT_TIMEOUT_MS = 5000

SINGLE_COMMIT_NOTE = (
    "Only one commit — distribution check is not meaningful until incremental work begins."
)


def _glob_to_regex(pattern: str) -> "re.Pattern[str]":
    """Tiny case-SENSITIVE glob -> regex (** crosses segments, * and ? do
    not). Identical translation lives in hygiene.ts — keep byte-compatible."""
    out = ["^"]
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            if pattern[i + 1 : i + 3] == "**":
                # consume the whole ** run (and a following slash) as cross-segment
                j = i
                while j < len(pattern) and pattern[j] == "*":
                    j += 1
                if pattern[j : j + 1] == "/":
                    j += 1
                    out.append("(?:.*/)?")
                else:
                    out.append(".*")
                i = j
            else:
                out.append("[^/]*")
                i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def _glob_match_any(rel_path: str, patterns: List[str]) -> bool:
    """Match repo-relative posix path OR basename against any glob."""
    base = rel_path.rsplit("/", 1)[-1]
    for pattern in patterns:
        regex = _glob_to_regex(pattern)
        if regex.match(rel_path) or regex.match(base):
            return True
    return False


class GitUnavailable(Exception):
    """SUBMIT-RES-03 degradation carrier: git ENOENT / not-a-repo / corrupt."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _run_git(repo_root: Path, args: List[str]) -> str:
    """Run one read-only git command; map every failure mode to
    GitUnavailable with a human reason (DP-J §6.3 table)."""
    cmd = ["git", "-C", str(repo_root)] + args
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=GIT_TIMEOUT_MS / 1000)
    except FileNotFoundError:
        raise GitUnavailable("git is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        raise GitUnavailable(
            f"git command timed out after {GIT_TIMEOUT_MS} ms: {' '.join(args)}"
        )
    if proc.returncode != 0:
        stderr_first = (proc.stderr or "").strip().splitlines()
        detail = stderr_first[0] if stderr_first else f"exit {proc.returncode}"
        raise GitUnavailable(detail)
    return proc.stdout


def list_candidate_files(
    repo_root: Path, include_unstaged: bool
) -> Tuple[List[str], List[str]]:
    """Committed (`git ls-files`) ∪ staged (`git diff --cached --name-only`);
    untracked-but-not-ignored files added only when --include-unstaged.
    Returns (repo_rel_posix_paths sorted+deduped, warnings)."""
    tracked = _run_git(repo_root, ["ls-files"])
    names = {line for line in tracked.splitlines() if line.strip()}
    staged = _run_git(repo_root, ["diff", "--cached", "--name-only"])
    names |= {line for line in staged.splitlines() if line.strip()}
    if include_unstaged:
        others = _run_git(repo_root, ["ls-files", "--others", "--exclude-standard"])
        names |= {line for line in others.splitlines() if line.strip()}
    files = sorted(n.replace("\\", "/") for n in names if ".git/" not in n and n != ".git")
    return files, []


def _compile_patterns(config: Dict[str, Any]) -> List[Tuple[str, "re.Pattern[str]"]]:
    compiled: List[Tuple[str, re.Pattern[str]]] = []
    for entry in config.get("secretPatterns", []):
        if not entry.get("enabled", True):
            continue
        source = entry["regex"]
        flags = 0
        if source.startswith("(?i)"):
            # Python accepts the inline flag directly; keep as-is for parity.
            compiled.append((entry["name"], re.compile(source)))
            continue
        compiled.append((entry["name"], re.compile(source, flags)))
    return compiled


def _redact(match_text: str) -> str:
    """First 4 chars + ...REDACTED — never the full secret (DP-J §6.1)."""
    head = match_text[:4].replace("\n", "")
    return f"{head}...REDACTED"


def scan_secrets(
    repo_root: Path,
    files: List[str],
    config: Dict[str, Any],
) -> Tuple[Dict[str, Any], List[str]]:
    """Read-only scan of each candidate file: credential-filename glob first,
    then per-line regex over text content (binary heuristic: NUL byte in the
    first 8 KiB -> filename check only). Returns (secret_scan object, warn
    lines). Flag-only — no write calls anywhere (SUBMIT-RES-02/NONGOAL-16)."""
    patterns = _compile_patterns(config)
    credential_globs = config.get("credentialFilenames", [])
    ignore_paths = set(config.get("ignorePaths", []))
    hits: List[Dict[str, Any]] = []
    warnings: List[str] = []
    scanned = 0
    ignored = 0
    root = str(repo_root)
    for rel in files:
        if _glob_match_any(rel, ignore_paths):
            ignored += 1
            continue
        path = Path(root) / rel
        is_binary = False
        try:
            blob = path.read_bytes()
            is_binary = b"\x00" in blob[:8192]
        except OSError as exc:
            warnings.append(f"warn: cannot read {rel}: {exc}")
            continue
        if _glob_match_any(rel, credential_globs):
            base = rel.rsplit("/", 1)[-1]
            hits.append({
                "file": rel,
                "pattern": "credential_filename",
                "line": 1,
                "redacted": f"{base[:4]}...REDACTED",
            })
            scanned += 1
            continue
        if is_binary:
            ignored += 1  # binary heuristic skip (content); name already checked above
            continue
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            ignored += 1
            continue
        scanned += 1
        for line_no, line in enumerate(text.splitlines(), start=1):
            for name, regex in patterns:
                match = regex.search(line)
                if match:
                    hits.append({
                        "file": rel,
                        "pattern": name,
                        "line": line_no,
                        "redacted": _redact(match.group(0)),
                    })
    status = "flagged" if hits else ("unavailable" if not files else "clean")
    return {
        "status": status,
        "hits": hits,
        "scanned_files": scanned,
        "ignored_files": ignored,
    }, warnings


def commit_distribution(repo_root: Path, config: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """`git log --all --pretty=format:%H %aI` bucketed by floor(commitDate,
    bucketSize); flagged when max-bucket ratio > threshold (6.19 default 0.8).
    Single-commit baseline never flags (day-0 false-positive guard, §6.2)."""
    dist_config = config.get("commitDistribution", {})
    bucket = dist_config.get("bucket", "1h")
    threshold = float(dist_config.get("threshold", 0.8))
    seconds = BUCKET_SECONDS.get(bucket, 3600)
    out = _run_git(
        repo_root,
        ["log", "--all", "--pretty=format:%H %aI"],
    )
    dates: List[int] = []
    for line in out.splitlines():
        stamp = line.strip().split(" ", 1)[-1].strip()
        if not stamp:
            continue
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        dates.append(int(parsed.timestamp()))
    total = len(dates)
    buckets: Dict[str, int] = {}
    for ts in dates:
        key_epoch = ts - (ts % seconds)
        key = datetime.fromtimestamp(key_epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        buckets[key] = buckets.get(key, 0) + 1
    if total == 0:
        return {
            "status": "clean",
            "total_commits": 0,
            "bucket": bucket,
            "threshold": threshold,
            "max_bucket": None,
            "buckets": {},
            "flagged": False,
        }, []
    max_key = max(buckets, key=lambda k: (buckets[k], k))
    max_count = buckets[max_key]
    ratio = round(max_count / total, 4)
    flagged = ratio > threshold and total > 1
    return {
        "status": "flagged" if flagged else "clean",
        "total_commits": total,
        "bucket": bucket,
        "threshold": threshold,
        "max_bucket": {"key": max_key, "count": max_count, "ratio": ratio},
        "buckets": dict(sorted(buckets.items())),
        "flagged": flagged,
    }, []


def _unavailable_secret_scan() -> Dict[str, Any]:
    return {"status": "unavailable", "hits": [], "scanned_files": 0, "ignored_files": 0}


def _unavailable_commit_distribution(bucket: str, threshold: float) -> Dict[str, Any]:
    return {
        "status": "unavailable",
        "total_commits": 0,
        "bucket": bucket,
        "threshold": threshold,
        "max_bucket": None,
        "buckets": {},
        "flagged": False,
    }


def _manifest_hash(manifest_path: Optional[Path]) -> str:
    blob = b""
    if manifest_path is not None:
        try:
            blob = manifest_path.read_bytes()
        except OSError:
            blob = b""
    return hashlib.sha256(blob).hexdigest()


def run_hygiene(
    config: Dict[str, Any],
    repo_root: Optional[str] = None,
    include_unstaged: bool = False,
    manifest_path: Optional[str] = None,
    now: Optional[str] = None,
) -> Tuple[Dict[str, Any], List[str]]:
    """Full SUBMIT-05 report per contracts/hygiene-report.schema.json.
    Outer guard maps ANY failure (config, git, fs) to the degraded
    `unavailable` statuses — never throws (SUBMIT-RES-03 / GOV-RES-04).
    Returns (report dict, warnings list); warnings are human-view only (the
    frozen report schema has no warnings field)."""
    warnings: List[str] = []
    dist_cfg = config.get("commitDistribution", {})
    bucket = dist_cfg.get("bucket", "1h")
    threshold = float(dist_cfg.get("threshold", 0.8))
    secret_scan = _unavailable_secret_scan()
    distribution = _unavailable_commit_distribution(bucket, threshold)
    root = Path(repo_root) if repo_root else Path.cwd()
    try:
        files, file_warnings = list_candidate_files(root, include_unstaged)
        warnings.extend(file_warnings)
        secret_scan, scan_warnings = scan_secrets(root, files, config)
        warnings.extend(scan_warnings)
    except GitUnavailable as exc:
        warnings.append(f"warn: hygiene secret scan unavailable: {exc.reason} (SUBMIT-RES-03)")
    except Exception as exc:  # noqa: BLE001 — RES-RES-03 outer guard
        warnings.append(f"warn: hygiene secret scan failed unexpectedly: {exc}")
    try:
        distribution, dist_warnings = commit_distribution(root, config)
        warnings.extend(dist_warnings)
    except GitUnavailable as exc:
        warnings.append(f"warn: hygiene commit distribution unavailable: {exc.reason} (SUBMIT-RES-03)")
    except Exception as exc:  # noqa: BLE001 — RES-RES-03 outer guard
        warnings.append(f"warn: hygiene commit distribution failed unexpectedly: {exc}")
    if secret_scan["status"] == "flagged" or distribution["status"] == "flagged":
        overall = "flagged"
    elif "unavailable" in (secret_scan["status"], distribution["status"]):
        overall = "unavailable"
    else:
        overall = "clean"
    return {
        "version": REPORT_VERSION,
        "generated_at": now or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "source_manifest_hash": _manifest_hash(Path(manifest_path) if manifest_path else None),
        "secret_scan": secret_scan,
        "commit_distribution": distribution,
        "overall": overall,
    }, warnings


def render_hygiene_markdown(report: Dict[str, Any], warnings: List[str]) -> str:
    """Human Markdown view of the hygiene report (DP-J §6.3 output shapes).
    Pure function of report + warnings; caller owns any FS write."""
    lines: List[str] = ["# Hygiene report", ""]
    scan = report["secret_scan"]
    dist = report["commit_distribution"]
    if scan["status"] == "unavailable" and dist["status"] == "unavailable":
        reason = next(
            (w.split(": ", 1)[1] for w in warnings if w.startswith("warn: hygiene ")),
            "git is not available",
        )
        # Canonical SUBMIT-RES-03 wording for the ASM-06 precondition miss;
        # other causes (git missing, corrupt repo) keep their specific reason.
        if "not a git repository" in reason.lower():
            lines.append(
                "> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06)."
            )
        else:
            lines.append(f"> Hygiene check unavailable — {reason}")
        lines.append(">")
        lines.append("> Run `submit format` again after assembly; formatting is never blocked.")
    else:
        if scan["status"] == "unavailable":
            lines.append("### Secret scan — unavailable")
            lines.append("")
            lines.append("> Hygiene check unavailable — secret scan could not run.")
        else:
            hits = scan["hits"]
            lines.append(f"### Secret scan — {scan['status']} ({len(hits)} hit(s))")
            lines.append("")
            if hits:
                for hit in hits:
                    lines.append(
                        f"- `{hit['file']}`:{hit['line']} — pattern `{hit['pattern']}` — `{hit['redacted']}`"
                    )
                lines.append("")
                lines.append(
                    "Remediation is manual: `git rm --cached <file>`, add to `.gitignore`, "
                    "rotate the key, then commit. This scanner is flag-only."
                )
            else:
                lines.append(
                    f"No secret-pattern hits across {scan['scanned_files']} scanned file(s) "
                    f"({scan['ignored_files']} ignored)."
                )
        lines.append("")
        if dist["status"] == "unavailable":
            lines.append("### Commit distribution — unavailable")
            lines.append("")
            lines.append("> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06).")
        else:
            maxb = dist.get("max_bucket")
            if maxb is None:
                lines.append("### Commit distribution — clean (no commits)")
                lines.append("")
                lines.append("No commits found in this repository yet.")
            else:
                pct = int(round(maxb["ratio"] * 100))
                lines.append(f"### Commit distribution — {dist['status']} ({pct}% in one {dist['bucket']} bucket)")
                lines.append("")
                lines.append(
                    f"{dist['total_commits']} total commits; largest bucket `{maxb['key']}` holds "
                    f"{maxb['count']} ({pct}%, threshold {int(dist['threshold'] * 100)}%)."
                )
                if not dist["flagged"] and dist["total_commits"] == 1:
                    lines.append("")
                    lines.append(SINGLE_COMMIT_NOTE)
                elif dist["flagged"]:
                    lines.append("")
                    lines.append(
                        f"Flagged: {pct}% of commits fall in a single {dist['bucket']} bucket "
                        "— consider incremental commits."
                    )
    if warnings:
        lines.append("")
        lines.append("## Warnings")
        lines.append("")
        for warning in warnings:
            lines.append(f"- {warning}")
    lines.append("")
    lines.append(f"Overall: **{report['overall']}**")
    return "\n".join(lines) + "\n"


def load_hygiene_config(config_path: Optional[str]) -> Tuple[Dict[str, Any], List[str]]:
    """Load + RES-04-validate config/hygiene.json. Absent default -> pure
    DEFAULT_HYGIENE_CONFIG; explicit-but-malformed -> warn + safe defaults,
    never crash (GOV-RES-02). Returns (config, warnings)."""
    path = Path(config_path) if config_path else DEFAULT_HYGIENE_CONFIG_PATH
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        schema = json.loads(HYGIENE_CONFIG_SCHEMA_PATH.read_text(encoding="utf-8"))
        result = validate(schema, parsed)
    except (OSError, json.JSONDecodeError) as exc:
        if config_path is None and not path.exists():
            return json.loads(json.dumps(DEFAULT_HYGIENE_CONFIG)), []
        return (
            json.loads(json.dumps(DEFAULT_HYGIENE_CONFIG)),
            [
                f"warn: hygiene config unreadable at {path}: {exc} — using safe defaults "
                "(GOV-RES-02)"
            ],
        )
    if not result["valid"]:
        detail = "; ".join(f"{e['path']} {e['message']}" for e in result["errors"])
        return (
            json.loads(json.dumps(DEFAULT_HYGIENE_CONFIG)),
            [
                f"warn: hygiene config invalid at {path}: {detail} — using safe defaults "
                "(GOV-RES-02)"
            ],
        )
    return parsed, []


__all__ = [
    "REPORT_VERSION",
    "HYGIENE_CONFIG_SCHEMA_PATH",
    "DEFAULT_HYGIENE_CONFIG_PATH",
    "DEFAULT_HYGIENE_CONFIG",
    "DEFAULT_SECRET_PATTERNS",
    "DEFAULT_CREDENTIAL_FILENAMES",
    "DEFAULT_IGNORE_PATHS",
    "DEFAULT_COMMIT_DISTRIBUTION",
    "SINGLE_COMMIT_NOTE",
    "GitUnavailable",
    "load_hygiene_config",
    "list_candidate_files",
    "scan_secrets",
    "commit_distribution",
    "run_hygiene",
    "render_hygiene_markdown",
]
