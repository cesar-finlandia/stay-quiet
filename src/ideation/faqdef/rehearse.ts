// Requirement IDs: FAQDEF-04, FAQDEF-05, FAQDEF-RES-01, FAQDEF-REU-02, XCUT-08
// Owned by M14 step 5 (DP-D2b §5.5/§5.6). Interactive strict-judge rehearsal:
// samples a question subset (axes-filtered, demand-weighted), times each answer
// with a visible countdown that auto-submits at expiry (FAQDEF-05), requests
// feedback through the single RES-01 gateway with timeout budget+30 s, prints
// Strength/Gap/Tip + Score immediately, tallies the average, and persists
// NOTHING unless --log is passed explicitly. The Q&A sheet on disk is never
// mutated; a failed judge call degrades to "Rehearsal unavailable" + exit 0.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { resilientFaqdefCall, defaultCallLlm, type FaqdefLlm } from "./llm.js";
import type { FaqdefSheetEntry } from "./sheet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const JUDGE_TEMPLATE_PATH = join(HERE, "templates", "judge-persona.template.md");
export const REHEARSAL_UNAVAILABLE =
  "Rehearsal unavailable — LLM judge call failed after retries (RES-01 exhausted). The Q&A sheet at docs/qa/qa-sheet.md is still usable; try again before the live session.";
export const PER_QUESTION_FALLBACK =
  "Rehearsal fallback: judge unavailable for this answer — review draft_answer in docs/qa/qa-sheet.md.";

//#region Sheet loading (JSON or Markdown — §9.1 accepts both)

/** Tolerant Markdown sheet parser. Accepts both shapes:
 *   generated:  `## q-01 [business_value + sponsor-slug] — grounded: partial`
 *   fallback:   `## Business Value (q-02) — grounded: not_stated`
 * with `Q:` / optional `WARNING: Unverified — A:` / `Sources:` lines. */
export function parseMarkdownSheet(md: string): FaqdefSheetEntry[] {
  const entries: FaqdefSheetEntry[] = [];
  const blocks = md.split(/^## /m).slice(1);
  let fallbackIndex = 0;
  for (const block of blocks) {
    const dashIdx = block.indexOf("—");
    if (dashIdx === -1) continue;
    const headLeft = block.slice(0, dashIdx).trim();
    const grounding = /grounded:\s*(\w+)/.exec(block.slice(dashIdx))?.[1];

    // id: parenthesised (fallback) or leading token (generated)
    const parenId = /\((q-\d{2})\)/i.exec(headLeft)?.[1];
    const leadId = /^[\w-]*q-\d{2}$/i.exec(headLeft.split(/\s|\[/)[0]?.trim() ?? "")?.[0];
    const id = (parenId ?? leadId ?? "").toLowerCase();

    // tags: bracketed list (generated) or free text before the id parens (fallback)
    let tags: string[] = [];
    const bracket = /\[([^\]]*)\]/.exec(headLeft);
    if (bracket?.[1]) {
      tags = bracket[1].split("+").map((t) => t.trim()).filter(Boolean);
    } else {
      tags = headLeft
        .replace(/\(q-\d{2}\)/gi, "")
        .split(/[\s/]+/)
        .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ""))
        .filter((t) => t.length > 0 && t !== "sponsor-track" && t !== "placeholder");
      if (id && !tags.some((t) => t.startsWith("q-"))) {
        // fallback headers carry axis words; keep them as-is (they are slugs already)
      }
    }

    const qMatch = /^Q: (.+)$/m.exec(block);
    const aMatch = /^(?:WARNING: Unverified — )?A: (.+)$/m.exec(block);
    const sMatch = /^Sources: (.+)$/m.exec(block);
    if (!qMatch || !id) continue;
    fallbackIndex += 1;
    entries.push({
      id,
      question: qMatch[1]!.trim(),
      tags,
      draft_answer: aMatch?.[1]?.trim() ?? "",
      citations: sMatch
        ? sMatch[1]!.split("·").map((s) => s.trim())
        : grounding === "not_stated"
          ? ["not_stated"]
          : [],
      source_grounding: (grounding as FaqdefSheetEntry["source_grounding"]) ?? "not_stated",
    });
  }
  return entries;
}

