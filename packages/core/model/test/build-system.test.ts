import { describe, expect, it } from "vitest";
import type { IRDocument, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { archModel, buildProjectModel, systemModel } from "../src/index.js";

const sp = (file: string) => fx.span(file, 0, 0, 0, 20);
const file = (path: string) => fx.node(path, "structure", "structure.file", { attrs: { path }, span: sp(path) });
/** A build system's package node: one per package directory, with the root directory as `root`. */
const pkgNode = (id: string, root: string) => fx.node(id, "structure", "structure.package", { attrs: { name: id, root } });
const target = (id: string, parent: string, targetKind = "cc_library") =>
  fx.node(id, "packaging", "packaging.build-target", { attrs: { name: id.split(":")[1], label: id, targetKind, source: "static" }, parent });
const external = (id: string, attrs: Record<string, unknown>) => fx.node(id, "packaging", "packaging.external", { attrs: { source: "bzlmod", ...attrs } });
/** A function in a file, so that the System view keeps the file's component. */
const fn = (path: string, name: string) => fx.node(`${path}#${name}`, "structure", "structure.function", { attrs: { name }, parent: path, span: sp(path) });
const contains = (target: string, path: string) => fx.edge(target, path, "packaging", "packaging.target-contains");
const dep = (from: string, to: string) => fx.edge(from, to, "packaging", "packaging.dep-edge");

/** A Bazel-style project: "//lib" (lib/core.cc) and the nested "//lib/sub" (lib/sub/x.cc), with two external packages. */
function bazelDoc(): IRDocument {
  const nodes: IRNode[] = [
    pkgNode("//lib", "lib"),
    file("lib/core.cc"),
    pkgNode("//lib/sub", "lib/sub"),
    file("lib/sub/x.cc"),
    fn("lib/core.cc", "run"),
    fn("lib/sub/x.cc", "helper"),
    target("//lib:core", "//lib"),
    target("//lib/sub:util", "//lib/sub"),
    external("@abseil-cpp", { name: "abseil-cpp", version: "20240116.2" }),
    external("@zlib", { name: "zlib", dev: true }),
  ];
  const edges = [
    contains("//lib:core", "lib/core.cc"),
    contains("//lib/sub:util", "lib/sub/x.cc"),
    dep("//lib:core", "@abseil-cpp"),
    dep("//lib/sub:util", "//lib:core"),
    fx.edge("lib/core.cc", "@zlib", "packaging", "packaging.include", { span: sp("lib/core.cc") }),
    fx.edge("lib/core.cc", "lib/sub/x.cc", "packaging", "packaging.include", { span: sp("lib/core.cc") }),
  ];
  return { nodes, edges, findings: [] };
}

describe("build-system packages (structure.package)", () => {
  it("makes each package node an Arch package, and a nested package owns its own files", () => {
    const model = archModel(fx.view({ nodes: bazelDoc().nodes, edges: bazelDoc().edges }));
    expect(model.packages.map((p) => [p.id, p.name, p.fileCount])).toEqual([
      ["lib", "//lib", 1],
      ["lib/sub", "//lib/sub", 1],
    ]);
  });

  // At the root the outermost package owns a file (as with package.json roots), so lib owns lib/sub/x.cc too. Inside "lib",
  // the nested package lib/sub is a component of its own.
  it("gives a System component to each package, and a nested package owns its files inside its scope", () => {
    const doc = bazelDoc();
    const model = buildProjectModel(doc);
    const atRoot = systemModel(model, "");
    expect(atRoot.components.map((c) => [c.id, c.kind, c.files])).toEqual([["lib", "package", 2]]);
    const inLib = systemModel(model, "lib");
    expect(inLib.components.map((c) => [c.id, c.kind])).toEqual([
      ["lib/core.cc", "file"],
      ["lib/sub", "package"],
    ]);
  });
});

describe("archModel build-system externals", () => {
  it("makes a dep-edge's external declared, with its version, and an include's external counted by import", () => {
    const model = archModel(fx.view({ nodes: bazelDoc().nodes, edges: bazelDoc().edges }));
    expect(model.externals).toEqual([
      { fromPackage: "lib", name: "zlib", imports: 1, id: "@zlib" },
      { fromPackage: "lib", name: "abseil-cpp", imports: 0, id: "@abseil-cpp", version: "20240116.2", declared: true },
    ]);
    expect(model.externals[0]).not.toHaveProperty("declared");
  });

  it("lists every packaging.external node as externalPackages, sorted by id", () => {
    const model = archModel(fx.view({ nodes: bazelDoc().nodes, edges: bazelDoc().edges }));
    expect(model.externalPackages).toEqual([
      { id: "@abseil-cpp", name: "abseil-cpp", version: "20240116.2", source: "bzlmod" },
      { id: "@zlib", name: "zlib", source: "bzlmod", dev: true },
    ]);
  });

  it("carries a packaging.external's manager as manager, and leaves it off when the node names none", () => {
    const model = archModel(
      fx.view({ nodes: [external("@zlib", { name: "zlib", manager: "bzlmod" }), external("@abseil-cpp", { name: "abseil-cpp" })] }),
    );
    expect(model.externalPackages).toEqual([
      { id: "@abseil-cpp", name: "abseil-cpp", source: "bzlmod" },
      { id: "@zlib", name: "zlib", source: "bzlmod", manager: "bzlmod" },
    ]);
    expect(model.externalPackages[0]).not.toHaveProperty("manager");
  });

  it("gives externalPackages an empty list when the project declares none", () => {
    expect(archModel(fx.view({ nodes: [file("src/a.ts")] })).externalPackages).toEqual([]);
  });
});

describe("archModel declared edges", () => {
  it("marks the rolled edge of a target dependency declared, and the other edges not declared", () => {
    const model = archModel(fx.view({ nodes: bazelDoc().nodes, edges: bazelDoc().edges }));
    expect(model.edges.map((e) => [e.from, e.to, e.imports, e.declared])).toEqual([
      ["lib", "lib/sub", 1, false],
      ["lib/sub", "lib", 0, true],
    ]);
    expect(model.edges[1]).toEqual({ from: "lib/sub", to: "lib", imports: 0, calls: 0, confidence: "exact", sites: [], declared: true });
  });

  it("leaves declared off every edge when the project has no target dependency", () => {
    const doc = bazelDoc();
    const edges = doc.edges.filter((e) => e.kind !== "packaging.dep-edge");
    const model = archModel(fx.view({ nodes: doc.nodes, edges }));
    expect(model.edges.length).toBeGreaterThan(0);
    for (const edge of model.edges) expect(edge).not.toHaveProperty("declared");
  });
});

describe("archModel on a TypeScript-style project", () => {
  it("gives the same packages, externals and edges as before, with no declared field", () => {
    const span = sp("apps/a/src/a.ts");
    const view = fx.view({
      nodes: [
        file("apps/a/package.json"),
        file("apps/a/src/a.ts"),
        file("apps/b/package.json"),
        file("apps/b/src/b.ts"),
      ],
      edges: [
        fx.edge("apps/a/src/a.ts", "apps/b/src/b.ts", "packaging", "packaging.import", { span }),
        fx.edge("apps/a/src/a.ts", { unresolved: { scheme: "module", text: "fastify" } }, "packaging", "packaging.import", { span }),
        fx.edge("apps/a/src/a.ts", { unresolved: { scheme: "module", text: "./gone.js" } }, "packaging", "packaging.import", { span }),
      ],
    });
    const model = archModel(view);
    expect(model.packages.map((p) => [p.id, p.fileCount])).toEqual([
      ["apps/a", 2],
      ["apps/b", 2],
    ]);
    expect(model.edges).toEqual([{ from: "apps/a", to: "apps/b", imports: 1, calls: 0, confidence: "exact", sites: [span] }]);
    expect(model.externals).toEqual([{ fromPackage: "apps/a", name: "fastify", imports: 1 }]);
    expect(model.unresolved).toEqual([{ fromPackage: "apps/a", text: "./gone.js", span }]);
    expect(model.externalPackages).toEqual([]);
    expect(JSON.stringify(model)).not.toContain("declared");
  });
});

describe("packages from several build systems", () => {
  // Bazel's "//lib" and CMake's "cmake:lib" both describe the lib directory; CMake's "cmake:tools" is the only one for tools.
  const bazelLib = fx.node("//lib", "structure", "structure.package", { attrs: { name: "//lib", root: "lib", buildSystem: "bazel" } });
  const cmakeLib = fx.node("cmake:lib", "structure", "structure.package", { attrs: { name: "lib", root: "lib", buildSystem: "cmake" } });
  const cmakeTools = fx.node("cmake:tools", "structure", "structure.package", { attrs: { name: "tools", root: "tools", buildSystem: "cmake" } });
  const noSystem = fx.node("//plain", "structure", "structure.package", { attrs: { name: "//plain", root: "lib" } });
  const sources: IRNode[] = [
    file("lib/core.cc"),
    file("tools/main.cc"),
    fn("lib/core.cc", "run"),
    fn("tools/main.cc", "main"),
    target("//lib:core", "//lib"),
    target("cmake:tools:tool", "cmake:tools", "add_executable"),
  ];
  const packages: IRNode[] = [bazelLib, cmakeLib, cmakeTools];
  const edgesOf = () => [contains("//lib:core", "lib/core.cc"), contains("cmake:tools:tool", "tools/main.cc")];

  /** The same records in two orders: forward, and reversed. */
  const bothOrders = (nodes: IRNode[]): IRNode[][] => [nodes, [...nodes].reverse()];

  it("merges packages by root and names each by the buildSystem that sorts first, the same in both record orders", () => {
    const outputs = bothOrders([...packages, ...sources]).map((ns) => {
      const model = archModel(fx.view({ nodes: ns, edges: edgesOf() }));
      return model.packages.map((p) => [p.id, p.name]);
    });
    expect(outputs[0]).toEqual([
      ["lib", "//lib"],
      ["tools", "tools"],
    ]);
    expect(outputs[1]).toEqual(outputs[0]);
  });

  it("gives a package with no buildSystem the name only when no other build system names its directory", () => {
    const withPlain = [...packages, noSystem, ...sources];
    const model = archModel(fx.view({ nodes: withPlain, edges: edgesOf() }));
    expect(model.packages.find((p) => p.id === "lib")?.name).toBe("//lib");
    const plainOnly = [noSystem, ...sources];
    expect(archModel(fx.view({ nodes: plainOnly, edges: edgesOf() })).packages.find((p) => p.id === "lib")?.name).toBe("//plain");
  });

  it("gives the same System components whatever the record order", () => {
    const outputs = bothOrders([...packages, ...sources]).map((ns) => {
      const doc: IRDocument = { nodes: ns, edges: edgesOf(), findings: [] };
      return systemModel(buildProjectModel(doc), "").components.map((c) => [c.id, c.kind, c.files]);
    });
    expect(outputs[0]).toEqual([
      ["lib", "package", 1],
      ["tools", "package", 1],
    ]);
    expect(outputs[1]).toEqual(outputs[0]);
  });
});
