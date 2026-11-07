import { describe, expect, it } from "vitest";
import { irFixtures as fx, type LensResult } from "@insight/sdk";
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
