import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IRRecord } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";
import { externalMatches, resolver, type ExternalName } from "../src/resolve.js";
import { buildModel, globRegex, labelOf, moduleVariables, outputOf, parseBuildFile } from "../src/model.js";
import { externalIdOf, mainRepoNames, parseExternals, repoOf } from "../src/externals.js";
import { globsIn, labelsIn, stringsIn, tokenize, topLevelCalls } from "../src/starlark.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "sample-bazel");
const goldenFile = join(here, "golden", "sample-bazel.ndjson");
const files = [
  "BUILD.bazel",
  "MODULE.bazel",
  "MODULE.bazel.lock",
  "app/main.cc",
  "ext/BUILD",
  "ext/consumer.cc",
  "ext/macros.bzl",
  "lib/BUILD",
  "lib/include/core/core.h",
  "lib/src/core.cc",
  "lib/test/core_test.cc",
  "lib/util/log.h",
  "third_party/BUILD",
  "third_party/absl/strings/str_cat.h",
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
    expect(targets.map((n) => n.id).sort()).toEqual(["//:app", "//ext:consumer", "//lib:core", "//lib:core_test", "//lib:util", "//third_party:vendored_absl"]);
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

describe("build-system contract", () => {
  const build = [
    'cc_library(name = "core", hdrs = ["core.h"], srcs = ["core.cc"])',
    'cc_test(name = "core_test", srcs = ["core_test.cc"], deps = [":core"])',
    'cc_binary(name = "app", srcs = ["app.cc"], deps = [":core"])',
    'py_binary(name = "tool", srcs = ["tool.py"], main = "tool.py")',
    'my_macro(name = "helpers", srcs = ["helpers.cc"], deps = [":core"])',
    'my_macro(name = "runner", srcs = ["runner.cc"], main = "runner.cc", deps = [":core"])',
    'my_macro(name = "plain", srcs = ["plain.cc"], hdrs = ["plain.h"], deps = [":core"])',
  ].join("\n");
  const buildFiles = ["x/core.h", "x/core.cc", "x/core_test.cc", "x/app.cc", "x/tool.py", "x/helpers.cc", "x/runner.cc", "x/plain.cc", "x/plain.h"];
  const targets = Object.fromEntries(
    parseBuildFile("x/BUILD", build, buildFiles, new Set(["x"])).map((t) => [t.name, t]),
  );

  it("classifies each target's output by its rule, and by its header and main for a heuristic macro", () => {
    expect(targets.core).toMatchObject({ kind: "cc_library" });
    expect(outputOf(targets.core!)).toBe("library");
    expect(outputOf(targets.core_test!)).toBe("test");
    expect(outputOf(targets.app!)).toBe("executable");
    expect(outputOf(targets.tool!)).toBe("executable");
    expect(targets.helpers?.confidence).toBe("heuristic");
    expect(outputOf(targets.helpers!)).toBe("library");
    expect(outputOf(targets.runner!)).toBe("other");
    expect(outputOf(targets.plain!)).toBe("library");
  });

  it("names the build system on every package and external, and the output on every target", async () => {
    const records = allRecords(await extractAll());
    const nodes = records.flatMap((r) => ("node" in r ? [r.node] : []));
    const packages = nodes.filter((n) => n.kind === "structure.package");
    expect(packages.length).toBeGreaterThan(0);
    for (const p of packages) expect(p.attrs).toMatchObject({ buildSystem: "bazel" });
    const externals = nodes.filter((n) => n.kind === "packaging.external");
    expect(externals.length).toBeGreaterThan(0);
    for (const e of externals) expect(e.attrs).toMatchObject({ manager: "bazel" });
    const outputs = Object.fromEntries(nodes.filter((n) => n.kind === "packaging.build-target").map((n) => [n.id, n.attrs.output]));
    expect(outputs).toMatchObject({ "//lib:core": "library", "//lib:core_test": "test", "//:app": "executable" });
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
    expect(pkgs.map((n) => n.id).sort()).toEqual(["//", "//ext", "//lib", "//third_party"]);
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
    expect(repoOf("@@rules_cc~0.1.5~cc~cc_toolchain//:x")).toBe("cc_toolchain");
    expect(repoOf("@@rules_cc~0.1.5//:x")).toBe("rules_cc");
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

describe("external includes", () => {
  it("answers an alias-mapped include with the external that declares its module", () => {
    const ext: ExternalName[] = [
      { id: "@abseil-cpp", name: "abseil-cpp" },
      { id: "@com_google_googletest", name: "googletest", repoName: "com_google_googletest" },
    ];
    expect(externalMatches("absl/strings/str_cat.h", ext)).toEqual(["@abseil-cpp"]);
    expect(externalMatches("gtest/gtest.h", ext)).toEqual(["@com_google_googletest"]);
    expect(externalMatches("gmock/gmock.h", ext)).toEqual(["@com_google_googletest"]);
    expect(externalMatches("absl/strings/str_cat.h", [])).toEqual([]);
  });

  it("maps google/protobuf and boost.* modules by their two- or one-segment alias", () => {
    expect(externalMatches("google/protobuf/message.h", [{ id: "@protobuf", name: "protobuf" }])).toEqual(["@protobuf"]);
    expect(externalMatches("boost/asio.hpp", [{ id: "@boost.asio", name: "boost.asio" }])).toEqual(["@boost.asio"]);
  });

  it("matches the first segment against an external's name or repo_name when no alias applies", () => {
    expect(externalMatches("libpfm/pfmlib.h", [{ id: "@libpfm", name: "libpfm" }])).toEqual(["@libpfm"]);
    expect(externalMatches("libpfm/pfmlib.h", [{ id: "@pfm", name: "other", repoName: "libpfm" }])).toEqual(["@pfm"]);
    expect(externalMatches("libpfm/pfmlib.h", [{ id: "@other", name: "other" }])).toEqual([]);
  });

  it("never matches a single-segment include, even when an external has that name", () => {
    const ext: ExternalName[] = [
      { id: "@string", name: "string" },
      { id: "@foo.h", name: "foo.h" },
      { id: "@vector", name: "vector", repoName: "vector" },
    ];
    expect(externalMatches("string", ext)).toEqual([]);
    expect(externalMatches("vector", ext)).toEqual([]);
    expect(externalMatches("foo.h", ext)).toEqual([]);
  });

  it("answers through the closure of the including file's owner targets, as inferred", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "absl/strings/str_cat.h" }, resolveCtx("ext/consumer.cc"));
    expect(answer?.targets).toEqual(["@abseil-cpp"]);
    expect(answer?.confidence).toBe("inferred");
    expect(await resolver.resolve({ scheme: "cpp.include", text: "gtest/gtest.h" }, resolveCtx("ext/consumer.cc"))).toMatchObject({
      targets: ["@com_google_googletest"],
      confidence: "inferred",
    });
  });

  it("does not answer with an external that no owner target's closure depends on", async () => {
    // lib/src/core.cc's targets depend on @abseil-cpp, but not on @com_google_googletest.
    expect(await resolver.resolve({ scheme: "cpp.include", text: "gtest/gtest.h" }, resolveCtx("lib/src/core.cc"))).toBeNull();
    expect(await resolver.resolve({ scheme: "cpp.include", text: "absl/strings/str_cat.h" }, resolveCtx("lib/src/core.cc"))).toMatchObject({
      targets: ["@abseil-cpp"],
    });
  });

  it("uses every declared external when the including file has no owner target, as heuristic", async () => {
    expect(await resolver.resolve({ scheme: "cpp.include", text: "absl/strings/str_cat.h" }, resolveCtx("nowhere.cc"))).toMatchObject({
      targets: ["@abseil-cpp"],
      confidence: "heuristic",
    });
    expect(await resolver.resolve({ scheme: "cpp.include", text: "gtest/gtest.h" }, resolveCtx("nowhere.cc"))).toMatchObject({
      targets: ["@com_google_googletest"],
    });
  });

  it("answers from the in-repository header of the file's own target before any external", async () => {
    const answer = await resolver.resolve({ scheme: "cpp.include", text: "absl/strings/str_cat.h" }, resolveCtx("third_party/absl/strings/str_cat.h"));
    expect(answer?.targets).toEqual(["third_party/absl/strings/str_cat.h"]);
    expect(answer?.confidence).toBe("inferred");
  });
});

describe("macro and custom rules", () => {
  it("reads a macro call with deps and srcs as a heuristic C++ target", () => {
    const [t] = parseBuildFile(
      "p/BUILD",
      'load("//p:m.bzl", "my_cc_library")\nmy_cc_library(name = "m", srcs = ["m.cc"], hdrs = ["m.h"], deps = [":core"])',
      [],
      new Set(["p"]),
    );
    expect(t).toMatchObject({ id: "//p:m", kind: "my_cc_library", cc: true, confidence: "heuristic", deps: ["//p:core"] });
    expect(t?.hdrs).toEqual(["p/m.h"]);
  });

  it("does not read a py_test with srcs and deps as a target, nor a py_library or filegroup", () => {
    const build = [
      'py_test(name = "t", srcs = ["t.py"], deps = [":x"])',
      'py_library(name = "x", srcs = ["x.py"], deps = [])',
      'filegroup(name = "f", srcs = ["a.txt"], deps = [])',
      'my_cc_test(name = "ct", srcs = ["ct.cc"], deps = [":x"])',
    ].join("\n");
    expect(parseBuildFile("p/BUILD", build, ["p/t.py", "p/x.py", "p/a.txt", "p/ct.cc"], new Set(["p"]))).toEqual([]);
  });

  it("gives a modelled rule exact confidence and keeps cc_library's cc flag", () => {
    const [lib] = parseBuildFile("p/BUILD", 'cc_library(name = "l", srcs = ["l.cc"])', ["p/l.cc"], new Set(["p"]));
    expect(lib).toMatchObject({ confidence: "exact", cc: true });
    const [bin] = parseBuildFile("p/BUILD", 'py_binary(name = "b", srcs = ["b.py"])', ["p/b.py"], new Set(["p"]));
    expect(bin).toMatchObject({ confidence: "exact", cc: false });
  });

  it("gives the macro target heuristic provenance in the IR", async () => {
    const nodes = nodesOf(await extractAll());
    expect(nodes.find((n) => n.id === "//ext:consumer")).toMatchObject({
      attrs: { targetKind: "my_cc_library", source: "static" },
      provenance: { confidence: "heuristic" },
    });
    expect(nodes.find((n) => n.id === "//lib:core")?.provenance).toMatchObject({ confidence: "exact" });
  });

  it("records every dep of the macro target as a dep-edge, including the external ones", async () => {
    const edges = edgesOf(await extractAll());
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "//ext:consumer", to: "@abseil-cpp" }));
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "//ext:consumer", to: "@com_google_googletest" }));
  });
});

