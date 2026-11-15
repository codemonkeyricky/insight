import { beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { couplingChart, couplingFacts, footprintSummary, moduleSurface, type Item } from "../src/index.js";
import { indexFixture } from "./coupling-fixture.js";

// State rows (phase 3 of the coupling view), on an IR built by hand. Two packages: pkgs/a holds the state and its
// functions, pkgs/b calls into it. So a pkgs/a function that pkgs/b calls is on the module surface, and one that only
// pkgs/a calls is not.

type Step = Extract<Item, { t: "step" }>;

const sp = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line, 10] as [number, number] });

const A = "pkgs/a/src/state.ts";
const B = "pkgs/b/src/use.ts";
const G_A = "pkgs/a/src/g.ts";
const G_B = "pkgs/b/src/g.ts";

const fnNode = (file: string, name: string, line: number, exported: boolean): IRNode =>
  fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name, qualifiedName: name, async: false, exported }, span: sp(file, line) });

const varNode = (file: string, name: string, line: number, attrs: Record<string, unknown>): IRNode =>
  fx.node(`${file}#var:${name}`, "data", "data.variable", { parent: file, attrs: { name, qualifiedName: name, exported: false, ...attrs }, span: sp(file, line) });

const fnId = (file: string, name: string) => `${file}#${name}`;
const varId = (file: string, name: string) => `${file}#var:${name}`;

const reads = (from: string, file: string, name: string, line: number): IREdge =>
  fx.edge(from, varId(file, name), "data", "data.read", { attrs: {}, span: sp(file, line) });
const writes = (from: string, file: string, name: string, line: number): IREdge =>
  fx.edge(from, varId(file, name), "data", "data.write", { attrs: { how: "assign" }, span: sp(file, line) });
const calls = (from: string, to: string, callee: string, file: string, line: number): IREdge =>
  fx.edge(from, to, "calls", "calls.call", { attrs: { callee }, span: sp(file, line) });

function project(): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes: IRNode[] = [
    fx.node("pkgs/a/package.json", "structure", "structure.file"),
    fx.node("pkgs/b/package.json", "structure", "structure.file"),
    fx.node("pkgs/a/index.ts", "structure", "structure.file"),
    fx.node(A, "structure", "structure.file"),
    fx.node(B, "structure", "structure.file"),
    fx.node(G_A, "structure", "structure.file"),
    fx.node(G_B, "structure", "structure.file"),
    // pkgs/a/src/state.ts: a file-static counter, an immutable table, a module-private cache, a Map written by put()
    varNode(A, "counter", 1, { storage: "file-static", mutable: true }),
    varNode(A, "LIMIT", 2, { storage: "file-static", mutable: false }),
    varNode(A, "cache", 3, { storage: "module", mutable: true }),
    varNode(A, "CACHE", 4, { storage: "module", mutable: true }),
    varNode(A, "TABLE", 5, { storage: "module", mutable: false }),
    fnNode(A, "bump", 10, false),
    fnNode(A, "peek", 13, false),
    fnNode(A, "threeReads", 17, false),
    fnNode(A, "publish", 23, true),
    fnNode(A, "helper", 27, false),
    fnNode(A, "api", 30, true),
    fnNode(A, "touch", 35, true),
    fnNode(A, "put", 39, false),
    fnNode(A, "lookup", 43, false),
    // pkgs/a/src/g.ts: a global written from pkgs/a, and from pkgs/b too
    varNode(G_A, "g_total", 1, { storage: "global", mutable: true, exported: true }),
    fnNode(G_A, "bumpGlobal", 3, true),
    fnNode(G_B, "bumpOther", 2, true),
    // pkgs/b/src/use.ts: calls into pkgs/a
    fnNode(B, "useA", 2, true),
    fnNode(B, "apiCaller", 6, true),
    fnNode(B, "touchCaller", 10, true),
    fnNode(B, "outsideCaller", 14, true),
    fx.node("pkgs/a/index.ts#entry", "structure", "structure.function", { parent: "pkgs/a/index.ts", attrs: { name: "entry", qualifiedName: "entry", async: false, exported: true }, span: sp("pkgs/a/index.ts", 1) }),
  ];
  const edges: IREdge[] = [
    writes(fnId(A, "bump"), A, "counter", 11),
    reads(fnId(A, "peek"), A, "counter", 14),
    reads(fnId(A, "peek"), A, "LIMIT", 15),
    reads(fnId(A, "threeReads"), A, "counter", 18),
    reads(fnId(A, "threeReads"), A, "counter", 19),
    reads(fnId(A, "threeReads"), A, "counter", 20),
    // publish writes the counter and is called from pkgs/b: on the surface
    writes(fnId(A, "publish"), A, "counter", 24),
    calls(fnId(B, "useA"), fnId(A, "publish"), "publish", B, 3),
    // helper writes the counter; api (on the surface) calls it
    writes(fnId(A, "helper"), A, "counter", 28),
    calls(fnId(A, "api"), fnId(A, "helper"), "helper", A, 31),
    calls(fnId(B, "apiCaller"), fnId(A, "api"), "api", B, 7),
    // touch writes a module-private let and is called from pkgs/b
    writes(fnId(A, "touch"), A, "cache", 36),
    calls(fnId(B, "touchCaller"), fnId(A, "touch"), "touch", B, 11),
    // put mutates a top-level Map; lookup reads an immutable table
    fx.edge(fnId(A, "put"), varId(A, "CACHE"), "data", "data.write", { attrs: { how: "mutate" }, span: sp(A, 40) }),
    reads(fnId(A, "lookup"), A, "TABLE", 44),
    // the global is written from both packages
    writes(fnId(G_A, "bumpGlobal"), G_A, "g_total", 4),
    writes(fnId(G_B, "bumpOther"), G_A, "g_total", 3),
    // an outside caller in pkgs/b reaches a pkgs/a function that does not write state
    calls(fnId(B, "outsideCaller"), "pkgs/a/index.ts#entry", "entry", B, 15),
  ];
  return { nodes, edges };
}

