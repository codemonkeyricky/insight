import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, execPlans } from "../src/index.js";
import { execModelLegacy } from "./exec-model-legacy.js";

// A seeded generator of IR graphs with every kind execModel reads: functions in several folders (one of them test code),
// anonymous closures, module entries, spawns, dispatches, calls, build targets, imports and lock sites. The cached
// execModel must give the same JSON as the copy of the old code for every scope and option.

const PROV = { frontend: "test", confidence: "exact" as const };
const FILES = ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "packages/p/index.ts", "packages/p/worker.ts", "test/t.test.ts", "scripts/run.ts"];
const SCOPES = ["", "src", "src/a", "packages", "packages/p", "test", "scripts", "src/a/x.ts"];
const OPTIONS = [{}, { maxFunctions: 7 }, { maxFunctions: Infinity }, { lambdas: true }, { lambdas: true, maxFunctions: 5 }];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function build(seed: number): { nodes: IRNode[]; edges: IREdge[] } {
  const r = rng(seed * 7919 + 13);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const fnIds: string[] = [];
  const span = (file: string, line: number) => ({ file, start: [line, 0] as [number, number], end: [line + 2, 1] as [number, number] });
  for (const file of FILES) {
    const count = 2 + Math.floor(r() * 3);
    for (let i = 0; i < count; i++) {
      const name = `f${i}`;
      const id = `${file}#${name}`;
      fnIds.push(id);
      const attrs: Record<string, unknown> = { name };
      if (i === 0 && r() < 0.4) attrs.name = "main";
      nodes.push({ id, facet: "structure", kind: "structure.function", span: span(file, i * 5), attrs, provenance: PROV });
    }
    if (r() < 0.6) {
      const id = `${file}#(module)`;
      fnIds.push(id);
      const attrs: Record<string, unknown> = { name: "(module)", module: true };
      if (r() < 0.3) attrs.htmlEntry = true;
      if (r() < 0.3) attrs.nodeEntry = true;
      if (r() < 0.3) attrs.packageEntry = true;
      if (r() < 0.2) attrs.programEntry = { kind: "bin", pkg: "p", name: "p" };
      nodes.push({ id, facet: "structure", kind: "structure.function", span: span(file, 0), attrs, provenance: PROV });
    }
    if (r() < 0.5) nodes.push({ id: `${file}#hidden`, facet: "structure", kind: "structure.file", span: span(file, 0), attrs: {}, provenance: PROV });
  }
  // Anonymous functions (closures), each written in a function or a file.
  for (let i = 0; i < 6; i++) {
    const file = pick(FILES);
    const parent = r() < 0.5 ? pick(fnIds.filter((id) => id.startsWith(`${file}#`))) ?? file : file;
    const id = `${file}#λ${i}`;
    fnIds.push(id);
    nodes.push({ id, facet: "structure", kind: "structure.function", span: span(file, 20 + i), parent, attrs: { name: `λ${i}`, anonymous: true }, provenance: PROV });
  }
  // Build targets over some files.
  for (let i = 0; i < 2; i++) {
    const tid = `//bin:${i}`;
    nodes.push({ id: tid, facet: "packaging", kind: "packaging.build-target", attrs: { name: `bin${i}`, targetKind: r() < 0.5 ? "cc_binary" : "add_executable" }, provenance: PROV });
    for (const f of FILES) if (r() < 0.4) edges.push({ from: tid, to: f, facet: "packaging", kind: "packaging.target-contains", provenance: PROV });
  }
  // Imports, some type-only.
  for (let i = 0; i < 12; i++) {
    const from = pick(FILES);
    const to = pick(FILES);
    if (from === to) continue;
    edges.push({ from, to, facet: "packaging", kind: "packaging.import", attrs: r() < 0.3 ? { typeOnly: true } : {}, provenance: PROV });
  }
  // Calls, closures and references between functions and anonymous functions.
  const all = [...fnIds];
  for (let i = 0; i < 60; i++) {
    const from = pick(all);
    const to = pick(all);
    const file = fileOfId(from);
    if (r() < 0.2) {
      edges.push({ from, to, facet: "calls", kind: "calls.reference", span: span(file, i), attrs: { how: "closure" }, provenance: PROV });
    } else if (r() < 0.8) {
      edges.push({ from, to, facet: "calls", kind: "calls.call", span: span(file, i), attrs: {}, provenance: PROV });
    } else {
      edges.push({ from, to, facet: "calls", kind: "calls.reference", span: span(file, i), attrs: {}, provenance: PROV });
    }
  }
  // Spawns (a node, with an edge to its target when resolved) and dispatches.
  for (let i = 0; i < 8; i++) {
    const owner = pick(all);
    const file = fileOfId(owner);
    const kind = r() < 0.7 ? "concurrency.spawn-thread" : "concurrency.spawn-process";
    const sid = `${file}@spawn:${i + 1}:2`;
    nodes.push({ id: sid, facet: "concurrency", kind, parent: owner, span: span(file, 40 + i), attrs: { api: "Worker" }, provenance: PROV });
    if (r() < 0.8) {
      const target = r() < 0.2 ? pick(FILES) : pick(all);
      edges.push({ from: sid, to: target, facet: "concurrency", kind: "concurrency.spawns", attrs: { how: r() < 0.5 ? "thread" : "process" }, span: span(file, 40 + i), provenance: PROV });
    }
  }
  for (let i = 0; i < 10; i++) {
    const from = pick(all);
    const file = fileOfId(from);
    const how = pick(["await", "start", "callback", "timer", "microtask", "message"]);
    edges.push({ from, to: pick(all), facet: "concurrency", kind: "concurrency.dispatches", attrs: { how }, span: span(file, 60 + i), provenance: PROV });
  }
  // Lock sites inside functions.
  for (let i = 0; i < 5; i++) {
    const owner = pick(all);
    const file = fileOfId(owner);
    nodes.push({ id: `${file}@lock:${i}`, facet: "sync", kind: "sync.lock-acquire", parent: owner, span: span(file, 80 + i), attrs: { lock: pick(["m", "n"]) }, provenance: PROV });
  }
  return { nodes, edges };
}

