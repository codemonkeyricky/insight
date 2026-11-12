import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "dist-spawn");
const files = ["apps/server/src/main.ts", "packages/cli/src/absent.ts", "packages/cli/src/serve.ts"];
const root = { path: fixtureRoot, name: "dist-spawn", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

/** Every edge and node the frontend emits for the dist-spawn fixture. */
async function extract(): Promise<{ edges: IREdge[]; nodes: IRNode[] }> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: { edges: IREdge[]; nodes: IRNode[] } = { edges: [], nodes: [] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("edge" in record) out.edges.push(record.edge);
      if ("node" in record) out.nodes.push(record.node);
    }
  }
  return out;
}

describe("concurrency.spawns for a Node child run from a build output", () => {
  it("links the serve.ts spawn of a const dist path to the source file it was built from", async () => {
    const spawns = (await extract()).edges.filter((e) => e.kind === "concurrency.spawns");
    const serve = spawns.filter((e) => e.from.startsWith("packages/cli/src/serve.ts@"));
    expect(serve).toHaveLength(1);
    expect(serve[0]?.to).toBe("apps/server/src/main.ts#(module)");
    expect(serve[0]?.attrs).toEqual({ how: "process" });
    expect(serve[0]?.provenance).toEqual({ frontend: "frontend-typescript", confidence: "inferred" });
    expect(serve[0]?.span?.file).toBe("packages/cli/src/serve.ts");
  });

  it("emits no spawns edge for a build output with no source counterpart, and none for a non-Node command", async () => {
    const { edges, nodes } = await extract();
    expect(edges.filter((e) => e.kind === "concurrency.spawns" && e.from.startsWith("packages/cli/src/absent.ts@"))).toEqual([]);
    const gitSpawn = nodes.find((n) => n.kind === "concurrency.spawn-process" && n.attrs?.api === "child_process.execFileSync");
    expect(gitSpawn).toBeDefined();
    expect(edges.filter((e) => e.kind === "concurrency.spawns" && e.from === gitSpawn?.id)).toEqual([]);
    // The absent Node spawn still exists as a process node, with no edge out of it.
    expect(nodes.some((n) => n.kind === "concurrency.spawn-process" && n.id.startsWith("packages/cli/src/absent.ts@"))).toBe(true);
  });
});
