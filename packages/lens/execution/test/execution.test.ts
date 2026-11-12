import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type TableView, type TreeView } from "@insight/sdk";
import { lensExecution } from "../src/index.js";

const ctx = () => ({ root: { path: "/unused", name: "fixture", allowBuildTools: false }, resultOf: () => undefined });
const scoped = (scope: string) => ({ ...ctx(), scope });
const span = (file: string, line: number) => fx.span(file, line, 0, line + 2, 1);

function fixtureNodes() {
  return [
    fx.node("src/a.ts", "structure", "structure.file"),
    fx.node("src/b.ts", "structure", "structure.file"),
    fx.node("src/a.ts#serve", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "serve", async: true }, span: span("src/a.ts", 0) }),
    fx.node("src/a.ts#plain", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "plain", async: false }, span: span("src/a.ts", 20) }),
    fx.node("src/b.ts#gitHead", "structure", "structure.function", { parent: "src/b.ts", attrs: { name: "gitHead", async: false }, span: span("src/b.ts", 3) }),
    fx.node("src/b.ts#boot", "structure", "structure.function", { parent: "src/b.ts", attrs: { name: "boot", async: false }, span: span("src/b.ts", 9) }),
    fx.node("src/b.ts#ticks", "structure", "structure.function", { parent: "src/b.ts", attrs: { name: "ticks", async: false }, span: span("src/b.ts", 15) }),
    fx.node("async:src/a.ts#serve", "concurrency", "concurrency.async-task", { parent: "src/a.ts#serve" }),
    fx.node("src/a.ts@await:1:2", "concurrency", "concurrency.await", { parent: "src/a.ts#serve" }),
    fx.node("src/a.ts@await:2:2", "concurrency", "concurrency.await", { parent: "src/a.ts#serve" }),
    fx.node("coroutine:src/b.ts#ticks", "concurrency", "concurrency.coroutine", { parent: "src/b.ts#ticks" }),
    fx.node("src/b.ts@spawn:4:2", "concurrency", "concurrency.spawn-process", {
      parent: "src/b.ts#gitHead",
      attrs: { target: "git", api: "child_process.execFileSync" },
      span: span("src/b.ts", 4),
    }),
    fx.node("src/b.ts@spawn:10:2", "concurrency", "concurrency.spawn-thread", {
      parent: "src/b.ts#boot",
      attrs: { target: "<dynamic>", api: "worker_threads.Worker" },
      span: span("src/b.ts", 10),
    }),
  ];
}

function fixture() {
  return fx.view({ nodes: fixtureNodes() });
}

/** A file with a coroutine, a branch, an await and a read, and a plain function. */
const xNodes = () => [
  fx.node("lib/x.ts", "structure", "structure.file"),
  fx.node("lib/x.ts#load", "structure", "structure.function", { parent: "lib/x.ts", attrs: { name: "load", async: true }, span: span("lib/x.ts", 0) }),
  fx.node("lib/x.ts@branch:1:2", "flow", "flow.branch", { parent: "lib/x.ts#load", span: span("lib/x.ts", 1) }),
  fx.node("lib/x.ts@await:2:2", "concurrency", "concurrency.await", { parent: "lib/x.ts#load", span: span("lib/x.ts", 2) }),
  fx.node("lib/x.ts@read:3:2", "effects", "effects.fs.read", { parent: "lib/x.ts#load", span: span("lib/x.ts", 3) }),
  fx.node("lib/x.ts#pure", "structure", "structure.function", { parent: "lib/x.ts", attrs: { name: "pure" }, span: span("lib/x.ts", 10) }),
];

const yNodes = () => [
  fx.node("lib/y.ts", "structure", "structure.file"),
  fx.node("lib/y.ts#run", "structure", "structure.function", { parent: "lib/y.ts", attrs: { name: "run" }, span: span("lib/y.ts", 0) }),
];

/** A function of another file, cut into the scope as a stub: no span, no parent, marked external. */
const stubFunction = () => fx.node("lib/z.ts#helper", "structure", "structure.function", { attrs: { name: "helper", external: true } });

const tree = (views: { type: string }[]) => views.find((v): v is TreeView => v.type === "tree") as TreeView;
const table = (views: { type: string }[]) => views.find((v): v is TableView => v.type === "table") as TableView;

