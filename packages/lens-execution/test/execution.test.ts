import { describe, expect, it } from "vitest";
import { irFixtures as fx, type TableView, type TreeView } from "@insight/sdk";
import { lensExecution } from "../src/index.js";

const ctx = () => ({ root: { path: "/unused", name: "fixture", allowBuildTools: false }, resultOf: () => undefined });
const span = (file: string, line: number) => fx.span(file, line, 0, line + 2, 1);

function fixture() {
  return fx.view({
    nodes: [
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
    ],
  });
}

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
});