const ix = couplingFacts(project().nodes, project().edges);
const { nodes, edges } = project();
const surface = moduleSurface(nodes, edges, ix.modules);

/** Every row of a list, including rows inside forks and loops. Fold rows are included. */
function rowsOf(items: readonly Item[], out: Step[] = []): Step[] {
  for (const item of items) {
    if (item.t === "step") out.push(item);
    else if (item.t === "fork") for (const a of item.arms) rowsOf(a.body, out);
    else if (item.t === "loop") rowsOf(item.body, out);
  }
  return out;
}

const stateRows = (items: readonly Item[]) => rowsOf(items).filter((r) => r.role === "state");
const factItems = (id: string): Item[] => {
  const f = ix.facts.get(id);
  if (f === undefined) throw new Error(`no function ${id}`);
  return f.items;
};
const chart = (id: string) => couplingChart(id, factItems(id), ix.modules, ix.footprints, ix.surface);
const keptRows = (items: Item[]) => rowsOf(items).filter((r) => r.foldId === undefined);

describe("state rows from the data facet", () => {
  it("(a) a write and a read of a mutable file-static give arrow rows; an immutable constant gives none", () => {
    const bump = stateRows(factItems(fnId(A, "bump")));
    expect(bump.map((r) => r.label)).toEqual(["▲ counter"]);
    expect(bump[0]?.write).toBeUndefined();
    const peek = stateRows(factItems(fnId(A, "peek")));
    expect(peek.map((r) => r.label)).toEqual(["▽ counter"]);
    expect(peek.some((r) => r.label.includes("LIMIT"))).toBe(false);
    expect(bump[0]?.kind).toBe("data.write");
    expect(bump[0]?.target).toBe(varId(A, "counter"));
  });

  it("(b) three consecutive reads of one variable merge into one row", () => {
    const rows = stateRows(factItems(fnId(A, "threeReads")));
    expect(rows.map((r) => r.label)).toEqual(["▽ counter"]);
  });

  it("(c) a surface function writing a file-static is kept, marked ◆, and classed state", () => {
    const { items, info } = chart(fnId(A, "publish"));
    const row = keptRows(items).find((r) => r.role === "state");
    expect(row).toMatchObject({ t: "step", role: "state", coupling: "state", hidden: true, write: true });
    expect(row?.t === "step" && row.label).toBe("◆ ▲ counter");
    expect(info.footprint.state).toEqual({ writes: 1, reads: 0, hidden: true });
  });

  it("(d) an internal function writing the same state is folded, and its surface caller hoists ◆ with the summary state 1w 0r", () => {
    const helper = chart(fnId(A, "helper"));
    expect(helper.items.every((i) => i.t === "step" && i.foldId !== undefined)).toBe(true);
    const api = chart(fnId(A, "api"));
    const callRow = keptRows(api.items).find((r) => r.role === "call");
    expect(callRow).toMatchObject({ coupling: "state" });
    expect(callRow?.hoisted).toContain("◆");
    expect(api.info.summary).toBe("state 1w 0r · ◆");
  });

  it("(e) an extern global written from two modules is kept as global, and its title lists the other module", () => {
    const { items } = chart(fnId(G_A, "bumpGlobal"));
    const row = keptRows(items).find((r) => r.role === "state");
    expect(row).toMatchObject({ coupling: "state", global: true, write: true });
    expect(row?.t === "step" && row.title).toContain("pkgs/b");
    expect(row?.t === "step" && row.hidden).toBeUndefined();
  });

  it("(f) a non-exported module let written from a surface function is hidden", () => {
    expect(surface.has(fnId(A, "touch"))).toBe(true);
    const { items } = chart(fnId(A, "touch"));
    const row = keptRows(items).find((r) => r.role === "state");
    expect(row).toMatchObject({ coupling: "state", hidden: true, write: true });
    expect(row?.t === "step" && row.label).toBe("◆ ▲ cache");
  });

  it("(g) a mutated top-level Map gives a state row; a never-written constant table gives none", () => {
    const put = stateRows(factItems(fnId(A, "put")));
    expect(put.map((r) => r.label)).toEqual(["▲ CACHE"]);
    expect(stateRows(factItems(fnId(A, "lookup")))).toEqual([]);
  });

  it("(h) the footprint summary lists state counts and ◆, in order", () => {
    const fp = { entries: [], modules: ["pkgs/b"], escape: false, state: { writes: 1, reads: 2, hidden: true } };
    expect(footprintSummary(fp)).toBe("⇄ 1 module · state 1w 2r · ◆");
    expect(footprintSummary({ ...fp, escape: true })).toBe("⇄ 1 module · state 1w 2r · ◆ · throws ↑");
    expect(footprintSummary({ entries: [], modules: [], escape: false, state: { writes: 0, reads: 1, hidden: false } })).toBe("state 0w 1r");
  });

  it("the module surface holds the functions another module calls and the exported functions of a package entry", () => {
    expect(surface.has(fnId(A, "publish"))).toBe(true);
    expect(surface.has(fnId(A, "api"))).toBe(true);
    expect(surface.has(fnId(A, "helper"))).toBe(false);
    // exported alone is not enough: bump is exported nowhere and not called across modules
    expect(surface.has(fnId(A, "bump"))).toBe(false);
    expect(surface.has("pkgs/a/index.ts#entry")).toBe(true);
  });
});

