import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "exported-ts");
const files = ["src/lib.ts"];
const root: ProjectRoot = { path: fixtureRoot, name: "exported-ts", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extractAll(): Promise<IRBatch[]> {
  const batches: IRBatch[] = [];
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  for await (const batch of frontend.extract(ctx)) batches.push(batch);
  return batches;
}

/** The exported flag of every function node, by its qualified name. */
async function exportedByName(): Promise<Map<string, boolean>> {
  const batches = await extractAll();
  const nodes = batches.flatMap((b) => b.records).flatMap((r): IRNode[] => ("node" in r ? [r.node] : []));
  const out = new Map<string, boolean>();
  for (const n of nodes) {
    if (n.kind !== "structure.function" || n.span?.file !== "src/lib.ts") continue;
    out.set(String(n.attrs.qualifiedName ?? n.attrs.name ?? n.id), n.attrs.exported === true);
  }
  return out;
}

describe("frontend-typescript exported flag", () => {
  it("a method of an exported class is exported, and a constructor, accessor and default-exported class's method too", async () => {
    const exp = await exportedByName();
    expect(exp.get("Store.load")).toBe(true);
    expect(exp.get("Store.constructor")).toBe(true);
    expect(exp.get("Store.size")).toBe(true);
    expect(exp.get("Main.go")).toBe(true);
  });

  it("a function named in an export list is exported, under its local name", async () => {
    const exp = await exportedByName();
    expect(exp.get("helper")).toBe(true);
    expect(exp.get("listedArrow")).toBe(true);
    expect(exp.get("direct")).toBe(true);
    expect(exp.get("arrow")).toBe(true);
  });

  it("a method of a class that is not exported is not exported", async () => {
    const exp = await exportedByName();
    expect(exp.get("Internal.run")).toBe(false);
  });

  it("a private method, and a #private method, of an exported class are not exported", async () => {
    const exp = await exportedByName();
    expect(exp.get("Store.secret")).toBe(false);
    const hidden = [...exp.entries()].find(([k]) => k.startsWith("Store.") && k.includes("hidden"));
    expect(hidden).toBeDefined();
    expect(hidden?.[1]).toBe(false);
  });
});
