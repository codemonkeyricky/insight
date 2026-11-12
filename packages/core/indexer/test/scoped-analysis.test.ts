import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IRDocument } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import * as fx from "@insight/sdk/testing";
import { type Lens, type LensResult, type ProjectRoot } from "@insight/sdk";
import {
  ANALYSIS_SCHEMA,
  latestScopedRun,
  projectPaths,
  runLensOnScope,
  writeAnalysis,
  type LoadedLens,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `scoped-${process.pid}`);
const root: ProjectRoot = { path: join(SCRATCH, "project"), name: "project", allowBuildTools: false };
const paths = projectPaths(root.path);
const registry = createCoreRegistry();

function loaded(lens: Lens): LoadedLens {
  return { manifest: { id: lens.id, version: "1.0.0", irVersion: "1", roles: {} }, dir: SCRATCH, lens };
}

/** Two files, one call across them. */
const doc: IRDocument = {
  nodes: [
    fx.node("src/a.ts", "structure", "structure.file", { attrs: { path: "src/a.ts" }, span: fx.span("src/a.ts", 0, 0, 0, 0) }),
    fx.node("src/a.ts#a", "structure", "structure.function", { attrs: { name: "a" }, parent: "src/a.ts", span: fx.span("src/a.ts", 1, 0, 2, 1) }),
    fx.node("src/b.ts", "structure", "structure.file", { attrs: { path: "src/b.ts" }, span: fx.span("src/b.ts", 0, 0, 0, 0) }),
    fx.node("src/b.ts#b", "structure", "structure.function", { attrs: { name: "b" }, parent: "src/b.ts", span: fx.span("src/b.ts", 1, 0, 2, 1) }),
  ],
  edges: [fx.edge("src/a.ts#a", "src/b.ts#b", "calls", "calls.call")],
  findings: [],
};

let runs = 0;
const count: LoadedLens = loaded({
  id: "count",
  title: "Count",
  requires: ["structure"],
  run: async (view) => {
    runs++;
    return { findings: [], views: [], metrics: { nodes: view.nodes().length } };
  },
});

describe("runLensOnScope", () => {
  beforeAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });
  afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("runs the lens on the scope's IR, with external stubs counted in the view", async () => {
    const record = await runLensOnScope({ doc, registry, root, snapshot: "snap1", scope: "src/a.ts", lens: count, configs: {} });
    expect(record).toMatchObject({ id: "count", title: "Count", status: "ok", reused: false });
    expect(record.result?.metrics).toEqual({ nodes: 3 });
    const whole = await runLensOnScope({ doc, registry, root, snapshot: "snap1", scope: "", lens: count, configs: {} });
    expect(whole.status).toBe("ok");
    expect(whole.result?.metrics).toEqual({ nodes: 4 });
  });

  it("reports unavailable with the scope named when a required facet has no facts in the scope", async () => {
    const needsEffects = loaded({
      id: "effects-only",
      title: "Effects",
      requires: ["effects"],
      run: async () => ({ findings: [], views: [], metrics: {} }),
    });
    const record = await runLensOnScope({ doc, registry, root, snapshot: "snap1", scope: "src/a.ts", lens: needsEffects, configs: {} });
    expect(record.status).toBe("unavailable");
    expect(record.reason).toContain('scope "src/a.ts"');
    expect(record.reason).toContain("effects");
  });

  it("records a lens that throws as an error and stores nothing for it", async () => {
    const broken = loaded({
      id: "broken",
      title: "Broken",
      requires: ["structure"],
      run: async () => {
        throw new Error("boom");
      },
    });
    const record = await runLensOnScope({ doc, registry, root, snapshot: "snap-err", scope: "src", lens: broken, configs: {} });
    expect(record).toMatchObject({ status: "error", reason: "boom", reused: false });
    expect(existsSync(join(paths.analysis, "scopes", "snap-err"))).toBe(false);
  });

  it("stores an ok result and returns it again without running the lens", async () => {
    const before = runs;
    const first = await runLensOnScope({ doc, registry, root, snapshot: "snap-cache", scope: "src", lens: count, configs: {} });
    expect(first.reused).toBe(false);
    expect(runs).toBe(before + 1);
    const files = readdirSync(join(paths.analysis, "scopes", "snap-cache"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("src");

    const second = await runLensOnScope({ doc, registry, root, snapshot: "snap-cache", scope: "src", lens: count, configs: {} });
    expect(second.reused).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.inputsHash).toBe(first.inputsHash);
    expect(runs).toBe(before + 1);

    const changedConfig = await runLensOnScope({ doc, registry, root, snapshot: "snap-cache", scope: "src", lens: count, configs: { count: { v: 2 } } });
    expect(changedConfig.reused).toBe(false);
    expect(changedConfig.inputsHash).not.toBe(first.inputsHash);
  });

  it("keeps results for different scopes apart, even when their facts are equal", async () => {
    const folder = await runLensOnScope({ doc, registry, root, snapshot: "snap-scope", scope: "src", lens: count, configs: {} });
    const file = await runLensOnScope({ doc, registry, root, snapshot: "snap-scope", scope: "src/b.ts", lens: count, configs: {} });
    expect(folder.inputsHash).not.toBe(file.inputsHash);
    const latest = latestScopedRun(paths, "snap-scope", "src", "count");
    expect(latest?.result).toEqual(folder.result);
    expect(latestScopedRun(paths, "snap-scope", "src/b.ts", "count")?.result).toEqual(file.result);
    expect(latestScopedRun(paths, "snap-scope", "src/none.ts", "count")).toBeUndefined();
  });

  it("runs the lenses an `after` names first, on the same scope, and passes their result along", async () => {
    const seen: LensResult[] = [];
    const base = loaded({
      id: "base",
      title: "Base",
      requires: ["structure"],
      run: async () => ({ findings: [], views: [], metrics: { base: 7 } }),
    });
    const dependent = loaded({
      id: "dependent",
      title: "Dependent",
      requires: ["structure"],
      after: ["base"],
      run: async (_view, ctx) => {
        const upstream = ctx.resultOf("base");
        if (upstream) seen.push(upstream);
        return { findings: [], views: [], metrics: { fromBase: upstream?.metrics.base ?? -1 } };
      },
    });
    const record = await runLensOnScope({
      doc,
      registry,
      root,
      snapshot: "snap-dep",
      scope: "src/a.ts",
      lens: dependent,
      lenses: [dependent, base],
      configs: {},
    });
    expect(record.result?.metrics).toEqual({ fromBase: 7 });
    expect(seen).toHaveLength(1);
    expect(existsSync(join(paths.analysis, "scopes", "snap-dep"))).toBe(true);
  });

  it("returns the record stored for the snapshot when asked for the project scope", async () => {
    writeAnalysis(paths, {
      schema: ANALYSIS_SCHEMA,
      snapshot: "snap-stored",
      lenses: [
        {
          id: "count",
          title: "Count",
          status: "ok",
          reused: false,
          inputsHash: "stored-hash",
          result: { findings: [], views: [], metrics: { stored: 1 } },
        },
      ],
    });
    const record = await runLensOnScope({ doc, registry, root, snapshot: "snap-stored", scope: "", lens: count, configs: {} });
    expect(record).toMatchObject({ inputsHash: "stored-hash", result: { metrics: { stored: 1 } } });
  });
});
