import { describe, expect, it } from "vitest";
import { irFixtures as fx, type TableView } from "@insight/sdk";
import { lensCalls } from "../src/index.js";

const ctx = (config?: unknown) => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config,
  resultOf: () => undefined,
});

/**
 * main (exported) -> helper -> rec1 <-> rec2. helper also calls an unresolved package.
 * orphan is never called. dead is exported and calls nothing.
 */
function fixture() {
  const fn = (name: string, exported: boolean) =>
    fx.node(`src/m.ts#${name}`, "structure", "structure.function", { parent: "src/m.ts", attrs: { name, exported }, span: fx.span("src/m.ts", 0, 0, 0, 1) });
  return fx.view({
    nodes: [
      fx.node("src/m.ts", "structure", "structure.file"),
      fn("main", true),
      fn("helper", false),
      fn("rec1", false),
      fn("rec2", false),
      fn("orphan", false),
      fn("dead", true),
    ],
    edges: [
      fx.edge("src/m.ts#main", "src/m.ts#helper", "calls", "calls.call"),
      fx.edge("src/m.ts#helper", "src/m.ts#rec1", "calls", "calls.call"),
      fx.edge("src/m.ts#rec1", "src/m.ts#rec2", "calls", "calls.call"),
      fx.edge("src/m.ts#rec2", "src/m.ts#rec1", "calls", "calls.call"),
      fx.edge("src/m.ts#helper", { unresolved: { scheme: "ts.import", text: "lodash" } }, "calls", "calls.call"),
    ],
  });
}

const table = (rows: TableView[] | undefined, id: string): TableView => {
  const t = rows?.find((v): v is TableView => v.type === "table" && v.id === id);
  if (!t) throw new Error(`missing table ${id}`);
  return t;
};

describe("lensCalls", () => {
  it("reports functions not reachable from exported entries as info", async () => {
    const result = await lensCalls.run(fixture(), ctx());
    const unreachable = result.findings.map((f) => f.nodes?.[0]).sort();
    expect(unreachable).toEqual(["src/m.ts#orphan"]);
    expect(result.findings[0]?.severity).toBe("info");
  });

  it("counts recursion and unresolved calls", async () => {
    const result = await lensCalls.run(fixture(), ctx());
    expect(result.metrics).toMatchObject({ functions: 6, entries: 2, unresolvedCalls: 1, recursiveGroups: 1, unreachable: 1 });
    expect(table(result.views, "recursion").rows).toEqual([["src/m.ts#rec1 -> src/m.ts#rec2", 2]]);
    expect(table(result.views, "unresolved-calls").rows).toEqual([["src/m.ts#helper", "ts.import", "lodash"]]);
  });

  it("records the status and shortest path for each function", async () => {
    const result = await lensCalls.run(fixture(), ctx());
    const rows = table(result.views, "reachability").rows;
    expect(rows.find((r) => r[0] === "src/m.ts#rec2")).toEqual(["src/m.ts#rec2", "reachable", 3, "src/m.ts#main -> src/m.ts#helper -> src/m.ts#rec1 -> src/m.ts#rec2"]);
    expect(rows.find((r) => r[0] === "src/m.ts#main")?.[1]).toBe("entry");
  });

  it("uses configured entries instead of exported functions, and warns about unknown ones", async () => {
    const result = await lensCalls.run(fixture(), ctx({ entries: ["src/m.ts#orphan", "src/m.ts#nope"] }));
    expect(result.metrics.entries).toBe(1);
    const unreachable = result.findings.filter((f) => f.id.startsWith("unreachable:")).map((f) => f.id).sort();
    expect(unreachable).toEqual(["unreachable:src/m.ts#dead", "unreachable:src/m.ts#helper", "unreachable:src/m.ts#main", "unreachable:src/m.ts#rec1", "unreachable:src/m.ts#rec2"]);
    expect(result.findings.some((f) => f.id === "entry:src/m.ts#nope" && f.severity === "warning")).toBe(true);
  });
});
