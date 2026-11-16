import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildFileFlow, couplingIndex, execModel, buildExecScene } from "../src/index.js";
import { indexFixture } from "./coupling-fixture.js";

// Unguarded shared state (phase 4): a mutable variable written from functions on two or more threads where no lock is
// held in common at every write. The hand-built IR gives the threads and lock frames; the real-frontend fixture checks the
// TypeScript extraction of a module-level global written by a page and by a Worker it starts.

const sp = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line, 10] as [number, number] });

const fnNode = (file: string, name: string, line: number): IRNode =>
  fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name, qualifiedName: name, async: false }, span: sp(file, line) });

const varNode = (file: string, id: string): IRNode =>
  fx.node(id, "data", "data.variable", { parent: file, attrs: { name: "g", qualifiedName: "g", storage: "module", exported: true, mutable: true }, span: sp(file, 1) });

const write = (from: string, to: string, file: string, line: number): IREdge =>
  fx.edge(from, to, "data", "data.write", { attrs: { how: "assign" }, span: sp(file, line) });

const read = (from: string, to: string, file: string, line: number): IREdge =>
  fx.edge(from, to, "data", "data.read", { attrs: {}, span: sp(file, line) });

const call = (from: string, to: string, file: string, line: number): IREdge =>
  fx.edge(from, to, "calls", "calls.call", { attrs: { callee: to.split("#")[1] ?? to }, span: sp(file, line) });

const spawnNode = (file: string, line: number, owner: string): IRNode =>
  fx.node(`${file}@spawn:${line + 1}:2`, "concurrency", "concurrency.spawn-thread", { parent: owner, attrs: {}, span: sp(file, line) });

const spawnEdge = (file: string, line: number, to: string): IREdge =>
  fx.edge(`${file}@spawn:${line + 1}:2`, to, "concurrency", "concurrency.spawns", { attrs: { how: "thread" }, span: sp(file, line) });

const lockNode = (file: string, line: number, parent: string, lock: string, op: "acquire" | "release"): IRNode =>
  fx.node(`${file}@${op}:${line}`, "sync", `sync.lock-${op}`, { parent, attrs: { lock, mode: "exclusive" }, span: sp(file, line) });

const M = "src/m.ts";
const W = "src/w.ts";
const G = "src/m.ts#var:g";

/** A page function `main` that starts a Worker `work`; both write `g`. */
function threadsFixture(): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes = [fnNode(M, "main", 0), spawnNode(M, 4, `${M}#main`), fnNode(W, "work", 0), varNode(M, G)];
  const edges = [spawnEdge(M, 4, `${W}#work`), write(`${M}#main`, G, M, 2), write(`${W}#work`, G, W, 2)];
  return { nodes, edges };
}

const unguardedOf = (nodes: IRNode[], edges: IREdge[]) => couplingIndex(nodes, edges).unguarded;

