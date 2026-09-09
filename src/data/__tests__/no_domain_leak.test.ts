// Requirement IDs: DATA-REU-01, GOV-REU-02, XCUT-08
// no_domain_leak.test.ts — guard test mirroring DP-H §9.3/§12: domain nouns live
// ONLY under examples/. Scans every src/data CODE file (.ts/.tsx/.py, excluding
// __tests__) and fails if any domain token appears — matching the plan's CI grep
// scope (--include="*.ts" --include="*.py"). README.md legitimately cites the
// fictional example domain in its Appendix A worked example, so docs are out of
// scope here; templates stay covered via their rendered prompts in tests.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DATA_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";
const FORBIDDEN = ["acme", "widget", "lorem"];

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue; // test files may name the tokens
      out.push(...listSources(full));
    } else if (/\.tsx?$|\.py$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("no_domain_leak (DATA-REU-01 / GOV-REU-02)", () => {
  it("src/data contains zero domain nouns", () => {
    for (const file of listSources(DATA_DIR)) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const token of FORBIDDEN) {
        expect(text).not.toContain(token);
      }
    }
    expect(listSources(DATA_DIR).length).toBeGreaterThan(0);
  });
});
