import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge } from "@insight/ir";
import frontend from "../src/index.js";

// A postMessage across a Web Worker boundary is a concurrency.dispatches edge with how "message": from the function that
// posts to the function that handles it, in the worker file or the page. Both ends must resolve.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "messages");
const files = ["src/page.ts", "src/worker.ts", "src/ping.ts"];
const root = { path: fixtureRoot, name: "messages", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

/** Every message edge the frontend emits for the messages fixture, as `from -> to`, sorted. */
async function messageEdges(): Promise<string[]> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const edges: IREdge[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("edge" in record && record.edge.kind === "concurrency.dispatches") edges.push(record.edge);
    }
  }
  return edges
    .filter((e) => (e.attrs as { how?: unknown }).how === "message")
    .map((e) => `${e.from} -> ${String(e.to)}`)
    .sort();
}

describe("worker messages", () => {
  it("pairs a page postMessage with the cast-alias handler in the worker, and the worker's reply with the page handler", async () => {
    const edges = await messageEdges();
    // page -> worker: the local const's postMessage reaches the lambda the worker installs on its cast alias.
    expect(edges).toContain("src/page.ts#runLocal -> src/worker.ts#λ7:17");
    // worker -> page: ctx.postMessage reaches the handler the page installed on the Worker it constructed.
    expect(edges).toContain("src/worker.ts#λ7:17 -> src/page.ts#runLocal.λ4:17");
  });

  it("pairs through a class field assigned in the same class, in both directions", async () => {
    const edges = await messageEdges();
    expect(edges).toContain("src/page.ts#VerifyClient.pump -> src/worker.ts#λ7:17");
    expect(edges).toContain("src/worker.ts#λ7:17 -> src/page.ts#VerifyClient.ensureWorker.λ33:19");
  });

  it('pairs addEventListener("message") on both sides, with a named handler on the page', async () => {
    const edges = await messageEdges();
    expect(edges).toContain("src/page.ts#startPing -> src/ping.ts#λ2:29");
    expect(edges).toContain("src/ping.ts#λ2:29 -> src/page.ts#onReply");
  });

  it("emits nothing for a postMessage on a Worker that arrives as a parameter", async () => {
    const edges = await messageEdges();
    expect(edges.some((e) => e.startsWith("src/page.ts#sendVia "))).toBe(false);
  });
});
