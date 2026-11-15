import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "rwlock");
const files = ["src/cache.cc"];

const root: ProjectRoot = { path: fixtureRoot, name: "rwlock", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractNodes(): Promise<IRNode[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches.flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node] : [])));
}

describe("C++ shared_mutex guards", () => {
  it("emit one acquire per guard, so a shared_lock on rw_ has no second rw_ acquire (no rw_ -> rw_ self edge)", async () => {
    const nodes = await extractNodes();
    const acquires = nodes.filter((n) => n.facet === "sync" && (n.kind === "sync.lock-acquire" || n.kind === "sync.rwlock-acquire" || n.kind === "x-cpp.scoped-lock"));
    const onRw = acquires.filter((n) => n.attrs.lock === "Cache::rw_");
    expect(onRw.map((n) => [n.kind, n.attrs.mode])).toEqual([["sync.rwlock-acquire", "shared"]]);
    const onB = acquires.filter((n) => n.attrs.lock === "Cache::b_");
    expect(onB.map((n) => n.kind)).toEqual(["x-cpp.scoped-lock"]);
  });
});
