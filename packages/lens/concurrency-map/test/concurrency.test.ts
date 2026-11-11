import { describe, expect, it } from "vitest";
import { irFixtures as fx, type TableView } from "@insight/sdk";
import { lensConcurrencyMap } from "../src/index.js";

const ctx = () => ({ root: { path: "/unused", name: "fixture", allowBuildTools: false }, resultOf: () => undefined });

function fixture() {
  const span = (line: number) => fx.span("src/a.ts", line, 0, line + 3, 1);
  return fx.view({
    nodes: [
      fx.node("src/a.ts", "structure", "structure.file"),
      fx.node("src/a.ts#start", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "start", async: true }, span: span(0) }),
      fx.node("src/a.ts#run", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "run", async: false }, span: span(10) }),
      fx.node("src/a.ts#worker", "structure", "structure.function", { parent: "src/a.ts", attrs: { name: "worker", async: true }, span: span(20) }),
      fx.node("async:src/a.ts#start", "concurrency", "concurrency.async-task", { parent: "src/a.ts#start" }),
      fx.node("src/a.ts@await:1:2", "concurrency", "concurrency.await", { parent: "src/a.ts#start" }),
      fx.node("src/a.ts@await:2:2", "concurrency", "concurrency.await", { parent: "src/a.ts#start" }),
      fx.node("src/a.ts@spawn:11:2", "concurrency", "concurrency.spawn-thread", { parent: "src/a.ts#run" }),
      fx.node("src/a.ts@send:21:2", "concurrency", "concurrency.channel-send", { parent: "src/a.ts#worker" }),
    ],
  });
}

const concurrencyTable = (views: { type: string }[]) => views.find((v): v is TableView => v.type === "table") as TableView;

describe("lensConcurrencyMap", () => {
  it("counts tasks, awaits, spawns and channel operations per function", async () => {
    const result = await lensConcurrencyMap.run(fixture(), ctx());
    expect(concurrencyTable(result.views).rows).toEqual([
      ["run", "no", 0, 0, 1, 0, "src/a.ts:11"],
      ["start", "yes", 1, 2, 0, 0, "src/a.ts:1"],
      ["worker", "yes", 0, 0, 0, 1, "src/a.ts:21"],
    ]);
    expect(result.metrics).toMatchObject({ asyncFunctions: 2, awaits: 2, spawns: 1, channelOps: 1, asyncWithoutAwait: 1 });
  });

  it("flags async functions that never await", async () => {
    const result = await lensConcurrencyMap.run(fixture(), ctx());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "async-no-await:src/a.ts#worker", severity: "info", nodes: ["src/a.ts#worker"] });
  });
});

/**
 * The scope "src" cut from a project. run (in scope) spawns a thread and calls fetchAll, which is outside the scope.
 * fetchAll is async and awaits, but its stub and its await are outside, so neither is this scope's.
 */
function scopedFixture() {
  const file = "src/a.ts";
  return fx.view({
    nodes: [
      fx.node(file, "structure", "structure.file"),
      fx.node(`${file}#run`, "structure", "structure.function", { parent: file, attrs: { name: "run", async: false }, span: fx.span(file, 0, 0, 5, 1) }),
      fx.node("lib/y.ts#fetchAll", "structure", "structure.function", { attrs: { name: "fetchAll", async: true, external: true } }),
      fx.node(`${file}@spawn:3:2`, "concurrency", "concurrency.spawn-thread", { parent: `${file}#run` }),
      fx.node("lib/y.ts@await:4:2", "concurrency", "concurrency.await", { parent: "lib/y.ts#fetchAll", attrs: { external: true } }),
    ],
    edges: [fx.edge(`${file}#run`, "lib/y.ts#fetchAll", "calls", "calls.call")],
  });
}

describe("lensConcurrencyMap in a partial scope", () => {
  it("lists only local functions and counts only their concurrency", async () => {
    const result = await lensConcurrencyMap.run(scopedFixture(), { ...ctx(), scope: "src" });
    expect(concurrencyTable(result.views).rows).toEqual([["run", "no", 0, 0, 1, 0, "src/a.ts:1"]]);
    expect(result.metrics).toMatchObject({ asyncFunctions: 0, awaits: 0, spawns: 1, asyncWithoutAwait: 0 });
    expect(result.findings).toEqual([]);
  });
});
