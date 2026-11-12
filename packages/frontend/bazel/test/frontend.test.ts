import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";
import { resolver } from "../src/resolve.js";
import { buildModel, globRegex, labelOf, parseBuildFile } from "../src/model.js";
import { globsIn, labelsIn, stringsIn, tokenize, topLevelCalls } from "../src/starlark.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-bazel");
const goldenFile = join(here, "golden", "sample-bazel.ndjson");
const files = [
  "BUILD.bazel",
  "app/main.cc",
  "lib/BUILD",
  "lib/include/core/core.h",
  "lib/src/core.cc",
  "lib/test/core_test.cc",
  "lib/util/log.h",
];

const root: ProjectRoot = { path: fixtureRoot, name: "sample-bazel", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const allRecords = (batches: IRBatch[]): IRRecord[] => batches.flatMap((b) => b.records);

function toGolden(batches: IRBatch[]): string {
  return allRecords(batches).map((r) => JSON.stringify(r)).sort().join("\n") + "\n";
}

/** A resolver context over the fixture, asked from one file. */
function resolveCtx(fromFile: string) {
  return {
    root,
    fromFile,
    hasFile: (p: string) => files.includes(p),
    hasNode: () => true,
    listFiles: () => [...files],
  };
}

describe("frontend-bazel", () => {
  it("passes the SDK conformance kit", async () => {
    const report = await runFrontendConformance({
      frontend,
      root,
      files,
      readFile,
      registry: createCoreRegistry(),
    });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("reads targets, their files and their dependencies from BUILD files", async () => {
    const records = allRecords(await extractAll());
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const targets = nodes.filter((n) => n.kind === "packaging.build-target");
    expect(targets.map((n) => n.id).sort()).toEqual(["//:app", "//lib:core", "//lib:core_test", "//lib:util"]);
    expect(targets.find((n) => n.id === "//lib:core")?.attrs).toMatchObject({ name: "core", targetKind: "cc_library", source: "static" });
    const contains = edges.filter((e) => e.kind === "packaging.target-contains" && e.from === "//lib:core").map((e) => e.to).sort();
    expect(contains).toEqual(["lib/include/core/core.h", "lib/src/core.cc"]);
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "//:app", to: "//lib:core" }));
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: "packaging.dep-edge", from: "//lib:core_test", to: { unresolved: { scheme: "bazel.label", text: "@googletest//:gtest_main" } } }),
    );
  });

  it("answers an include with the header a target exposes under that path", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "acme/core/core.h" }, resolveCtx("lib/src/core.cc"));
    expect(answer?.targets).toEqual(["lib/include/core/core.h"]);
    expect(answer?.confidence).toBe("inferred");
  });

  it("answers an include through an include directory of a dependency", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "util/log.h" }, resolveCtx("lib/src/core.cc"));
    expect(answer?.targets).toEqual(["lib/util/log.h"]);
  });

  it("gives no answer for a file that no target owns, or an include no target can see", async () => {
    expect(await resolver.resolve({ scheme: "cpp.include", text: "acme/core/core.h" }, resolveCtx("nowhere.cc"))).toBeNull();
    expect(await resolver.resolve({ scheme: "cpp.include", text: "missing.h" }, resolveCtx("lib/src/core.cc"))).toBeNull();
  });

  it("matches the golden IR for the sample repository", async () => {
    const actual = toGolden(await extractAll());
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenFile, actual);
    expect(actual).toBe(readFileSync(goldenFile, "utf8"));
  });
});

describe("starlark subset", () => {
  it("reads labels but not the arguments of a call other than select()", () => {
    const [call] = topLevelCalls(tokenize('py_binary(deps = [":a", requirement("numpy"), select({"//c:d": ":e"})])'));
    const deps = call?.args.find((a) => a.key === "deps")?.tokens ?? [];
    expect(labelsIn(deps)).toEqual([":a", ":e"]);
    expect(stringsIn(deps)).toEqual([":a", "numpy", ":e"]);
  });

  it("reads strings with escapes, skips comments and select keys, and expands glob patterns", () => {
    const src = '# comment\ncc_library(name = "a", srcs = glob(["x/*.cc"]), copts = select({"//c:d": ["-O2\\n"]}))';
    const [call] = topLevelCalls(tokenize(src));
    expect(call?.name).toBe("cc_library");
    const arg = (k: string) => call?.args.find((a) => a.key === k)?.tokens ?? [];
    expect(stringsIn(arg("name"))).toEqual(["a"]);
    expect(stringsIn(arg("srcs"))).toEqual([]);
    expect(globsIn(arg("srcs"))).toEqual([{ include: ["x/*.cc"], exclude: [] }]);
    expect(stringsIn(arg("copts"))).toEqual(["-O2\n"]);
  });

  it("reads labels relative to their package", () => {
    expect(labelOf(":x", "a/b")).toEqual({ id: "//a/b:x" });
    expect(labelOf("//c", "a")).toEqual({ id: "//c:c" });
    expect(labelOf("//c/d:e", "a")).toEqual({ id: "//c/d:e" });
    expect(labelOf("@repo//p:q", "a")).toEqual({ external: "@repo//p:q" });
  });

  it("turns ** and * into the right path matches", () => {
    expect(globRegex("src/*.cc").test("src/a.cc")).toBe(true);
    expect(globRegex("src/*.cc").test("src/x/a.cc")).toBe(false);
    expect(globRegex("src/**/*.h").test("src/x/y/a.h")).toBe(true);
  });
});

