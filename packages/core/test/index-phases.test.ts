import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runIndex, type IndexPhase, type PhaseProgress } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// Scratch lives inside this package and is gitignored. Removed after the tests.
const SCRATCH = join(here, "..", ".insight-test", `index-phases-${process.pid}`);

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// Two fake frontends, so the extract phase runs once per frontend. "alpha" owns *.txt and fails on any file
// containing "boom", which exercises the solo retry path. "beta" owns *.md and never fails.
function writePlugins(dir: string): void {
  const frontend = (id: string, glob: string, body: string) => {
    write(dir, `${id}/insight-plugin.json`, JSON.stringify({
      id,
      version: "0.1.0",
      irVersion: "^1.0",
      files: [glob],
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(dir, `${id}/index.mjs`, `export default {
  id: ${JSON.stringify(id)},
  version: "0.1.0",
  provides: ["structure"],
  async detect() { return { reason: "${id} files" }; },
  async *extract(ctx) {
${body}
  },
};
`);
  };
  frontend("alpha", "**/*.txt", `    for (const file of ctx.files) {
      const text = await ctx.readFile(file);
      if (text.includes("boom")) throw new Error("cannot read " + file);
      yield { file, records: [] };
    }`);
  frontend("beta", "**/*.md", `    for (const file of ctx.files) {
      yield { file, records: [] };
    }`);
}

function makeProject(name: string): string {
  const project = join(SCRATCH, name);
  write(project, "a.txt", "one\n");
  write(project, "b.txt", "boom\n");
  write(project, "c.txt", "three\n");
  write(project, "notes/d.md", "# d\n");
  write(project, "notes/e.md", "# e\n");
  return project;
}

const baseOpts = (projectPath: string, extra: Record<string, unknown> = {}) => ({
  projectPath,
  full: true,
  builtinRoot: join(SCRATCH, "no-builtins"),
  userPluginDir: join(SCRATCH, "no-user-plugins"),
  extraDirs: [join(SCRATCH, "plugins")],
  ...extra,
});

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writePlugins(join(SCRATCH, "plugins"));
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("runIndex onPhase", () => {
  it("emits scan, extract, link, analyze and save in order, with monotonic extract counts", async () => {
    const project = makeProject("ordered");
    const events: PhaseProgress[] = [];
    const report = await runIndex(baseOpts(project, { onPhase: (p: PhaseProgress) => events.push(p) }));

    // Each phase first appears in the documented order.
    const order: IndexPhase[] = ["scan", "extract", "link", "analyze", "save"];
    const firstSeen = order.map((ph) => events.findIndex((e) => e.phase === ph));
    expect(firstSeen.every((i) => i >= 0)).toBe(true);
    expect(firstSeen).toEqual([...firstSeen].sort((a, b) => a - b));

    // Both frontends extract, in their own extract phases.
    const frontends = [...new Set(events.filter((e) => e.phase === "extract").map((e) => e.frontend))];
    expect(frontends.sort()).toEqual(["alpha", "beta"]);

    for (const id of ["alpha", "beta"]) {
      const series = events.filter((e) => e.phase === "extract" && e.frontend === id);
      expect(series.length).toBeGreaterThan(1);
      expect(series[0]?.done).toBe(0);
      const dones = series.map((e) => e.done ?? -1);
      expect(dones).toEqual([...dones].sort((a, b) => a - b));
      const total = series[0]?.total ?? -1;
      expect(total).toBeGreaterThan(0);
      expect(series.every((e) => e.total === total)).toBe(true);
      expect(series.at(-1)?.done).toBe(total);
      expect(series.every((e) => e.label === `Extracting · ${id}`)).toBe(true);
      expect(series.every((e) => typeof e.step === "number")).toBe(true);
    }

    // The run itself still completes with the expected files.
    expect(report.extracted.length).toBe(5);
    expect(report.failed.map((f) => f.file)).toEqual(["b.txt"]);
  });

  it("does not fail the run when the callback throws", async () => {
    const project = makeProject("throwing");
    let calls = 0;
    const report = await runIndex(baseOpts(project, {
      onPhase: () => {
        calls++;
        throw new Error("callback broke");
      },
    }));
    expect(calls).toBeGreaterThan(0);
    expect(report.extracted.length).toBe(5);
    expect(report.snapshot).toMatch(/\S/);
  });
});
