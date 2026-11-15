import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";

/**
 * Indexes a small project with the TypeScript frontend. The frontend emits no structure.file nodes, so one is added for
 * every listed file, as the indexer does; package roots come from the package.json files among them.
 */
export async function indexFixture(files: Record<string, string>): Promise<{ nodes: IRNode[]; edges: IREdge[] }> {
  const dir = mkdtempSync(join(tmpdir(), "insight-coupling-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const list = Object.keys(files);
    const ctx = {
      root: { path: dir, name: "coupling-fixture", allowBuildTools: false },
      files: list,
      listFiles: () => list,
      readFile: async (p: string) => files[p] ?? "",
      log: () => undefined,
    };
    const nodes: IRNode[] = [];
    const edges: IREdge[] = [];
    for await (const batch of frontend.extract(ctx)) {
      for (const r of batch.records) {
        if ("node" in r) nodes.push(r.node);
        else if ("edge" in r) edges.push(r.edge);
      }
    }
    for (const path of list) nodes.push(fx.node(path, "structure", "structure.file"));
    return { nodes, edges };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
