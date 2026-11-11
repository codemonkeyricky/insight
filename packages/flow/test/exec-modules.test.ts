import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, type ExecModel } from "../src/index.js";
import { PROVENANCE, callEdge, fnNode } from "./synthetic.js";

// A file's module entry: its top-level code, `<file>#(module)`, as the TypeScript frontend emits it.
const moduleNode = (file: string): IRNode => {
  const node = fnNode(file, "(module)", 0);
  return { ...node, attrs: { name: "(module)", module: true } };
};
const MODULE = (file: string) => `${file}#(module)`;

/** An import of `to` by `from`. The frontend marks `import type` as typeOnly and `import()` as dynamic. */
function importEdge(from: string, to: string, opts: { typeOnly?: boolean; dynamic?: boolean } = {}): IREdge {
  return {
    from,
    to,
    facet: "packaging",
    kind: "packaging.import",
    attrs: { specifier: to, typeOnly: opts.typeOnly ?? false, dynamic: opts.dynamic ?? false },
    span: { file: from, start: [0, 0], end: [0, 1] },
    provenance: PROVENANCE,
  };
}

/** A spawn node on `line` of `file`, started by `owner`. */
function spawnNode(file: string, line: number, owner: string): IRNode {
  const id = `${file}@spawn:${line + 1}:2`;
  return {
    id,
    facet: "concurrency",
    kind: "concurrency.spawn-thread",
    parent: owner,
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: {},
    provenance: PROVENANCE,
  };
}
const spawnIdOf = (file: string, line: number) => `${file}@spawn:${line + 1}:2`;

/** The spawns edge of the spawn on `line` of `file`, to a worker's module entry. */
function spawnEdge(file: string, line: number, to: string): IREdge {
  return {
    from: spawnIdOf(file, line),
    to,
    facet: "concurrency",
    kind: "concurrency.spawns",
    attrs: { how: "thread" },
    span: { file, start: [line, 2], end: [line, 8] },
    provenance: PROVENANCE,
  };
}

const threadReached = (m: ExecModel, thread: string): string[] => m.threads.find((t) => t.id === thread)?.reached ?? [];
const runtimeOfFn = (m: ExecModel, id: string): string => m.functions.find((f) => f.id === id)?.runtime ?? "none";

const MAIN = "src/main.ts";
const A = "src/a.ts";
const B = "src/b.ts";

