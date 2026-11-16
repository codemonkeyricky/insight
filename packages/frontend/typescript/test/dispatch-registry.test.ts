import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// Calls through a fixed registry of functions: keyed lookups, bound lookups, untyped tables, and named object types.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "dispatch-registry");
const files = ["src/parsers.ts", "src/gates.ts", "src/tasks.ts", "src/untyped.ts", "src/alias.ts", "src/direct.ts"];
const root = { path: fixtureRoot, name: "dispatch-registry", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Extracted {
  nodes: IRNode[];
  edges: IREdge[];
}

async function extract(): Promise<Extracted> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: Extracted = { nodes: [], edges: [] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) out.nodes.push(record.node);
      if ("edge" in record) out.edges.push(record.edge);
    }
  }
  return out;
}

/** The candidate ids an edge names, or its single target. */
function candidatesOf(e: IREdge): string[] {
  const to = e.to;
  if (typeof to === "string") return [to];
  if ("candidates" in to) return [...to.candidates];
  return [`unresolved:${to.unresolved.text}`];
}

/** The calls.call edge a function makes to a callee, by its from id and callee text. */
function callFrom(all: IREdge[], from: string, callee: string): IREdge | undefined {
  return all.find((e) => e.kind === "calls.call" && e.from === from && (e.attrs as { callee?: unknown }).callee === callee);
}

describe("registry dispatch", () => {
  it("names every implementation of a record of interface-typed values, from inline, imported, shorthand and separate literals", async () => {
    const { edges } = await extract();
    const run = callFrom(edges, "src/gates.ts#runGate", "def.parse");
    expect(run?.kind).toBe("calls.call");
    expect(candidatesOf(run as IREdge)).toEqual([
      "src/gates.ts#GATES.inline.parse",
      "src/gates.ts#parse",
      "src/gates.ts#separate.parse",
      "src/parsers.ts#byExit",
    ]);
    expect(run?.attrs).toEqual({ callee: "def.parse", how: "interface", callEnd: [20, 25], reads: ["def"] });
    expect(run?.provenance.confidence).toBe("heuristic");
  });

  it("makes a keyed lookup into a const table, and a const bound to one, a registry edge to every function in it", async () => {
    const { edges } = await extract();
    const keyed = callFrom(edges, "src/tasks.ts#dispatch", "impl[name]");
    expect(candidatesOf(keyed as IREdge)).toEqual(["src/tasks.ts#impl.alpha", "src/tasks.ts#impl.beta"]);
    expect(keyed?.attrs).toEqual({ callee: "impl[name]", how: "registry", callEnd: [12, 22], reads: ["name", "x"], argReads: [["x"]] });
    const bound = callFrom(edges, "src/tasks.ts#viaConst", "run");
    expect(candidatesOf(bound as IREdge)).toEqual(["src/tasks.ts#impl.alpha", "src/tasks.ts#impl.beta"]);
    expect(bound?.attrs).toEqual({ callee: "run", how: "registry", callEnd: [18, 15], reads: ["x"], argReads: [["x"]] });
  });

  it("makes a member call through a keyed lookup into an untyped table a registry edge to that member of each literal", async () => {
    const { edges } = await extract();
    const member = callFrom(edges, "src/untyped.ts#runKey", "T[k].parse");
    expect(candidatesOf(member as IREdge)).toEqual(["src/untyped.ts#T.json.parse", "src/untyped.ts#T.text.parse"]);
    expect(member?.attrs).toEqual({ callee: "T[k].parse", how: "registry", callEnd: [14, 24], reads: ["k", "log"], argReads: [["log"]] });
  });

  it("makes a member call in a loop over Object.values of an untyped table a registry edge to each literal's member", async () => {
    const { edges } = await extract();
    const loop = callFrom(edges, "src/untyped.ts#runAll", "t.parse");
    expect(candidatesOf(loop as IREdge)).toEqual(["src/untyped.ts#T.json.parse", "src/untyped.ts#T.text.parse"]);
    expect(loop?.attrs).toEqual({ callee: "t.parse", how: "registry", callEnd: [20, 53], reads: ["t", "log"], argReads: [["log"]] });
  });

  it("dispatches a call through a receiver typed by a named object type alias like an interface", async () => {
    const { edges } = await extract();
    const use = callFrom(edges, "src/alias.ts#use", "h.handle");
    expect(candidatesOf(use as IREdge)).toEqual(["src/alias.ts#doubler.handle"]);
    expect(use?.attrs).toEqual({ callee: "h.handle", how: "interface", callEnd: [8, 20], reads: ["h"] });
  });
});

describe("registry dispatch never replaces a direct call", () => {
  const direct = (e: IREdge | undefined) => ({ to: e?.to, confidence: e?.provenance.confidence, how: (e?.attrs as { how?: unknown } | undefined)?.how });

  it("keeps the checker's target when a table value is not an object literal, so the candidates would be partial", async () => {
    const { edges } = await extract();
    expect(direct(callFrom(edges, "src/direct.ts#mixed", "MIXED[k].run"))).toEqual({ to: "src/direct.ts#Svc.run", confidence: "exact", how: undefined });
  });

  it("makes a lookup with a literal key a direct call to that entry, bound to a const or not", async () => {
    const { edges } = await extract();
    expect(direct(callFrom(edges, "src/direct.ts#literalKey", 'TABLE["json"].parse'))).toEqual({ to: "src/direct.ts#TABLE.json.parse", confidence: "exact", how: undefined });
    expect(direct(callFrom(edges, "src/direct.ts#literalDirect", 'ops["alpha"]'))).toEqual({ to: "src/direct.ts#ops.alpha", confidence: "exact", how: undefined });
    expect(direct(callFrom(edges, "src/direct.ts#literalBound", "r"))).toEqual({ to: "src/direct.ts#ops.beta", confidence: "exact", how: undefined });
    expect(direct(callFrom(edges, "src/direct.ts#firstFn", "FNS[0]"))).toEqual({ to: "src/direct.ts#one", confidence: "exact", how: undefined });
    expect(callFrom(edges, "src/direct.ts#firstFn", "FNS[0]")?.attrs).toEqual({ callee: "FNS[0]", callEnd: [59, 18], reads: ["x"], argReads: [["x"]] });
  });

  it("keeps a direct call when every key of the table holds the same object", async () => {
    const { edges } = await extract();
    expect(direct(callFrom(edges, "src/direct.ts#same", "SAME[k].alpha"))).toEqual({ to: "src/direct.ts#ops.alpha", confidence: "exact", how: undefined });
  });

  it("keeps only the entries a union key can pick, and every element for a numeric key", async () => {
    const { edges } = await extract();
    expect(candidatesOf(callFrom(edges, "src/direct.ts#twoOf", "THREE[k]") as IREdge)).toEqual(["src/direct.ts#one", "src/direct.ts#two"]);
    expect(candidatesOf(callFrom(edges, "src/direct.ts#anyFn", "FNS[i]") as IREdge)).toEqual(["src/direct.ts#one", "src/direct.ts#two"]);
  });

  it("makes no registry edge for a table with a spread, whose entries are not all known", async () => {
    const { edges } = await extract();
    const e = callFrom(edges, "src/direct.ts#viaSpread", "spread[k]");
    expect((e?.attrs as { how?: unknown } | undefined)?.how).not.toBe("registry");
  });
});
