import { describe, expect, it } from "vitest";
import { irFixtures as fx, type LensResult, type GraphView } from "@insight/sdk";
import { lensDependencies } from "../src/index.js";

const sp = (file: string) => fx.span(file, 0, 0, 0, 1);

/** a.ts and b.ts import each other, c.ts imports b.ts, and a.ts calls into c.ts. */
function fixture() {
  const nodes = [
    fx.node("src/a.ts", "structure", "structure.file", { attrs: { path: "src/a.ts" } }),
    fx.node("src/b.ts", "structure", "structure.file"),
    fx.node("src/c.ts", "structure", "structure.file"),
    fx.node("src/a.ts#f", "structure", "structure.function", { parent: "src/a.ts", span: sp("src/a.ts") }),
    fx.node("src/c.ts#h", "structure", "structure.function", { parent: "src/c.ts" }),
  ];
  const edges = [
    fx.edge("src/a.ts", "src/b.ts", "packaging", "packaging.import", { span: fx.span("src/a.ts", 0, 0, 0, 20) }),
    fx.edge("src/b.ts", "src/a.ts", "packaging", "packaging.import", { span: fx.span("src/b.ts", 0, 0, 0, 20) }),
    fx.edge("src/c.ts", "src/b.ts", "packaging", "packaging.import"),
    fx.edge("src/a.ts#f", "src/c.ts#h", "calls", "calls.call"),
  ];
  return fx.view({ nodes, edges });
}

const run = (config?: unknown): Promise<LensResult> =>
  lensDependencies.run(fixture(), {
    root: { path: "/unused", name: "fixture", allowBuildTools: false },
    config,
    resultOf: () => undefined,
  });

describe("lens-dependencies", () => {
  it("finds the import cycle between a.ts and b.ts and nothing else", async () => {
    const result = await run();
    const cycles = result.findings.filter((f) => f.id.startsWith("cycle:"));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.nodes).toEqual(["src/a.ts", "src/b.ts"]);
    expect(cycles[0]?.severity).toBe("warning");
    expect(cycles[0]?.lens).toBe("lens-dependencies");
    expect(result.metrics.modules).toBe(3);
    expect(result.metrics.cycles).toBe(1);
  });

  it("lifts a function-level call to a module edge and marks it as a call", async () => {
    const result = await run();
    const graph = result.views.find((v) => v.type === "graph") as GraphView;
    expect(graph.edges.some((e) => e.kind === "call" && e.from === "src/a.ts" && e.to === "src/c.ts")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "import" && e.from === "src/c.ts" && e.to === "src/b.ts")).toBe(true);
  });

  it("points the import edge at its span so the UI can open the line", async () => {
    const result = await run();
    const graph = result.views.find((v) => v.type === "graph") as GraphView;
    const edge = graph.edges.find((e) => e.kind === "import" && e.from === "src/a.ts" && e.to === "src/b.ts");
    expect(edge?.span).toEqual(fx.span("src/a.ts", 0, 0, 0, 20));
  });

  it("reports a layer rule violation as an error with the import span", async () => {
    const result = await run({ rules: [{ from: "src/c.ts", notDependOn: ["src/b.ts"], reason: "c is a leaf" }] });
    const violations = result.findings.filter((f) => f.id.startsWith("rule:"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.message).toContain("c is a leaf");
    expect(result.metrics.ruleViolations).toBe(1);
  });

  it("reports nothing for a rule that matches no import", async () => {
    const result = await run({ rules: [{ from: "src/b.ts", notDependOn: ["src/c.ts"] }] });
    expect(result.findings.filter((f) => f.id.startsWith("rule:"))).toEqual([]);
  });
});
