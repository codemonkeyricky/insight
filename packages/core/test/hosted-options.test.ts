import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IndexLimitError, runIndex, scanProject, type IndexOptions, type IndexReport } from "../src/index.js";

// Counts how many times better-sqlite3 is loaded. The core imports it lazily, so a run without an index database never loads it.
const sqlite = vi.hoisted(() => ({ loads: 0 }));
vi.mock("better-sqlite3", async (importOriginal) => {
  sqlite.loads++;
  return importOriginal();
});

const here = dirname(fileURLToPath(import.meta.url));
// Scratch lives inside this package and is removed after the tests.
const SCRATCH = join(here, "..", ".insight-test", `hosted-options-${process.pid}`);
const NO_BUILTINS = join(SCRATCH, "no-builtins");
const NO_USER_PLUGINS = join(SCRATCH, "no-user-plugins");

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A frontend over *.txt files that yields an empty batch for each. Enough for a real run. */
function textFrontend(root: string): void {
  write(root, "insight-plugin.json", JSON.stringify({
    id: "probe",
    version: "0.1.0",
    irVersion: "^1.0",
    files: ["**/*.txt"],
    provides: ["structure"],
    roles: { frontend: "index.mjs" },
  }));
  write(root, "index.mjs", `export default {
  id: "probe",
  version: "0.1.0",
  provides: ["structure"],
  async detect() { return { reason: "txt files" }; },
  async *extract(ctx) {
    for (const file of ctx.files) yield { file, records: [] };
  },
};
`);
}

/**
 * A plugin that is in the project's own .insight/plugins folder. Importing it writes a marker file, so a test can tell
 * whether the indexer loaded it. Its detect returns null, so it contributes no records.
 */
function evilPlugin(project: string, marker: string): void {
  write(project, ".insight/plugins/evil/insight-plugin.json", JSON.stringify({
    id: "evil",
    version: "0.1.0",
    irVersion: "^1.0",
    files: ["**/*.never"],
    provides: ["structure"],
    roles: { frontend: "index.mjs" },
  }));
  write(project, ".insight/plugins/evil/index.mjs", `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
export default {
  id: "evil",
  version: "0.1.0",
  provides: ["structure"],
  async detect() { return null; },
  async *extract() {},
};
`);
}

function project(name: string): string {
  const root = join(SCRATCH, name);
  rmSync(root, { recursive: true, force: true });
  write(root, "a.txt", "one\n");
  write(root, "b.txt", "two\n");
  write(root, "c.txt", "three\n");
  return root;
}

