import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolveContext } from "@insight/sdk";
import bazelResolver from "../../../frontend/bazel/dist/resolve.js";
import cmakeResolver from "../../../frontend/cmake/resolve.js";

// The Bazel and CMake resolvers read their build model once per link run when the run has a runCache, and read it
// again on every call when it has none. The counter is the number of listFiles calls: a model load lists the files.
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "insight-run-cache-"));
  mkdirSync(join(scratch, "bazel", "lib"), { recursive: true });
  writeFileSync(join(scratch, "bazel", "lib", "BUILD"), 'cc_library(name = "core", srcs = ["core.cc"], hdrs = ["core.h"])\n');
  mkdirSync(join(scratch, "cmake", "lib", "include", "shapes"), { recursive: true });
  writeFileSync(
    join(scratch, "cmake", "lib", "CMakeLists.txt"),
    "add_library(shapes STATIC src/shapes.cc include/shapes/area.h)\ntarget_include_directories(shapes PUBLIC include)\n",
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A context over a fixed file list whose listFiles calls are counted. */
function countingCtx(root: string, files: string[], fromFile: string, runCache?: Map<string, unknown>) {
  const counter = { listFiles: 0 };
  const set = new Set(files);
  const ctx: ResolveContext = {
    root: { path: root, name: "fixture", allowBuildTools: false } as ResolveContext["root"],
    fromFile,
    hasFile: (p) => set.has(p),
    hasNode: () => true,
    listFiles: () => {
      counter.listFiles++;
      return files;
    },
    ...(runCache !== undefined ? { runCache } : {}),
  };
  return { ctx, counter };
}

describe("Bazel resolver runCache", () => {
  const root = (): string => join(scratch, "bazel");
  const files = ["lib/BUILD", "lib/core.cc", "lib/core.h"];
  const ref = { scheme: "cpp.include", text: "lib/core.h" };

  it("loads the model once per link run and shares it between resolves", async () => {
    const runCache = new Map<string, unknown>();
    const first = countingCtx(root(), files, "lib/core.cc", runCache);
    const a = await bazelResolver.resolve(ref, first.ctx);
    expect(a?.targets).toEqual(["lib/core.h"]);
    expect(first.counter.listFiles).toBeGreaterThan(0);
    expect(runCache.has("frontend-bazel:model")).toBe(true);

    const second = countingCtx(root(), files, "lib/core.cc", runCache);
    const b = await bazelResolver.resolve(ref, second.ctx);
    expect(b).toEqual(a);
    expect(second.counter.listFiles).toBe(0);
  });

  it("reads the model on every call when the context has no runCache", async () => {
    const one = countingCtx(root(), files, "lib/core.cc");
    await bazelResolver.resolve(ref, one.ctx);
    const two = countingCtx(root(), files, "lib/core.cc");
    await bazelResolver.resolve(ref, two.ctx);
    expect(two.counter.listFiles).toBeGreaterThan(0);
  });
});

describe("CMake resolver runCache", () => {
  const root = (): string => join(scratch, "cmake");
  const files = ["lib/CMakeLists.txt", "lib/src/shapes.cc", "lib/include/shapes/area.h"];
  const ref = { scheme: "cpp.include", text: "shapes/area.h" };

  it("loads the model once per link run and shares it between resolves", async () => {
    const runCache = new Map<string, unknown>();
    const first = countingCtx(root(), files, "lib/src/shapes.cc", runCache);
    const a = await cmakeResolver.resolve(ref, first.ctx);
    expect(a?.targets).toEqual(["lib/include/shapes/area.h"]);
    expect(first.counter.listFiles).toBeGreaterThan(0);
    expect(runCache.has("frontend-cmake:model")).toBe(true);

    const second = countingCtx(root(), files, "lib/src/shapes.cc", runCache);
    const b = await cmakeResolver.resolve(ref, second.ctx);
    expect(b).toEqual(a);
    expect(second.counter.listFiles).toBe(0);
  });

  it("reads the model on every call when the context has no runCache", async () => {
    const one = countingCtx(root(), files, "lib/src/shapes.cc");
    await cmakeResolver.resolve(ref, one.ctx);
    const two = countingCtx(root(), files, "lib/src/shapes.cc");
    await cmakeResolver.resolve(ref, two.ctx);
    expect(two.counter.listFiles).toBeGreaterThan(0);
  });
});
