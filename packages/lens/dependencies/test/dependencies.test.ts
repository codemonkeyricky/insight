import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type LensResult, type GraphView } from "@insight/sdk";
import type { IRNode } from "@insight/ir";
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

// ---- Build-graph rules -------------------------------------------------------------------------------------------

interface TargetSpec {
  id: string;
  frontend?: string;
  files?: string[];
  deps?: string[];
  externals?: string[];
  open?: boolean;
  visibility?: string[];
}

interface GraphSpec {
  targets: TargetSpec[];
  files: string[];
  externals?: string[];
  includes?: [string, string][];
  functions?: [string, string][];
  calls?: [string, string][];
}

function inFrontend(node: IRNode, frontend: string): IRNode {
  return { ...node, provenance: { frontend, confidence: "exact" } };
}

/** Synthetic build IR. Targets are Bazel-style ("//lib:a") unless the id starts with "cmake:". */
function graph(spec: GraphSpec) {
  const nodes: IRNode[] = spec.files.map((f) => fx.node(f, "structure", "structure.file", { attrs: { path: f } }));
  const packages = new Set<string>();
  for (const t of spec.targets) {
    const pkg = t.id.startsWith("//") ? t.id.slice(0, t.id.lastIndexOf(":")) : undefined;
    if (pkg !== undefined && !packages.has(pkg)) {
      packages.add(pkg);
      nodes.push(fx.node(pkg, "structure", "structure.package", { attrs: { name: pkg, root: pkg.slice(2), buildSystem: "bazel" } }));
    }
    nodes.push(
      inFrontend(
        fx.node(t.id, "packaging", "packaging.build-target", {
          ...(pkg !== undefined ? { parent: pkg } : {}),
          attrs: { name: t.id, label: t.id, targetKind: "cc_library", output: "library", ...(t.visibility ? { visibility: t.visibility } : {}) },
        }),
        t.frontend ?? "bazel",
      ),
    );
  }
  for (const x of spec.externals ?? []) {
    nodes.push(inFrontend(fx.node(x, "packaging", "packaging.external", { attrs: { name: x, manager: "bazel", source: "bzlmod" } }), "bazel"));
  }
  for (const [id, file] of spec.functions ?? []) {
    nodes.push(fx.node(id, "structure", "structure.function", { parent: file, attrs: { name: id.split("#")[1] } }));
  }

  const edges = [];
  for (const t of spec.targets) {
    for (const f of t.files ?? []) edges.push(fx.edge(t.id, f, "packaging", "packaging.target-contains"));
    for (const d of t.deps ?? []) edges.push(fx.edge(t.id, d, "packaging", "packaging.dep-edge"));
    for (const x of t.externals ?? []) edges.push(fx.edge(t.id, x, "packaging", "packaging.dep-edge"));
    if (t.open) edges.push(fx.edge(t.id, { unresolved: { scheme: "bazel.label", text: "//unknown" } }, "packaging", "packaging.dep-edge"));
  }
  for (const [from, to] of spec.includes ?? []) {
    edges.push(fx.edge(from, to, "packaging", "packaging.include", { span: fx.span(from, 3, 0, 3, 20) }));
  }
  for (const [from, to] of spec.calls ?? []) edges.push(fx.edge(from, to, "calls", "calls.call"));
  return fx.view({ nodes, edges });
}

const runGraph = (spec: GraphSpec, config?: unknown): Promise<LensResult> =>
  lensDependencies.run(graph(spec), {
    root: { path: "/unused", name: "fixture", allowBuildTools: false },
    config,
    resultOf: () => undefined,
  });

const rulesOf = (result: LensResult, prefix: string) => result.findings.filter((f) => f.id.startsWith(`${prefix}:`));

const base: GraphSpec = {
  files: ["lib/a.cc", "lib/b/x.h", "app/main.cc", "lib/other.h"],
  targets: [
    { id: "//lib:a", files: ["lib/a.cc"] },
    { id: "//lib/b:x", files: ["lib/b/x.h"] },
    { id: "//app:main", files: ["app/main.cc"] },
  ],
};

