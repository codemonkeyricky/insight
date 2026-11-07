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
