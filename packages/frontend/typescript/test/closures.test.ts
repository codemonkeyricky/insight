import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// A named member made inside a function (a property or method of a literal, a method or property arrow of a local class)
// gets a closure edge from its creator, as an anonymous lambda does. A nested declaration, or a function bound to a
// variable, gets none: its own call or value edge reaches it. A top-level declaration gets none.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "closures");
const root = { path: fixtureRoot, name: "closures", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");
const files = ["src/closures.ts"];

interface Extracted {
  nodes: IRNode[];
  edges: IREdge[];
}

async function extract(which: string[] = files): Promise<Extracted> {
  const ctx = { root, files: which, listFiles: () => [...which], readFile, log: () => undefined };
  const out: Extracted = { nodes: [], edges: [] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) out.nodes.push(record.node);
      if ("edge" in record) out.edges.push(record.edge);
    }
  }
  return out;
}

/** `from -> to` for each closure edge, sorted. */
function closures(all: IREdge[]): string[] {
  return all
    .filter((e) => e.kind === "calls.reference" && (e.attrs as { how?: unknown }).how === "closure")
    .map((e) => `${String(e.from)} -> ${String(e.to)}`)
    .sort();
}

/** `from -> to` for each direct call edge, sorted. */
function calls(all: IREdge[]): string[] {
  return all
    .filter((e) => e.kind === "calls.call")
    .map((e) => `${String(e.from)} -> ${String(e.to)}`)
    .sort();
}

describe("closures defined inside a function", () => {
  it("gives a closure edge to each named member and each lambda made inside a function", async () => {
    const closed = closures((await extract()).edges);
    expect(closed).toEqual([
      "src/closures.ts#factory -> src/closures.ts#factory.Local.lg",
      "src/closures.ts#factory -> src/closures.ts#factory.Local.lm",
      "src/closures.ts#factory -> src/closures.ts#factory.Local.pa",
      "src/closures.ts#link -> src/closures.ts#link.ctx.hasFile",
      "src/closures.ts#mapper -> src/closures.ts#mapper.λ42:18",
      "src/closures.ts#wrap -> src/closures.ts#wrap.holder.mid.leaf",
    ]);
  });

  it("gives no closure edge to a nested function declaration called directly by its outer function", async () => {
    const { edges } = await extract();
    expect(closures(edges).filter((s) => s.endsWith("#outer.helper"))).toEqual([]);
    expect(calls(edges)).toContain("src/closures.ts#outer -> src/closures.ts#outer.helper");
  });

  it("gives no closure edge to a nested const arrow called by its outer function", async () => {
    const { edges } = await extract();
    expect(closures(edges).filter((s) => s.endsWith("#outer.f"))).toEqual([]);
    expect(calls(edges)).toContain("src/closures.ts#outer -> src/closures.ts#outer.f");
  });

  it("gives no incoming edge to a nested function declaration that nothing references", async () => {
    const { nodes, edges } = await extract();
    expect(nodes.some((n) => n.id === "src/closures.ts#outer.unused")).toBe(true);
    expect(edges.filter((e) => String(e.to) === "src/closures.ts#outer.unused")).toEqual([]);
  });

  it("gives no closure edge to a top-level declaration: a bound literal's function, a top-level function, a class method", async () => {
    const { nodes, edges } = await extract();
    const targets = closures(edges).map((s) => s.split(" -> ")[1]);
    expect(targets).not.toContain("src/closures.ts#api.get");
    expect(targets).not.toContain("src/closures.ts#top");
    expect(targets.filter((t) => /#Top\.|#Ns\.|#nf$/.test(t))).toEqual([]);
    expect(nodes.some((n) => n.id === "src/closures.ts#api.get")).toBe(true);
    expect(nodes.some((n) => n.id === "src/closures.ts#top")).toBe(true);
  });

  it("keeps the names and parents of the named members", async () => {
    const { nodes } = await extract();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("src/closures.ts#outer.helper")?.attrs?.name).toBe("helper");
    expect(byId.get("src/closures.ts#outer.helper")?.attrs?.anonymous).toBeUndefined();
    expect(byId.get("src/closures.ts#factory.Local.lm")?.parent).toBe("src/closures.ts#factory.Local");
    expect(byId.get("src/closures.ts#link.ctx.hasFile")?.attrs?.name).toBe("hasFile");
  });
});

describe("closure edges for members of a local class and of literals", () => {
  it("gives a method, a getter and a property arrow of a class declared in a function a closure edge", async () => {
    const closed = closures((await extract()).edges).filter((s) => s.startsWith("src/closures.ts#factory ->"));
    expect(closed).toEqual([
      "src/closures.ts#factory -> src/closures.ts#factory.Local.lg",
      "src/closures.ts#factory -> src/closures.ts#factory.Local.lm",
      "src/closures.ts#factory -> src/closures.ts#factory.Local.pa",
    ]);
  });

  it("gives no closure edge to a namespace function or to top-level class members", async () => {
    const { edges } = await extract();
    const targets = closures(edges).map((s) => s.split(" -> ")[1]);
    expect(targets.filter((t) => t.includes("#Top.") || t.includes("#Ns."))).toEqual([]);
  });

  it("gives no closure edge to the method of an export default literal, or to the method of an unbound top-level literal", async () => {
    const { edges } = await extract(["src/defaults.ts"]);
    expect(closures(edges)).toEqual([]);
  });

  it("still gives a closure edge to a function expression passed as an argument inside a function", async () => {
    const closed = closures((await extract()).edges).filter((s) => s.startsWith("src/closures.ts#mapper ->"));
    expect(closed).toHaveLength(1);
  });
});