describe("build-graph: undeclared dependency", () => {
  it("reports an include of a file the includer's target does not depend on", async () => {
    const result = await runGraph({ ...base, includes: [["lib/a.cc", "lib/b/x.h"]] });
    const found = rulesOf(result, "undeclared");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("undeclared:lib/a.cc>lib/b/x.h");
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.nodes).toEqual(["//lib:a", "//lib/b:x"]);
    expect(found[0]?.message).toBe("lib/a.cc includes lib/b/x.h, but //lib:a does not depend on //lib/b:x");
    expect(found[0]?.span).toEqual(fx.span("lib/a.cc", 3, 0, 3, 20));
    expect(result.metrics.undeclaredDependencies).toBe(1);
  });

  it("reports an include of an external the includer's target does not depend on", async () => {
    const result = await runGraph({ ...base, externals: ["@fmt"], includes: [["lib/a.cc", "@fmt"]] });
    const found = rulesOf(result, "undeclared");
    expect(found.map((f) => f.id)).toEqual(["undeclared:lib/a.cc>@fmt"]);
    expect(found[0]?.nodes).toEqual(["//lib:a", "@fmt"]);
  });

  it("does not report an include declared through a transitive dependency", async () => {
    const result = await runGraph({
      ...base,
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"], deps: ["//lib/b:x"] },
        { id: "//lib/b:x", files: ["lib/b/x.h"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:a"] },
      ],
      includes: [["app/main.cc", "lib/b/x.h"]],
    });
    expect(rulesOf(result, "undeclared")).toEqual([]);
  });

  it("does not report when the closure is open (an unresolved dependency)", async () => {
    const result = await runGraph({
      ...base,
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"], open: true },
        { id: "//lib/b:x", files: ["lib/b/x.h"] },
      ],
      externals: ["@fmt"],
      includes: [["lib/a.cc", "lib/b/x.h"], ["lib/a.cc", "@fmt"]],
    });
    expect(rulesOf(result, "undeclared")).toEqual([]);
  });

  it("does not report when another frontend that shares both files says the include is declared", async () => {
    const result = await runGraph({
      files: ["lib/a.cc", "lib/b/x.h"],
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"] },
        { id: "//lib/b:x", files: ["lib/b/x.h"] },
        { id: "cmake:lib_a", frontend: "cmake", files: ["lib/a.cc"], deps: ["cmake:lib_b"] },
        { id: "cmake:lib_b", frontend: "cmake", files: ["lib/b/x.h"] },
      ],
      includes: [["lib/a.cc", "lib/b/x.h"]],
    });
    expect(rulesOf(result, "undeclared")).toEqual([]);
  });

  it("reports when the frontends that share both files all say undeclared, and treats a frontend that owns only one file as no evidence", async () => {
    const result = await runGraph({
      files: ["lib/a.cc", "lib/b/x.h", "other.h"],
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"] },
        { id: "//lib/b:x", files: ["lib/b/x.h"] },
        { id: "cmake:lib_a", frontend: "cmake", files: ["lib/a.cc"] },
        { id: "cmake:other", frontend: "cmake", files: ["other.h"] },
      ],
      includes: [["lib/a.cc", "lib/b/x.h"]],
    });
    expect(rulesOf(result, "undeclared").map((f) => f.id)).toEqual(["undeclared:lib/a.cc>lib/b/x.h"]);
  });
});

