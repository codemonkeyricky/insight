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
import { externalIdOf, parseExternals, repoOf } from "../src/externals.js";
import { globsIn, labelsIn, stringsIn, tokenize, topLevelCalls } from "../src/starlark.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-bazel");
const goldenFile = join(here, "golden", "sample-bazel.ndjson");
const files = [
  "BUILD.bazel",
  "MODULE.bazel",
  "MODULE.bazel.lock",
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
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "//lib:core_test", to: "@com_google_googletest" }));
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

/** Extracts an in-memory project: the given files and their texts. */
async function extractFiles(texts: Record<string, string>): Promise<IRBatch[]> {
  const names = Object.keys(texts);
  const ctx = {
    root: { path: "/nonexistent", name: "t", allowBuildTools: false },
    files: names,
    listFiles: () => [...names],
    readFile: async (p: string) => texts[p] ?? "",
    log: () => undefined,
  };
  const out: IRBatch[] = [];
  for await (const batch of frontend.extract(ctx)) out.push(batch);
  return out;
}

const nodesOf = (batches: IRBatch[]) => allRecords(batches).flatMap((r) => ("node" in r ? [r.node] : []));
const edgesOf = (batches: IRBatch[]) => allRecords(batches).flatMap((r) => ("edge" in r ? [r.edge] : []));

/** Externals declared by an in-memory MODULE.bazel (and optional lock and WORKSPACE). */
function externalsOf(texts: Record<string, string>) {
  return parseExternals(new Map(Object.entries(texts)));
}

describe("packages and parents", () => {
  it("emits one structure.package per BUILD file, and parents each target to its package", async () => {
    const nodes = nodesOf(await extractAll());
    const pkgs = nodes.filter((n) => n.kind === "structure.package");
    expect(pkgs.map((n) => n.id).sort()).toEqual(["//", "//lib"]);
    expect(pkgs.find((n) => n.id === "//")).toMatchObject({ facet: "structure", attrs: { name: "//", root: "." } });
    expect(pkgs.find((n) => n.id === "//lib")).toMatchObject({ facet: "structure", attrs: { name: "//lib", root: "lib" } });
    expect(nodes.find((n) => n.id === "//:app")?.parent).toBe("//");
    expect(nodes.find((n) => n.id === "//lib:core")?.parent).toBe("//lib");
    expect(nodes.find((n) => n.id === "//lib:core_test")?.parent).toBe("//lib");
  });

  it("emits a package node even for a BUILD file with no targets", async () => {
    const batches = await extractFiles({ "empty/BUILD": "# nothing here\n" });
    expect(nodesOf(batches).map((n) => [n.id, n.kind])).toEqual([["//empty", "structure.package"]]);
  });
});

