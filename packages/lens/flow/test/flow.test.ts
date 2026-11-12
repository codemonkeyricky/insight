import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { buildFileFlow, type FileFlow, type FunctionFlow } from "../src/index.js";

const SOURCE = `import { execFileSync } from "node:child_process";

export function helper(x: number): number {
  return x + 1;
}

export function decide(n: number): string {
  if (n < 0) {
    return "negative";
  } else if (n === 0) {
    helper(n);
    return "zero";
  }
  return "positive";
}

export function pick(kind: string): number {
  switch (kind) {
    case "a":
      return helper(1);
    case "b":
      helper(2);
      break;
    default:
      throw new Error("bad");
  }
  return 0;
}

export function walk(items: number[]): number {
  let total = 0;
  for (const item of items) {
    if (item < 0) continue;
    total += helper(item);
  }
  return total;
}

export async function load(path: string): Promise<string> {
  try {
    const out = await fetchIt(path);
    return out;
  } catch (err) {
    helper(0);
    throw err;
  } finally {
    helper(9);
  }
}

async function fetchIt(path: string): Promise<string> {
  return path;
}

export function run(): string {
  return execFileSync("git", ["rev-parse", "HEAD"]).toString();
}

export function plain(): number {
  return 1;
}
`;

let flow: FileFlow;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-flow-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "flow-sample", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, "src", "sample.ts"), SOURCE);
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const ctx = {
    root: { path: dir, name: "flow-sample", allowBuildTools: false },
    files: ["src/sample.ts"],
    listFiles: () => ["src/sample.ts"],
    readFile: async () => SOURCE,
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) {
      if ("node" in r) nodes.push(r.node);
      else if ("edge" in r) edges.push(r.edge);
    }
  }
  flow = buildFileFlow("src/sample.ts", nodes, edges);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fn = (name: string): FunctionFlow => {
  const f = flow.functions.find((x) => x.name === name);
  if (!f) throw new Error(`no function ${name}; have ${flow.functions.map((x) => x.name).join(", ")}`);
  return f;
};
const labels = (f: FunctionFlow) => f.nodes.map((n) => n.label);
const edge = (f: FunctionFlow, kind: string) => f.edges.filter((e) => e.kind === kind);

describe("buildFileFlow", () => {
  it("lists every function of the file in source order", () => {
    expect(flow.functions.map((f) => f.name)).toEqual(["helper", "decide", "pick", "walk", "load", "fetchIt", "run", "plain"]);
  });

  it("charts a function with no decisions as start, steps, end", () => {
    const f = fn("plain");
    expect(f.nodes.map((n) => n.role)).toEqual(["start", "return"]);
    expect(f.stats).toMatchObject({ decisions: 0, loops: 0, exits: 1 });
    // A function that always returns has no end node: control never falls out of the bottom.
    expect(f.nodes.some((n) => n.role === "end")).toBe(false);
  });

  it("charts if / else if with yes and no paths and a call in one arm", () => {
    const f = fn("decide");
    expect(f.stats).toMatchObject({ decisions: 2, exits: 3 });
    expect(labels(f)).toContain("n < 0");
    expect(labels(f)).toContain("n === 0");
    expect(labels(f)).toContain("helper()");
    const arms = [...edge(f, "true"), ...edge(f, "false")].map((e) => e.label);
    expect(arms.sort()).toEqual(["no", "no", "yes", "yes"]);
    // The else-if sits inside the else arm of the first decision: its decision node is below the first.
    const first = f.nodes.find((n) => n.label === "n < 0");
    const second = f.nodes.find((n) => n.label === "n === 0");
    expect(second!.y).toBeGreaterThan(first!.y);
  });

  it("charts a switch with one column per case and the implicit no-match path", () => {
    const f = fn("pick");
    expect(edge(f, "case").map((e) => e.label)).toEqual(["case \"a\"", "case \"b\"", "default"]);
    expect(f.nodes.filter((n) => n.role === "break")).toHaveLength(1);
    expect(f.nodes.filter((n) => n.role === "throw")).toHaveLength(1);
  });

  it("charts a loop with a back edge and an exit edge", () => {
    const f = fn("walk");
    expect(f.stats.loops).toBe(1);
    expect(edge(f, "back")).toHaveLength(1);
    expect(edge(f, "exit").map((e) => e.label)).toEqual(["done"]);
    expect(edge(f, "each")).toHaveLength(1);
    expect(f.nodes.some((n) => n.role === "continue")).toBe(true);
    const loop = f.nodes.find((n) => n.role === "loop");
    expect(loop?.label).toContain("of items");
  });

  it("charts try, catch and finally with an exception path", () => {
    const f = fn("load");
    expect(f.async).toBe(true);
    expect(edge(f, "exception").map((e) => e.label)).toEqual(["throws"]);
    expect(labels(f)).toContain("finally");
    // The wrapped call is one step: await fetchIt(), not an await step plus a call step.
    expect(labels(f).filter((l) => l.includes("fetchIt"))).toEqual(["await fetchIt()"]);
    const target = f.nodes.find((n) => n.label === "await fetchIt()")?.target;
    expect(target).toBe("src/sample.ts#fetchIt");
  });

  it("shows side effects and spawned processes as one step", () => {
    const f = fn("run");
    const spawn = f.nodes.filter((n) => n.role === "spawn");
    expect(spawn).toHaveLength(1);
    expect(spawn[0]?.label).toContain("git");
    // The same call is both a spawn and a proc.exec effect; it must not appear twice.
    expect(f.nodes.filter((n) => n.label.includes("git"))).toHaveLength(1);
  });

  it("gives every edge two or more points that start and end on its nodes", () => {
    for (const f of flow.functions) {
      const byId = new Map(f.nodes.map((n) => [n.id, n]));
      for (const e of f.edges) {
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        const from = byId.get(e.from)!;
        const to = byId.get(e.to)!;
        expect(from).toBeDefined();
        expect(to).toBeDefined();
        const [sx, sy] = e.points[0]!;
        const [tx, ty] = e.points[e.points.length - 1]!;
        // Edges leave a node from its bottom or side and arrive at its top or side.
        expect(sx).toBeGreaterThanOrEqual(from.x - 0.5);
        expect(sx).toBeLessThanOrEqual(from.x + from.w + 0.5);
        expect(sy).toBeGreaterThanOrEqual(from.y - 0.5);
        expect(sy).toBeLessThanOrEqual(from.y + from.h + 0.5);
        expect(tx).toBeGreaterThanOrEqual(to.x - 0.5);
        expect(tx).toBeLessThanOrEqual(to.x + to.w + 0.5);
        expect(ty).toBeGreaterThanOrEqual(to.y - 0.5);
        expect(ty).toBeLessThanOrEqual(to.y + to.h + 0.5);
      }
    }
  });

  it("keeps nodes inside the chart and does not overlap them", () => {
    for (const f of flow.functions) {
      for (const n of f.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w).toBeLessThanOrEqual(f.width + 0.5);
        expect(n.y + n.h).toBeLessThanOrEqual(f.height + 0.5);
      }
      for (let i = 0; i < f.nodes.length; i++) {
        for (let j = i + 1; j < f.nodes.length; j++) {
          const a = f.nodes[i]!;
          const b = f.nodes[j]!;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${f.name}: ${a.label} overlaps ${b.label}`).toBe(true);
        }
      }
    }
  });

  it("is empty for a file the IR has no functions for", () => {
    expect(buildFileFlow("nope.ts", [], []).functions).toEqual([]);
  });
});
