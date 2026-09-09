// Requirement IDs: DATA-04
// Guard — DP-H §9.3 row 4: src/data contains NO schema-validation engine of its
// own — no `new Ajv`, `new Zod`, or standalone jsonschema usage. Validation is
// imported from src/resilience (the single RES-04 owner); this fs-scan enforces it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN = ["new Ajv", "new Zod", "jsonschema", "from \"ajv\"", "from \"zod\""];

describe("res04_reuse (DATA-04) — no bespoke validator in src/data", () => {
  it("no validation-engine usage outside src/resilience imports", () => {
    const files = listTsFiles(DATA_DIR); // guard targets core code; tests may NAME the engines
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      if (file.includes("__tests__")) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        // Importing validate/repair FROM src/resilience is the sanctioned pattern.
        if (line.includes("src/resilience")) return;
        for (const token of FORBIDDEN) {
          expect(line.includes(token), `${file}:${i + 1} contains "${token}" — validation must come from src/resilience (DATA-04)`).toBe(false);
        }
      });
    }
  });

  it("src/data actually imports the shared validate engine somewhere in core code", () => {
    const core = listTsFiles(DATA_DIR).filter((f) => !f.includes("__tests__"));
    const anyImport = core.some((f) => readFileSync(f, "utf8").includes('from "src/resilience"'));
    expect(anyImport).toBe(true);
  });
});
