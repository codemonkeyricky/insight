import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import type { IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// CMake packages, outputs, aliases and externals through the loader, on test/fixtures/cmake-packages.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `cmake-packages-${process.pid}`);
const project = join(SCRATCH, "cmake-packages");
const repoRoot = resolve(here, "..", "..", "..", "..");

let records: IRRecord[] = [];

const nodes = () => records.flatMap((r) => ("node" in r ? [r.node] : []));
const edges = () => records.flatMap((r) => ("edge" in r ? [r.edge] : []));

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(here, "fixtures", "cmake-packages"), project, { recursive: true });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
  });
  records = readSnapshot(projectPaths(project), report.snapshot);
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("frontend-cmake packages", () => {
  it("emits one package per directory that defines targets, named by project() at the root", () => {
    const pkgs = nodes().filter((n) => n.kind === "structure.package");
    expect(pkgs.map((p) => p.id).sort()).toEqual(["cmake:.", "cmake:lib", "cmake:tests"]);
    expect(pkgs.find((p) => p.id === "cmake:.")?.attrs).toEqual({ name: "demo", root: ".", buildSystem: "cmake" });
    expect(pkgs.find((p) => p.id === "cmake:lib")?.attrs).toEqual({ name: "lib", root: "lib", buildSystem: "cmake" });
  });

  it("parents each build target to its directory's package", () => {
    const parents = Object.fromEntries(nodes().filter((n) => n.kind === "packaging.build-target").map((n) => [n.id, n.parent]));
    expect(parents).toMatchObject({
      "cmake://:app": "cmake:.",
      "cmake://lib:shapes": "cmake:lib",
      "cmake://tests:shapes_test": "cmake:tests",
    });
  });

  it("gives each target an output kind, including add_test registration and the test name pattern", () => {
    const out = Object.fromEntries(nodes().filter((n) => n.kind === "packaging.build-target").map((n) => [n.attrs?.name, n.attrs?.output]));
    expect(out).toMatchObject({
      app: "executable",
      shapes: "library",
      shapes_test: "test",
      test_runner: "test",
      tool: "executable",
    });
  });

  it("resolves an ALIAS link to the real target", () => {
    expect(edges()).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://:app", to: "cmake://lib:shapes" }));
    expect(edges()).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://tests:shapes_test", to: "cmake://lib:shapes" }));
  });

  it("does not emit dep-edges for flags or system libraries", () => {
    const unresolved = edges()
      .filter((e) => e.kind === "packaging.dep-edge" && typeof e.to !== "string")
      .map((e) => JSON.stringify(e.to));
    for (const flag of ["-pthread", "rt", "m", "pthread"]) {
      expect(unresolved.some((u) => u.includes(`"${flag}"`))).toBe(false);
    }
  });

  it("emits find_package and FetchContent externals in their declaring file's batch", () => {
    const ext = nodes().filter((n) => n.kind === "packaging.external");
    expect(ext.map((n) => n.id).sort()).toEqual(["cmake:pkg:GTest", "cmake:pkg:Threads", "cmake:pkg:fmt", "cmake:pkg:zlibng"]);
    expect(ext.find((n) => n.id === "cmake:pkg:GTest")?.attrs).toEqual({ name: "GTest", version: "1.12", manager: "cmake", source: "find_package" });
    expect(ext.find((n) => n.id === "cmake:pkg:fmt")?.attrs).toEqual({
      name: "fmt",
      version: "10.2.1",
      manager: "cmake",
      source: "FetchContent",
      url: "https://github.com/fmtlib/fmt.git",
    });
    expect(ext.find((n) => n.id === "cmake:pkg:zlibng")?.attrs).toMatchObject({ sha256: "abc123", url: "https://example.com/zlib-ng.tar.gz" });
  });

  it("resolves Ns::target links to the external named Ns", () => {
    expect(edges()).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://tests:shapes_test", to: "cmake:pkg:GTest" }));
    expect(edges()).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://:app", to: "cmake:pkg:Threads" }));
    expect(edges()).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://lib:shapes", to: "cmake:pkg:fmt" }));
  });
});

describe("frontend-cmake include resolution to externals", () => {
  const resolverPromise = import("../../../frontend/cmake/resolve.js") as Promise<{
    default: { resolve(ref: { scheme: string; text: string }, ctx: unknown): Promise<unknown> };
  }>;
  const listFiles = () => {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(dir, r);
        else out.push(r);
      }
    };
    walk(project, "");
    return out;
  };
  const ctxFor = (fromFile: string) => {
    const files = listFiles();
    return {
      root: { path: project, name: "cmake-packages", allowBuildTools: false },
      fromFile,
      hasFile: (p: string) => files.includes(p),
      hasNode: (id: string) => id.startsWith("cmake:pkg:") || id.startsWith("cmake://"),
      listFiles: () => files,
    };
  };

  it("resolves gtest/gtest.h to GTest through the test target's closure", async () => {
    const { default: resolver } = await resolverPromise;
    expect(await resolver.resolve({ scheme: "cpp.include", text: "gtest/gtest.h" }, ctxFor("tests/test_shapes.cc"))).toEqual({
      targets: ["cmake:pkg:GTest"],
      confidence: "inferred",
      note: "external package: cmake:pkg:GTest",
    });
  });

  it("uses every declared external, as a heuristic, for a file with no owner target", async () => {
    const { default: resolver } = await resolverPromise;
    expect(await resolver.resolve({ scheme: "cpp.include", text: "gtest/gtest.h" }, ctxFor("notes/loose.cc"))).toEqual({
      targets: ["cmake:pkg:GTest"],
      confidence: "heuristic",
      note: "external package: cmake:pkg:GTest",
    });
  });

  it("answers null for an include no declared external names", async () => {
    const { default: resolver } = await resolverPromise;
    expect(await resolver.resolve({ scheme: "cpp.include", text: "zlib.h" }, ctxFor("tests/test_shapes.cc"))).toBeNull();
  });
});
