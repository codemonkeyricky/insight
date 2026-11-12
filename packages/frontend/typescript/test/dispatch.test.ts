import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// Object literals bound to a name, and calls through interface-typed and abstract-typed receivers.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "dispatch");
const files = ["src/repo.ts", "src/shapes.ts", "src/wide.ts", "src/props.ts", "src/defaults.ts", "src/use.ts"];
const root = { path: fixtureRoot, name: "dispatch", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Extracted {
  nodes: IRNode[];
  edges: IREdge[];
}

async function extract(indexed: string[] = files): Promise<Extracted> {
  const ctx = { root, files: indexed, listFiles: () => [...indexed], readFile, log: () => undefined };
  const out: Extracted = { nodes: [], edges: [] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) out.nodes.push(record.node);
      if ("edge" in record) out.edges.push(record.edge);
    }
  }
  return out;
}

/** An edge's target as text: the id, or the candidate ids in brackets. */
function targetText(e: IREdge): string {
  const to = e.to;
  if (typeof to === "string") return to;
  if ("candidates" in to) return `[${to.candidates.join(", ")}]`;
  return `unresolved:${to.unresolved.text}`;
}

/** `from -> target` for each edge of one kind, sorted. */
function pairs(all: IREdge[], kind: string): string[] {
  return all
    .filter((e) => e.kind === kind)
    .map((e) => `${e.from} -> ${targetText(e)}`)
    .sort();
}

/** The call edge a function makes to a callee, looked up by its from id and callee text. */
function callFrom(all: IREdge[], from: string, callee: string): IREdge | undefined {
  return all.find((e) => e.kind === "calls.call" && e.from === from && (e.attrs as { callee?: unknown }).callee === callee);
}

