import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRRecord } from "@insight/ir";
import { projectPaths, readSnapshot, runIndex } from "../src/index.js";

// The real frontend-cmake plugin is loaded from plugins/ through the normal loader, so `pnpm -r test`
// covers it. Scratch lives inside this package and is removed after the tests.
const here = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(here, "..", ".insight-test", `cmake-${process.pid}`);
const project = join(SCRATCH, "cmake-sample");
const repoRoot = resolve(here, "..", "..", "..");

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
    expect(contains).toEqual(["lib/include/shapes/area.h", "lib/src/shapes.cc"]);
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
    const resolver = (await import("../../../plugins/frontend-cmake/resolve.js")).default as {
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
