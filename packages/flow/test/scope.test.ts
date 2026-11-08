import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { SCOPE_FUNCTION_LIMIT, summarizeScope, type ScopeFlow } from "../src/index.js";

const FILES: Record<string, string> = {
  "src/app/main.ts": `import { add } from "../lib/math.js";

export const answer = add(40, 2);

export function run(): number {
  return add(1, 2);
}

export function start(): number {
  return run() + answer;
}
`,
  "src/lib/math.ts": `export function add(a: number, b: number): number {
  return a + b;
}

export function double(n: number): number {
  return add(n, n);
}

export class Counter {
  total = 0;

  increment(): void {
    this.total = add(this.total, 1);
  }
}
`,
};

const ADD = "src/lib/math.ts#add";
const PROVENANCE = { frontend: "test", confidence: "exact" as const };
let nodes: IRNode[];
let edges: IREdge[];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-scope-flow-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "scope-sample", type: "module" }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    nodes = [];
    edges = [];
    const ctx = {
      root: { path: dir, name: "scope-sample", allowBuildTools: false },
      files: Object.keys(FILES),
      listFiles: () => Object.keys(FILES),
      readFile: async (rel: string) => FILES[rel] ?? "",
      log: () => undefined,
    };
    for await (const batch of frontend.extract(ctx)) {
      for (const r of batch.records) {
        if ("node" in r) nodes.push(r.node);
        else if ("edge" in r) edges.push(r.edge);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The scoped IR of some files, cut the way core's scopeDoc cuts it: the local records, plus an
 * external stub for the far end of each kept edge. Only string targets are kept as far ends.
 */
function cut(files: string[]): { nodes: IRNode[]; edges: IREdge[] } {
  const inside = new Set(files);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isLocal = (id: string) => {
    const n = byId.get(id);
    return inside.has(id) || (n?.span !== undefined && inside.has(n.span.file));
  };
  const kept = edges.filter((e) => isLocal(e.from) || (typeof e.to === "string" && isLocal(e.to)));
  const stubs = new Map<string, IRNode>();
  const far = (id: string) => {
    if (isLocal(id) || stubs.has(id)) return;
    const orig = byId.get(id);
    stubs.set(id, {
      id,
      facet: orig?.facet ?? "structure",
      kind: orig?.kind ?? "structure.function",
      attrs: { ...orig?.attrs, external: true },
      provenance: PROVENANCE,
    });
  };
  for (const e of kept) {
    far(e.from);
    if (typeof e.to === "string") far(e.to);
  }
  const local = nodes.filter((n) => n.span !== undefined && inside.has(n.span.file));
  return { nodes: [...local, ...stubs.values()], edges: kept };
}

const scoped = (files: string[]): ScopeFlow => {
  const c = cut(files);
  return summarizeScope(c.nodes, c.edges, files);
};

const idOf = (flow: ScopeFlow, name: string): string => {
  const f = flow.functions.find((x) => x.name === name);
  if (!f) throw new Error(`no function ${name}; have ${flow.functions.map((x) => x.name).join(", ")}`);
  return f.id;
};

describe("summarizeScope on the sample project", () => {
  it("makes a call into another file external at file scope and resolved at folder scope", () => {
    const file = scoped(["src/app/main.ts"]);
    const folder = scoped(["src/app/main.ts", "src/lib/math.ts"]);
    const run = idOf(file, "run");

    expect(file.calls.find((c) => c.from === run && c.to === ADD)).toEqual({ from: run, to: ADD, count: 1, external: true });
    expect(file.externals.find((e) => e.id === ADD)).toEqual({ id: ADD, name: "add", file: "src/lib/math.ts" });
    expect(file.stats).toMatchObject({ calls: 3, resolved: 1, external: 2, unresolved: 0, inbound: 0 });

    expect(folder.calls.find((c) => c.from === run && c.to === ADD)).toEqual({ from: run, to: ADD, count: 1, external: false });
    expect(folder.externals).toEqual([]);
    expect(folder.stats).toMatchObject({ calls: 5, resolved: 5, external: 0 });
  });

  it("resolves more calls as the scope widens, never fewer", () => {
    const lib = scoped(["src/lib/math.ts"]);
    const app = scoped(["src/app/main.ts"]);
    const all = scoped(Object.keys(FILES));
    // Each file alone resolves only its own calls; the project resolves every call.
    expect([lib.stats.resolved, all.stats.resolved]).toEqual([2, 5]);
    expect([app.stats.resolved, all.stats.resolved]).toEqual([1, 5]);
    expect([app.stats.external, all.stats.external]).toEqual([2, 0]);
    expect(all.stats.calls).toBe(lib.stats.calls + app.stats.calls);
  });

  it("flags a function called from outside the scope and keeps it out of the entries", () => {
    const lib = scoped(["src/lib/math.ts"]);
    const add = lib.functions.find((f) => f.id === ADD);
    expect(add?.calledFromOutside).toBe(true);
    expect(lib.stats).toMatchObject({ calls: 2, resolved: 2, external: 0, inbound: 2 });
    expect(lib.entries).not.toContain(ADD);
    expect(lib.entries.map((id) => lib.functions.find((f) => f.id === id)?.name).sort()).toEqual(["Counter.increment", "double"]);
    expect(lib.files).toEqual([expect.objectContaining({ file: "src/lib/math.ts", functions: 3, calledFromOutside: true })]);
  });

  it("lists the entries of a folder: functions that nothing calls", () => {
    const folder = scoped(["src/app/main.ts", "src/lib/math.ts"]);
    const names = folder.entries.map((id) => folder.functions.find((f) => f.id === id)?.name).sort();
    // run is called by start, so only start, double and the method have no caller.
    expect(names).toEqual(["Counter.increment", "double", "start"]);
    expect(folder.functions.some((f) => f.calledFromOutside)).toBe(false);
  });

  it("counts flow facts per function the same way the charts do", () => {
    const folder = scoped(["src/app/main.ts", "src/lib/math.ts"]);
    const run = folder.functions.find((f) => f.name === "run");
    expect(run).toMatchObject({ file: "src/app/main.ts", line: 5, steps: 1, decisions: 0, loops: 0, exits: 1 });
    const increment = folder.functions.find((f) => f.name === "Counter.increment");
    expect(increment).toMatchObject({ file: "src/lib/math.ts", async: false, steps: 1 });
  });
});

/** A function node in one file, one line per function. */
function fn(file: string, name: string, line: number): IRNode {
  return {
    id: `${file}#${name}`,
    facet: "structure",
    kind: "structure.function",
    span: { file, start: [line, 0], end: [line + 1, 1] },
    attrs: { name },
    provenance: PROVENANCE,
  };
}

/** A call edge from one function to a target, with a span in the caller's file. */
function call(from: string, to: IREdge["to"], file: string, line: number): IREdge {
  return {
    from,
    to,
    facet: "calls",
    kind: "calls.call",
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: { callee: typeof to === "string" ? (to.split("#")[1] ?? to) : "call" },
    provenance: PROVENANCE,
  };
}

/** `count` functions in one file, each calling the next. */
function chain(file: string, count: number): { nodes: IRNode[]; edges: IREdge[] } {
  const ns = Array.from({ length: count }, (_, i) => fn(file, `f${i}`, i));
  const es = Array.from({ length: count - 1 }, (_, i) => call(`${file}#f${i}`, `${file}#f${i + 1}`, file, i));
  return { nodes: ns, edges: es };
}

describe("summarizeScope on synthetic IR", () => {
  it("is empty for an empty scope", () => {
    expect(summarizeScope([], [])).toEqual({
      granularity: "functions",
      functions: [],
      unreferenced: [],
      calls: [],
      externals: [],
      entries: [],
      files: [],
      stats: {
        functions: 0,
        files: 0,
        calls: 0,
        resolved: 0,
        external: 0,
        unresolved: 0,
        inbound: 0,
        entries: 0,
        functionsTotal: 0,
        functionsTests: 0,
        unreferenced: 0,
        unreferencedTests: 0,
        unreferencedOutside: 0,
      },
    });
  });

  it("lists every function up to the limit and aggregates per file above it", () => {
    expect(SCOPE_FUNCTION_LIMIT).toBe(400);
    const atLimit = chain("src/big.ts", SCOPE_FUNCTION_LIMIT);
    const atLimitFlow = summarizeScope(atLimit.nodes, atLimit.edges, ["src/big.ts"]);
    expect(atLimitFlow.granularity).toBe("functions");
    expect(atLimitFlow.functions).toHaveLength(SCOPE_FUNCTION_LIMIT);
    expect(atLimitFlow.entries).toEqual(["src/big.ts#f0"]);

    const over = chain("src/big.ts", SCOPE_FUNCTION_LIMIT + 1);
    const overFlow = summarizeScope(over.nodes, over.edges, ["src/big.ts"]);
    expect(overFlow.granularity).toBe("files");
    expect(overFlow.functions).toEqual([]);
    expect(overFlow.calls).toEqual([]);
    expect(overFlow.files).toEqual([expect.objectContaining({ file: "src/big.ts", functions: SCOPE_FUNCTION_LIMIT + 1 })]);
    expect(overFlow.entries).toEqual(["src/big.ts"]);
    expect(overFlow.stats).toMatchObject({ functions: SCOPE_FUNCTION_LIMIT + 1, calls: SCOPE_FUNCTION_LIMIT, resolved: SCOPE_FUNCTION_LIMIT, entries: 1 });
  });

  it("aggregates calls per pair of files and per outside file when the scope is large", () => {
    const a = Array.from({ length: SCOPE_FUNCTION_LIMIT }, (_, i) => fn("src/a.ts", `f${i}`, i));
    const b = fn("src/b.ts", "g", 0);
    const outside: IRNode = { id: "lib/x.ts#y", facet: "structure", kind: "structure.function", attrs: { name: "y", external: true }, provenance: PROVENANCE };
    const calls = [
      call("src/a.ts#f0", "src/b.ts#g", "src/a.ts", 0),
      call("src/a.ts#f1", "src/b.ts#g", "src/a.ts", 1),
      call("src/a.ts#f2", "src/b.ts#g", "src/a.ts", 2),
      call("src/a.ts#f5", "lib/x.ts#y", "src/a.ts", 5),
    ];
    const flow = summarizeScope([...a, b, outside], calls, ["src/a.ts", "src/b.ts"]);
    expect(flow.granularity).toBe("files");
    expect(flow.calls).toEqual([
      { from: "src/a.ts", to: "lib/x.ts", count: 1, external: true },
      { from: "src/a.ts", to: "src/b.ts", count: 3, external: false },
    ]);
    expect(flow.externals).toEqual([{ id: "lib/x.ts", name: "lib/x.ts", file: "lib/x.ts" }]);
    expect(flow.entries).toEqual(["src/a.ts"]);
    expect(flow.files.map((f) => [f.file, f.functions])).toEqual([
      ["src/a.ts", SCOPE_FUNCTION_LIMIT],
      ["src/b.ts", 1],
    ]);
    expect(flow.stats).toEqual({
      functions: SCOPE_FUNCTION_LIMIT + 1,
      files: 2,
      calls: 4,
      resolved: 3,
      external: 1,
      unresolved: 0,
      inbound: 0,
      entries: 1,
      functionsTotal: SCOPE_FUNCTION_LIMIT + 1,
      functionsTests: 0,
      // Every f_i of src/a.ts is uncalled; g is called by f0 to f2.
      unreferenced: SCOPE_FUNCTION_LIMIT,
      unreferencedTests: 0,
      unreferencedOutside: 0,
    });
    expect(flow.unreferenced).toHaveLength(SCOPE_FUNCTION_LIMIT);
  });

  it("counts an unresolved call once and keeps each candidate of an ambiguous call", () => {
    const nodes = [fn("src/a.ts", "f", 0), fn("src/a.ts", "g", 4), fn("src/b.ts", "h", 0)];
    const edges = [
      call("src/a.ts#f", { unresolved: { scheme: "dynamic", text: "obj.m" } }, "src/a.ts", 1),
      call("src/a.ts#f", { candidates: ["src/a.ts#g", "src/b.ts#h"] }, "src/a.ts", 2),
    ];
    const flow = summarizeScope(nodes, edges, ["src/a.ts", "src/b.ts"]);
    expect(flow.calls).toEqual([
      { from: "src/a.ts#f", to: "src/a.ts#g", count: 1, external: false, candidate: true },
      { from: "src/a.ts#f", to: "src/b.ts#h", count: 1, external: false, candidate: true },
    ]);
    expect(flow.stats).toMatchObject({ calls: 2, resolved: 1, external: 0, unresolved: 1 });
  });
});