describe("bzlmod externals", () => {
  it("reads bazel_dep, its repo_name and dev flag, and the lock's version and registry", () => {
    const ext = externalsOf({ "MODULE.bazel": moduleText(), "MODULE.bazel.lock": LOCK });
    expect(ext.entries.get("@abseil-cpp")).toMatchObject({
      confidence: "exact",
      attrs: { name: "abseil-cpp", version: "20240116.2", source: "lockfile", registry: "https://bcr.bazel.build", override: "single_version" },
    });
    expect(ext.entries.get("@com_google_googletest")?.attrs).toEqual({
      name: "googletest",
      version: "1.14.0",
      repoName: "com_google_googletest",
      dev: true,
      source: "lockfile",
      registry: "https://bcr.bazel.build",
    });
  });

  it("omits the root module() call and keeps a bazel_dep without repo_name or dev flag plain", () => {
    const ext = externalsOf({ "MODULE.bazel": 'module(name = "root")\nbazel_dep(name = "zlib", version = "1.3")' });
    expect([...ext.entries.keys()]).toEqual(["@zlib"]);
    expect(ext.entries.get("@zlib")?.attrs).toEqual({ name: "zlib", version: "1.3", source: "bzlmod" });
  });

  it("applies each override kind to the bazel_dep of that module", () => {
    const ext = externalsOf({
      "MODULE.bazel": [
        'bazel_dep(name = "a", version = "1.0")',
        'bazel_dep(name = "b", version = "1.0")',
        'bazel_dep(name = "c", version = "1.0")',
        'bazel_dep(name = "d", version = "1.0")',
        'git_override(module_name = "a", remote = "https://example.com/a.git")',
        'archive_override(module_name = "b", urls = ["https://x/b1.tgz", "https://x/b2.tgz"], integrity = "sha256-x")',
        'local_path_override(module_name = "c", path = "../c")',
        'multiple_version_override(module_name = "d", versions = ["1.0", "2.0"])',
        'git_override(module_name = "unknown", remote = "https://example.com/u.git")',
      ].join("\n"),
    });
    expect(ext.entries.get("@a")?.attrs).toMatchObject({ override: "git", url: "https://example.com/a.git" });
    expect(ext.entries.get("@b")?.attrs).toMatchObject({ override: "archive", url: "https://x/b1.tgz" });
    expect(ext.entries.get("@c")?.attrs).toMatchObject({ override: "local" });
    expect(ext.entries.get("@d")?.attrs).toMatchObject({ override: "multiple_version" });
    expect(ext.entries.has("@unknown")).toBe(false);
  });

  it("lets single_version_override replace the bazel_dep version", () => {
    const ext = externalsOf({
      "MODULE.bazel": 'bazel_dep(name = "a", version = "1.0")\nsingle_version_override(module_name = "a", version = "1.1")',
    });
    expect(ext.entries.get("@a")?.attrs).toMatchObject({ version: "1.1", override: "single_version", source: "bzlmod" });
  });

  it("declares use_repo names: positional strings as ids, keyword as the local id with the string as its name", () => {
    const ext = externalsOf({
      "MODULE.bazel": [
        'bazel_dep(name = "x", version = "1")',
        'ext = use_extension("//:e.bzl", "e")',
        'use_repo(ext, "pip_deps", "x", alias = "remote_name")',
      ].join("\n"),
    });
    expect(ext.entries.get("@pip_deps")).toMatchObject({ confidence: "inferred", attrs: { name: "pip_deps", source: "bzlmod" } });
    expect(ext.entries.get("@alias")).toMatchObject({ confidence: "inferred", attrs: { name: "remote_name", source: "bzlmod" } });
    // x is already declared by bazel_dep, so use_repo does not redeclare it.
    expect(ext.entries.get("@x")?.confidence).toBe("exact");
  });

  it("takes the version from moduleDepGraph when the lock has one", () => {
    const lock = JSON.stringify({ moduleDepGraph: { "zlib@1.3.1": { name: "zlib", version: "1.3.1", repoName: "zlib" } } });
    const ext = externalsOf({ "MODULE.bazel": 'bazel_dep(name = "zlib")', "MODULE.bazel.lock": lock });
    expect(ext.entries.get("@zlib")?.attrs).toMatchObject({ version: "1.3.1", source: "lockfile" });
  });

  it("takes the version from registryFileHashes only when exactly one version of the module appears", () => {
    const one = JSON.stringify({ registryFileHashes: { "https://r/modules/zlib/1.3.1/MODULE.bazel": "h" } });
    const two = JSON.stringify({
      registryFileHashes: { "https://r/modules/zlib/1.3.1/MODULE.bazel": "h", "https://r/modules/zlib/1.2.0/MODULE.bazel": "h" },
    });
    const declared = 'bazel_dep(name = "zlib")';
    expect(externalsOf({ "MODULE.bazel": declared, "MODULE.bazel.lock": one }).entries.get("@zlib")?.attrs).toMatchObject({
      version: "1.3.1",
      registry: "https://r",
      source: "lockfile",
    });
    expect(externalsOf({ "MODULE.bazel": declared, "MODULE.bazel.lock": two }).entries.get("@zlib")?.attrs).toEqual({ name: "zlib", source: "bzlmod" });
  });

  it("ignores a malformed lock file without failing, and still reads MODULE.bazel", async () => {
    expect(() => externalsOf({ "MODULE.bazel": 'bazel_dep(name = "zlib", version = "1.3")', "MODULE.bazel.lock": "{not json" })).not.toThrow();
    const ext = externalsOf({ "MODULE.bazel": 'bazel_dep(name = "zlib", version = "1.3")', "MODULE.bazel.lock": "{not json" });
    expect(ext.entries.get("@zlib")?.attrs).toEqual({ name: "zlib", version: "1.3", source: "bzlmod" });
    const batches = await extractFiles({ "MODULE.bazel": 'bazel_dep(name = "zlib", version = "1.3")', "MODULE.bazel.lock": "{not json" });
    expect(nodesOf(batches).filter((n) => n.kind === "packaging.external").map((n) => n.id)).toEqual(["@zlib"]);
  });

  it("emits the external nodes in the MODULE.bazel batch, with their declaring span", async () => {
    const batches = await extractAll();
    const moduleBatch = batches.find((b) => b.file === "MODULE.bazel");
    const lockBatch = batches.find((b) => b.file === "MODULE.bazel.lock");
    const externalsInModule = moduleBatch?.records.flatMap((r) => ("node" in r && r.node.kind === "packaging.external" ? [r.node.id] : [])).sort();
    expect(externalsInModule).toEqual(["@abseil-cpp", "@com_google_googletest", "@alias", "@sample_helper"].sort());
    expect(lockBatch?.records).toEqual([]);
    expect(nodesOf(batches).find((n) => n.id === "@abseil-cpp")?.span?.file).toBe("MODULE.bazel");
  });
});

