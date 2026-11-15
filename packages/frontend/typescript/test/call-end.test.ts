import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// Each call edge records the end of its whole call expression (callEnd), not just the callee name's span.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "call-end");
const files = ["src/nested.ts"];
const root = { path: fixtureRoot, name: "call-end", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extract(): Promise<{ nodes: IRNode[]; edges: IREdge[] }> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: { nodes: IRNode[]; edges: IREdge[] } = { nodes: [], edges: [] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) out.nodes.push(record.node);
      if ("edge" in record) out.edges.push(record.edge);
    }
  }
  return out;
}

describe("callEnd on call edges", () => {
  it("ends a nested call's callEnd before the wrapping call's, with the name span unchanged", async () => {
    const { edges } = await extract();
    const callsFromRun = edges.filter((e) => e.kind === "calls.call" && e.from === "src/nested.ts#run");
    const f = callsFromRun.find((e) => (e.attrs as { callee?: unknown }).callee === "f");
    const g = callsFromRun.find((e) => (e.attrs as { callee?: unknown }).callee === "g");
    expect(f && g).toBeTruthy();
    // `  return f(g(x));` is line 10 (0-based 9): f's name is at column 9, g's at column 11; g(x) ends at 15, f(g(x)) at 16.
    expect((g?.attrs as { callEnd?: unknown }).callEnd).toEqual([9, 15]);
    expect((f?.attrs as { callEnd?: unknown }).callEnd).toEqual([9, 16]);
    expect(f?.span?.start).toEqual([9, 9]);
    expect(g?.span?.start).toEqual([9, 11]);
    expect(g?.span?.end).toEqual([9, 12]);
  });
});
