import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "data-ts");
const files = ["data/counters.ts", "data/registry.ts", "data/meter.ts", "data/globals.ts", "data/state.ts", "data/writer.ts", "data/deep.ts", "data/globals-2.ts", "data/hoisted.ts"];
const root: ProjectRoot = { path: fixtureRoot, name: "data-ts", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

const records = (batches: IRBatch[]) => batches.flatMap((b) => b.records);
const dataNodes = (batches: IRBatch[]): IRNode[] => records(batches).flatMap((r) => ("node" in r && r.node.facet === "data" ? [r.node] : []));
const dataEdges = (batches: IRBatch[]): IREdge[] => records(batches).flatMap((r) => ("edge" in r && r.edge.facet === "data" ? [r.edge] : []));
const fnId = (batches: IRBatch[], name: string): string => {
  const n = records(batches).flatMap((r) => ("node" in r && r.node.kind === "structure.function" && r.node.attrs?.name === name ? [r.node] : []));
  expect(n).toHaveLength(1);
  return n[0]!.id;
};

describe("frontend-typescript data facts", () => {
  it("a: a module let written with ++ by one function and read by another", async () => {
    const b = await extractAll();
    const hits = "data/counters.ts#var:hits";
    const bump = fnId(b, "bump");
    const show = fnId(b, "show");
    expect(dataNodes(b).find((n) => n.id === hits)).toMatchObject({ kind: "data.variable", attrs: { storage: "module", mutable: true } });
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: bump, to: hits, kind: "data.write", attrs: { how: "update" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: show, to: hits, kind: "data.read" }));
  });

  it("b: a top-level const Map mutated with set is a mutate write on a mutable variable", async () => {
    const b = await extractAll();
    const m = "data/registry.ts#var:m";
    expect(dataNodes(b).find((n) => n.id === m)?.attrs).toMatchObject({ mutable: true });
    const edge = dataEdges(b).find((e) => e.to === m && e.kind === "data.write");
    expect(edge).toMatchObject({ from: fnId(b, "remember"), attrs: { how: "mutate" }, provenance: { confidence: "heuristic" } });
  });

  it("c: a never-written const with as const is immutable and has read edges only", async () => {
    const b = await extractAll();
    const table = "data/registry.ts#var:TABLE";
    expect(dataNodes(b).find((n) => n.id === table)?.attrs).toMatchObject({ mutable: false, exported: true });
    expect(dataEdges(b).filter((e) => e.to === table && e.kind === "data.write")).toEqual([]);
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "lookup"), to: table, kind: "data.read" }));
  });

  it("d: a class static bumped from a method, with parent the class node", async () => {
    const b = await extractAll();
    const n = "data/meter.ts#var:Meter.n";
    const cls = records(b).flatMap((r) => ("node" in r && r.node.kind === "structure.type" && r.node.attrs?.name === "Meter" ? [r.node.id] : []));
    expect(dataNodes(b).find((x) => x.id === n)).toMatchObject({
      kind: "data.variable",
      parent: cls[0],
      attrs: { storage: "class-static", qualifiedName: "Meter.n", mutable: true },
    });
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "tick"), to: n, kind: "data.write", attrs: { how: "update" } }));
    expect(dataNodes(b).find((x) => x.id === "data/meter.ts#var:Meter.LABEL")?.attrs).toMatchObject({ mutable: false });
  });

  it("e: globalThis.flag = true yields a project-wide global node and an assign write", async () => {
    const b = await extractAll();
    const g = "<global>#global:flag";
    expect(dataNodes(b).find((n) => n.id === g)).toMatchObject({ attrs: { storage: "global", qualifiedName: "globalThis.flag", exported: true, mutable: true } });
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "setFlag"), to: g, kind: "data.write", attrs: { how: "assign" } }));
  });

  it("e2: a global written from two files has one id and one set of attrs, and both files' writes target it", async () => {
    const b = await extractAll();
    const g = "<global>#global:flag";
    // Each writing file emits the same node id; the linker keeps the first, so every copy must agree.
    const copies = dataNodes(b).filter((n) => n.id === g);
    expect(copies.length).toBeGreaterThan(1);
    expect(new Set(copies.map((n) => JSON.stringify(n.attrs))).size).toBe(1);
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "castFlag"), to: g, kind: "data.write", attrs: { how: "assign" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "setFlag"), to: g, kind: "data.write" }));
  });

  it("e3: a read of a global that project code writes is a data.read; a host property nobody writes adds nothing", async () => {
    const b = await extractAll();
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "readFlag"), to: "<global>#global:flag", kind: "data.read", attrs: {} }));
    expect(dataEdges(b).filter((e) => e.from === fnId(b, "where"))).toEqual([]);
    expect(dataNodes(b).some((n) => n.id === "<global>#global:location")).toBe(false);
  });

  it("e4: a cast head, (globalThis as T).x = v, is a write of the global", async () => {
    const b = await extractAll();
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "castFlag"), to: "<global>#global:flag", kind: "data.write", attrs: { how: "assign" } }));
  });

  it("e5: a module const bound to a container is marked constBound, and a frozen one is not", async () => {
    const b = await extractAll();
    expect(dataNodes(b).find((n) => n.id === "data/deep.ts#var:state")?.attrs).toMatchObject({ mutable: true, constBound: true });
    expect(dataNodes(b).find((n) => n.id === "data/registry.ts#var:TABLE")?.attrs).not.toHaveProperty("constBound");
  });

  it("e6: a write through a chain of properties or elements writes the root variable", async () => {
    const b = await extractAll();
    const state = "data/deep.ts#var:state";
    const rows = "data/deep.ts#var:rows";
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "putDeep"), to: state, kind: "data.write", attrs: { how: "mutate" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "setDeep"), to: state, kind: "data.write", attrs: { how: "mutate" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "setElem"), to: rows, kind: "data.write", attrs: { how: "mutate" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "neverWritten"), to: state, kind: "data.read" }));
  });

  it("f: a write through a namespace import or a direct import targets the declaring file's variable", async () => {
    const b = await extractAll();
    const counter = "data/state.ts#var:counter";
    const bumpNs = fnId(b, "bumpNs");
    const bumpDirect = fnId(b, "bumpDirect");
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: bumpNs, to: counter, kind: "data.write", attrs: { how: "update" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: bumpDirect, to: counter, kind: "data.write", attrs: { how: "assign" } }));
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: bumpDirect, to: counter, kind: "data.read" }));
    expect(dataEdges(b).filter((e) => e.from === bumpNs || e.from === bumpDirect).every((e) => !String(e.to).startsWith("data/writer.ts"))).toBe(true);
  });

  it("g: a function-local variable shadowing a module variable produces no edge", async () => {
    const b = await extractAll();
    const shadow = fnId(b, "shadow");
    expect(dataEdges(b).filter((e) => e.from === shadow)).toEqual([]);
  });

  it("h: exported is true only for exported variables", async () => {
    const b = await extractAll();
    expect(dataNodes(b).find((n) => n.id === "data/counters.ts#var:hits")?.attrs).toMatchObject({ exported: false });
    expect(dataNodes(b).find((n) => n.id === "data/counters.ts#var:total")?.attrs).toMatchObject({ exported: true });
    expect(dataNodes(b).find((n) => n.id === "data/counters.ts#var:snapshot")?.attrs).toMatchObject({ exported: true });
    expect(dataNodes(b).find((n) => n.id === "data/state.ts#var:counter")?.attrs).toMatchObject({ exported: true });
  });

  it("i: top-level code reading a variable has the module entry as its from, as calls do", async () => {
    const b = await extractAll();
    const moduleEntry = "data/counters.ts#(module)";
    expect(records(b).some((r) => "node" in r && r.node.id === moduleEntry)).toBe(true);
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: moduleEntry, to: "data/counters.ts#var:hits", kind: "data.read" }));
    expect(dataEdges(b).filter((e) => e.from === "data/counters.ts")).toEqual([]);
  });
});

describe("frontend-typescript data facts, const bound to a call result", () => {
  it("d1: a const bound to a call result, written through a property, is mutable state", async () => {
    const b = await extractAll();
    const v = "data/hoisted.ts#var:s";
    expect(dataNodes(b).find((n) => n.id === v)?.attrs).toMatchObject({ constBound: true, mutable: true });
    expect(dataEdges(b)).toContainEqual(expect.objectContaining({ from: fnId(b, "load"), to: v, kind: "data.write", attrs: { how: "mutate" } }));
  });

  it("d2: a const bound to a call result that is only read has no write edges (the flow layer treats it as not state)", async () => {
    const b = await extractAll();
    const v = "data/hoisted.ts#var:r";
    expect(dataNodes(b).find((n) => n.id === v)?.attrs).toMatchObject({ constBound: true, mutable: true });
    expect(dataEdges(b).filter((e) => e.to === v && e.kind === "data.write")).toEqual([]);
  });

  it("d3: a global written through globalThis has no parent", async () => {
    const b = await extractAll();
    const g = dataNodes(b).find((n) => n.id === "<global>#global:flag");
    expect(g).toBeDefined();
    expect(g?.parent).toBeUndefined();
  });
});
