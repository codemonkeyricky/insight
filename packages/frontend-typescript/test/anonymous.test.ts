import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// A function expression or arrow that no declaration names becomes a structure.function named by its position.
// Everything inside it belongs to it, and the function that creates it reaches it by a closure edge.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "anon");
const files = ["src/lambdas.ts", "src/tasks.ts"];
const root = { path: fixtureRoot, name: "anon", allowBuildTools: false };
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

/** `from -> to (how)` for each edge of one kind, sorted. */
function labelled(all: IREdge[], kind: string): string[] {
  return all
    .filter((e) => e.kind === kind)
    .map((e) => `${e.from} -> ${e.to} (${String((e.attrs as { how?: unknown }).how)})`)
    .sort();
}

/** `from -> to` for each edge of one kind, sorted. */
function pairs(all: IREdge[], kind: string): string[] {
  return all.filter((e) => e.kind === kind).map((e) => `${e.from} -> ${e.to}`).sort();
}

const anonymousOf = (nodes: IRNode[]): IRNode[] => nodes.filter((n) => n.attrs?.anonymous === true);

describe("anonymous functions", () => {
  it("names each lambda by its position, parents it by the enclosing function or the file, and marks it anonymous", async () => {
    const { nodes } = await extract();
    const anon = anonymousOf(nodes);
    expect(Object.fromEntries(anon.map((n) => [n.id, [n.attrs?.name, n.parent]]))).toEqual({
      "src/lambdas.ts#outer.λ6:20": ["λ6:20", "src/lambdas.ts#outer"],
      "src/lambdas.ts#outer.λ6:20.λ7:29": ["λ7:29", "src/lambdas.ts#outer.λ6:20"],
      "src/lambdas.ts#filtered.λ14:23": ["λ14:23", "src/lambdas.ts#filtered"],
      "src/lambdas.ts#schedule.λ22:14": ["λ22:14", "src/lambdas.ts#schedule"],
      "src/lambdas.ts#schedule.λ23:18": ["λ23:18", "src/lambdas.ts#schedule"],
      "src/lambdas.ts#schedule.λ24:24": ["λ24:24", "src/lambdas.ts#schedule"],
      "src/lambdas.ts#kick.λ29:9": ["λ29:9", "src/lambdas.ts#kick"],
      "src/lambdas.ts#wait.λ35:17": ["λ35:17", "src/lambdas.ts#wait"],
      "src/lambdas.ts#λ62:13": ["λ62:13", "src/lambdas.ts"],
      "src/lambdas.ts#λ56:16": ["λ56:16", "src/lambdas.ts"],
    });
  });

  it("starts each lambda's span at its first token, and records async on an async lambda only", async () => {
    const { nodes } = await extract();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("src/lambdas.ts#outer.λ6:20")?.span?.start).toEqual([5, 19]);
    expect(byId.get("src/lambdas.ts#kick.λ29:9")?.span?.start).toEqual([28, 8]);
    expect(byId.get("src/lambdas.ts#kick.λ29:9")?.attrs?.async).toBe(true);
    expect(byId.get("src/lambdas.ts#wait.λ35:17")?.attrs?.async).toBe(true);
    expect(byId.get("src/lambdas.ts#outer.λ6:20")?.attrs?.async).toBe(false);
  });

  it("makes the function that creates each lambda reach it by a closure edge, the file for module-level lambdas", async () => {
    expect(labelled((await extract()).edges, "calls.reference")).toEqual([
      "src/lambdas.ts -> src/lambdas.ts#λ56:16 (closure)",
      "src/lambdas.ts -> src/lambdas.ts#λ62:13 (closure)",
      "src/lambdas.ts#filtered -> src/lambdas.ts#filtered.λ14:23 (closure)",
      "src/lambdas.ts#kick -> src/lambdas.ts#kick.λ29:9 (closure)",
      "src/lambdas.ts#outer -> src/lambdas.ts#outer.λ6:20 (closure)",
      "src/lambdas.ts#outer.λ6:20 -> src/lambdas.ts#outer.λ6:20.λ7:29 (closure)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ22:14 (closure)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ23:18 (closure)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ24:24 (closure)",
      "src/lambdas.ts#wait -> src/lambdas.ts#wait.λ35:17 (closure)",
    ]);
  });

  it("attributes each call inside a lambda to the lambda, and leaves the creator with only the calls it makes itself", async () => {
    expect(pairs((await extract()).edges, "calls.call")).toEqual([
      "src/lambdas.ts -> src/lambdas.ts#takes",
      "src/lambdas.ts#kick.λ29:9 -> src/tasks.ts#fetchUser",
      "src/lambdas.ts#schedule -> src/tasks.ts#fetchUser",
      "src/lambdas.ts#schedule.λ22:14 -> src/tasks.ts#onTick",
      "src/lambdas.ts#schedule.λ23:18 -> src/tasks.ts#onFlush",
      "src/lambdas.ts#wait.λ35:17 -> src/tasks.ts#fetchUser",
      "src/lambdas.ts#λ56:16 -> src/tasks.ts#onTick",
    ]);
  });

  it("dispatches inline timer, microtask and promise callbacks from the function that schedules them, and async IIFEs by start or await", async () => {
    expect(labelled((await extract()).edges, "concurrency.dispatches")).toEqual([
      "src/lambdas.ts#kick -> src/lambdas.ts#kick.λ29:9 (start)",
      "src/lambdas.ts#kick.λ29:9 -> src/tasks.ts#fetchUser (await)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ22:14 (timer)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ23:18 (microtask)",
      "src/lambdas.ts#schedule -> src/lambdas.ts#schedule.λ24:24 (callback)",
      "src/lambdas.ts#schedule -> src/tasks.ts#fetchUser (start)",
      "src/lambdas.ts#wait -> src/lambdas.ts#wait.λ35:17 (await)",
      "src/lambdas.ts#wait.λ35:17 -> src/tasks.ts#fetchUser (start)",
    ]);
  });

  it("keeps each branch and await in the function or lambda that contains it", async () => {
    const { nodes } = await extract();
    const scoped = nodes.filter((n) => n.kind === "flow.branch" || n.kind === "concurrency.await");
    expect(Object.fromEntries(scoped.map((n) => [n.id, n.parent]))).toEqual({
      "src/lambdas.ts@if:4:2": "src/lambdas.ts#outer",
      "src/lambdas.ts@if:14:4": "src/lambdas.ts#filtered.λ14:23",
      "src/lambdas.ts@await:29:4": "src/lambdas.ts#kick.λ29:9",
      "src/lambdas.ts@await:34:9": "src/lambdas.ts#wait",
    });
  });

  it("keeps a class property arrow and a named function expression named, not anonymous", async () => {
    const { nodes } = await extract();
    const named = nodes.filter((n) => n.id === "src/lambdas.ts#Counter.tick" || n.id === "src/lambdas.ts#named");
    expect(Object.fromEntries(named.map((n) => [n.id, [n.attrs?.name, n.attrs?.anonymous]]))).toEqual({
      "src/lambdas.ts#Counter.tick": ["tick", undefined],
      "src/lambdas.ts#named": ["named", undefined],
    });
  });
});