describe("unguarded shared state", () => {
  it("flags a variable written on the main thread and a Worker thread with no locks", () => {
    const { nodes, edges } = threadsFixture();
    const u = unguardedOf(nodes, edges);
    expect(u.variables.get(G)).toMatchObject({ name: "g", threads: ["main", `${M}@spawn:5:2`] });
    expect([...u.threads].sort()).toEqual(["main", `${M}@spawn:5:2`]);
    // The thread boxes carry the badge too.
    const model = execModel(nodes, edges, "", { maxFunctions: Infinity });
    expect(model.threads.map((t) => t.unguardedWrites)).toEqual([["g"], ["g"]]);
    const scene = buildExecScene(model);
    const threads = [...scene.nodes.values()].filter((n) => n.kind === "thread");
    expect(threads.map((n) => n.unguarded)).toEqual([["g"], ["g"]]);
  });

  it("does not flag writes both under the same lock", () => {
    const { nodes, edges } = threadsFixture();
    nodes.push(lockNode(M, 1, `${M}#main`, "m", "acquire"), lockNode(M, 3, `${M}#main`, "m", "release"));
    nodes.push(lockNode(W, 1, `${W}#work`, "m", "acquire"), lockNode(W, 3, `${W}#work`, "m", "release"));
    expect(unguardedOf(nodes, edges).variables.size).toBe(0);
  });

  it("flags when one of the writes is unlocked", () => {
    const { nodes, edges } = threadsFixture();
    nodes.push(lockNode(M, 1, `${M}#main`, "m", "acquire"), lockNode(M, 3, `${M}#main`, "m", "release"));
    const u = unguardedOf(nodes, edges);
    expect([...u.variables.keys()]).toEqual([G]);
  });

  it("does not flag writes on one thread only", () => {
    // The Worker thread exists but writes nothing.
    const nodes = [fnNode(M, "main", 0), spawnNode(M, 4, `${M}#main`), fnNode(W, "work", 0), varNode(M, G)];
    const edges = [spawnEdge(M, 4, `${W}#work`), write(`${M}#main`, G, M, 2)];
    expect(unguardedOf(nodes, edges).variables.size).toBe(0);
  });

  it("does not flag two functions of one thread writing the same variable", () => {
    const nodes = [fnNode(M, "main", 0), fnNode(M, "helper", 10), varNode(M, G)];
    const edges = [call(`${M}#main`, `${M}#helper`, M, 2), write(`${M}#main`, G, M, 3), write(`${M}#helper`, G, M, 11)];
    expect(unguardedOf(nodes, edges).variables.size).toBe(0);
  });

  it("marks the kept state write row of the flagged variable, not its read row", () => {
    const { nodes, edges } = threadsFixture();
    // main reads g as well as writing it: only the write row is stamped.
    edges.push(read(`${M}#main`, G, M, 3));
    const flow = buildFileFlow(M, nodes, edges, { coupling: couplingIndex(nodes, edges) });
    const rows = flow.functions.flatMap((f) => f.coupling?.chart.nodes ?? []).filter((n) => n.role === "state");
    const byLabel = new Map(rows.map((n) => [n.label, n.unguarded]));
    expect(byLabel.get("▲ g")).toBe(true);
    expect(byLabel.get("▽ g")).toBeUndefined();
  });

  it("keeps the badge in a file scope when the other writer's thread starts outside it", () => {
    // a.ts starts a Worker that writes g; b.ts writes g too, on the project's main thread. A view scoped to a.ts sees
    // only a.ts's threads, but the project-wide thread map still knows b.ts's writer is on the main thread, so the
    // in-scope Worker's badge is kept.
    const A = "src/a.ts";
    const B = "src/b.ts";
    const nodes = [fnNode(A, "boot", 0), spawnNode(A, 4, `${A}#boot`), fnNode(A, "worker", 6), fnNode(B, "other", 0), varNode(A, G)];
    const edges = [spawnEdge(A, 4, `${A}#worker`), write(`${A}#worker`, G, A, 7), write(`${B}#other`, G, B, 2)];
    expect(unguardedOf(nodes, edges).variables.get(G)?.threads).toHaveLength(2);
    const model = execModel(nodes, edges, A, { maxFunctions: Infinity });
    const worker = model.threads.find((t) => t.id === `${A}@spawn:5:2`);
    expect(worker?.unguardedWrites).toEqual(["g"]);
    const scene = buildExecScene(model);
    const threads = [...scene.nodes.values()].filter((n) => n.kind === "thread");
    expect(threads.map((n) => n.unguarded)).toEqual([["g"]]);
  });
});

describe("unguarded shared state from real TypeScript frontend output", () => {
  const FILES: Record<string, string> = {
    "package.json": JSON.stringify({ name: "worker-state", private: true }),
    "src/main.ts": `globalThis.shared = 0;
new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
`,
    "src/worker.ts": `globalThis.shared = 1;
`,
  };

  it("flags a globalThis property written by the page and by its Worker", async () => {
    const { nodes, edges } = await indexFixture(FILES);
    const u = couplingIndex(nodes, edges).unguarded;
    const variable = [...u.variables.values()].filter((v) => v.name === "globalThis.shared");
    expect(variable).toHaveLength(1);
    expect(variable[0]!.threads).toHaveLength(2);
    expect([...u.threads]).toHaveLength(2);
    const flow = buildFileFlow("src/main.ts", nodes, edges, { coupling: couplingIndex(nodes, edges) });
    const row = flow.functions.flatMap((f) => f.coupling?.chart.nodes ?? []).find((n) => n.role === "state" && n.write);
    expect(row?.unguarded).toBe(true);
    const model = execModel(nodes, edges, "", { maxFunctions: Infinity });
    expect(model.threads.flatMap((t) => t.unguardedWrites ?? [])).toEqual(["globalThis.shared", "globalThis.shared"]);
  });
});
