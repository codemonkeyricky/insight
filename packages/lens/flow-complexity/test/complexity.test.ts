import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type LensResult } from "@insight/sdk";
import { lensFlowComplexity, measureFunctions } from "../src/index.js";

const ctx = (config?: unknown) => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config,
  resultOf: () => undefined,
});

/** f has two branches (one switch), a loop and a try: complexity 1 + 2 + 1 + 1 = 5. g is straight-line. */
function fixture() {
  const span = fx.span("src/a.ts", 0, 0, 9, 1);
  return fx.view({
    nodes: [
      fx.node("src/a.ts", "structure", "structure.file"),
      fx.node("src/a.ts#f", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "f" }, span }),
      fx.node("src/a.ts#g", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "g" }, span: fx.span("src/a.ts", 10, 0, 12, 1) }),
      fx.node("src/a.ts@b1", "flow", "flow.branch", { parent: "src/a.ts#f" }),
      fx.node("src/a.ts@b2", "flow", "flow.switch", { parent: "src/a.ts#f" }),
      fx.node("src/a.ts@l1", "flow", "flow.loop", { parent: "src/a.ts#f" }),
      fx.node("src/a.ts@t1", "flow", "flow.try", { parent: "src/a.ts#f" }),
      fx.node("src/a.ts@r1", "flow", "flow.return", { parent: "src/a.ts#g" }),
    ],
  });
}

describe("measureFunctions", () => {
  it("counts branches, switches, loops and tries per owning function", () => {
    const [top, bottom] = measureFunctions(fixture());
    expect(top).toMatchObject({ id: "src/a.ts#f", complexity: 5, branches: 2, loops: 1, tries: 1 });
    expect(bottom).toMatchObject({ id: "src/a.ts#g", complexity: 1 });
  });
});

describe("lensFlowComplexity", () => {
  it("warns only for functions above the configured threshold", async () => {
    const result: LensResult = await lensFlowComplexity.run(fixture(), ctx({ maxComplexity: 4 }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ lens: "lens-flow-complexity", severity: "warning", nodes: ["src/a.ts#f"] });
    expect(result.metrics).toMatchObject({ functions: 2, maxComplexity: 5, overThreshold: 1, threshold: 4 });
  });

  it("uses 10 when the config is missing or not a positive number", async () => {
    const result = await lensFlowComplexity.run(fixture(), ctx({ maxComplexity: -3 }));
    expect(result.findings).toHaveLength(0);
    expect(result.metrics.threshold).toBe(10);
  });

  it("emits a table sorted by complexity", async () => {
    const result = await lensFlowComplexity.run(fixture(), ctx());
    const table = result.views[0];
    expect(table?.type === "table" && table.rows[0]?.[0]).toBe("f");
  });
});

/**
 * The scope "src" cut from a project. f (in scope) has one branch. g is outside, and its stub has a branch under it.
 * The second branch under f is marked external, so it is not this scope's flow.
 */
function scopedFixture() {
  return fx.view({
    nodes: [
      fx.node("src/a.ts", "structure", "structure.file"),
      fx.node("src/a.ts#f", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "f" }, span: fx.span("src/a.ts", 0, 0, 5, 1) }),
      fx.node("src/a.ts@b1", "flow", "flow.branch", { parent: "src/a.ts#f" }),
      fx.node("src/a.ts@b2", "flow", "flow.branch", { parent: "src/a.ts#f", attrs: { external: true } }),
      fx.node("lib/g.ts#g", "structure", "structure.function", { attrs: { name: "g", external: true } }),
      fx.node("lib/g.ts@b3", "flow", "flow.branch", { parent: "lib/g.ts#g", attrs: { external: true } }),
    ],
  });
}

describe("lens-flow-complexity in a partial scope", () => {
  it("measures only local functions, and counts only their own flow", async () => {
    const measured = measureFunctions(scopedFixture());
    expect(measured).toHaveLength(1);
    expect(measured[0]).toMatchObject({ id: "src/a.ts#f", complexity: 2, branches: 1 });
    const result = await lensFlowComplexity.run(scopedFixture(), { ...ctx(), scope: "src" });
    expect(result.metrics).toMatchObject({ functions: 1, maxComplexity: 2 });
  });
});
