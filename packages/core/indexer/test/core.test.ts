import { mkdirSync, rmSync, unlinkSync, utimesSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffTrees, loadPlugins, runIndex, scanProject } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// Scratch lives inside this package and is gitignored. Removed after the tests.
const SCRATCH = join(here, "..", ".insight-test", `core-${process.pid}`);

function write(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  // Remove only this suite's scratch, since the other core suites run in parallel workers.
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("merkle scan", () => {
  const root = join(SCRATCH, "merkle");

  it("honours .gitignore and always skips .insight, .git and node_modules", () => {
    write(root, ".gitignore", "dist/\n*.log\n");
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "dist/out.js", "built\n");
    write(root, "debug.log", "noise\n");
    write(root, "node_modules/x/index.js", "dep\n");
    write(root, ".insight/state.json", "{}\n");
    const scan = scanProject(root);
    expect([...scan.files.keys()]).toEqual([".gitignore", "src/a.ts"]);
    expect(scan.rehashed).toBe(2);
  });

  it("reuses cached hashes when size and mtime are unchanged, and rehashes what changed", () => {
    const first = scanProject(root);
    const again = scanProject(root, first.stats);
    expect(again.rehashed).toBe(0);
    expect(again.files).toEqual(first.files);

    write(root, "src/a.ts", "export const a = 2;\n");
    const changed = scanProject(root, again.stats);
    expect(changed.rehashed).toBe(1);
    const diff = diffTrees(first.tree, changed.tree);
    expect(diff.modified).toEqual(["src/a.ts"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("reports a moved file with equal content as a rename, not as add plus remove only", () => {
    const before = scanProject(root);
    renameSync(join(root, "src/a.ts"), join(root, "src/renamed.ts"));
    const after = scanProject(root, before.stats);
    const diff = diffTrees(before.tree, after.tree);
    expect(diff.renamed).toEqual([{ from: "src/a.ts", to: "src/renamed.ts" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("reports deletions", () => {
    const before = scanProject(root);
    unlinkSync(join(root, "src/renamed.ts"));
    const after = scanProject(root, before.stats);
    const diff = diffTrees(before.tree, after.tree);
    expect(diff.removed).toEqual(["src/renamed.ts"]);
    expect(diff.renamed).toEqual([]);
  });

  it("treats an identical tree as no change", () => {
    const a = scanProject(root);
    const b = scanProject(root, a.stats);
    const diff = diffTrees(a.tree, b.tree);
    expect(diff).toEqual({ added: [], removed: [], modified: [], renamed: [] });
  });

  it("notices a same-size edit when the mtime moves", () => {
    const first = scanProject(root);
    const file = join(root, ".gitignore");
    writeFileSync(file, "dist/\n*.tmp\n");
    utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const second = scanProject(root, first.stats);
    expect(second.files.get(".gitignore")).not.toBe(first.files.get(".gitignore"));
  });
});

describe("merkle scan skips nested repos and worktrees", () => {
  const root = join(SCRATCH, "merkle-nested");

  it("skips a nested directory that holds a .git file (worktree)", () => {
    write(root, "src/a.ts", "export const a = 1;\n");
    write(root, "wt/.git", "gitdir: /elsewhere/.git/worktrees/wt\n");
    write(root, "wt/src/b.ts", "export const b = 1;\n");
    const scan = scanProject(root);
    expect([...scan.files.keys()]).toEqual(["src/a.ts"]);
  });

  it("skips a nested directory that holds a .git directory (nested repo)", () => {
    write(root, "vendor/lib/.git/HEAD", "ref: refs/heads/main\n");
    write(root, "vendor/lib/index.ts", "export {};\n");
    const scan = scanProject(root);
    expect([...scan.files.keys()]).toEqual(["src/a.ts"]);
  });

  it("skips .claude/worktrees explicitly, even without a .git entry", () => {
    write(root, ".claude/worktrees/x/src/c.ts", "export {};\n");
    write(root, ".claude/settings.json", "{}\n");
    const scan = scanProject(root);
    expect([...scan.files.keys()]).toEqual([".claude/settings.json", "src/a.ts"]);
  });

  it("still indexes the root when the root itself has a .git directory", () => {
    const top = join(SCRATCH, "merkle-root-git");
    write(top, ".git/HEAD", "ref: refs/heads/main\n");
    write(top, "src/root.ts", "export const r = 1;\n");
    const scan = scanProject(top);
    expect([...scan.files.keys()]).toEqual(["src/root.ts"]);
  });
});

describe("plugin loader", () => {
  it("disables a broken plugin with a reason and keeps the rest", async () => {
    const project = join(SCRATCH, "loader-project");
    const plugins = join(SCRATCH, "loader-plugins");
    mkdirSync(project, { recursive: true });
    write(plugins, "broken/insight-plugin.json", JSON.stringify({ id: "broken", version: "0.1.0" }));
    write(plugins, "missing-entry/insight-plugin.json", JSON.stringify({
      id: "missing-entry",
      version: "0.1.0",
      irVersion: "^1.0",
      roles: { frontend: "nope.mjs" },
    }));
    write(plugins, "good/insight-plugin.json", JSON.stringify({
      id: "good",
      version: "0.1.0",
      irVersion: "^1.0",
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(plugins, "good/index.mjs", "export default { id: 'good', version: '0.1.0', provides: ['structure'], async detect() { return { reason: 'always' }; }, async *extract() {} };\n");

    const loaded = await loadPlugins({
      projectPath: project,
      builtinRoot: join(SCRATCH, "no-builtins"),
      userPluginDir: join(SCRATCH, "no-user-plugins"),
      extraDirs: [plugins],
    });
    expect(loaded.frontends.map((f) => f.frontend.id)).toEqual(["good"]);
    const disabled = Object.fromEntries(loaded.disabled.map((d) => [d.id, d.reason]));
    expect(Object.keys(disabled).sort()).toEqual(["broken", "missing-entry"]);
    expect(disabled["missing-entry"]).toMatch(/nope\.mjs/);
  });
});

describe("plugin loader, nested folders", () => {
  it("loads a plugin one folder down inside packages/ (packages/lens/<name>)", async () => {
    const builtin = join(SCRATCH, "nested-builtin");
    write(builtin, "packages/lens/nested/insight-plugin.json", JSON.stringify({
      id: "nested",
      version: "0.1.0",
      irVersion: "^1.0",
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(builtin, "packages/lens/nested/index.mjs", "export default { id: 'nested', version: '0.1.0', provides: ['structure'], async detect() { return { reason: 'always' }; }, async *extract() {} };\n");
    write(builtin, "packages/direct/insight-plugin.json", JSON.stringify({
      id: "direct",
      version: "0.1.0",
      irVersion: "^1.0",
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(builtin, "packages/direct/index.mjs", "export default { id: 'direct', version: '0.1.0', provides: ['structure'], async detect() { return { reason: 'always' }; }, async *extract() {} };\n");
    const loaded = await loadPlugins({
      projectPath: join(SCRATCH, "nested-project"),
      builtinRoot: builtin,
      userPluginDir: join(SCRATCH, "no-user-plugins"),
    });
    expect(loaded.frontends.map((f) => f.frontend.id)).toEqual(["direct", "nested"]);
    expect(loaded.disabled).toEqual([]);
  });
});

describe("pipeline with a fake frontend", () => {
  it("records a file that fails extraction as failed and keeps the other files", async () => {
    const project = join(SCRATCH, "pipeline-project");
    const plugins = join(SCRATCH, "pipeline-plugins");
    write(project, "ok.txt", "fine\n");
    write(project, "bad.txt", "boom\n");
    write(plugins, "fake/insight-plugin.json", JSON.stringify({
      id: "fake",
      version: "0.1.0",
      irVersion: "^1.0",
      files: ["**/*.txt"],
      provides: ["structure"],
      roles: { frontend: "index.mjs" },
    }));
    write(plugins, "fake/index.mjs", `export default {
  id: "fake",
  version: "0.1.0",
  provides: ["structure"],
  async detect() { return { reason: "txt files" }; },
  async *extract(ctx) {
    for (const file of ctx.files) {
      const text = await ctx.readFile(file);
      if (text.includes("boom")) throw new Error("cannot read " + file);
      yield { file, records: [] };
    }
  },
};
`);
    const report = await runIndex({
      projectPath: project,
      builtinRoot: join(SCRATCH, "no-builtins"),
      userPluginDir: join(SCRATCH, "no-user-plugins"),
      extraDirs: [plugins],
    });
    expect(report.failed.map((f) => f.file)).toEqual(["bad.txt"]);
    expect(report.failed[0]?.message).toMatch(/cannot read bad\.txt/);
    expect(report.extracted.map((e) => e.file)).toContain("ok.txt");
    expect(report.findings).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(project, ".insight"))).toBe(true);
  });
});
