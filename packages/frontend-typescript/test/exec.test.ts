import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "exec");
const files = ["src/child.ts", "src/crunch.ts", "src/dispatch.ts", "src/spawns.ts", "src/tasks.ts"];
const root = { path: fixtureRoot, name: "exec", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Extracted {
  edges: IREdge[];
  nodes: IRNode[];
  dependsOn: Map<string, string[]>;
}

/** Every edge and node the frontend emits for the exec fixture, and the dependsOn of each file. */
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

/** `from -> to (how)` for each edge of one kind, sorted. */
function labelled(all: IREdge[], kind: string): string[] {
  return all
    .filter((e) => e.kind === kind)
    .map((e) => `${e.from} -> ${e.to} (${String((e.attrs as { how?: unknown }).how)})`)
    .sort();
}

/** `from -> to` for each edge of one kind, sorted. For kinds that carry no `how`. */
function pairs(all: IREdge[], kind: string): string[] {
  return all.filter((e) => e.kind === kind).map((e) => `${e.from} -> ${e.to}`).sort();
}

/** The file part of a node or edge id: `<rel>#...`, `<rel>@...`, or the bare rel path. */
const fileOf = (id: string): string => id.split(/[#@]/)[0] ?? id;

describe("concurrency.spawns", () => {
  it("links each worker or fork script that resolves to a project file, and nothing else", async () => {
    expect(labelled((await extract()).edges, "concurrency.spawns")).toEqual([
      "src/spawns.ts@spawn:10:9 -> src/crunch.ts#(module) (thread)",
      "src/spawns.ts@spawn:19:2 -> src/child.ts#(module) (process)",
      "src/spawns.ts@spawn:5:9 -> src/crunch.ts#(module) (thread)",
    ]);
  });

  it("starts each edge at its spawn node, with the node's position as the span", async () => {
    const spawnEdges = (await extract()).edges.filter((e) => e.kind === "concurrency.spawns");
    expect(spawnEdges).toHaveLength(3);
    for (const e of spawnEdges) {
      const [, line, col] = /@spawn:(\d+):(\d+)$/.exec(e.from) ?? [];
      expect(e.span?.start).toEqual([Number(line), Number(col)]);
      expect(e.span?.file).toBe(fileOf(e.from));
    }
  });

  it("keeps each spawn node's attrs.target as the literal was written, including the unresolved ones", async () => {
    const spawnNodes = (await extract()).nodes.filter(
      (n) => n.kind === "concurrency.spawn-thread" || n.kind === "concurrency.spawn-process",
    );
    expect(Object.fromEntries(spawnNodes.map((n) => [n.id, n.attrs?.target]))).toEqual({
      "src/spawns.ts@spawn:5:9": "./src/crunch.js",
      "src/spawns.ts@spawn:10:9": "<dynamic>",
      "src/spawns.ts@spawn:15:9": "./src/missing.js",
      "src/spawns.ts@spawn:19:2": "./src/child.js",
      "src/spawns.ts@spawn:24:2": "./src/absent.js",
    });
  });

  it("marks a URL-form worker exact, and a worker or fork named by a cwd-relative literal heuristic", async () => {
    const edges = (await extract()).edges.filter((e) => e.kind === "concurrency.spawns");
    expect(Object.fromEntries(edges.map((e) => [e.from, e.provenance.confidence]))).toEqual({
      "src/spawns.ts@spawn:5:9": "heuristic",
      "src/spawns.ts@spawn:10:9": "exact",
      "src/spawns.ts@spawn:19:2": "heuristic",
    });
  });
});

describe("concurrency.dispatches", () => {
  it("records awaited, started, timer, microtask and promise-callback dispatches, inline callbacks included, and nothing else", async () => {
    // An inline callback dispatches to its own anonymous function; a module-level call has the file as its source.
    expect(labelled((await extract()).edges, "concurrency.dispatches")).toEqual([
      "src/dispatch.ts#(module) -> src/tasks.ts#onDone (timer)",
      "src/dispatch.ts#Job.run -> src/dispatch.ts#Job.finish (callback)",
      "src/dispatch.ts#Job.run -> src/tasks.ts#fetchUser (start)",
      "src/dispatch.ts#chain -> src/tasks.ts#fetchUser (start)",
      "src/dispatch.ts#chain -> src/tasks.ts#onDone (callback)",
      "src/dispatch.ts#chain -> src/tasks.ts#onError (callback)",
      "src/dispatch.ts#chain -> src/tasks.ts#onFlush (callback)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ33:14 (timer)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ34:18 (microtask)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ35:24 (callback)",
      "src/dispatch.ts#inline -> src/tasks.ts#fetchUser (start)",
      "src/dispatch.ts#kickoff -> src/tasks.ts#fetchUser (start)",
      "src/dispatch.ts#load -> src/tasks.ts#fetchUser (await)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onFlush (microtask)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onTick (microtask)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onTick (timer)",
    ]);
  });

  it("keeps calls.call to named functions, and puts a call inside a lambda on the lambda: calls are never also dispatches", async () => {
    expect(pairs((await extract()).edges, "calls.call")).toEqual([
      "src/dispatch.ts#Job.run -> src/tasks.ts#fetchUser",
      "src/dispatch.ts#chain -> src/tasks.ts#fetchUser",
      "src/dispatch.ts#inline -> src/tasks.ts#fetchUser",
      "src/dispatch.ts#inline.λ33:14 -> src/tasks.ts#onTick",
      "src/dispatch.ts#inline.λ34:18 -> src/tasks.ts#onFlush",
      "src/dispatch.ts#kickoff -> src/tasks.ts#fetchUser",
      "src/dispatch.ts#load -> src/tasks.ts#fetchUser",
      "src/dispatch.ts#plain -> src/tasks.ts#syncValue",
    ]);
  });

  it("keeps calls.reference to a callback passed by name, and adds a closure edge from each creator to the inline function it makes", async () => {
    expect(labelled((await extract()).edges, "calls.reference")).toEqual([
      "src/dispatch.ts#(module) -> src/tasks.ts#onDone (value)",
      "src/dispatch.ts#Job.run -> src/dispatch.ts#Job.finish (value)",
      "src/dispatch.ts#chain -> src/tasks.ts#onDone (value)",
      "src/dispatch.ts#chain -> src/tasks.ts#onError (value)",
      "src/dispatch.ts#chain -> src/tasks.ts#onFlush (value)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ33:14 (closure)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ34:18 (closure)",
      "src/dispatch.ts#inline -> src/dispatch.ts#inline.λ35:24 (closure)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onFlush (value)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onTick (value)",
      "src/dispatch.ts#schedule -> src/tasks.ts#onTick (value)",
    ]);
  });

  it("gives each dispatch edge the concurrency facet, frontend provenance and a span in its source file", async () => {
    const { edges } = await extract();
    const dispatches = edges.filter((e) => e.kind === "concurrency.dispatches");
    expect(dispatches).toHaveLength(16);
    for (const e of dispatches) {
      expect(e.facet).toBe("concurrency");
      expect(e.provenance).toEqual({ frontend: "frontend-typescript", confidence: "exact" });
      expect(e.span?.file).toBe(fileOf(e.from));
    }
  });

  it("spans each dispatch over the call that makes it, including a module-level timer", async () => {
    const { edges } = await extract();
    const awaited = edges.find((e) => e.kind === "concurrency.dispatches" && e.from === "src/dispatch.ts#load");
    expect(awaited?.span).toEqual({ file: "src/dispatch.ts", start: [4, 15], end: [4, 30] });
    const moduleTimer = edges.find((e) => e.kind === "concurrency.dispatches" && e.from === "src/dispatch.ts#(module)");
    expect(moduleTimer?.span).toEqual({ file: "src/dispatch.ts", start: [47, 0], end: [47, 21] });
  });
});

describe("dependsOn", () => {
  it("makes spawns.ts depend on the scripts it resolves, and on the missing ones so creating them re-extracts it", async () => {
    const { dependsOn } = await extract();
    expect(dependsOn.get("src/spawns.ts")).toEqual(
      expect.arrayContaining(["src/crunch.ts", "src/child.ts", "src/missing.ts"]),
    );
  });
});