describe("build-graph: unused dependency", () => {
  it("reports a target dependency that no include or call reaches", async () => {
    const result = await runGraph({
      ...base,
      targets: [
        { id: "//lib:a", files: ["lib/a.cc", "lib/a.h"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:a"] },
      ],
      includes: [],
    });
    const found = rulesOf(result, "unused");
    expect(found.map((f) => f.id)).toEqual(["unused://app:main>//lib:a"]);
    expect(found[0]?.severity).toBe("info");
    expect(result.metrics.unusedDependencies).toBe(1);
  });

  it("does not report a dependency used by an include", async () => {
    const result = await runGraph({
      ...base,
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:a"] },
      ],
      includes: [["app/main.cc", "lib/a.cc"]],
    });
    expect(rulesOf(result, "unused")).toEqual([]);
  });

  it("does not report a dependency reached through a chain of calls", async () => {
    const result = await runGraph({
      files: ["app/main.cc", "lib/a.cc", "lib/mid.cc"],
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"] },
        { id: "//lib:mid", files: ["lib/mid.cc"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:a"] },
      ],
      functions: [["app/main.cc#m", "app/main.cc"], ["lib/mid.cc#g", "lib/mid.cc"], ["lib/a.cc#f", "lib/a.cc"]],
      calls: [["app/main.cc#m", "lib/mid.cc#g"], ["lib/mid.cc#g", "lib/a.cc#f"]],
    });
    expect(rulesOf(result, "unused")).toEqual([]);
  });

  it("does not report a dependency whose files define main(), since it is linked for its entry point", async () => {
    const result = await runGraph({
      files: ["app/main.cc", "lib/entry.cc"],
      targets: [
        { id: "//lib:entry", files: ["lib/entry.cc"] },
        { id: "//test:t", files: ["app/main.cc"], deps: ["//lib:entry"] },
      ],
      functions: [["lib/entry.cc#main", "lib/entry.cc"]],
    });
    expect(rulesOf(result, "unused")).toEqual([]);
  });

  it("does not report a dependency that owns no header, since it is used only by linking", async () => {
    const result = await runGraph({
      files: ["app/main.cc", "lib/impl.cc"],
      targets: [
        { id: "//lib:impl", files: ["lib/impl.cc"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:impl"] },
      ],
      includes: [],
    });
    expect(rulesOf(result, "unused")).toEqual([]);
  });

  it("still reports a dependency that owns a header and that no use reaches", async () => {
    const result = await runGraph({
      files: ["app/main.cc", "lib/impl.cc", "lib/impl.h"],
      targets: [
        { id: "//lib:impl", files: ["lib/impl.cc", "lib/impl.h"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:impl"] },
      ],
      includes: [],
    });
    expect(rulesOf(result, "unused").map((f) => f.id)).toEqual(["unused://app:main>//lib:impl"]);
  });

  it("still reports a main() dependency when the depending target defines main() itself", async () => {
    const result = await runGraph({
      files: ["app/main.cc", "lib/entry.cc", "lib/entry.h"],
      targets: [
        { id: "//lib:entry", files: ["lib/entry.cc", "lib/entry.h"] },
        { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:entry"] },
      ],
      functions: [["lib/entry.cc#main", "lib/entry.cc"], ["app/main.cc#main", "app/main.cc"]],
    });
    expect(rulesOf(result, "unused").map((f) => f.id)).toEqual(["unused://app:main>//lib:entry"]);
  });

  it("reports an unused external that some include maps to", async () => {
    const result = await runGraph({
      ...base,
      externals: ["@fmt"],
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"], externals: ["@fmt"] },
        { id: "//app:main", files: ["app/main.cc"], externals: ["@fmt"] },
      ],
      includes: [["lib/a.cc", "@fmt"]],
    });
    expect(rulesOf(result, "unused").map((f) => f.id)).toEqual(["unused://app:main>@fmt"]);
  });

  it("does not report an unused external that no include maps to", async () => {
    const result = await runGraph({
      ...base,
      externals: ["@zlib"],
      targets: [{ id: "//app:main", files: ["app/main.cc"], externals: ["@zlib"] }],
    });
    expect(rulesOf(result, "unused")).toEqual([]);
  });
});

describe("build-graph: visibility", () => {
  /** //lib/c:y has the given visibility. `from` is the one target that depends on it; the others depend on nothing. */
  const VIS_FILES: Record<string, string> = { "//app:main": "app/main.cc", "//lib:src": "lib/src.cc", "//lib/b:x": "lib/b/x.cc" };
  const visCheck = (visibility: string[], from: string) =>
    runGraph({
      files: [...Object.values(VIS_FILES), "lib/c/y.cc"],
      targets: [
        ...Object.entries(VIS_FILES).map(([id, file]) => ({ id, files: [file], deps: id === from ? ["//lib/c:y"] : [] })),
        { id: "//lib/c:y", files: ["lib/c/y.cc"], visibility },
      ],
    });

  it("allows a dependency on //visibility:public", async () => {
    expect(rulesOf(await visCheck(["//visibility:public"], "//app:main"), "visibility")).toEqual([]);
  });

  it("denies a dependency on //visibility:private from another package", async () => {
    const found = rulesOf(await visCheck(["//visibility:private"], "//app:main"), "visibility");
    expect(found.map((f) => f.id)).toEqual(["visibility://app:main>//lib/c:y"]);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.nodes).toEqual(["//app:main", "//lib/c:y"]);
  });

  it("admits exactly the named package with //pkg:__pkg__", async () => {
    expect(rulesOf(await visCheck(["//lib:__pkg__"], "//lib:src"), "visibility")).toEqual([]);
    expect(rulesOf(await visCheck(["//lib:__pkg__"], "//lib/b:x"), "visibility").map((f) => f.id)).toEqual([
      "visibility://lib/b:x>//lib/c:y",
    ]);
    expect(rulesOf(await visCheck(["//lib:__pkg__"], "//app:main"), "visibility")).toHaveLength(1);
  });

  it("admits a package and its subpackages with //pkg:__subpackages__, and not a sibling with a shared prefix", async () => {
    expect(rulesOf(await visCheck(["//lib:__subpackages__"], "//lib/b:x"), "visibility")).toEqual([]);
    expect(rulesOf(await visCheck(["//lib:__subpackages__"], "//lib:src"), "visibility")).toEqual([]);
    expect(rulesOf(await visCheck(["//lib:__subpackages__"], "//app:main"), "visibility")).toHaveLength(1);
    expect(rulesOf(await visCheck(["//li:__subpackages__"], "//lib/b:x"), "visibility")).toHaveLength(1);
  });

  it("does not report an entry it cannot read (a package_group label or another visibility keyword)", async () => {
    expect(rulesOf(await visCheck(["//visibility:legacy_public"], "//app:main"), "visibility")).toEqual([]);
    expect(rulesOf(await visCheck(["//tools:friends"], "//app:main"), "visibility")).toEqual([]);
  });

  it("does not check a dependency within one package", async () => {
    const result = await runGraph({
      files: ["lib/a.cc", "lib/c.cc"],
      targets: [
        { id: "//lib:a", files: ["lib/a.cc"], deps: ["//lib:c"] },
        { id: "//lib:c", files: ["lib/c.cc"], visibility: ["//visibility:private"] },
      ],
    });
    expect(rulesOf(result, "visibility")).toEqual([]);
  });

  it("admits a package named beside another repository's entry, and reads another repository's package as admitting nothing here", async () => {
    const shared = ["//lib:__pkg__", "@do_not_use_for_gloop_visibility_only//gloop/util/random:__subpackages__"];
    expect(rulesOf(await visCheck(shared, "//lib:src"), "visibility")).toEqual([]);
    expect(rulesOf(await visCheck(shared, "//app:main"), "visibility").map((f) => f.id)).toEqual(["visibility://app:main>//lib/c:y"]);
    expect(rulesOf(await visCheck(["//app:__pkg__", "@other//x:__pkg__"], "//app:main"), "visibility")).toEqual([]);
  });

  it("does not treat an other-repository entry as unknown, so a denial stands", async () => {
    const found = rulesOf(await visCheck(["@other//gloop:__subpackages__"], "//app:main"), "visibility");
    expect(found.map((f) => f.id)).toEqual(["visibility://app:main>//lib/c:y"]);
  });

  it("treats an empty visibility list as private and counts the violation", async () => {
    const result = await visCheck([], "//app:main");
    expect(rulesOf(result, "visibility")).toHaveLength(1);
    expect(result.metrics.visibilityViolations).toBe(1);
  });
});

describe("build-graph: configuration and output", () => {
  const spec: GraphSpec = {
    ...base,
    targets: [
      { id: "//lib:a", files: ["lib/a.cc", "lib/a.h"] },
      { id: "//lib/b:x", files: ["lib/b/x.h"], visibility: ["//visibility:private"] },
      { id: "//app:main", files: ["app/main.cc"], deps: ["//lib:a", "//lib/b:x"] },
    ],
    includes: [["lib/a.cc", "lib/b/x.h"]],
  };

  it("runs all three rules by default and lists them in the build-graph table", async () => {
    const result = await runGraph(spec);
    expect(rulesOf(result, "undeclared")).toHaveLength(1);
    expect(rulesOf(result, "visibility")).toHaveLength(1);
    expect(rulesOf(result, "unused").map((f) => f.id)).toEqual(["unused://app:main>//lib/b:x", "unused://app:main>//lib:a"]);
    const table = result.views.find((v) => v.type === "table" && v.id === "build-graph");
    expect(table).toMatchObject({ type: "table", columns: ["Rule", "From", "To", "Detail"] });
    expect(table && "rows" in table ? [...new Set(table.rows.map((r) => r[0]))].sort() : []).toEqual(["undeclared", "unused", "visibility"]);
    expect(result.metrics).toMatchObject({ undeclaredDependencies: 1, unusedDependencies: 2, visibilityViolations: 1 });
  });

  it("switches each rule off on its own", async () => {
    const noUndeclared = await runGraph(spec, { buildGraph: { undeclared: false } });
    expect(rulesOf(noUndeclared, "undeclared")).toEqual([]);
    expect(rulesOf(noUndeclared, "visibility")).toHaveLength(1);
    expect(noUndeclared.metrics.undeclaredDependencies).toBe(0);

    const noUnused = await runGraph(spec, { buildGraph: { unused: false } });
    expect(rulesOf(noUnused, "unused")).toEqual([]);
    expect(noUnused.metrics.unusedDependencies).toBe(0);

    const noVisibility = await runGraph(spec, { buildGraph: { visibility: false } });
    expect(rulesOf(noVisibility, "visibility")).toEqual([]);
    expect(noVisibility.metrics.visibilityViolations).toBe(0);
  });

  it("leaves a TypeScript-style project with no build targets unchanged: same views and metrics keys", async () => {
    const result = await run();
    expect(result.views.map((v) => v.id)).toEqual(["modules", "cycles"]);
    expect(Object.keys(result.metrics).sort()).toEqual(
      ["cycles", "externalModules", "importPairs", "callPairs", "modules", "ruleViolations", "unresolvedImports"].sort(),
    );
    expect(result.findings.filter((f) => /^(undeclared|unused|visibility):/.test(f.id))).toEqual([]);
  });
});
