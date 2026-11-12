import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths, readSnapshot, runIndex, type IndexReport } from "@insight/indexer";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../frontend/typescript/test/fixtures/sample-ts");
// Scratch lives inside this package and is gitignored. Removed after the test.
const SCRATCH = join(here, "..", ".insight-test", `incremental-${process.pid}`);

const live = join(SCRATCH, "live");
let freshCount = 0;

/** Copies the project's source (not its .insight state) to a new directory. */
function copySource(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".insight") });
}

/** Records of the snapshot a run produced, in canonical order. */
function recordsOf(root: string, report: IndexReport): string {
  return JSON.stringify(readSnapshot(projectPaths(root), report.snapshot));
}

/** Runs a from-scratch index in a fresh copy of the current source and returns its snapshot. */
async function fullIndex(): Promise<{ id: string; records: string }> {
  const dir = join(SCRATCH, `fresh-${++freshCount}`);
  copySource(live, dir);
  const report = await runIndex({ projectPath: dir, full: true });
  return { id: report.snapshot, records: recordsOf(dir, report) };
}

function edit(rel: string, from: string, to: string): void {
  const file = join(live, rel);
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${rel} does not contain ${JSON.stringify(from)}`);
  writeFileSync(file, text.replace(from, to));
}

interface Step {
  name: string;
  apply(): void;
  /** Files that must be re-extracted. Omitted when the step does not check extraction. */
  extracted?: string[];
  /** Files that must be reported as removed or renamed, checked by a predicate. */
  check?: (report: IndexReport) => void;
}

const steps: Step[] = [
  {
    name: "change: edit one function body",
    apply: () => edit("src/lib/math.ts", "return a + b;", "return b + a;"),
    extracted: ["src/lib/math.ts"],
  },
  {
    name: "no change: nothing extracted",
    apply: () => undefined,
    extracted: [],
  },
  {
    name: "add: new file that imports math",
    apply: () =>
      writeFileSync(
        join(live, "src/lib/extra.ts"),
        'import { add } from "./math.js";\n\nexport const triple = (x: number): number => add(x, add(x, x));\n',
      ),
    extracted: ["src/lib/extra.ts"],
  },
  {
    name: "signature change: dependents are re-extracted",
    apply: () => edit("src/lib/math.ts", "export function add(a: number, b: number): number {\n  return b + a;", "export function add(a: number, b: number, c = 0): number {\n  return b + a + c;"),
    extracted: ["src/lib/math.ts", "src/app/main.ts", "src/lib/extra.ts"],
  },
  {
    name: "rename: math.ts becomes maths.ts, importers updated",
    apply: () => {
      renameSync(join(live, "src/lib/math.ts"), join(live, "src/lib/maths.ts"));
      edit("src/app/main.ts", '"../lib/math.js"', '"../lib/maths.js"');
      edit("src/lib/extra.ts", '"./math.js"', '"./maths.js"');
    },
    check: (report) => {
      expect(report.changes.renamed.map((r) => r.to)).toContain("src/lib/maths.ts");
    },
  },
  {
    name: "delete: a file is removed",
    apply: () => unlinkSync(join(live, "src/lib/extra.ts")),
    check: (report) => {
      expect(report.removed.map((r) => r.file)).toContain("src/lib/extra.ts");
    },
  },
  {
    name: "build file: tsconfig.json edit",
    apply: () => edit("tsconfig.json", '"strict": true', '"strict": false'),
  },
  {
    name: "return type change in a dependency",
    apply: () => edit("src/lib/maths.ts", "export const double = (n: number): number => add(n, n);", "export const double = (n: number) => String(add(n, n));"),
  },
];

describe("incremental index equals a from-scratch index", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    copySource(FIXTURE, live);
  });

  afterAll(() => {
    rmSync(join(here, "..", ".insight-test"), { recursive: true, force: true });
  });

  it("matches a full re-index after every scripted edit", async () => {
    const results: { step: string; extracted: string[]; matchesFull: boolean }[] = [];

    const first = await runIndex({ projectPath: live });
    const firstFull = await fullIndex();
    results.push({ step: "initial index", extracted: first.extracted.map((e) => e.file), matchesFull: first.snapshot === firstFull.id && recordsOf(live, first) === firstFull.records });

    for (const step of steps) {
      step.apply();
      const report = await runIndex({ projectPath: live });
      const full = await fullIndex();
      const extracted = report.extracted.map((e) => e.file).sort();
      results.push({
        step: step.name,
        extracted,
        matchesFull: report.snapshot === full.id && recordsOf(live, report) === full.records,
      });
      if (step.extracted) {
        expect({ step: step.name, extracted }).toEqual({ step: step.name, extracted: [...step.extracted].sort() });
      }
      step.check?.(report);
    }

    expect(results.filter((r) => !r.matchesFull)).toEqual([]);
  }, 180_000);
});
