import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreRegistry, type IRRecord } from "@insight/ir";
import { runFrontendConformance, type IRBatch, type ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";
import { resolver } from "../src/resolve.js";
import { globRegex, labelOf } from "../src/model.js";
import { globsIn, stringsIn, tokenize, topLevelCalls } from "../src/starlark.js";

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