describe("visibility expressions", () => {
  const vis = (build: string, name = "x") => parseBuildFile("absl/random/internal/BUILD", build, [], new Set(["absl/random/internal"])).find((t) => t.name === name);

  it("reads a module-level variable bound to a list of strings", () => {
    const t = vis('ALLOWED = ["//app:__pkg__", "//lib:__subpackages__"]\ncc_library(name = "x", visibility = ALLOWED)');
    expect(t?.visibility).toEqual(["//app:__pkg__", "//lib:__subpackages__"]);
  });

  it("concatenates lists and variables with +, in order", () => {
    const t = vis('BASE = ["//app:__pkg__"]\ncc_library(name = "x", visibility = BASE + ["//lib:__pkg__"] + BASE)');
    expect(t?.visibility).toEqual(["//app:__pkg__", "//lib:__pkg__", "//app:__pkg__"]);
  });

  it("omits visibility when a variable is unknown, rather than emitting a partial list", () => {
    const t = vis('cc_library(name = "x", visibility = UNKNOWN + ["//lib:__pkg__"])');
    expect(t).not.toHaveProperty("visibility");
  });

  it("omits visibility for a call or select(), and for a name bound twice", () => {
    expect(vis('cc_library(name = "x", visibility = select({"//conditions:default": ["//a:__pkg__"]}))')).not.toHaveProperty("visibility");
    expect(vis('cc_library(name = "x", visibility = make_vis() + ["//a:__pkg__"])')).not.toHaveProperty("visibility");
    expect(vis('V = ["//a:__pkg__"]\nV = ["//b:__pkg__"]\ncc_library(name = "x", visibility = V)')).not.toHaveProperty("visibility");
  });

  it("applies package(default_visibility) through the same evaluation, to targets that set none", () => {
    const build = 'DEFAULT = ["//absl/random:__pkg__", "@do_not_use_for_gloop_visibility_only//gloop/util/random:__subpackages__"]\npackage(default_visibility = DEFAULT)\ncc_library(name = "a")\ncc_library(name = "b", visibility = ["//visibility:public"])';
    const parsed = parseBuildFile("absl/random/internal/BUILD", build, [], new Set(["absl/random/internal"]));
    expect(parsed.find((t) => t.name === "a")?.visibility).toEqual([
      "//absl/random:__pkg__",
      "@do_not_use_for_gloop_visibility_only//gloop/util/random:__subpackages__",
    ]);
    expect(parsed.find((t) => t.name === "b")?.visibility).toEqual(["//visibility:public"]);
  });

  it("does not fall back to the package default when the target's own visibility cannot be read", () => {
    const build = 'package(default_visibility = ["//visibility:public"])\ncc_library(name = "x", visibility = UNKNOWN)';
    expect(vis(build)).not.toHaveProperty("visibility");
  });

  it("reads randen_engine's shape: a package variable, then default + [] in the target", () => {
    const build = [
      'default_package_visibility = ["//absl/random:__pkg__", "@do_not_use_for_gloop_visibility_only//gloop/util/random:__subpackages__"]',
      'package(default_visibility = default_package_visibility, features = ["x"])',
      'cc_library(name = "randen_engine", hdrs = ["randen_engine.h"], visibility = default_package_visibility + [\n    ],\n    deps = [":randen"])',
    ].join("\n");
    expect(vis(build, "randen_engine")?.visibility).toEqual([
      "//absl/random:__pkg__",
      "@do_not_use_for_gloop_visibility_only//gloop/util/random:__subpackages__",
    ]);
  });
});

