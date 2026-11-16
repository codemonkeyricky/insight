import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateIR, type IREdge, type IRNode } from "@insight/ir";
import { createCoreRegistry } from "@insight/ir/node";
import frontend from "../src/index.js";

// Phase P2: the data facts the TypeScript frontend emits for the stage view. `calls.call` `attrs.reads` (the locals a call's
// receiver and arguments read), `calls.call` `attrs.bindsType` (the type of the local its result is bound to) and
// `structure.function` `attrs.derives` (the locals each local is derived from).

const FILE = "src/data.ts";

const SOURCE = `const moduleVar = 5;

function sinkA(arg: unknown): void {
  void arg;
}

function sinkB(arg: unknown): void {
  void arg;
}

function sinkC(arg: unknown): void {
  void arg;
}

function helper(x: number): number {
  return x;
}

function pair(x: number): { d: number; e: number } {
  return { d: x, e: x };
}

function loadConfig(): { debug: boolean; level: number } {
  return { debug: true, level: 1 };
}

function anyValue(): any {
  return 1;
}

function wideValue(): { alphaFirst: string; betaSecond: number; gammaThird: boolean; deltaFourth: string[] } {
  return { alphaFirst: "", betaSecond: 1, gammaThird: true, deltaFourth: [] };
}

export function probeReads(items: number[], cfg: { root: string }, flag: boolean): void {
  const local = items.length;
  const api = { fetch(x: number): number { return x; } };
  sinkA({ a: items, b: cfg.root, c: (n: number) => n + local, d: flag });
  api.fetch(items.length);
  sinkB(moduleVar);
}

export function wrapper(cfg: { root: string }): () => void {
  const inner = cfg.root;
  return () => sinkC(inner);
}

export function derive(input: number, other: number): number {
  const a = input + 1;
  let b = 0;
  b = other * 2;
  let c = 0;
  c += input;
  const { d, e } = pair(a);
  const f = helper(input);
  const g = 7;
  function nested(): number {
    const h = other + 100;
    return h;
  }
  const k = () => {
    const m = a;
    return m;
  };
  return nested() + k() + b + c + d + e + f + g;
}

export function reassign(src: number[], seed: number): number {
  let p = 0;
  let q = 0;
  [p, q] = [seed, src.length];
  return p + q;
}

export function bindings(): void {
  const cfg = loadConfig();
  const v = anyValue();
  const { debug, level } = loadConfig();
  const wide = wideValue();
  sinkA(cfg);
  sinkB(v);
  sinkC(debug && level && wide);
}

function sinkD(arg: unknown): void {
  void arg;
}

function stepOne(): number {
  return 1;
}

function stepTwo(v: number): void {
  void v;
}

export const viaConst = (): void => {
  const x = stepOne();
  const y = x;
  stepTwo(y);
};

export class Holder {
  run = (): void => {
    const z = stepOne();
    const w = z;
    stepTwo(w);
  };
}

export function loopOver(): void {
  const items = [stepOne()];
  for (const it of items) sinkD(it);
  const pairs = [{ a: stepOne(), b: 2 }];
  for (const { a, b } of pairs) sinkD(a + b);
  for (const key in items) sinkD(key);
}

export function shadowLoops(items: string[]): void {
  for (const f of items) sinkD(f);
  for (const f of items) sinkD(f);
}

function sinkPair(...rest: unknown[]): void {
  void rest;
}

export function argShapes(xs: string[]): void {
  const n = xs.length;
  sinkPair(xs, 2, n);
  sinkPair(...xs);
  sinkPair(1, "a");
}
`;

let nodes: IRNode[];
let edges: IREdge[];
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-data-attrs-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "data-attrs", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, FILE), SOURCE);
  const ctx = {
    root: { path: dir, name: "data-attrs", allowBuildTools: false },
    files: [FILE],
    listFiles: () => [FILE],
    readFile: async () => SOURCE,
    log: () => undefined,
  };
  nodes = [];
  edges = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) {
      if ("node" in r) nodes.push(r.node);
      else edges.push(r.edge);
    }
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The calls.call edges with a given callee text, in source order. */
const callsTo = (callee: string): IREdge[] => edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

/** The function node with a given name. */
const fnNamed = (name: string): IRNode | undefined => nodes.find((n) => n.kind === "structure.function" && n.attrs.name === name);

