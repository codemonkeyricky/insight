import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// A named function made inside a function (a local arrow, a nested declaration, a property of a literal inside a function)
// gets the same closure edge from its creator as an anonymous lambda. A top-level declaration gets none.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "closures");
const files = ["src/closures.ts"];
const root = { path: fixtureRoot, name: "closures", allowBuildTools: false };
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

/** `from -> to` for each closure edge, sorted. */
function closures(all: IREdge[]): string[] {
  return all
    .filter((e) => e.kind === "calls.reference" && (e.attrs as { how?: unknown }).how === "closure")
    .map((e) => `${String(e.from)} -> ${String(e.to)}`)
    .sort();
}

describe("closures defined inside a function", () => {
  it("gives each named closure made inside a function a closure edge from its creator", async () => {
    expect(closures((await extract()).edges)).toEqual([
      "src/closures.ts#link -> src/closures.ts#link.ctx.hasFile",
      "src/closures.ts#outer -> src/closures.ts#outer.helper",
      "src/closures.ts#outer -> src/closures.ts#outer.inner",
      "src/closures.ts#wrap -> src/closures.ts#wrap.holder.mid.leaf",
    ]);
  });

  it("gives no closure edge to a top-level declaration: a bound literal's function, a top-level function", async () => {
    const { nodes, edges } = await extract();
    const targets = closures(edges).map((s) => s.split(" -> ")[1]);
    expect(targets).not.toContain("src/closures.ts#api.get");
    expect(targets).not.toContain("src/closures.ts#top");
    expect(nodes.some((n) => n.id === "src/closures.ts#api.get")).toBe(true);
    expect(nodes.some((n) => n.id === "src/closures.ts#top")).toBe(true);
  });

  it("keeps the names and parents of the named closures", async () => {
    const { nodes } = await extract();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("src/closures.ts#outer.helper")?.attrs?.anonymous).toBeUndefined();
    expect(byId.get("src/closures.ts#outer.inner")?.attrs?.name).toBe("inner");
    expect(byId.get("src/closures.ts#outer.inner")?.parent).toBe("src/closures.ts#outer");
    expect(byId.get("src/closures.ts#link.ctx.hasFile")?.attrs?.name).toBe("hasFile");
  });
});