describe("header exposure without strip_include_prefix", () => {
  it("answers an include with the workspace-relative path of a header in another package", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bazel-expose-"));
    const put = (rel: string, text: string) => {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    };
    put("absl/algorithm/BUILD.bazel", 'cc_library(name = "algorithm", hdrs = ["algorithm.h"], deps = ["//absl/base:config"])');
    put("absl/base/BUILD.bazel", 'cc_library(name = "config", hdrs = ["config.h"])');
    put("absl/algorithm/algorithm.h", "");
    put("absl/base/config.h", "");
    const all = ["absl/algorithm/BUILD.bazel", "absl/base/BUILD.bazel", "absl/algorithm/algorithm.h", "absl/base/config.h"];
    const ctx = { root: { path: dir, name: "t", allowBuildTools: false }, fromFile: "absl/algorithm/algorithm.h", hasFile: (p: string) => all.includes(p), hasNode: () => true, listFiles: () => [...all] };
    try {
      expect(await resolver.resolve({ scheme: "cpp.include", text: "absl/base/config.h" }, ctx)).toMatchObject({ targets: ["absl/base/config.h"], confidence: "inferred" });
      expect(await resolver.resolve({ scheme: "cpp.include", text: "config.h" }, ctx)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("glob patterns", () => {
  it("reads the include patterns of glob(include = [...]) given by keyword, as well as positionally", () => {
    const files = ["gt/src/a.cc", "gt/src/b.cc", "gt/include/x.h", "gt/include/sub/y.h"];
    const kw = parseBuildFile("gt/BUILD", 'cc_library(name = "gt", srcs = glob(\n    include = ["src/*.cc", "include/**/*.h"],\n    exclude = ["src/b.cc"],\n))', files, new Set(["gt"]));
    expect(kw[0]?.srcs).toEqual(["gt/include/sub/y.h", "gt/include/x.h", "gt/src/a.cc"]);
    const positional = parseBuildFile("gt/BUILD", 'cc_library(name = "gt", srcs = glob(["src/*.cc"]))', files, new Set(["gt"]));
    expect(positional[0]?.srcs).toEqual(["gt/src/a.cc", "gt/src/b.cc"]);
  });
});

/** Writes a small tree into a temp directory and asks the resolver one include, from one file. */
async function answerIn(tree: Record<string, string>, fromFile: string, include: string) {
  const dir = mkdtempSync(join(tmpdir(), "bazel-case-"));
  const all = Object.keys(tree);
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const ctx = {
    root: { path: dir, name: "t", allowBuildTools: false },
    fromFile,
    hasFile: (p: string) => all.includes(p),
    hasNode: () => true,
    listFiles: () => [...all],
  };
  try {
    return await resolver.resolve({ scheme: "cpp.include", text: include }, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("include_prefix strips the package directory first", () => {
  const consumer = { "app/BUILD": 'cc_binary(name = "app", srcs = ["main.cc"], deps = ["//third_party/z:z"])', "app/main.cc": "" };

  it("exposes a header under include_prefix alone with the package directory stripped", async () => {
    const tree = {
      ...consumer,
      "third_party/z/BUILD": 'cc_library(name = "z", hdrs = ["x.h"], include_prefix = "zlib")',
      "third_party/z/x.h": "",
    };
    expect(await answerIn(tree, "app/main.cc", "zlib/x.h")).toMatchObject({ targets: ["third_party/z/x.h"], confidence: "inferred" });
    expect(await answerIn(tree, "app/main.cc", "zlib/third_party/z/x.h")).toBeNull();
  });

  it("keeps include_prefix over an explicit strip_include_prefix", async () => {
    const tree = {
      ...consumer,
      "third_party/z/BUILD": 'cc_library(name = "z", hdrs = ["inc/x.h"], strip_include_prefix = "inc", include_prefix = "zlib")',
      "third_party/z/inc/x.h": "",
    };
    expect(await answerIn(tree, "app/main.cc", "zlib/x.h")).toMatchObject({ targets: ["third_party/z/inc/x.h"] });
  });

  it("keeps the workspace-relative path when neither strip_include_prefix nor include_prefix is set", async () => {
    const tree = {
      ...consumer,
      "third_party/z/BUILD": 'cc_library(name = "z", hdrs = ["x.h"])',
      "third_party/z/x.h": "",
    };
    expect(await answerIn(tree, "app/main.cc", "third_party/z/x.h")).toMatchObject({ targets: ["third_party/z/x.h"] });
    expect(await answerIn(tree, "app/main.cc", "x.h")).toBeNull();
  });
});

describe("canonical labels after the lock pins a module", () => {
  const moduleFile = 'module(name = "sample")\nbazel_dep(name = "googletest", version = "1.14.0", repo_name = "com_google_googletest")';
  const lock = JSON.stringify({ moduleDepGraph: { "googletest@1.14.0": { name: "googletest", version: "1.14.0" } } });
  const build = 'cc_library(name = "a", srcs = [], deps = ["@@googletest+//:gtest"])';

  it("matches a canonical name by module name without a lock, and with a lock that sets source to lockfile", () => {
    expect(externalIdOf("googletest", externalsOf({ "MODULE.bazel": moduleFile }))).toBe("@com_google_googletest");
    const locked = externalsOf({ "MODULE.bazel": moduleFile, "MODULE.bazel.lock": lock });
    expect(locked.entries.get("@com_google_googletest")?.attrs.source).toBe("lockfile");
    expect(externalIdOf("googletest", locked)).toBe("@com_google_googletest");
  });

  it("points a dep-edge at the declared external with a lock, as without one", async () => {
    for (const texts of [{ "MODULE.bazel": moduleFile, "BUILD": build }, { "MODULE.bazel": moduleFile, "MODULE.bazel.lock": lock, "BUILD": build }]) {
      const deps = edgesOf(await extractFiles(texts)).filter((e) => e.kind === "packaging.dep-edge" && e.from === "//:a");
      expect(deps.map((e) => e.to)).toEqual(["@com_google_googletest"]);
    }
  });
});

describe("visibility variables reassigned with += or in a block", () => {
  const vis = (build: string) => parseBuildFile("absl/random/internal/BUILD", build, [], new Set(["absl/random/internal"])).find((t) => t.name === "x");

  it("makes a variable unknown after += , so visibility is omitted rather than the first value", () => {
    expect(vis('VIS = ["//a:__pkg__"]\nVIS += ["//b:__pkg__"]\ncc_library(name = "x", visibility = VIS)')).not.toHaveProperty("visibility");
    expect(moduleVariables(tokenize('VIS = ["//a:__pkg__"]\nVIS += ["//b:__pkg__"]')).get("VIS")).toBeUndefined();
  });

  it("makes a variable unknown when it is assigned inside a block", () => {
    const build = 'VIS = ["//a:__pkg__"]\nif True:\n    VIS = ["//b:__pkg__"]\ncc_library(name = "x", visibility = VIS)';
    expect(vis(build)).not.toHaveProperty("visibility");
  });

  it("still reads a single module-level assignment", () => {
    expect(vis('VIS = ["//a:__pkg__"]\ncc_library(name = "x", visibility = VIS)')?.visibility).toEqual(["//a:__pkg__"]);
  });
});

describe("main-repository labels and label forms", () => {
  it("reads @//p:t and @@//p:t as in-repository labels, and @root//p:t for the root module name", () => {
    expect(labelOf("@//pkg:t", "p")).toEqual({ id: "//pkg:t" });
    expect(labelOf("@@//pkg:t", "p")).toEqual({ id: "//pkg:t" });
    expect(labelOf("@sample//pkg:t", "p", ["sample"])).toEqual({ id: "//pkg:t" });
    expect(labelOf("@sample//pkg:t", "p")).toEqual({ external: "@sample//pkg:t" });
    expect(labelOf("@repo//pkg:t", "p")).toEqual({ external: "@repo//pkg:t" });
  });

  it("reads //pkg, //pkg:pkg and :local as the same or package-relative target ids", () => {
    expect(labelOf("//pkg", "")).toEqual({ id: "//pkg:pkg" });
    expect(labelOf("//pkg:pkg", "")).toEqual({ id: "//pkg:pkg" });
    expect(labelOf(":local", "p")).toEqual({ id: "//p:local" });
  });

  it("gives no repository for a main-repository label, and the apparent name for each canonical form", () => {
    expect(repoOf("@//pkg:t")).toBeUndefined();
    expect(repoOf("@@//pkg:t")).toBeUndefined();
    expect(repoOf("@repo//pkg:t")).toBe("repo");
    expect(repoOf("@@name+//p")).toBe("name");
    expect(repoOf("@@rules_cc++ext+foo//:x")).toBe("foo");
    expect(repoOf("@@+ext+foo//...")).toBe("foo");
  });

  it("reads the root module name from module(name = ...)", () => {
    expect(mainRepoNames(new Map([["MODULE.bazel", 'module(name = "sample", version = "0.1")']]))).toEqual(["sample"]);
    expect(mainRepoNames(new Map())).toEqual([]);
  });

  it("drops main-repository deps from the external list and records them as in-repository targets", () => {
    const targets = parseBuildFile("app/BUILD", 'cc_binary(name = "app", srcs = [], deps = ["@sample//lib:core", "@@//lib:core", "@//lib:core", "@repo//lib:core"])', [], new Set(["app"]), ["sample"]);
    expect(targets[0]?.deps).toEqual(["//lib:core", "//lib:core", "//lib:core"]);
    expect(targets[0]?.externalDeps).toEqual(["@repo//lib:core"]);
  });

  it("resolves an extension canonical name to the external its use_repo declares", async () => {
    const moduleFile = 'module(name = "sample")\next = use_extension("//:deps.bzl", "e")\nuse_repo(ext, "foo")';
    const ext = externalsOf({ "MODULE.bazel": moduleFile });
    expect(externalIdOf(repoOf("@@rules_cc++ext+foo//:x") ?? "", ext)).toBe("@foo");
    expect(externalIdOf(repoOf("@@+ext+foo//p") ?? "", ext)).toBe("@foo");
  });
});

describe("main-repository names and label shorthand", () => {
  const withRepoName = 'module(name = "me", repo_name = "my_repo")';
  const withoutRepoName = 'module(name = "me")';

  it("takes the repo_name over the module name as the main repository's apparent name", () => {
    expect(mainRepoNames(new Map([["MODULE.bazel", withRepoName]]))).toEqual(["my_repo"]);
    expect(mainRepoNames(new Map([["MODULE.bazel", withoutRepoName]]))).toEqual(["me"]);
  });

  it("resolves @my_repo//a:b to //a:b, and does not treat @me//a:b as the main repository when repo_name is set", () => {
    const mains = mainRepoNames(new Map([["MODULE.bazel", withRepoName]]));
    expect(labelOf("@my_repo//a:b", "p", mains)).toEqual({ id: "//a:b" });
    expect(labelOf("@me//a:b", "p", mains)).toEqual({ external: "@me//a:b" });
  });

  it("without repo_name, resolves @me//a:b to //a:b and the shorthand @me to //:me", () => {
    const mains = mainRepoNames(new Map([["MODULE.bazel", withoutRepoName]]));
    expect(labelOf("@me//a:b", "p", mains)).toEqual({ id: "//a:b" });
    expect(labelOf("@me", "p", mains)).toEqual({ id: "//:me" });
  });

  it("resolves @@//a:b to //a:b", () => {
    expect(labelOf("@@//a:b", "p")).toEqual({ id: "//a:b" });
  });

  it("does not resolve @@me//a:b as the main repository, even when me is the main repository name", () => {
    expect(labelOf("@@me//a:b", "p", ["me"])).toEqual({ external: "@@me//a:b" });
    const targets = parseBuildFile("app/BUILD", 'cc_binary(name = "app", srcs = [], deps = ["@@me//a:b"])', [], new Set(["app"]), ["me"]);
    expect(targets[0]?.deps).toEqual([]);
    expect(targets[0]?.externalDeps).toEqual(["@@me//a:b"]);
  });

  it("writes the external shorthand @foo as @foo//:foo, which maps to the bazel_dep foo", async () => {
    expect(labelOf("@foo", "p")).toEqual({ external: "@foo//:foo" });
    const ext = externalsOf({ "MODULE.bazel": 'module(name = "me")\nbazel_dep(name = "foo", version = "1.0")' });
    expect(externalIdOf(repoOf("@foo") ?? "", ext)).toBe("@foo");
    const deps = edgesOf(await extractFiles({
      "MODULE.bazel": 'module(name = "me")\nbazel_dep(name = "foo", version = "1.0")',
      "BUILD": 'cc_library(name = "a", srcs = [], deps = ["@foo"])',
    })).filter((e) => e.kind === "packaging.dep-edge" && e.from === "//:a");
    expect(deps.map((e) => e.to)).toEqual(["@foo"]);
  });
});