describe("frontend-typescript call reads", () => {
  it("reads the locals of a call's receiver and arguments, in first-seen order", () => {
    const [call] = callsTo("sinkA");
    // `items` and `cfg` are parameters, `flag` too. `root` and the property names `a`, `b`, `d` are not reads.
    expect(call?.attrs?.reads).toEqual(["items", "cfg", "flag"]);
  });

  it("does not descend into a function written as an argument, so its captured local is not read here", () => {
    // `local` is read only inside the arrow passed to sinkA, which is its own function.
    expect(callsTo("sinkA")[0]?.attrs?.reads).not.toContain("local");
  });

  it("reads the receiver and the arguments of a method call, but not the member name", () => {
    // `api` is a local of probeReads, `items` a parameter; `fetch` is the member called and is not a read.
    expect(callsTo("api.fetch")[0]?.attrs?.reads).toEqual(["api", "items"]);
  });

  it("omits reads when the call reads only a module variable", () => {
    // sinkB(moduleVar): the only argument is a module variable, so the attribute is absent.
    expect(callsTo("sinkB")[0]?.attrs).not.toHaveProperty("reads");
  });

  it("counts a local of an enclosing function as a local when the call sits in a nested function", () => {
    // `inner` is declared by `wrapper`, which encloses the arrow that makes this call: a closure capture is a local, as for flow.branch reads.
    expect(callsTo("sinkC")[0]?.attrs?.reads).toEqual(["inner"]);
  });
});

describe("frontend-typescript function derives", () => {
  const derives = (name: string): Record<string, string[]> | undefined => fnNamed(name)?.attrs.derives as Record<string, string[]> | undefined;

  it("maps an initializer's and a later compound assignment's locals to the declared local", () => {
    const d = derives("derive");
    expect(d?.a).toEqual(["input"]);
    expect(d?.c).toEqual(["input"]);
  });

  it("maps every later plain assignment, not only the initializer", () => {
    expect(derives("derive")?.b).toEqual(["other"]);
  });

  it("gives every target of a destructuring declaration the whole right side's reads", () => {
    const d = derives("derive");
    expect(d?.d).toEqual(["a"]);
    expect(d?.e).toEqual(["a"]);
  });

  it("does not read a called function's name, and keeps a local whose initializer reads a local through a call", () => {
    expect(derives("derive")?.f).toEqual(["input"]);
  });

  it("omits a local that reads no local", () => {
    expect(derives("derive")).not.toHaveProperty("g");
  });

  it("does not descend into a nested function declaration or a function-valued initializer", () => {
    const d = derives("derive");
    // `h` is local to `nested`, and `m` to the arrow that `k` holds, so neither is an entry of derive.
    expect(d).not.toHaveProperty("h");
    expect(d).not.toHaveProperty("m");
    expect(d).not.toHaveProperty("k");
  });

  it("gives a parameter no entry", () => {
    const d = derives("derive") ?? {};
    expect(d).not.toHaveProperty("input");
    expect(d).not.toHaveProperty("other");
  });

  it("gives each target of an array destructuring assignment the whole right side's reads", () => {
    const d = derives("reassign");
    expect(d?.p).toEqual(["seed", "src"]);
    expect(d?.q).toEqual(["seed", "src"]);
  });

  it("emits derives on every function, empty when it derives nothing", () => {
    expect(fnNamed("sinkA")?.attrs.derives).toEqual({});
  });

  it("computes a const arrow's derives on the arrow, the function the declaration holds", () => {
    // export const viaConst = () => { const x = stepOne(); const y = x; stepTwo(y); }: x reads nothing, y reads x.
    expect(fnNamed("viaConst")?.attrs.derives).toEqual({ y: ["x"] });
  });

  it("computes a class property arrow's derives on the arrow", () => {
    const run = nodes.find((n) => n.kind === "structure.function" && n.attrs.qualifiedName === "Holder.run");
    expect(run?.attrs.derives).toEqual({ w: ["z"] });
  });

  it("gives a for-of or for-in loop variable the reads of its iterable, and each name a destructured one binds", () => {
    expect(fnNamed("loopOver")?.attrs.derives).toEqual({ it: ["items"], a: ["pairs"], b: ["pairs"], key: ["items"] });
  });
});