describe("WORKSPACE externals", () => {
  const WS = [
    'load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")',
    'http_archive(name = "rules_thing", urls = ["https://x/rules.tgz"], sha256 = "abc")',
    'git_repository(name = "gitdep", remote = "https://example.com/g.git", tag = "v2.0")',
    'local_repository(name = "localdep", path = "../local")',
    'http_archive(name = "abseil-cpp", url = "https://x/abseil.tgz")',
  ].join("\n");

  it("reads http_archive, git_repository and local_repository with their url, sha256 and tag", () => {
    const ext = externalsOf({ "WORKSPACE": WS });
    expect(ext.entries.get("@rules_thing")).toMatchObject({
      confidence: "exact",
      attrs: { name: "rules_thing", source: "workspace", url: "https://x/rules.tgz", sha256: "abc" },
    });
    expect(ext.entries.get("@gitdep")?.attrs).toEqual({ name: "gitdep", source: "workspace", url: "https://example.com/g.git", version: "v2.0" });
    expect(ext.entries.get("@localdep")?.attrs).toEqual({ name: "localdep", source: "workspace" });
  });

  it("gives precedence to a MODULE.bazel declaration over a WORKSPACE repo of the same id", () => {
    const ext = externalsOf({ "MODULE.bazel": 'bazel_dep(name = "abseil-cpp", version = "20240116.2")', "WORKSPACE": WS });
    expect(ext.entries.get("@abseil-cpp")?.attrs).toEqual({ name: "abseil-cpp", version: "20240116.2", source: "bzlmod" });
  });

  it("emits WORKSPACE externals in the WORKSPACE batch when there is no MODULE.bazel", async () => {
    const batches = await extractFiles({ "WORKSPACE": WS, "BUILD": "" });
    const wsBatch = batches.find((b) => b.file === "WORKSPACE");
    const ids = wsBatch?.records.map((r) => ("node" in r ? r.node.id : "")).sort();
    expect(ids).toEqual(["@abseil-cpp", "@gitdep", "@localdep", "@rules_thing"]);
    const withExternals = batches.filter((b) => b.records.some((r) => "node" in r && r.node.kind === "packaging.external"));
    expect(withExternals.map((b) => b.file)).toEqual(["WORKSPACE"]);
  });
});

