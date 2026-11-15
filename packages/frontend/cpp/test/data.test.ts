import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "data-cpp");
const files = ["src/a.h", "src/a.cc", "src/b.cc"];
const root: ProjectRoot = { path: fixtureRoot, name: "data-cpp", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch["records"]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records);
}

const nodes = (records: Awaited<ReturnType<typeof extractAll>>): IRNode[] => records.flatMap((r) => ("node" in r && r.node.facet === "data" ? [r.node] : []));
const edges = (records: Awaited<ReturnType<typeof extractAll>>): IREdge[] => records.flatMap((r) => ("edge" in r && r.edge.facet === "data" ? [r.edge] : []));
const allNodes = (records: Awaited<ReturnType<typeof extractAll>>): IRNode[] => records.flatMap((r) => ("node" in r ? [r.node] : []));

describe("frontend-cpp data facts", () => {
  it("a: a file-static counter written with ++ and read elsewhere", async () => {
    const r = await extractAll();
    const v = "src/a.cc#var:counter";
    expect(nodes(r).find((n) => n.id === v)).toMatchObject({ kind: "data.variable", parent: "src/a.cc", attrs: { storage: "file-static", exported: false, mutable: true } });
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#bump", to: v, kind: "data.write", attrs: { how: "update" } }));
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#peek", to: v, kind: "data.read" }));
  });

  it("b: a variable in an anonymous namespace is file-static", async () => {
    const r = await extractAll();
    const v = "src/a.cc#var:hidden";
    expect(nodes(r).find((n) => n.id === v)?.attrs).toMatchObject({ storage: "file-static", exported: false });
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#touch", to: v, kind: "data.write", attrs: { how: "assign" } }));
  });

  it("c: a definition in a.cc, extern in a.h, written from b.cc targets the definition", async () => {
    const r = await extractAll();
    const def = "src/a.cc#var:g";
    expect(nodes(r).find((n) => n.id === def)?.attrs).toMatchObject({ storage: "global", exported: true, mutable: true });
    expect(nodes(r).find((n) => n.id === "src/a.h#var:g")?.attrs).toMatchObject({ storage: "extern-decl", exported: true });
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/b.cc#setg", to: def, kind: "data.write", attrs: { how: "assign" } }));
    expect(edges(r).filter((e) => e.to === "src/a.h#var:g")).toEqual([]);
  });

  it("d: a function-local static map mutated by subscript and by insert", async () => {
    const r = await extractAll();
    const cache = "src/a.cc#var:cached::cache";
    const m = "src/a.cc#var:put::m";
    expect(nodes(r).find((n) => n.id === cache)).toMatchObject({ parent: "src/a.cc#cached", attrs: { storage: "function-static", exported: false } });
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#cached", to: cache, kind: "data.write", attrs: { how: "mutate" } }));
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#put", to: m, kind: "data.write", attrs: { how: "mutate" } }));
  });

  it("e: a static data member incremented in a method is class-static", async () => {
    const r = await extractAll();
    const v = "src/a.cc#var:Meter::count";
    expect(nodes(r).find((n) => n.id === v)).toMatchObject({
      parent: "src/a.cc#Meter",
      attrs: { storage: "class-static", qualifiedName: "Meter::count", mutable: true },
    });
    expect(allNodes(r).some((n) => n.id === "src/a.cc#Meter" && n.kind === "structure.type")).toBe(true);
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#Meter::tick", to: v, kind: "data.write", attrs: { how: "update" } }));
  });

  it("f: a constexpr constant is immutable and only read", async () => {
    const r = await extractAll();
    const v = "src/a.cc#var:kMax";
    expect(nodes(r).find((n) => n.id === v)?.attrs).toMatchObject({ mutable: false });
    expect(edges(r).filter((e) => e.to === v && e.kind === "data.write")).toEqual([]);
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#limit", to: v, kind: "data.read" }));
  });

  it("g: a local shadowing a global name produces no edge", async () => {
    const r = await extractAll();
    expect(edges(r).filter((e) => e.from === "src/a.cc#shadowed")).toEqual([]);
  });

  it("h: passing &g to a function is an address write", async () => {
    const r = await extractAll();
    expect(edges(r)).toContainEqual(expect.objectContaining({ from: "src/a.cc#addr", to: "src/a.cc#var:g", kind: "data.write", attrs: { how: "address" }, provenance: { frontend: "frontend-cpp", confidence: "heuristic" } }));
  });
});