describe("object-literal functions bound to a name", () => {
  it("names each function property by its binding, nested and in a class, with the parent its literal sits in", async () => {
    const { nodes } = await extract();
    const named = nodes.filter((n) => n.kind === "structure.function" && /props\.ts#(api|outer|Clicker|make)|defaults\.ts/.test(n.id));
    expect(Object.fromEntries(named.map((n) => [n.id, [n.attrs?.qualifiedName, n.parent, n.attrs?.anonymous]]))).toEqual({
      "src/defaults.ts#default.ping": ["default.ping", "src/defaults.ts", undefined],
      "src/props.ts#Clicker.handlers.onY": ["Clicker.handlers.onY", "src/props.ts#Clicker", undefined],
      "src/props.ts#Clicker.onX": ["Clicker.onX", "src/props.ts#Clicker", undefined],
      "src/props.ts#api.load": ["api.load", "src/props.ts", undefined],
      "src/props.ts#api.save": ["api.save", "src/props.ts", undefined],
      "src/props.ts#make": ["make", "src/props.ts", undefined],
      "src/props.ts#make.local.go": ["make.local.go", "src/props.ts#make", undefined],
      "src/props.ts#outer.inner.deep": ["outer.inner.deep", "src/props.ts", undefined],
    });
  });

  it("gives a named property a span at the property and the frontend's exact provenance, without the anonymous mark", async () => {
    const { nodes } = await extract();
    const load = nodes.find((n) => n.id === "src/props.ts#api.load");
    expect(load?.span?.start).toEqual([2, 2]);
    expect(load?.attrs?.name).toBe("load");
    expect(load?.attrs).not.toHaveProperty("anonymous");
    expect(load?.provenance.confidence).toBe("exact");
  });

  it("keeps an arrow in an object literal passed inline as a lambda parented by the file, with no closure name", async () => {
    const { nodes, edges } = await extract();
    const anon = nodes.filter((n) => n.attrs?.anonymous === true);
    expect(anon.map((n) => [n.id, n.parent])).toEqual([["src/props.ts#λ28:33", "src/props.ts#(module)"]]);
    expect(pairs(edges, "calls.reference")).toContain("src/props.ts#(module) -> src/props.ts#λ28:33");
  });

  it("resolves calls to those properties to the named function, and calls inside a named property to it", async () => {
    const { edges } = await extract();
    expect(pairs(edges, "calls.call")).toEqual(
      expect.arrayContaining([
        "src/props.ts#make -> src/props.ts#make.local.go",
        "src/use.ts#callProps -> src/defaults.ts#default.ping",
        "src/use.ts#callProps -> src/props.ts#Clicker.handlers.onY",
        "src/use.ts#callProps -> src/props.ts#Clicker.onX",
        "src/use.ts#callProps -> src/props.ts#api.load",
        "src/use.ts#callProps -> src/props.ts#api.save",
        "src/use.ts#callProps -> src/props.ts#make",
        "src/use.ts#callProps -> src/props.ts#outer.inner.deep",
      ]),
    );
    // The object-literal method `run` is a plain function, and its `o.go()` names a type literal's signature, not a dispatch.
    expect(callFrom(edges, "src/props.ts#run", "o.go")).toBeUndefined();
  });

  it("makes no reference edges to named properties, so only the inline lambda has a closure edge", async () => {
    const { edges } = await extract();
    expect(pairs(edges, "calls.reference")).toEqual(["src/props.ts#(module) -> src/props.ts#λ28:33"]);
  });
});

describe("interface and abstract dispatch", () => {
  it("makes a call through an interface receiver a calls.call edge to the implementations, sorted, with how interface", async () => {
    const { edges } = await extract();
    const persist = callFrom(edges, "src/use.ts#persist", "r.save");
    expect(persist?.kind).toBe("calls.call");
    expect(targetText(persist as IREdge)).toBe(
      "[src/repo.ts#Cache.save, src/repo.ts#FastMem.save, src/repo.ts#MemRepo.save, src/repo.ts#SqlRepo.save]",
    );
    expect(persist?.attrs).toEqual({ callee: "r.save", how: "interface" });
    expect(persist?.provenance.confidence).toBe("heuristic");
  });

  it("counts implementers through an extended interface, a subclass of an implementer, and a subclass that keeps the base's method", async () => {
    const { edges } = await extract();
    // FastMem overrides save; PlainMem inherits SqlRepo's, which is already a candidate, so it adds nothing.
    const persist = callFrom(edges, "src/use.ts#persist", "r.save") as IREdge;
    expect(targetText(persist)).toContain("src/repo.ts#Cache.save");
    expect(targetText(persist)).toContain("src/repo.ts#FastMem.save");
    expect(targetText(persist).match(/SqlRepo\.save/g)).toHaveLength(1);
    expect(targetText(persist)).not.toContain("PlainMem");
  });

  it("restricts a receiver typed by an extended interface to the implementers of that interface", async () => {
    const { edges } = await extract();
    // Store extends Repo, and only Cache implements Store. SqlRepo and MemRepo implement Repo alone.
    const persistStore = callFrom(edges, "src/use.ts#persistStore", "s.save");
    expect(persistStore?.kind).toBe("calls.call");
    expect(targetText(persistStore as IREdge)).toBe("[src/repo.ts#Cache.save]");
    expect(persistStore?.attrs).toEqual({ callee: "s.save", how: "interface" });
  });

  it("gives a receiver typed by the class itself an ordinary edge to its own method, not candidates", async () => {
    const { edges } = await extract();
    const direct = callFrom(edges, "src/use.ts#direct", "s.save");
    expect(targetText(direct as IREdge)).toBe("src/repo.ts#SqlRepo.save");
    expect(direct?.attrs).toEqual({ callee: "s.save" });
    expect(direct?.provenance.confidence).toBe("exact");
  });

  it("dispatches an abstract class member to every concrete subclass that overrides it, including a call through this", async () => {
    const { edges } = await extract();
    expect(targetText(callFrom(edges, "src/use.ts#area", "s.area") as IREdge)).toBe("[src/shapes.ts#Circle.area, src/shapes.ts#Square.area]");
    expect(targetText(callFrom(edges, "src/shapes.ts#Shape.describe", "this.area") as IREdge)).toBe(
      "[src/shapes.ts#Circle.area, src/shapes.ts#Square.area]",
    );
  });

  it("keeps an ordinary edge when a receiver's class declares the method it calls", async () => {
    const { edges } = await extract();
    expect(targetText(callFrom(edges, "src/use.ts#squareArea", "s.area") as IREdge)).toBe("src/shapes.ts#Square.area");
  });

  it("caps the candidates at 32 by id, and marks the edge truncated when it cuts", async () => {
    const { edges } = await extract();
    const sweep = callFrom(edges, "src/use.ts#sweep", "w.go") as IREdge;
    const to = sweep.to as { candidates: string[] };
    expect(to.candidates).toHaveLength(32);
    expect(to.candidates[0]).toBe("src/wide.ts#W00.go");
    expect(to.candidates[31]).toBe("src/wide.ts#W31.go");
    expect(sweep.attrs).toEqual({ callee: "w.go", how: "interface", truncated: true });
  });

  it("leaves truncated off an edge that is under the cap", async () => {
    const { edges } = await extract();
    expect(callFrom(edges, "src/use.ts#persist", "r.save")?.attrs).not.toHaveProperty("truncated");
  });

  it("counts only implementers in indexed files", async () => {
    const { edges } = await extract();
    // src/unindexed.ts implements Repo, but it is not among the indexed files, so it is not a candidate.
    const persist = callFrom(edges, "src/use.ts#persist", "r.save") as IREdge;
    expect(targetText(persist)).not.toContain("Stray");
  });

  it("gives every interface or abstract dispatch edge the interface attribute and no other edge that attribute", async () => {
    const { edges } = await extract();
    const withHow = edges.filter((e) => e.kind === "calls.call" && (e.attrs as { how?: unknown }).how !== undefined);
    expect(withHow.map((e) => `${e.from}:${String((e.attrs as { how?: unknown }).how)}`).sort()).toEqual([
      "src/shapes.ts#Shape.describe:interface",
      "src/use.ts#area:interface",
      "src/use.ts#persist:interface",
      "src/use.ts#persistStore:interface",
      "src/use.ts#sweep:interface",
    ]);
  });
});

describe("object-literal implementers of an interface", () => {
  const literalRoot = join(here, "fixtures", "dispatch-literal");
  const literalFiles = ["src/shape.ts", "src/factory.ts", "src/annotated.ts", "src/cls.ts", "src/use.ts"];
  const literalCtx = { root: { path: literalRoot, name: "dispatch-literal", allowBuildTools: false } };

  async function extractLiterals(): Promise<Extracted> {
    const readLiteral = async (rel: string) => readFileSync(join(literalRoot, rel), "utf8");
    const ctx = { ...literalCtx, files: literalFiles, listFiles: () => [...literalFiles], readFile: readLiteral, log: () => undefined };
    const out: Extracted = { nodes: [], edges: [] };
    for await (const batch of frontend.extract(ctx)) {
      for (const record of batch.records) {
        if ("node" in record) out.nodes.push(record.node);
        if ("edge" in record) out.edges.push(record.edge);
      }
    }
    return out;
  }

  it("(a) a call through a variable typed by the interface includes the method of a literal a factory returns", async () => {
    const { edges } = await extractLiterals();
    const call = callFrom(edges, "src/use.ts#viaFactory", "c.bump") as IREdge;
    expect(call?.kind).toBe("calls.call");
    expect(targetText(call)).toContain("src/factory.ts#makeCounter.bump");
    expect(call.attrs).toEqual({ callee: "c.bump", how: "interface" });
  });

  it("(b) an interface-annotated variable and a satisfies literal are both candidates", async () => {
    const { edges } = await extractLiterals();
    const call = callFrom(edges, "src/use.ts#viaParam", "c.bump") as IREdge;
    const ids = targetText(call);
    expect(ids).toContain("src/annotated.ts#annotated.bump");
    expect(ids).toContain("src/annotated.ts#sat.bump");
  });

  it("(c) a class and object literals implementing one interface are all candidates, sorted", async () => {
    const { edges } = await extractLiterals();
    const call = callFrom(edges, "src/use.ts#viaParam", "c.bump") as IREdge;
    expect(targetText(call)).toBe(
      "[src/annotated.ts#annotated.bump, src/annotated.ts#sat.bump, src/cls.ts#Real.bump, src/factory.ts#makeCounter.bump]",
    );
  });

  it("(d) a call to an array method from the lib makes no interface edge", async () => {
    const { edges } = await extractLiterals();
    expect(edges.filter((e) => e.kind === "calls.call" && e.from === "src/use.ts#viaArray")).toEqual([]);
    expect(edges.some((e) => e.kind === "calls.call" && (e.attrs as { how?: unknown }).how === "interface" && e.from === "src/use.ts#viaArray")).toBe(false);
  });
});