/** Options with no built-in or user plugins, so only the test's own probe frontend runs. */
function baseOpts(projectPath: string, extra: Partial<IndexOptions> = {}): IndexOptions {
  return {
    projectPath,
    full: true,
    builtinRoot: NO_BUILTINS,
    userPluginDir: NO_USER_PLUGINS,
    ...extra,
  };
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(NO_BUILTINS, { recursive: true });
  mkdirSync(NO_USER_PLUGINS, { recursive: true });
  textFrontend(join(NO_USER_PLUGINS, "probe"));
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("writeIndexDb", () => {
  it("writes no index.sqlite and never loads better-sqlite3 when turned off", async () => {
    const root = project("db-off");
    const state = join(SCRATCH, "state-db-off");
    // This is the first run in the file, so the driver has not been loaded by anything before it.
    expect(sqlite.loads).toBe(0);
    const report = await runIndex(baseOpts(root, { writeIndexDb: false, stateDir: state }));
    expect(report.snapshot).toBeTruthy();
    expect(existsSync(join(state, "index.sqlite"))).toBe(false);
    expect(sqlite.loads).toBe(0);
  });

  it("writes index.sqlite by default and then loads better-sqlite3", async () => {
    const root = project("db-on");
    const state = join(SCRATCH, "state-db-on");
    await runIndex(baseOpts(root, { stateDir: state }));
    expect(existsSync(join(state, "index.sqlite"))).toBe(true);
    expect(sqlite.loads).toBeGreaterThan(0);
  });
});

describe("projectPlugins", () => {
  it("never imports a plugin from the project's .insight/plugins when turned off", async () => {
    const root = project("plugins-off");
    const marker = join(SCRATCH, "marker-off.txt");
    evilPlugin(root, marker);
    const report = await runIndex(baseOpts(root, { projectPlugins: false }));
    expect(report.snapshot).toBeTruthy();
    expect(existsSync(marker)).toBe(false);
  });

  it("imports the project's plugin by default, so the marker above means something", async () => {
    const root = project("plugins-on");
    const marker = join(SCRATCH, "marker-on.txt");
    evilPlugin(root, marker);
    await runIndex(baseOpts(root));
    expect(existsSync(marker)).toBe(true);
  });
});

describe("limits", () => {
  it("fails the run with a readable IndexLimitError when the file count is over the limit", async () => {
    const root = project("limit-count");
    const err: unknown = await runIndex(baseOpts(root, { limits: { maxFiles: 2 } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexLimitError);
    expect((err as Error).message).toBe("repo has 3 files; limit 2");
  });

  it("fails the run when the total bytes are over the limit", async () => {
    const root = project("limit-total");
    write(root, "big.txt", "x".repeat(2 * 1024 * 1024));
    await expect(runIndex(baseOpts(root, { limits: { maxTotalBytes: 1024 * 1024 } }))).rejects.toThrow(
      "repo has 2.0 MiB of files; limit 1.0 MiB",
    );
  });

  it("skips a file over maxFileBytes with a warning and indexes the rest", async () => {
    const root = project("limit-file");
    write(root, "big.txt", "x".repeat(2048));
    const report: IndexReport = await runIndex(baseOpts(root, { limits: { maxFileBytes: 1024 } }));
    expect(report.logs).toContain("warning: skipped big.txt: 2.0 KiB, over the 1.0 KiB per-file limit");
    const indexed = report.extracted.map((e) => e.file);
    expect(indexed).toEqual(expect.arrayContaining(["a.txt", "b.txt", "c.txt"]));
    expect(indexed).not.toContain("big.txt");
  });

  it("does not hash files past a cap, and still reports the count", () => {
    const root = project("limit-scan");
    write(root, "d.txt", "four\n");
    expect(() => scanProject(root, {}, { maxFiles: 3 })).toThrow(IndexLimitError);
    expect(() => scanProject(root, {}, { maxFiles: 4 })).not.toThrow();
  });

  it("is off by default, so a local run has no caps", () => {
    const root = project("limit-off");
    write(root, "big.txt", "x".repeat(3 * 1024 * 1024));
    const scan = scanProject(root);
    expect(scan.skipped).toEqual([]);
    expect(scan.files.has("big.txt")).toBe(true);
  });
});

describe("keepSnapshots", () => {
  it("keeps only the newest snapshot when set to 1", async () => {
    const root = project("keep-one");
    const state = join(SCRATCH, "state-keep-one");
    await runIndex(baseOpts(root, { stateDir: state, keepSnapshots: 1 }));
    write(root, "a.txt", "changed\n");
    const second = await runIndex(baseOpts(root, { stateDir: state, keepSnapshots: 1 }));
    const saved = JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { snapshots: { id: string }[]; latest: string };
    expect(saved.snapshots.map((s) => s.id)).toEqual([second.snapshot]);
    expect(saved.latest).toBe(second.snapshot);
  });

  it("rejects a keepSnapshots that is not a whole number of 1 or more", async () => {
    await expect(runIndex(baseOpts(project("keep-bad"), { keepSnapshots: 0 }))).rejects.toThrow("keepSnapshots");
  });
});

describe("the defaults", () => {
  it("keeps today's local behaviour: plugins load, the index is written, snapshots are kept", async () => {
    const root = project("local-default");
    const state = join(SCRATCH, "state-local-default");
    const report = await runIndex(baseOpts(root, { stateDir: state }));
    expect(report.extracted.length).toBe(3);
    expect(statSync(join(state, "index.sqlite")).size).toBeGreaterThan(0);
    const saved = JSON.parse(readFileSync(join(state, "state.json"), "utf8")) as { snapshots: unknown[] };
    expect(saved.snapshots.length).toBe(1);
    // A symlink is never followed by the scanner, so it cannot pull in a file from outside the project.
    symlinkSync(join(SCRATCH, "a.txt"), join(root, "link.txt"));
    expect(scanProject(root).files.has("link.txt")).toBe(false);
  });
});