// Const containers, built from the TypeScript frontend's real output (no hand-written attributes).
describe("const containers from real frontend output", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "pkgs/a/package.json": JSON.stringify({ name: "a" }),
    "pkgs/a/src/tables.ts": `const TABLE = { a: 1, b: 2 };
const cache = new Map<string, number>();
export function lookup(k: string): number {
  return TABLE.a + (cache.get(k) ?? 0);
}
export function remember(k: string): void {
  cache.set(k, 1);
}
export function callsLookup(): number {
  return lookup("a");
}
export function readTable(): number {
  return TABLE.b;
}
`,
  };
  const T = "pkgs/a/src/tables.ts";
  let real: Awaited<ReturnType<typeof realIndex>>;
  async function realIndex() {
    const { nodes, edges } = await indexFixture(FILES);
    return { nodes, edges, ...couplingFacts(nodes, edges) };
  }
  beforeAll(async () => {
    real = await realIndex();
  });

  it("a never-written const table gives no state row, and its function hoists nothing", () => {
    const items = real.facts.get(`${T}#readTable`)?.items ?? [];
    expect(stateRows(items)).toEqual([]);
    expect(real.footprints.get(`${T}#readTable`)?.entries.filter((e) => e.cls === "state")).toEqual([]);
    expect(real.state.get(`${T}#var:TABLE`)).toMatchObject({ mutable: false, writers: [] });
  });

  it("reading the written cache from a helper shows one row, and no row for the table", () => {
    expect(stateRows(real.facts.get(`${T}#lookup`)?.items ?? []).map((r) => r.label)).toEqual(["▽ cache"]);
  });

  it("a const Map that a method writes gives one state row", () => {
    const rows = stateRows(real.facts.get(`${T}#remember`)?.items ?? []);
    expect(rows.map((r) => r.label)).toEqual(["▲ cache"]);
    expect(rows[0]?.write).toBeUndefined();
  });
});


// A data write nested inside a sync atomic op (`g++` on a std::atomic global): the write's row is drawn before the op's row.
describe("state rows nested in sync ops", () => {
  const SF = "src/atomic.cc";
  const FN = `${SF}#app::bump`;
  const syncSpan = { file: SF, start: [4, 0] as [number, number], end: [4, 10] as [number, number] };
  const nodes: IRNode[] = [
    fx.node(SF, "structure", "structure.file"),
    fx.node(FN, "structure", "structure.function", {
      parent: SF,
      attrs: { name: "bump", qualifiedName: "app::bump", async: false, exported: true },
      span: { file: SF, start: [2, 0], end: [6, 1] },
    }),
    varNode(SF, "g", 1, { storage: "global", mutable: true }),
    fx.node(`${SF}@atomic:4:0`, "sync", "sync.atomic-op", {
      parent: FN,
      attrs: { op: "op", api: "std::atomic::operator++", lock: "g" },
      span: syncSpan,
    }),
  ];
  const edges: IREdge[] = [
    fx.edge(FN, varId(SF, "g"), "data", "data.write", { attrs: { how: "mutate" }, span: { file: SF, start: [4, 2] as [number, number], end: [4, 3] as [number, number] } }),
  ];

  it("a data.write nested as a child of a sync atomic op produces a state row, drawn before the op", () => {
    const items = couplingFacts(nodes, edges).facts.get(FN)?.items ?? [];
    expect(stateRows(items).map((r) => r.label)).toEqual(["▲ g"]);
    const labels = items.map((i) => (i.t === "step" ? `${i.role}:${i.label}` : i.t));
    const stateAt = labels.indexOf("state:▲ g");
    const syncAt = items.findIndex((i) => i.t === "step" && i.role === "sync");
    expect(stateAt).toBeGreaterThanOrEqual(0);
    expect(syncAt).toBeGreaterThan(stateAt);
  });
});