describe("non-cc binaries", () => {
  // tools/ has a py_binary with a main file, a binary that depends on another binary, a java_binary that
  // globs its sources, a py_library (not a program), and a pip requirement inside deps.
  const toolsBuild = [
    'py_library(name = "gbench", srcs = ["gbench/__init__.py"])',
    'py_binary(',
    '    name = "compare",',
    '    srcs = ["compare.py"],',
    '    main = "run.py",',
    '    deps = [":gbench", requirement("numpy")],',
    ")",
    'py_binary(name = "helper", srcs = ["helper.py"], deps = [":compare", "@rules_python//python/runfiles"])',
    'java_binary(name = "tool", srcs = glob(["java/*.java"]), main_class = "x.Tool")',
    'sh_binary(name = "lint", srcs = ["lint.sh"])',
    'cc_binary(name = "app", srcs = ["app.cc"], deps = [":core"])',
  ].join("\n");
  const toolsFiles = ["tools/compare.py", "tools/run.py", "tools/helper.py", "tools/java/Tool.java", "tools/lint.sh", "tools/app.cc", "tools/gbench/__init__.py"];

  it("models every *_binary rule as a target, with its srcs and main file", () => {
    const targets = parseBuildFile("tools/BUILD.bazel", toolsBuild, toolsFiles, new Set(["tools"]));
    const byName = new Map(targets.map((t) => [t.name, t]));
    expect([...byName.keys()].sort()).toEqual(["app", "compare", "helper", "lint", "tool"]);
    expect(byName.get("compare")).toMatchObject({ id: "//tools:compare", kind: "py_binary", srcs: ["tools/compare.py", "tools/run.py"] });
    expect(byName.get("tool")).toMatchObject({ kind: "java_binary", srcs: ["tools/java/Tool.java"] });
    expect(byName.get("lint")?.srcs).toEqual(["tools/lint.sh"]);
  });

  it("gives a non-cc binary no headers, includes or prefixes, and keeps cc_binary's", () => {
    const build = 'cc_binary(name = "app", srcs = ["app.cc"], hdrs = ["app.h"], includes = ["inc"], strip_include_prefix = "inc")';
    const [app] = parseBuildFile("tools/BUILD.bazel", build, ["tools/app.cc", "tools/app.h"], new Set(["tools"]));
    expect(app).toMatchObject({ hdrs: ["tools/app.h"], includes: ["tools/inc"], stripPrefix: "tools/inc" });
    const [py] = parseBuildFile("tools/BUILD.bazel", 'py_binary(name = "p", srcs = ["p.py"], hdrs = ["p.py"], includes = ["x"])', ["tools/p.py"], new Set(["tools"]));
    expect(py).toMatchObject({ srcs: ["tools/p.py"], hdrs: [], includes: [] });
    expect(py?.stripPrefix).toBeUndefined();
  });

  it("does not read a pip requirement in deps as a label", () => {
    const [compare] = parseBuildFile("tools/BUILD.bazel", toolsBuild, toolsFiles, new Set(["tools"])).filter((t) => t.name === "compare");
    expect(compare?.deps).toEqual(["//tools:gbench"]);
    expect(compare?.externalDeps).toEqual([]);
  });

  it("emits target-contains edges for existing files and dep-edges only to known targets", async () => {
    const files = [...toolsFiles, "tools/BUILD.bazel"];
    const texts = new Map([["tools/BUILD.bazel", toolsBuild]]);
    const model = buildModel(texts, files);
    expect(model.targets.has("//tools:gbench")).toBe(false);
    const ctx = {
      root: { path: "/nonexistent", name: "tools", allowBuildTools: false },
      files,
      listFiles: () => [...files],
      readFile: async () => toolsBuild,
      log: () => undefined,
    };
    const batches: IRBatch[] = [];
    for await (const batch of frontend.extract(ctx)) batches.push(batch);
    const records = allRecords(batches);
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    expect(nodes.filter((n) => n.kind === "packaging.build-target").map((n) => n.id).sort()).toEqual([
      "//tools:app",
      "//tools:compare",
      "//tools:helper",
      "//tools:lint",
      "//tools:tool",
    ]);
    const contains = (from: string) => edges.filter((e) => e.kind === "packaging.target-contains" && e.from === from).map((e) => e.to).sort();
    expect(contains("//tools:compare")).toEqual(["tools/compare.py", "tools/run.py"]);
    expect(contains("//tools:tool")).toEqual(["tools/java/Tool.java"]);
    // helper depends on compare, a known binary: an edge. Its external label is not recorded for a non-cc rule.
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "//tools:helper", to: "//tools:compare" }));
    expect(edges.filter((e) => e.from === "//tools:helper" && e.kind === "packaging.dep-edge")).toHaveLength(1);
    // compare's only dependency, gbench, is a py_library and not modelled: no edge.
    expect(edges.filter((e) => e.from === "//tools:compare" && e.kind === "packaging.dep-edge")).toEqual([]);
    // cc_binary keeps its dependency edge, resolved or unresolved, as before.
    expect(edges).toContainEqual(
      expect.objectContaining({ kind: "packaging.dep-edge", from: "//tools:app", to: { unresolved: { scheme: "bazel.label", text: "//tools:core" } } }),
    );
  });
});