describe("canonical labels and dependency edges to externals", () => {
  it("reads the repo of canonical and apparent labels", () => {
    expect(repoOf("@@abseil-cpp+//absl/strings")).toBe("abseil-cpp");
    expect(repoOf("@@rules_cc~0.1.5~cc~cc_toolchain//:x")).toBe("rules_cc");
    expect(repoOf("@@googletest//:gtest")).toBe("googletest");
    expect(repoOf("@googletest")).toBe("googletest");
    expect(repoOf("//lib:core")).toBeUndefined();
  });

  it("maps a canonical name to the declared id, including one declared under another repo_name", () => {
    const ext = externalsOf({ "MODULE.bazel": moduleText() });
    expect(externalIdOf("abseil-cpp", ext)).toBe("@abseil-cpp");
    expect(externalIdOf("googletest", ext)).toBe("@com_google_googletest");
    expect(externalIdOf("nowhere", ext)).toBeUndefined();
  });

  it("points dep-edges at declared externals as string ids, and keeps undeclared repos unresolved", async () => {
    const batches = await extractFiles({
      "MODULE.bazel": moduleText(),
      "BUILD": 'cc_library(name = "a", srcs = [], deps = ["@@abseil-cpp+//absl/strings", "@@googletest+//:gtest", "@undeclared//x"])',
    });
    const deps = edgesOf(batches).filter((e) => e.kind === "packaging.dep-edge" && e.from === "//:a");
    expect(deps.map((e) => e.to)).toEqual([
      "@abseil-cpp",
      "@com_google_googletest",
      { unresolved: { scheme: "bazel.label", text: "@undeclared//x" } },
    ]);
  });
});

describe("visibility", () => {
  it("copies an explicit visibility into absolute labels", () => {
    const [t] = parseBuildFile("app/BUILD", 'cc_library(name = "x", visibility = [":__subpackages__", "//visibility:public", "//other:__pkg__"])', [], new Set(["app"]));
    expect(t?.visibility).toEqual(["//app:__subpackages__", "//visibility:public", "//other:__pkg__"]);
  });

  it("uses package(default_visibility) when a target sets none, and an explicit one over the default", () => {
    const build = 'package(default_visibility = ["//visibility:public"])\ncc_library(name = "a")\ncc_library(name = "b", visibility = ["//app:__pkg__"])';
    const targets = parseBuildFile("lib/BUILD", build, [], new Set(["lib"]));
    expect(targets.find((t) => t.name === "a")?.visibility).toEqual(["//visibility:public"]);
    expect(targets.find((t) => t.name === "b")?.visibility).toEqual(["//app:__pkg__"]);
  });

  it("omits visibility when neither the target nor its package sets it", () => {
    const [t] = parseBuildFile("app/BUILD", 'cc_library(name = "x")', [], new Set(["app"]));
    expect(t).not.toHaveProperty("visibility");
  });

  it("emits visibility on the build-target node", async () => {
    const nodes = nodesOf(await extractAll());
    expect(nodes.find((n) => n.id === "//lib:util")?.attrs).toMatchObject({ visibility: ["//app:__pkg__"] });
    expect(nodes.find((n) => n.id === "//lib:core")?.attrs).toMatchObject({ visibility: ["//visibility:public"] });
    expect(nodes.find((n) => n.id === "//:app")?.attrs).not.toHaveProperty("visibility");
  });
});

const LOCK = JSON.stringify({
  registryFileHashes: {
    "https://bcr.bazel.build/modules/abseil-cpp/20240116.2/MODULE.bazel": "h",
    "https://bcr.bazel.build/modules/googletest/1.14.0/MODULE.bazel": "h",
  },
});

/** The MODULE.bazel of the fixture, read the way the tests need it. */
function moduleText(): string {
  return readFileSync(join(fixtureRoot, "MODULE.bazel"), "utf8");
}