function fileOfId(id: string): string {
  const i = id.indexOf("#");
  return i < 0 ? id : id.slice(0, i);
}

describe("execModel: cached plans are byte-identical to the old code", () => {
  it("matches the old execModel on generated graphs for every scope and option", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { nodes, edges } = build(seed);
      for (const scope of SCOPES) {
        for (const opts of OPTIONS) {
          const want = JSON.stringify(execModelLegacy(nodes, edges, scope, opts));
          const got = JSON.stringify(execModel(nodes, edges, scope, opts));
          if (got !== want) throw new Error(`differs: seed=${seed} scope="${scope}" opts=${JSON.stringify(opts)}`);
        }
      }
    }
  });

  it("generates graphs that use threads, programs, dispatches and resources", () => {
    let spawned = 0;
    let programs = 0;
    let dispatches = 0;
    let resources = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { nodes, edges } = build(seed);
      const m = execModel(nodes, edges, "");
      spawned += m.stats.spawns;
      programs += m.programs.length;
      dispatches += m.dispatches.length;
      resources += m.resources.length;
    }
    expect(spawned).toBeGreaterThan(20);
    expect(programs).toBeGreaterThan(20);
    expect(dispatches).toBeGreaterThan(20);
    expect(resources).toBeGreaterThan(5);
  });

  it("gives the same result when the same arrays serve several scopes in a row (cached plans reused)", () => {
    const { nodes, edges } = build(99);
    const order = [...SCOPES, "", ...SCOPES.slice().reverse()];
    for (const scope of order) {
      expect(JSON.stringify(execModel(nodes, edges, scope))).toBe(JSON.stringify(execModelLegacy(nodes, edges, scope)));
    }
  });

  it("returns the same plans object for the same arrays and option, and a different one for lambdas", () => {
    const { nodes, edges } = build(5);
    expect(execPlans(nodes, edges)).toBe(execPlans(nodes, edges));
    expect(execPlans(nodes, edges)).not.toBe(execPlans(nodes, edges, { lambdas: true }));
  });

  it("does not let one scope's program objects leak into another scope", () => {
    const { nodes, edges } = build(7);
    const a = execModel(nodes, edges, "src");
    execModel(nodes, edges, "packages");
    const b = execModel(nodes, edges, "src");
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