describe("frontend-typescript function params", () => {
  it("lists a function's parameter names in order", () => {
    expect(fnNamed("derive")?.attrs.params).toEqual(["input", "other"]);
  });

  it("gives a const arrow its own parameters", () => {
    expect(fnNamed("viaConst")?.attrs).not.toHaveProperty("params");
  });
});

describe("frontend-typescript calls.call bindsType", () => {
  it("gives the checker's type of a single bound local", () => {
    expect(callsTo("loadConfig")[0]?.attrs?.bindsType).toBe("{ debug: boolean; level: number; }");
  });

  it("truncates a long type to 60 characters in all, the last one an ellipsis", () => {
    // The wide value's type text is longer than 60 characters: cut to 59 characters and an ellipsis.
    const text = callsTo("wideValue")[0]?.attrs?.bindsType;
    expect(typeof text).toBe("string");
    expect((text as string).length).toBe(60);
    expect((text as string).endsWith("…")).toBe(true);
    expect((text as string).startsWith("{ alphaFirst: string; betaSecond: number;")).toBe(true);
  });

  it("omits bindsType for an any-typed result", () => {
    expect(callsTo("anyValue")[0]?.attrs).not.toHaveProperty("bindsType");
  });

  it("omits bindsType when the call binds several names (a destructuring)", () => {
    const destructured = edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === "loadConfig")[1];
    expect(destructured?.attrs?.binds).toEqual(["debug", "level"]);
    expect(destructured?.attrs).not.toHaveProperty("bindsType");
  });
});

describe("frontend-typescript data attrs validate against the IR schema", () => {
  it("validates every node and edge of the fixture, with the file node the records hang off", () => {
    // The host indexes each file as a structure.file node, and the frontend's records hang off it.
    const fileNode: IRNode = {
      id: FILE,
      facet: "structure",
      kind: "structure.file",
      attrs: { path: FILE, language: "typescript", parseStatus: "ok" },
      provenance: { frontend: "test", confidence: "exact" },
    } as IRNode;
    const text = [
      ...[fileNode, ...nodes].map((node) => ({ node })),
      ...edges.map((edge) => ({ edge })),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const report = validateIR(text, createCoreRegistry());
    expect(report.errors.map((e) => e.message)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("frontend-typescript local keys and argument reads", () => {
  /** The 1-based line of each source line holding the text, in order. */
  const linesWith = (text: string): number[] =>
    SOURCE.split("\n").flatMap((l, i) => (l.includes(text) ? [i + 1] : []));

  it("keys a name declared in two loops of one function by its declaration line", () => {
    const [first, second] = linesWith("for (const f of items) sinkD(f)");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(fnNamed("shadowLoops")?.attrs.derives).toEqual({ [`f@${first}`]: ["items"], [`f@${second}`]: ["items"] });
  });

  it("keys each loop body's read of f to the declaration it sits under", () => {
    const [first, second] = linesWith("for (const f of items) sinkD(f)");
    const at = (line: number) => callsTo("sinkD").filter((e) => e.span?.start[0] === line - 1);
    expect(at(first!)[0]?.attrs.reads).toEqual([`f@${first}`]);
    expect(at(second!)[0]?.attrs.reads).toEqual([`f@${second}`]);
  });

  it("emits argReads with one entry per positional argument", () => {
    const [line] = linesWith("sinkPair(xs, 2, n)");
    const call = callsTo("sinkPair").find((e) => e.span?.start[0] === line! - 1);
    expect(call?.attrs.argReads).toEqual([["xs"], [], ["n"]]);
    expect(call?.attrs).not.toHaveProperty("argSpread");
  });

  it("gives a spread argument's reads at its index and records the index as argSpread", () => {
    const [line] = linesWith("sinkPair(...xs)");
    const call = callsTo("sinkPair").find((e) => e.span?.start[0] === line! - 1);
    expect(call?.attrs.argReads).toEqual([["xs"]]);
    expect(call?.attrs.argSpread).toBe(0);
  });

  it("omits argReads when no argument reads a local", () => {
    const [line] = linesWith('sinkPair(1, "a")');
    const call = callsTo("sinkPair").find((e) => e.span?.start[0] === line! - 1);
    expect(call?.attrs).not.toHaveProperty("argReads");
  });

  it("keeps a name declared once bare", () => {
    expect(fnNamed("argShapes")?.attrs.params).toEqual(["xs"]);
    expect(fnNamed("argShapes")?.attrs.derives).toEqual({ n: ["xs"] });
  });
});
