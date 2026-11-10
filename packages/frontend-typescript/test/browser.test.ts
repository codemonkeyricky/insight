import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "browser");
const files = [
  "src/cli.ts",
  "src/client.ts",
  "src/main.tsx",
  "src/shim.ts",
  "src/shimmed.ts",
  "src/types.ts",
  "src/verify/mesh.ts",
  "src/verify/print.worker.ts",
  "src/verify/verify.ts",
  "src/verify/verify.worker.ts",
];
const root = { path: fixtureRoot, name: "browser", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Extracted {
  edges: IREdge[];
  nodes: IRNode[];
  dependsOn: Map<string, string[]>;
}

/** Every edge and node the frontend emits for the browser fixture, and the dependsOn of each file. */
async function extract(): Promise<Extracted> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: Extracted = { edges: [], nodes: [], dependsOn: new Map() };
  for await (const batch of frontend.extract(ctx)) {
    out.dependsOn.set(batch.file, batch.dependsOn ?? []);
    for (const record of batch.records) {
      if ("edge" in record) out.edges.push(record.edge);
      if ("node" in record) out.nodes.push(record.node);
    }
  }
  return out;
}

/** `from -> to (how)` for each spawns edge, sorted. */
const spawns = (all: IREdge[]): string[] =>
  all
    .filter((e) => e.kind === "concurrency.spawns")
    .map((e) => `${e.from} -> ${e.to} (${String((e.attrs as { how?: unknown }).how)})`)
    .sort();

const modules = (nodes: IRNode[]): IRNode[] => nodes.filter((n) => n.attrs?.module === true);

// src/client.ts, by line (columns are the extractor's 0-based offsets):
//   2  new Worker(url)                        url is a const holding new URL(literal, import.meta.url)
//   3  new Worker(new URL(literal, ...))      inline URL form
//   4  new Worker("./verify/print.worker.ts") plain string
//   5  new SharedWorker("./verify/verify.worker.ts")
//   8  new Worker(path)                       runtime path, no literal
describe("browser Worker spawns", () => {
  it("links each global Worker and SharedWorker whose script is a literal or const URL to its worker module", async () => {
    expect(spawns((await extract()).edges)).toEqual([
      "src/client.ts@spawn:2:23 -> src/verify/verify.worker.ts#(module) (thread)",
      "src/client.ts@spawn:3:21 -> src/verify/print.worker.ts#(module) (thread)",
      "src/client.ts@spawn:4:24 -> src/verify/print.worker.ts#(module) (thread)",
      "src/client.ts@spawn:5:22 -> src/verify/verify.worker.ts#(module) (thread)",
    ]);
  });

  it("emits no spawn for a Worker whose script is a runtime path", async () => {
    const lines = spawns((await extract()).edges).map((s) => s.split("@spawn:")[1]?.split(":")[0]);
    expect(lines).not.toContain("8");
  });

  it("does not treat an imported Worker class as the browser global", async () => {
    expect(spawns((await extract()).edges).some((s) => s.startsWith("src/shimmed.ts@"))).toBe(false);
  });
});

describe("(module) entity", () => {
  it("creates a module for each file with top-level executable code, and none for a declarations-only file", async () => {
    const ids = modules((await extract()).nodes).map((n) => n.id).sort();
    expect(ids).toEqual([
      "src/cli.ts#(module)",
      "src/client.ts#(module)",
      "src/main.tsx#(module)",
      "src/shimmed.ts#(module)",
      "src/verify/print.worker.ts#(module)",
      "src/verify/verify.worker.ts#(module)",
    ]);
  });

  it("names the module (module) and marks it with no async or export flags", async () => {
    const cli = (await extract()).nodes.find((n) => n.id === "src/cli.ts#(module)");
    expect(cli?.attrs?.name).toBe("(module)");
    expect(cli?.attrs?.qualifiedName).toBe("(module)");
    expect(cli?.attrs?.async).toBe(false);
    expect(cli?.attrs?.exported).toBe(false);
    expect(cli?.attrs?.htmlEntry).toBeUndefined();
  });

  it("marks only the index.html script entry as htmlEntry", async () => {
    const html = modules((await extract()).nodes)
      .filter((n) => n.attrs?.htmlEntry === true)
      .map((n) => n.id);
    expect(html).toEqual(["src/main.tsx#(module)"]);
  });

  it("parents a top-level lambda to the module, not the file, so the module reaches it", async () => {
    const handlers = (await extract()).nodes.filter(
      (n) => n.attrs?.anonymous === true && n.id.startsWith("src/verify/verify.worker.ts#"),
    );
    expect(handlers.map((n) => n.parent)).toEqual(["src/verify/verify.worker.ts#(module)"]);
  });
});

describe("dependsOn for the browser fixture", () => {
  it("records a worker's imports so editing the imported module invalidates the worker", async () => {
    expect((await extract()).dependsOn.get("src/verify/verify.worker.ts") ?? []).toEqual(
      expect.arrayContaining(["src/verify/verify.ts"]),
    );
  });
});
