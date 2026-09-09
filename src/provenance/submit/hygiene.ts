// Requirement IDs: SUBMIT-05, SUBMIT-REU-02, SUBMIT-RES-02, SUBMIT-RES-03, 6.19, 6.20
// Repo Hygiene Guard — TypeScript twin of src/provenance/submit/hygiene.py
// (DP-J §6). Read-only: fs.readFileSync + regex.test + glob.match ONLY —
// never a write/unlink/git-mutation (SUBMIT-RES-02, NONGOAL-16). Flag-only
// advisory; every failure degrades to `unavailable` per SUBMIT-RES-03 and
// NEVER blocks submission formatting.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validate } from "../../resilience/index.js";
import { REPO_ROOT } from "../provo/validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HYGIENE_CONFIG_SCHEMA_PATH = join(REPO_ROOT, "contracts", "hygiene-config.schema.json");
export const DEFAULT_HYGIENE_CONFIG_PATH = join(HERE, "..", "config", "hygiene.json");

export const REPORT_VERSION = "1.0.0";

/** Default pattern list (DP-J §6.1 table) — hardcoded fallback; every pattern
 * is overridable via config/hygiene.json (SUBMIT-REU-02). */
export const DEFAULT_SECRET_PATTERNS = [
  { name: "openai_sk", regex: "sk-[A-Za-z0-9]{20,}", enabled: true },
  { name: "openai_sk_proj", regex: "sk-proj-[A-Za-z0-9_-]{20,}", enabled: true },
  { name: "aws_access_key", regex: "AKIA[0-9A-Z]{16}", enabled: true },
  {
    name: "aws_secret_key",
    regex: "(?i)aws_secret_access_key\\s*[:=]\\s*[A-Za-z0-9/+=]{30,}",
    enabled: true,
  },
  { name: "github_pat", regex: "ghp_[A-Za-z0-9_]{30,}", enabled: true },
  { name: "github_oauth", regex: "gho_[A-Za-z0-9_]{30,}", enabled: true },
  { name: "stripe_sk", regex: "sk_(live|test)_[A-Za-z0-9]{20,}", enabled: true },
  {
    name: "generic_api_key",
    regex: "(?i)(api[_-]?key|apikey)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-]{20,}['\"]?",
    enabled: true,
  },
  {
    name: "private_key_block",
    regex: "-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----",
    enabled: true,
  },
];

/** Default credential-filename globs (DP-J §6.1) — mirror ASM-06's generic
 * .gitignore so scanner and ignore list are intentionally aligned. */
export const DEFAULT_CREDENTIAL_FILENAMES = [
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
];

export const DEFAULT_IGNORE_PATHS = ["examples/dummy-fixtures/**"];

export const DEFAULT_COMMIT_DISTRIBUTION = { bucket: "1h", threshold: 0.8 };

export const DEFAULT_HYGIENE_CONFIG = {
  version: REPORT_VERSION,
  secretPatterns: DEFAULT_SECRET_PATTERNS.map((p) => ({ ...p })),
  credentialFilenames: [...DEFAULT_CREDENTIAL_FILENAMES],
  ignorePaths: [...DEFAULT_IGNORE_PATHS],
  commitDistribution: { ...DEFAULT_COMMIT_DISTRIBUTION },
};

const BUCKET_SECONDS: Record<string, number> = { "1h": 3600, "6h": 21600, "1d": 86400 };

const GIT_TIMEOUT_MS = 5000;

export const SINGLE_COMMIT_NOTE =
  "Only one commit — distribution check is not meaningful until incremental work begins.";

/** Tiny case-SENSITIVE glob -> regex (** crosses segments, * and ? do not).
 * Identical translation lives in hygiene.py — keep behavior-compatible. */
function globToRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break;
    if (ch === "*") {
      if (pattern.slice(i + 1, i + 3) === "**") {
        let j = i;
        while (j < pattern.length && pattern[j] === "*") j++;
        if (pattern.slice(j, j + 1) === "/") {
          j += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
        i = j;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(out + "$");
}

function globMatchAny(relPath: string, patterns: string[]): boolean {
  const base = relPath.includes("/") ? relPath.slice(relPath.lastIndexOf("/") + 1) : relPath;
  return patterns.some((p) => {
    const regex = globToRegex(p);
    return regex.test(relPath) || regex.test(base);
  });
}

/** SUBMIT-RES-03 degradation carrier: git ENOENT / not-a-repo / corrupt. */
export class GitUnavailable extends Error {}

/** Run one read-only git command; map every failure mode to GitUnavailable
 * with a human reason (DP-J §6.3 table). */
function runGit(repoRoot: string, args: string[]): string {
  const proc = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new GitUnavailable("git is not installed or not on PATH");
    throw new GitUnavailable(`git failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    const stderrFirst = (proc.stderr ?? "").trim().split("\n")[0]?.trim();
    throw new GitUnavailable(stderrFirst || `exit ${proc.status}`);
  }
  return proc.stdout ?? "";
}

/** Committed (`git ls-files`) ∪ staged (`git diff --cached --name-only`);
 * untracked-but-not-ignored files added only when --include-unstaged.
 * Returns [repo-relative posix paths sorted+deduped, warnings]. */
export function listCandidateFiles(
  repoRoot: string,
  includeUnstaged: boolean,
): [string[], string[]] {
  const names = new Set<string>();
  for (const line of runGit(repoRoot, ["ls-files"]).split("\n")) {
    if (line.trim()) names.add(line.trim());
  }
  for (const line of runGit(repoRoot, ["diff", "--cached", "--name-only"]).split("\n")) {
    if (line.trim()) names.add(line.trim());
  }
  if (includeUnstaged) {
    for (const line of runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
  }
  const files = [...names]
    .map((n) => n.replace(/\\/g, "/"))
    .filter((n) => !n.includes(".git/") && n !== ".git")
    .sort();
  return [files, []];
}

export interface LoadedHygieneConfig {
  config: Record<string, unknown>;
  warnings: string[];
}

/** Load + RES-04-validate config/hygiene.json. Absent default -> pure
 * DEFAULT_HYGIENE_CONFIG; explicit-but-malformed -> warn + safe defaults,
 * never crash (GOV-RES-02). */
export function loadHygieneConfig(configPath?: string | null): LoadedHygieneConfig {
  const path = configPath ? configPath : DEFAULT_HYGIENE_CONFIG_PATH;
  let parsed: unknown;
  let schema: object;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
    schema = JSON.parse(readFileSync(HYGIENE_CONFIG_SCHEMA_PATH, "utf8")) as object;
  } catch (err) {
    if (!configPath) return { config: structuredClone(DEFAULT_HYGIENE_CONFIG), warnings: [] };
    return {
      config: structuredClone(DEFAULT_HYGIENE_CONFIG),
      warnings: [
        `warn: hygiene config unreadable at ${path}: ${(err as Error).message} — using safe defaults (GOV-RES-02)`,
      ],
    };
  }
  const result = validate(schema, parsed);
  if (!result.valid) {
    const detail = result.errors.map((e) => `${e.path} ${e.message}`).join("; ");
    return {
      config: structuredClone(DEFAULT_HYGIENE_CONFIG),
      warnings: [
        `warn: hygiene config invalid at ${path}: ${detail} — using safe defaults (GOV-RES-02)`,
      ],
    };
  }
  return { config: parsed as Record<string, unknown>, warnings: [] };
}

interface CompiledPattern {
  name: string;
  regex: RegExp;
}

function compilePatterns(config: Record<string, unknown>): CompiledPattern[] {
  const compiled: CompiledPattern[] = [];
  for (const entry of (config.secretPatterns as Array<Record<string, unknown>> | undefined) ?? []) {
    if ((entry.enabled as boolean | undefined) === false) continue;
    let source = entry.regex as string;
    let flags = "";
    if (source.startsWith("(?i)")) {
      // JS RegExp has no inline flags: transpile leading (?i) to the i flag.
      source = source.slice(4);
      flags += "i";
    }
    compiled.push({ name: entry.name as string, regex: new RegExp(source, flags) });
  }
  return compiled;
}

/** First 4 chars + ...REDACTED — never the full secret (DP-J §6.1). */
function redact(matchText: string): string {
  return `${matchText.slice(0, 4).replace(/\n/g, "")}...REDACTED`;
}

interface SecretHit {
  file: string;
  pattern: string;
  line: number;
  redacted: string;
}

interface SecretScanResult {
  status: "flagged" | "clean" | "unavailable";
  hits: SecretHit[];
  scanned_files: number;
  ignored_files: number;
}

/** Read-only scan of each candidate file: credential-filename glob first,
 * then per-line regex over text content (binary heuristic: NUL byte in the
 * first 8 KiB -> filename check only). Returns [secret_scan object, warn
 * lines]. Flag-only — no write calls anywhere (SUBMIT-RES-02/NONGOAL-16). */
export function scanSecrets(
  repoRoot: string,
  files: string[],
  config: Record<string, unknown>,
): [SecretScanResult, string[]] {
  const patterns = compilePatterns(config);
  const credentialGlobs = (config.credentialFilenames as string[] | undefined) ?? [];
  const ignorePaths = new Set((config.ignorePaths as string[] | undefined) ?? []);
  const hits: SecretHit[] = [];
  const warnings: string[] = [];
  let scanned = 0;
  let ignored = 0;
  for (const rel of files) {
    if (globMatchAny(rel, [...ignorePaths])) {
      ignored += 1;
      continue;
    }
    let blob: Buffer;
    try {
      blob = readFileSync(join(repoRoot, rel));
    } catch (err) {
      warnings.push(`warn: cannot read ${rel}: ${(err as Error).message}`);
      continue;
    }
    const isBinary = blob.subarray(0, 8192).includes(0);
    if (globMatchAny(rel, credentialGlobs)) {
      const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
      hits.push({
        file: rel,
        pattern: "credential_filename",
        line: 1,
        redacted: `${base.slice(0, 4)}...REDACTED`,
      });
      scanned += 1;
      continue;
    }
    if (isBinary) {
      ignored += 1; // binary heuristic skip (content); name already checked above
      continue;
    }
    scanned += 1;
    const lines = blob.toString("utf8").split("\n");
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo] ?? "";
      for (const { name, regex } of patterns) {
        const match = regex.exec(line);
        if (match) {
          hits.push({
            file: rel,
            pattern: name,
            line: lineNo + 1,
            redacted: redact(match[0]),
          });
        }
      }
    }
  }
  const status = hits.length > 0 ? "flagged" : files.length === 0 ? "unavailable" : "clean";
  return [{ status, hits, scanned_files: scanned, ignored_files: ignored }, warnings];
}

export interface CommitDistributionResult {
  status: "flagged" | "clean" | "unavailable";
  total_commits: number;
  bucket: string;
  threshold: number;
  max_bucket: { key: string; count: number; ratio: number } | null;
  buckets: Record<string, number>;
  flagged: boolean;
}

/** Format epoch-ms bucket start as ISO-8601 UTC `YYYY-MM-DDTHH:MMZ` —
 * matches Python's strftime("%Y-%m-%dT%H:%MZ") byte-for-byte. */
function bucketKey(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`
  );
}

/** `git log --all --pretty=format:%H %aI` bucketed by floor(commitDate,
 * bucketSize); flagged when max-bucket ratio > threshold (6.19 default 0.8).
 * Single-commit baseline never flags (day-0 false-positive guard, §6.2). */
export function commitDistribution(
  repoRoot: string,
  config: Record<string, unknown>,
): [CommitDistributionResult, string[]] {
  const distConfig = (config.commitDistribution as Record<string, unknown> | undefined) ?? {};
  const bucket = (distConfig.bucket as string | undefined) ?? "1h";
  const threshold = typeof distConfig.threshold === "number" ? distConfig.threshold : 0.8;
  const seconds = BUCKET_SECONDS[bucket] ?? 3600;
  const out = runGit(repoRoot, ["log", "--all", "--pretty=format:%H %aI"]);
  const dates: number[] = [];
  for (const line of out.split("\n")) {
    const stamp = line.trim().split(" ").slice(1).join(" ").trim();
    if (!stamp) continue;
    const ms = Date.parse(stamp);
    if (Number.isNaN(ms)) continue; // malformed date line — skip (GOV-RES-02)
    dates.push(Math.floor(ms / 1000));
  }
  const total = dates.length;
  const buckets: Record<string, number> = {};
  for (const ts of dates) {
    const keyEpoch = ts - (ts % seconds);
    const key = bucketKey(keyEpoch * 1000);
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  if (total === 0) {
    return [
      {
        status: "clean",
        total_commits: 0,
        bucket,
        threshold,
        max_bucket: null,
        buckets: {},
        flagged: false,
      },
      [],
    ];
  }
  let maxKey: string | null = null;
  let maxCount = 0;
  for (const key of Object.keys(buckets)) {
    const count = buckets[key];
    if (
      maxKey === null ||
      (count !== undefined && count > maxCount) ||
      (count !== undefined && count === maxCount && key > maxKey)
    ) {
      maxKey = key;
      maxCount = count ?? 0;
    }
  }
  if (maxKey === null) maxKey = "";
  const ratio = Math.round((maxCount / total) * 10000) / 10000;
  const flagged = ratio > threshold && total > 1;
  const sortedBuckets = Object.fromEntries(
    Object.entries(buckets).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return [
    {
      status: flagged ? "flagged" : "clean",
      total_commits: total,
      bucket,
      threshold,
      max_bucket: { key: maxKey, count: maxCount, ratio },
      buckets: sortedBuckets,
      flagged,
    },
    [],
  ];
}

interface HygieneReport {
  version: string;
  generated_at: string;
  source_manifest_hash: string;
  secret_scan: SecretScanResult | Record<string, unknown>;
  commit_distribution: CommitDistributionResult | Record<string, unknown>;
  overall: "flagged" | "clean" | "unavailable";
}

function unavailableSecretScan(): SecretScanResult {
  return { status: "unavailable", hits: [], scanned_files: 0, ignored_files: 0 };
}

function unavailableCommitDistribution(bucket: string, threshold: number): CommitDistributionResult {
  return {
    status: "unavailable",
    total_commits: 0,
    bucket,
    threshold,
    max_bucket: null,
    buckets: {},
    flagged: false,
  };
}

function manifestHash(manifestPath?: string): string {
  // sha256 over manifest bytes; unreadable/absent hashes the empty string.
  let blob = Buffer.alloc(0);
  if (manifestPath) {
    try {
      blob = readFileSync(manifestPath);
    } catch {
      blob = Buffer.alloc(0);
    }
  }
  return createHash("sha256").update(blob).digest("hex");
}

/** Full SUBMIT-05 report per contracts/hygiene-report.schema.json. Outer
 * guard maps ANY failure (config, git, fs) to the degraded `unavailable`
 * statuses — never throws (SUBMIT-RES-03 / GOV-RES-04). Returns [report,
 * warnings]; warnings are human-view only (the frozen report schema has no
 * warnings field). */
export function runHygiene(
  config: Record<string, unknown>,
  options?: {
    repoRoot?: string;
    includeUnstaged?: boolean;
    manifestPath?: string;
    now?: string;
  },
): [HygieneReport, string[]] {
  const warnings: string[] = [];
  const distConfig = (config.commitDistribution as Record<string, unknown> | undefined) ?? {};
  const bucket = (distConfig.bucket as string | undefined) ?? "1h";
  const threshold = typeof distConfig.threshold === "number" ? distConfig.threshold : 0.8;
  const repoRoot = options?.repoRoot ?? process.cwd();
  let secretScan: SecretScanResult = unavailableSecretScan();
  let distribution: CommitDistributionResult = unavailableCommitDistribution(bucket, threshold);
  try {
    const [files, fileWarnings] = listCandidateFiles(repoRoot, options?.includeUnstaged ?? false);
    warnings.push(...fileWarnings);
    const [scan, scanWarnings] = scanSecrets(repoRoot, files, config);
    secretScan = scan;
    warnings.push(...scanWarnings);
  } catch (err) {
    if (err instanceof GitUnavailable) {
      warnings.push(`warn: hygiene secret scan unavailable: ${err.message} (SUBMIT-RES-03)`);
    } else {
      warnings.push(`warn: hygiene secret scan failed unexpectedly: ${(err as Error).message}`);
    }
  }
  try {
    const [dist, distWarnings] = commitDistribution(repoRoot, config);
    distribution = dist;
    warnings.push(...distWarnings);
  } catch (err) {
    if (err instanceof GitUnavailable) {
      warnings.push(`warn: hygiene commit distribution unavailable: ${err.message} (SUBMIT-RES-03)`);
    } else {
      warnings.push(
        `warn: hygiene commit distribution failed unexpectedly: ${(err as Error).message}`,
      );
    }
  }
  const scanStatus = (secretScan as SecretScanResult).status;
  const distStatus = (distribution as CommitDistributionResult).status;
  let overall: HygieneReport["overall"] = "clean";
  if (scanStatus === "flagged" || distStatus === "flagged") overall = "flagged";
  else if (scanStatus === "unavailable" || distStatus === "unavailable") overall = "unavailable";
  return [
    {
      version: REPORT_VERSION,
      generated_at: options?.now ?? new Date().toISOString(),
      source_manifest_hash: manifestHash(options?.manifestPath),
      secret_scan: secretScan,
      commit_distribution: distribution,
      overall,
    },
    warnings,
  ];
}

/** Human Markdown view of the hygiene report (DP-J §6.3 output shapes).
 * Pure function of report + warnings; caller owns any FS write. Byte-twin
 * of render_hygiene_markdown in hygiene.py. */
export function renderHygieneMarkdown(report: HygieneReport, warnings: string[]): string {
  const lines: string[] = ["# Hygiene report", ""];
  const scan = report.secret_scan as SecretScanResult;
  const dist = report.commit_distribution as CommitDistributionResult;
  if (scan.status === "unavailable" && dist.status === "unavailable") {
    const reasonWarning = warnings.find((w) => w.startsWith("warn: hygiene "));
    const reason = reasonWarning ? reasonWarning.split(": ").slice(1).join(": ") : "git is not available";
    // Canonical SUBMIT-RES-03 wording for the ASM-06 precondition miss;
    // other causes (git missing, corrupt repo) keep their specific reason.
    if (reason.toLowerCase().includes("not a git repository")) {
      lines.push("> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06).");
    } else {
      lines.push(`> Hygiene check unavailable — ${reason}`);
    }
    lines.push(">");
    lines.push("> Run `submit format` again after assembly; formatting is never blocked.");
  } else {
    if (scan.status === "unavailable") {
      lines.push("### Secret scan — unavailable");
      lines.push("");
      lines.push("> Hygiene check unavailable — secret scan could not run.");
    } else {
      const hits = scan.hits;
      lines.push(`### Secret scan — ${scan.status} (${hits.length} hit(s))`);
      lines.push("");
      if (hits.length > 0) {
        for (const hit of hits) {
          lines.push(`- \`${hit.file}\`:${hit.line} — pattern \`${hit.pattern}\` — \`${hit.redacted}\``);
        }
        lines.push("");
        lines.push(
          "Remediation is manual: `git rm --cached <file>`, add to `.gitignore`, " +
            "rotate the key, then commit. This scanner is flag-only.",
        );
      } else {
        lines.push(
          `No secret-pattern hits across ${scan.scanned_files} scanned file(s) ` +
            `(${scan.ignored_files} ignored).`,
        );
      }
    }
    lines.push("");
    if (dist.status === "unavailable") {
      lines.push("### Commit distribution — unavailable");
      lines.push("");
      lines.push(
        "> Hygiene check unavailable — not a Git repository. Run assembly first (ASM-06).",
      );
    } else if (dist.max_bucket === null) {
      lines.push("### Commit distribution — clean (no commits)");
      lines.push("");
      lines.push("No commits found in this repository yet.");
    } else {
      const pct = Math.round(dist.max_bucket.ratio * 100);
      lines.push(
        `### Commit distribution — ${dist.status} (${pct}% in one ${dist.bucket} bucket)`,
      );
      lines.push("");
      lines.push(
        `${dist.total_commits} total commits; largest bucket \`${dist.max_bucket.key}\` holds ` +
          `${dist.max_bucket.count} (${pct}%, threshold ${Math.round(dist.threshold * 100)}%).`,
      );
      if (!dist.flagged && dist.total_commits === 1) {
        lines.push("");
        lines.push(SINGLE_COMMIT_NOTE);
      } else if (dist.flagged) {
        lines.push("");
        lines.push(
          `Flagged: ${pct}% of commits fall in a single ${dist.bucket} bucket ` +
            "— consider incremental commits.",
        );
      }
    }
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push("");
  lines.push(`Overall: **${report.overall}**`);
  return lines.join("\n") + "\n";
}