describe("lensExecution", () => {
  it("draws one process with a main thread, grouped by module", async () => {
    const result = await lensExecution.run(fixture(), ctx());
    const root = tree(result.views).root;
    expect(root).toMatchObject({ label: "Program", kind: "process" });
    const main = root.children?.[0];
    expect(main).toMatchObject({ label: "Main thread", kind: "thread" });
    expect(main?.children?.map((m) => [m.label, m.kind])).toEqual([
      ["src/a.ts", "module"],
      ["src/b.ts", "module"],
    ]);
  });

  it("lists coroutines with their awaits and nests spawns under the function that starts them", async () => {
    const result = await lensExecution.run(fixture(), ctx());
    const [a, b] = tree(result.views).root.children?.[0]?.children ?? [];
    expect(a?.children).toEqual([expect.objectContaining({ label: "serve", kind: "coroutine", detail: "async, 2 awaits" })]);
    expect(b?.children?.map((f) => [f.label, f.kind])).toEqual([
      ["gitHead", "function"],
      ["boot", "function"],
      ["ticks", "coroutine"],
    ]);
    expect(b?.children?.[0]?.children).toEqual([expect.objectContaining({ label: "git", kind: "process", detail: "child_process.execFileSync" })]);
    expect(b?.children?.[1]?.children).toEqual([expect.objectContaining({ label: "<dynamic>", kind: "thread" })]);
    expect(b?.children?.[2]?.detail).toBe("generator, 0 awaits");
  });

  it("tabulates spawn sites, counts them, and flags targets that are not literal", async () => {
    const result = await lensExecution.run(fixture(), ctx());
    expect(table(result.views).rows).toEqual([
      ["child process", "git", "child_process.execFileSync", "gitHead", "src/b.ts:5"],
      ["worker thread", "<dynamic>", "worker_threads.Worker", "boot", "src/b.ts:11"],
    ]);
    expect(result.metrics).toEqual({ processes: 2, threads: 2, coroutines: 2, awaits: 2, spawnSites: 2 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "dynamic-spawn:src/b.ts@spawn:10:2", severity: "info" });
  });

  it("never counts or lists an external stub, even one that starts work", async () => {
    const view = fx.view({
      nodes: [
        ...fixtureNodes(),
        fx.node("lib/far.ts@spawn:1:2", "concurrency", "concurrency.spawn-thread", { attrs: { target: "far", api: "x", external: true } }),
        fx.node("lib/far.ts#farFn", "structure", "structure.function", { attrs: { name: "farFn", async: true, external: true } }),
      ],
    });
    const result = await lensExecution.run(view, ctx());
    expect(result.metrics).toEqual({ processes: 2, threads: 2, coroutines: 2, awaits: 2, spawnSites: 2 });
    const json = JSON.stringify(result.views);
    expect(json).not.toContain('"label":"far"');
    expect(json).not.toContain("farFn");
  });

  it("shows a file's functions under the file when the scope starts no process or thread", async () => {
    const view = fx.view({ nodes: xNodes() });
    const result = await lensExecution.run(view, scoped("lib/x.ts"));
    const t = tree(result.views);
    expect(t.title).toBe("Function tree");
    expect(t.root).toMatchObject({ label: "lib/x.ts", kind: "module", detail: "2 functions" });
    expect(t.root.children?.map((c) => [c.label, c.kind, c.detail])).toEqual([
      ["load", "coroutine", "async, 1 branch, 1 await, 1 effect"],
      ["pure", "function", "no branches, loops or effects"],
    ]);
    expect(result.metrics).toEqual({ functions: 2, coroutines: 1, awaits: 1 });
    expect(result.findings).toEqual([]);
  });

  it("groups a folder's functions by file, and leaves out stubs", async () => {
    const view = fx.view({ nodes: [...xNodes(), ...yNodes(), stubFunction()] });
    const result = await lensExecution.run(view, scoped("lib"));
    const t = tree(result.views);
    expect(t.title).toBe("Function tree");
    expect(t.root).toMatchObject({ label: "lib", kind: "module", detail: "3 functions in 2 files" });
    expect(t.root.children?.map((c) => [c.label, c.kind])).toEqual([
      ["lib/x.ts", "module"],
      ["lib/y.ts", "module"],
    ]);
    expect(t.root.children?.[0]?.children?.map((c) => c.label)).toEqual(["load", "pure"]);
    expect(t.root.children?.[1]?.children?.map((c) => c.label)).toEqual(["run"]);
    expect(result.metrics).toEqual({ functions: 3, coroutines: 1, awaits: 1 });
    expect(JSON.stringify(result.views)).not.toContain("helper");
  });

  it("gives an empty scope an explicit empty state rather than an empty tree", async () => {
    const view = fx.view({ nodes: [fx.node("lib/e.ts", "structure", "structure.file")] });
    const result = await lensExecution.run(view, scoped("lib/e.ts"));
    const t = tree(result.views);
    expect(t.title).toBe("Function tree");
    expect(t.root).toMatchObject({ label: "lib/e.ts", detail: "no functions" });
    expect(t.root.children).toEqual([expect.objectContaining({ label: "Nothing to show", kind: "empty" })]);
    expect(result.metrics).toEqual({ functions: 0, coroutines: 0, awaits: 0 });
    expect(table(result.views).rows).toEqual([]);
  });

  it("labels the project-level pass with the project name when nothing is in scope", async () => {
    const result = await lensExecution.run(fx.view({ nodes: [] }), ctx());
    expect(tree(result.views).root).toMatchObject({ label: "fixture", detail: "no functions" });
    expect(tree(result.views).root.children?.[0]).toMatchObject({ kind: "empty" });
  });
});