/** Accepts qa-sheet.json (RES-04 shape) OR the human qa-sheet.md. */
export function loadSheet(path: string): { ok: true; entries: FaqdefSheetEntry[] } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: `sheet not found at ${path}` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(raw) as { questions?: FaqdefSheetEntry[] };
      if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
        return { ok: false, error: "sheet JSON has no questions[]" };
      }
      return { ok: true, entries: parsed.questions };
    } catch (err) {
      return { ok: false, error: `invalid sheet JSON: ${String(err)}` };
    }
  }
  const entries = parseMarkdownSheet(raw);
  if (entries.length === 0) return { ok: false, error: "no q-XX sections found in markdown sheet" };
  return { ok: true, entries };
}

//#endregion

//#region Sampling + prompt + feedback parsing (pure, unit-testable)

/** Sample without replacement, filtered by axes BEFORE the draw, weighted by
 * rehearsal demand: not_stated answers weigh ×3 (they need practice most). */
export function sampleQuestions(
  entries: FaqdefSheetEntry[],
  opts: { count: number; axes?: string[] },
): FaqdefSheetEntry[] {
  let pool = entries;
  if (opts.axes && opts.axes.length > 0) {
    pool = entries.filter((e) => e.tags.some((t) => opts.axes!.includes(t)));
  }
  const remaining = [...pool];
  const target = Math.min(opts.count, remaining.length);
  const picked: FaqdefSheetEntry[] = [];
  while (picked.length < target && remaining.length > 0) {
    const weights = remaining.map((e) => (e.source_grounding === "not_stated" ? 3 : 1));
    let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
    let idx = 0;
    for (; idx < remaining.length - 1 && roll >= weights[idx]!; idx++) {
      roll -= weights[idx]!;
    }
    picked.push(remaining.splice(idx, 1)[0]!);
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

/** Render the strict-judge persona template with runtime-only content. */
export function renderJudgePrompt(template: string, args: {
  axis: string;
  question: string;
  participantAnswer: string;
  grounding: string;
}): string {
  return template
    .replace(/\{\{\s*axis\s*\}\}/g, args.axis)
    .replace(/\{\{\s*question\s*\}\}/g, args.question)
    .replace(/\{\{\s*participant_answer\s*\}\}/g, args.participantAnswer)
    .replace(/\{\{\s*draft_answer_grounding\s*\}\}/g, args.grounding);
}

/** Extract the trailing `Score: N/5`; absent/malformed → null score. */
export function parseFeedback(text: string): { body: string; score: number | null } {
  const m = /Score:\s*([1-5])\s*\/\s*5/.exec(text);
  const score = m ? Number.parseInt(m[1]!, 10) : null;
  return { body: text.trim(), score };
}

//#endregion

//#region Interactive session

export interface RehearsalIo {
  /** Prompt + read one participant answer; resolves at Enter or budget expiry. */
  ask(prompt: string, budgetS: number): Promise<string>;
  write(line: string): void;
}

/** Node readline I/O with the visible countdown (§5.6). Auto-submits the
 * current buffer when the budget expires (FAQDEF-05). Exported for reuse. */
export function createNodeRehearsalIo(): RehearsalIo {
  return {
    ask: (prompt, budgetS) =>
      new Promise<string>((resolvePrompt) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        let buffer = "";
        let settled = false;
        let remaining = budgetS;
        const tick = setInterval(() => {
          remaining -= 1;
          if (remaining > 0) process.stdout.write(`\r${prompt} [${remaining}s] `);
        }, 1000);
        const finish = (value: string) => {
          if (settled) return;
          settled = true;
          clearInterval(tick);
          rl.close();
          resolvePrompt(value);
        };
        // countdown display then line collection; expiry auto-submits buffer
        process.stdout.write(`\r${prompt} [${remaining}s] `);
        rl.on("line", (line) => finish(line));
        // Ctrl+C exits cleanly mid-session (§5.5): no stack trace, no partial
        // artifact — the session was never persisted.
        rl.on("SIGINT", () => {
          if (settled) return;
          settled = true;
          clearInterval(tick);
          rl.close();
          process.stdout.write("\nInterrupted — session ended (not persisted).\n");
          process.exit(0);
        });
        setTimeout(() => finish(buffer), budgetS * 1000);
      }),
    write: (line) => console.log(line),
  };
}

export interface RehearseOptions {
  qaPath: string;
  count?: number;
  budgetS?: number;
  axes?: string[];
  strict?: boolean;
  logPath?: string;
  defaultSubsetSize?: number;
  defaultBudgetS?: number;
  /** Injected judge callable (tests/offline). Default: provider call. */
  callLlm?: FaqdefLlm;
  io?: RehearsalIo;
}

/** Session driver — returns exit code (0 on success AND on RES-01 exhaustion). */
export async function runRehearsal(opts: RehearseOptions): Promise<number> {
  const sheet = loadSheet(opts.qaPath);
  if (!sheet.ok) {
    console.error(`error: ${sheet.error}`);
    return 2;
  }
  const count = opts.count ?? opts.defaultSubsetSize ?? 5;
  const budgetS = Math.min(300, Math.max(30, opts.budgetS ?? opts.defaultBudgetS ?? 90));
  const strict = opts.strict !== false;
  void strict; // persona tone switch — the shipped template is strict; --no-strict is a session-local soften

  const picked = sampleQuestions(sheet.entries, { count, axes: opts.axes });
  if (picked.length === 0) {
    console.error("error: no questions match the requested axes filter");
    return 2;
  }

  const io = opts.io ?? createNodeRehearsalIo();
  const template = existsSync(JUDGE_TEMPLATE_PATH)
    ? readFileSync(JUDGE_TEMPLATE_PATH, "utf8")
    : "You are a strict hackathon judge for axis {{axis}}. Q: {{question}} A: {{participant_answer}} Grounding: {{draft_answer_grounding}} Give Strength/Gap/Tip bullets and end with Score: N/5.";
  const logLines: string[] = [];
  const scores: number[] = [];

  io.write(`FAQDEF — Strict Judge Rehearsal (budget ${budgetS} s per question, press Enter to submit, Ctrl+C to exit)`);
  io.write("");

  for (let i = 0; i < picked.length; i++) {
    const q = picked[i]!;
    const axisTag = q.tags.find((t) => !t.startsWith("q-")) ?? "presentation";
    io.write(`Q${i + 1}/${picked.length} [${q.tags.join("+")}] ${q.question} (${budgetS} s)`);
    const answer = await io.ask(">", budgetS); // FAQDEF-05 auto-submit at expiry
    io.write("");

    const prompt = renderJudgePrompt(template, {
      axis: axisTag,
      question: q.question,
      participantAnswer: answer,
      grounding: q.draft_answer,
    });
    // §5.6: judge-call timeout is budget+30 s via RES-01's timeout_ms.
    const wrapped = resilientFaqdefCall(
      opts.callLlm ?? ((input: string) => defaultCallLlm("faqdef_judge", input)),
      prompt,
      { timeout_ms: (budgetS + 30) * 1000, retries: 1 },
    );
    const result = await wrapped();

    if (typeof result !== "string") {
      // Whole-session unavailability (RES-01 exhausted) — never hang, exit 0.
      io.write(REHEARSAL_UNAVAILABLE);
      return 0;
    }
    const { body, score } = parseFeedback(result);
    if (score === null && body.length === 0) {
      io.write(PER_QUESTION_FALLBACK);
      logLines.push(`Q${i + 1}\t${q.id}\t<no feedback>`);
      continue;
    }
    if (score === null) {
      // single-answer degradation path per §5.5
      io.write(PER_QUESTION_FALLBACK);
      logLines.push(`Q${i + 1}\t${q.id}\t<judge output unparsable>`);
      continue;
    }
    for (const line of body.split(/\r?\n/)) io.write(`  ${line}`);
    scores.push(score);
    logLines.push(`Q${i + 1}\t${q.id}\tscore=${score}`);
    io.write("");
  }

  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  io.write(`Session: ${picked.length} questions, avg ${avg.toFixed(1)}/5.`);
  io.write("Not persisted.");

  // NOT persisted by default (FAQDEF-04) — only an explicit --log writes the
  // gitignored reports/faqdef/rehearsal.log; never rehearsal-history.json.
  if (opts.logPath) {
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(dirname(opts.logPath), { recursive: true });
      writeFileSync(opts.logPath, `${logLines.join("\n")}\n`, "utf8");
    } catch {
      /* best-effort — session itself already printed */
    }
  }
  return 0;
}

//#endregion