describe("execModel: a thread runs the module entries its files import", () => {
  it("puts an imported file's module entry, and what its top level calls, on the importing thread", () => {
    // main.ts imports a.ts, which imports b.ts. b.ts's top level calls fromB, which nothing else calls.
    const nodes = [moduleNode(MAIN), moduleNode(A), moduleNode(B), fnNode(B, "fromB", 4)];
    const edges = [importEdge(MAIN, A), importEdge(A, B), callEdge(MODULE(B), `${B}#fromB`, B, 1)];
    const model = execModel(nodes, edges, "src");
    expect(model.threads[0]?.roots).toEqual([MODULE(MAIN)]);
    expect(threadReached(model, "main")).toEqual(expect.arrayContaining([MODULE(MAIN), MODULE(A), MODULE(B), `${B}#fromB`]));
    expect(runtimeOfFn(model, MODULE(B))).toBe("thread");
    expect(runtimeOfFn(model, `${B}#fromB`)).toBe("thread");
    expect(model.unthreaded).toEqual([]);
    expect(model.stats).toMatchObject({ functionsInScope: 4, functionsThreaded: 4, functionsUnthreaded: 0 });
  });

  it("puts a module shared by a page thread and a worker on both threads", () => {
    // main.ts imports shared.ts and spawns worker.ts, which also imports shared.ts. Neither imports the other.
    const S = "src/shared.ts";
    const W = "src/worker.ts";
    const nodes = [moduleNode(MAIN), moduleNode(W), moduleNode(S), fnNode(S, "sharedFn", 4), spawnNode(MAIN, 3, MODULE(MAIN))];
    const edges = [
      importEdge(MAIN, S),
      importEdge(W, S),
      spawnEdge(MAIN, 3, MODULE(W)),
      callEdge(MODULE(S), `${S}#sharedFn`, S, 1),
    ];
    const model = execModel(nodes, edges, "src");
    const worker = spawnIdOf(MAIN, 3);
    expect(threadReached(model, "main")).toEqual(expect.arrayContaining([MODULE(S), `${S}#sharedFn`]));
    expect(threadReached(model, worker)).toEqual(expect.arrayContaining([MODULE(S), `${S}#sharedFn`, MODULE(W)]));
    // The worker's own module is the worker's root, not the page's: the page does not import worker.ts.
    expect(threadReached(model, "main")).not.toContain(MODULE(W));
    expect(model.unthreaded).toEqual([]);
  });

  it("terminates on an import cycle, and reaches every module of the cycle", () => {
    // main.ts imports a.ts; a.ts and b.ts import each other.
    const nodes = [moduleNode(MAIN), moduleNode(A), moduleNode(B), fnNode(A, "fromA", 4), fnNode(B, "fromB", 4)];
    const edges = [
      importEdge(MAIN, A),
      importEdge(A, B),
      importEdge(B, A),
      callEdge(MODULE(A), `${A}#fromA`, A, 1),
      callEdge(MODULE(B), `${B}#fromB`, B, 1),
    ];
    const model = execModel(nodes, edges, "src");
    expect(threadReached(model, "main")).toEqual(expect.arrayContaining([MODULE(A), MODULE(B), `${A}#fromA`, `${B}#fromB`]));
    expect(model.unthreaded).toEqual([]);
  });

  it("does not pull in a module that is imported only by a type-only import", () => {
    // main.ts imports a type from types.ts. The import is erased at runtime, so types.ts's top level runs on no thread.
    const T = "src/types.ts";
    const nodes = [moduleNode(MAIN), moduleNode(T), fnNode(T, "typeFn", 4)];
    const edges = [importEdge(MAIN, T, { typeOnly: true }), callEdge(MODULE(T), `${T}#typeFn`, T, 1)];
    const model = execModel(nodes, edges, "src");
    expect(threadReached(model, "main")).toEqual([MODULE(MAIN)]);
    expect(runtimeOfFn(model, MODULE(T))).toBe("none");
    expect(model.unthreaded).toEqual([MODULE(T), `${T}#typeFn`]);
  });

  it("reaches what the top level of an imported file with no module entry references", () => {
    // app.ts has no module entry, since its top level is only an object literal that refers to load(). The reference
    // starts at the file id. main.ts imports app.ts, so that top-level code runs on main's thread, and so does load().
    const APP = "src/app.ts";
    const L = "src/lion.ts";
    const nodes = [moduleNode(MAIN), fnNode(L, "load", 0)];
    const reference: IREdge = {
      from: APP,
      to: `${L}#load`,
      facet: "calls",
      kind: "calls.reference",
      attrs: { how: "value" },
      span: { file: APP, start: [2, 0], end: [2, 1] },
      provenance: PROVENANCE,
    };
    const model = execModel(nodes, [importEdge(MAIN, APP), reference], "src");
    expect(threadReached(model, "main")).toEqual(expect.arrayContaining([MODULE(MAIN), `${L}#load`]));
    expect(runtimeOfFn(model, `${L}#load`)).toBe("thread");
    expect(model.unthreaded).toEqual([]);
  });

  it("does not run the top level of a file no thread loads, so what it calls runs on no thread", () => {
    // s.ts has no module entry, is imported by nothing, and holds no function a thread runs. Its top-level call to f
    // starts nothing: f is no root, and no thread loads s.ts.
    const S = "src/s.ts";
    const nodes = [moduleNode(MAIN), fnNode(S, "f", 4)];
    const edges = [callEdge(S, `${S}#f`, S, 1)];
    const model = execModel(nodes, edges, "src");
    expect(threadReached(model, "main")).toEqual([MODULE(MAIN)]);
    expect(runtimeOfFn(model, `${S}#f`)).toBe("none");
  });

  it("follows a dynamic import, which runs its module when the import is reached", () => {
    const D = "src/lazy.ts";
    const nodes = [moduleNode(MAIN), moduleNode(D), fnNode(D, "lazyFn", 4)];
    const edges = [importEdge(MAIN, D, { dynamic: true }), callEdge(MODULE(D), `${D}#lazyFn`, D, 1)];
    const model = execModel(nodes, edges, "src");
    expect(threadReached(model, "main")).toEqual(expect.arrayContaining([MODULE(D), `${D}#lazyFn`]));
    expect(model.unthreaded).toEqual([]);
  });
});
