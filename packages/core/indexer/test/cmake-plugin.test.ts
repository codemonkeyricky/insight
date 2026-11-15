import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";
import { buildCmakeModel } from "../../../frontend/cmake/parse.js";

// The real frontend-cmake plugin is loaded from packages/frontend/cmake through the normal loader, so `pnpm -r test`
// covers it. Scratch lives inside this package and is removed after the tests.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `cmake-${process.pid}`);
const project = join(SCRATCH, "cmake-sample");
const repoRoot = resolve(here, "..", "..", "..", "..");

let records: IRRecord[] = [];
let frontends: string[] = [];

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  cpSync(join(here, "fixtures", "cmake-sample"), project, { recursive: true });
  const report = await runIndex({
    projectPath: project,
    builtinRoot: repoRoot,
    userPluginDir: join(SCRATCH, "no-user-plugins"),
  });
  frontends = report.frontends.map((f) => f.id);
  records = readSnapshot(projectPaths(project), report.snapshot);
});

afterAll(() => {
  // Remove only this suite's scratch, since the other core suites run in parallel workers.
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("frontend-cmake through the loader", () => {
  it("runs as a built-in plugin on the sample project", () => {
    expect(frontends).toContain("frontend-cmake");
  });

  it("reads targets from CMakeLists.txt, including one in a subdirectory", () => {
    const targets = records.flatMap((r) => ("node" in r && r.node.kind === "packaging.build-target" ? [r.node] : []));
    expect(targets.map((n) => n.id).sort()).toEqual(["cmake://:app", "cmake://lib:shapes"]);
    expect(targets.find((n) => n.id === "cmake://lib:shapes")?.span?.file).toBe("lib/CMakeLists.txt");
  });

  it("records target sources, the link between targets, and a link it cannot resolve", () => {
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const contains = edges.filter((e) => e.kind === "packaging.target-contains" && e.from === "cmake://lib:shapes").map((e) => e.to).sort();
    expect(contains).toEqual(["lib/include/shapes/area.h", "lib/src/shapes.cc", "lib/src/shapes_internal.h"]);
    expect(edges).toContainEqual(expect.objectContaining({ kind: "packaging.dep-edge", from: "cmake://:app", to: "cmake://lib:shapes" }));
    expect(edges).toContainEqual(
      expect.objectContaining({
        kind: "packaging.dep-edge",
        from: "cmake://:app",
        to: { unresolved: { scheme: "cmake.target", text: "Threads::Threads" } },
      }),
    );
  });

  it("links the include in app/main.cc to the header the library exposes", () => {
    const edges = records.flatMap((r) => ("edge" in r ? [r.edge] : []));
    const include = edges.find((e) => e.kind === "packaging.include" && e.from === "app/main.cc" && e.attrs?.text === "shapes/area.h");
    expect(include?.to).toBe("lib/include/shapes/area.h");
  });
});

describe("frontend-cmake resolver", () => {
  it("does not expose a PRIVATE include directory to the executable that links the library", async () => {
    const resolver = (await import("../../../frontend/cmake/resolve.js")).default as {
      resolve(ref: { scheme: string; text: string }, ctx: unknown): Promise<unknown>;
    };
    const ctx = {
      root: { path: project, name: "cmake-sample", allowBuildTools: false },
      fromFile: "app/main.cc",
      hasFile: (p: string) => ["lib/src/shapes_internal.h", "lib/include/shapes/area.h"].includes(p),
      hasNode: () => true,
      listFiles: () => ["CMakeLists.txt", "app/main.cc", "lib/CMakeLists.txt", "lib/include/shapes/area.h", "lib/src/shapes.cc", "lib/src/shapes_internal.h"],
    };
    expect(await resolver.resolve({ scheme: "cpp.include", text: "shapes_internal.h" }, ctx)).toBeNull();
    expect(await resolver.resolve({ scheme: "cpp.include", text: "shapes/area.h" }, ctx)).toEqual({
      targets: ["lib/include/shapes/area.h"],
      confidence: "inferred",
      note: "via CMake include directories",
    });
  });
});

// Macros and functions are read from the parser directly: each case is a small CMakeLists.txt at the root.
describe("frontend-cmake macros and functions", () => {
  const targetsOf = (text: string, files: string[] = []) =>
    buildCmakeModel(new Map([["CMakeLists.txt", text]]), ["CMakeLists.txt", ...files]).targets;

  it("runs a macro body at each call, with its parameter bound", () => {
    const targets = targetsOf(
      [
        "macro(compile_test name)",
        '  add_executable(${name} "${name}.cc")',
        "  target_link_libraries(${name} benchmark::benchmark)",
        "endmacro(compile_test)",
        "compile_test(alpha)",
        "compile_test(beta)",
      ].join("\n"),
      ["alpha.cc", "beta.cc"],
    );
    expect([...targets.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(targets.get("alpha")).toMatchObject({ id: "cmake://:alpha", kind: "add_executable", sources: ["alpha.cc"] });
    expect(targets.get("beta")?.links).toEqual([{ name: "benchmark::benchmark", propagates: true }]);
  });

  it("matches a call to a macro or function regardless of case", () => {
    const targets = targetsOf(["function(MakeLib name)", "  add_library(${name} ${name}.cc)", "endfunction()", "MAKELIB(core)", "makelib(util)"].join("\n"), [
      "core.cc",
      "util.cc",
    ]);
    expect([...targets.keys()].sort()).toEqual(["core", "util"]);
    expect(targets.get("util")?.sources).toEqual(["util.cc"]);
  });

  it("runs a macro called from inside another macro", () => {
    const targets = targetsOf(
      [
        "macro(inner name)",
        "  add_library(${name} STATIC ${name}.cpp)",
        "endmacro()",
        "macro(outer name)",
        "  inner(${name}_lib)",
        "  target_link_libraries(${name}_lib PUBLIC ${name}_dep)",
        "endmacro()",
        "outer(net)",
        "FetchContent_Declare(net_dep GIT_REPOSITORY https://example.com/net.git)",
      ].join("\n"),
      ["net_lib.cpp"],
    );
    expect(targets.get("net_lib")?.sources).toEqual(["net_lib.cpp"]);
    expect(targets.get("net_lib")?.links).toEqual([{ name: "net_dep", propagates: true }]);
  });

  it("keeps a function's variable sets to itself, and lets a macro's reach the caller", () => {
    const targets = targetsOf(
      [
        "set(dir_var one)",
        "function(make_lib name)",
        "  set(dir_var two)",
        "  add_library(${name} ${dir_var}.cc)",
        "endfunction()",
        "make_lib(fnlib)",
        "add_library(after ${dir_var}.cc)",
        "macro(set_mode)",
        "  set(mode_var macro_value)",
        "endmacro()",
        "set_mode()",
        "add_library(leak ${mode_var}.cc)",
      ].join("\n"),
      ["two.cc", "one.cc", "macro_value.cc"],
    );
    expect(targets.get("fnlib")?.sources).toEqual(["two.cc"]);
    expect(targets.get("after")?.sources).toEqual(["one.cc"]);
    expect(targets.get("leak")?.sources).toEqual(["macro_value.cc"]);
  });

  it("binds ARGN to the arguments after the named parameters", () => {
    const targets = targetsOf(["function(add_all name)", "  add_executable(${name} ${ARGN})", "endfunction()", "add_all(tool a.cc b.cc)"].join("\n"), [
      "a.cc",
      "b.cc",
    ]);
    expect(targets.get("tool")?.sources).toEqual(["a.cc", "b.cc"]);
  });

  it("binds ARGV, ARGV0 and ARGC to every argument of the call", () => {
    const targets = targetsOf(
      ["function(by_argv)", "  add_library(${ARGV0} ${ARGV1}.cc ${ARGV2}.cc)", "  set(count ${ARGC})", "endfunction()", "by_argv(packed x y)"].join("\n"),
      ["x.cc", "y.cc"],
    );
    expect([...targets.keys()]).toEqual(["packed"]);
    expect(targets.get("packed")?.sources).toEqual(["x.cc", "y.cc"]);
  });

  it("stops a recursive macro at the depth limit", () => {
    // Each level declares one more target name. The limit is 16 nested calls, so 16 targets, not an endless loop.
    const targets = targetsOf(["macro(chain n)", "  add_library(${n} ${n}.cc)", "  chain(${n}x)", "endmacro()", "chain(a)"].join("\n"), []);
    expect(targets.size).toBe(16);
    expect(targets.has("a")).toBe(true);
    expect(targets.has(`a${"x".repeat(15)}`)).toBe(true);
    expect(targets.has(`a${"x".repeat(16)}`)).toBe(false);
  });

  it("returns from a macro body at return() and reads the rest of the file", () => {
    const targets = targetsOf(["macro(early)", "  add_library(first first.cc)", "  return()", "  add_library(never never.cc)", "endmacro()", "early()", "add_library(last last.cc)"].join("\n"), [
      "first.cc",
      "last.cc",
    ]);
    expect([...targets.keys()].sort()).toEqual(["first", "last"]);
  });
});

describe("frontend-cmake header ownership and system libraries", () => {
  /** The model for one top-level CMakeLists.txt (plus any extra files) over the given file list. */
  const modelOf = (text: string, files: string[], extra: Record<string, string> = {}) =>
    buildCmakeModel(new Map([["CMakeLists.txt", text], ...Object.entries(extra)]), ["CMakeLists.txt", ...Object.keys(extra), ...files]);

  const benchmarkLike = `
project(bm CXX)
add_library(benchmark src/a.cc)
target_include_directories(benchmark PUBLIC
  $<BUILD_INTERFACE:\${PROJECT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>)
target_include_directories(benchmark PRIVATE \${BUILD_ONLY_DIR}/gen)
`;
  const benchmarkFiles = ["src/a.cc", "include/benchmark/benchmark.h", "include/benchmark/benchmark_api.h", "include/benchmark/notes.txt"];

  it("owns every header under a PUBLIC BUILD_INTERFACE include directory, and no other header", () => {
    const t = modelOf(benchmarkLike, benchmarkFiles).targets.get("benchmark");
    expect(t?.headers.sort()).toEqual(["include/benchmark/benchmark.h", "include/benchmark/benchmark_api.h"]);
  });

  it("does not own headers through the project root or a skipped unknown-variable item", () => {
    const t = modelOf('add_library(lib a.cc)\ntarget_include_directories(lib PUBLIC ${PROJECT_SOURCE_DIR})\n', ["a.h", "x/y.h"]).targets.get("lib");
    expect(t?.headers).toEqual([]);
  });

  it("keeps a header the target already lists as a source out of its owned headers", () => {
    const t = modelOf(
      "add_library(lib include/x.h include/y.cc)\ntarget_include_directories(lib PUBLIC include)\n",
      ["include/x.h", "include/y.cc"],
    ).targets.get("lib");
    expect(t?.headers).toEqual([]);
  });

  it("resolves the include directory of benchmark/benchmark.h back to its header", () => {
    const model = modelOf(benchmarkLike, benchmarkFiles);
    expect(model.targets.get("benchmark")?.publicDirs).toEqual(["include"]);
  });

  it("drops a bare unknown library with no FetchContent or ExternalProject (a system library)", () => {
    const t = modelOf("add_library(a a.cc)\ntarget_link_libraries(a PRIVATE kstat fancylib)\n", ["a.cc"]).targets.get("a");
    expect(t?.links).toEqual([]);
  });

  it("keeps a bare unknown library unresolved when the project declares FetchContent", () => {
    const t = modelOf(
      'add_library(a a.cc)\ntarget_link_libraries(a PRIVATE fancylib)\nFetchContent_Declare(other GIT_REPOSITORY https://x)\n',
      ["a.cc"],
    ).targets.get("a");
    expect(t?.links.map((l) => l.name)).toEqual(["fancylib"]);
  });

  it("keeps a bare unknown library unresolved when a subdirectory is outside the parsed tree", () => {
    const t = modelOf(
      "add_library(a a.cc)\ntarget_link_libraries(a PRIVATE fancylib)\nadd_subdirectory(\${GOOGLETEST_SOURCE_DIR} build EXCLUDE_FROM_ALL)\n",
      ["a.cc"],
    ).targets.get("a");
    expect(t?.links.map((l) => l.name)).toEqual(["fancylib"]);
  });

  it("keeps a bare name declared as an ALIAS of an external, since the project declares it", () => {
    const model = modelOf(
      "find_package(GTest)\nadd_library(gmock_main ALIAS GTest::gmock_main)\nadd_library(t t.cc)\ntarget_link_libraries(t PRIVATE gmock_main)\n",
      ["t.cc"],
    );
    expect(model.targets.get("t")?.links.map((l) => l.name)).toEqual(["gmock_main"]);
  });

  it("keeps a bare name that is a declared external or a project target", () => {
    const model = modelOf(
      "find_package(Threads)\nadd_library(core core.cc)\nadd_library(app app.cc)\ntarget_link_libraries(app PRIVATE Threads core)\n",
      ["core.cc", "app.cc"],
    );
    expect(model.targets.get("app")?.links.map((l) => l.name)).toEqual(["Threads", "core"]);
  });
});
