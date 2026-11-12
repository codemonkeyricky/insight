import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type LensResult, type GraphView } from "@insight/sdk";
import { buildModuleGraph, lensDependencies } from "../src/index.js";

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

/**
 * The scope "src" cut from a project. a.ts imports lib/util.ts and calls its function u. lib/other.ts is outside: it
 * imports c.ts and has an unresolved import of its own. c.ts has an unresolved import too. a.ts and b.ts import each other.
 */
function scopedFixture() {
  return fx.view({
    nodes: [
      fx.node("src/a.ts", "structure", "structure.file", { attrs: { path: "src/a.ts" } }),
      fx.node("src/b.ts", "structure", "structure.file"),
      fx.node("src/c.ts", "structure", "structure.file"),
      fx.node("src/a.ts#f", "structure", "structure.function", { parent: "src/a.ts", span: sp("src/a.ts") }),
      fx.node("lib/util.ts", "structure", "structure.file", { attrs: { external: true } }),
      fx.node("lib/other.ts", "structure", "structure.file", { attrs: { external: true } }),
      fx.node("lib/util.ts#u", "structure", "structure.function", { attrs: { name: "u", external: true } }),
    ],
    edges: [
      fx.edge("src/a.ts", "src/b.ts", "packaging", "packaging.import"),
      fx.edge("src/b.ts", "src/a.ts", "packaging", "packaging.import"),
      fx.edge("src/a.ts", "lib/util.ts", "packaging", "packaging.import", { span: fx.span("src/a.ts", 0, 0, 0, 20) }),
      fx.edge("src/c.ts", { unresolved: { scheme: "ts.import", text: "left-pad" } }, "packaging", "packaging.import"),
      fx.edge("lib/other.ts", "src/c.ts", "packaging", "packaging.import"),
      fx.edge("lib/other.ts", { unresolved: { scheme: "ts.import", text: "magic" } }, "packaging", "packaging.import"),
      fx.edge("src/a.ts#f", "lib/util.ts#u", "calls", "calls.call"),
    ],
  });
}

const runScoped = (config?: unknown): Promise<LensResult> =>
  lensDependencies.run(scopedFixture(), {
    root: { path: "/unused", name: "fixture", allowBuildTools: false },
    config,
    resultOf: () => undefined,
    scope: "src",
  });

describe("lens-dependencies in a partial scope", () => {
  it("keeps the cycle inside the scope and finds no cycle through outside modules", async () => {
    const result = await runScoped();
    const cycles = result.findings.filter((f) => f.id.startsWith("cycle:"));
    expect(cycles.map((f) => f.nodes)).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("counts in-scope modules apart from outside ones, and unresolved imports only inside the scope", async () => {
    const result = await runScoped();
    expect(result.metrics).toMatchObject({ modules: 3, externalModules: 2, unresolvedImports: 1 });
  });

  it("labels outside modules in the graph and lifts a call into an outside function onto its module", async () => {
    const result = await runScoped();
    const graph = result.views.find((v): v is GraphView => v.type === "graph");
    expect(graph?.nodes.find((n) => n.id === "lib/util.ts")?.group).toBe("(outside scope)");
    expect(graph?.nodes.find((n) => n.id === "src/a.ts")?.group).toBe("src");
    expect(graph?.edges.some((e) => e.kind === "call" && e.from === "src/a.ts" && e.to === "lib/util.ts")).toBe(true);
    expect(graph?.edges.some((e) => e.kind === "import" && e.from === "lib/other.ts" && e.to === "src/c.ts")).toBe(true);
  });

  it("checks a rule only against importers inside the scope", async () => {
    const result = await runScoped({
      rules: [
        { from: "src/a.ts", notDependOn: ["lib/**"], reason: "a stays local" },
        { from: "lib/**", notDependOn: ["src/**"] },
      ],
    });
    const violations = result.findings.filter((f) => f.id.startsWith("rule:")).map((f) => f.id);
    expect(violations).toEqual(["rule:0:src/a.ts>lib/util.ts"]);
    expect(result.metrics.ruleViolations).toBe(1);
  });
});

describe("buildModuleGraph", () => {
  it("keeps the span of every import in a module pair, not just the first", () => {
    const spans = [fx.span("src/x.ts", 1, 0, 1, 20), fx.span("src/x.ts", 4, 0, 4, 20), fx.span("src/x.ts", 9, 0, 9, 20)];
    const view = fx.view({
      nodes: [fx.node("src/x.ts", "structure", "structure.file"), fx.node("src/y.ts", "structure", "structure.file")],
      edges: spans.map((span) => fx.edge("src/x.ts", "src/y.ts", "packaging", "packaging.import", { span })),
    });
    const pair = buildModuleGraph(view).pairs.get("src/x.ts\0src/y.ts");
    expect(pair?.imports).toBe(3);
    expect(pair?.spans).toEqual(spans);
    expect(pair?.span).toEqual(spans[0]);
  });

  it("lists an unresolved import with its text and span, and still counts it", () => {
    const span = fx.span("src/x.ts", 2, 0, 2, 30);
    const view = fx.view({
      nodes: [fx.node("src/x.ts", "structure", "structure.file")],
      edges: [fx.edge("src/x.ts", { unresolved: { scheme: "module", text: "left-pad" } }, "packaging", "packaging.import", { span })],
    });
    const graph = buildModuleGraph(view);
    expect(graph.unresolved).toBe(1);
    expect(graph.unresolvedImports).toEqual([{ from: "src/x.ts", text: "left-pad", span }]);
  });
});
