import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// Phase 4a: the local a call's result goes into (`calls.call.attrs.binds`) and the locals a branch or loop condition reads
// (`flow.branch.attrs.reads`, `flow.loop.attrs.reads`).

const SOURCE = `const LIMIT = 10;

function pair(): { a: number; b: number } {
  return { a: 1, b: 2 };
}

function localLog(): void {}

async function fetchX(): Promise<number> {
  return 1;
}

function parse(s: string): number {
  return s.length;
}

function loadConfig(): { debug: boolean } {
  return { debug: true };
}

export async function run(items: number[], n: number): Promise<void> {
  const cfg = loadConfig();
  let count = parse("x");
  count = parse("y");
  const { a, b } = pair();
  const r = await fetchX();
  if (cfg.debug && n > LIMIT) {
    localLog();
  }
  while (count > n) {
    count--;
  }
  for (const x of items) {
    localLog();
  }
  localLog();
  return a && b && r ? undefined : undefined;
}
`;

let nodes: IRNode[];
let edges: IREdge[];
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-binds-reads-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "binds-reads", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, "src", "use.ts"), SOURCE);
  const ctx = {
    root: { path: dir, name: "binds-reads", allowBuildTools: false },
    files: ["src/use.ts"],
    listFiles: () => ["src/use.ts"],
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

/** The calls.call edges by callee text. */
const calls = (callee: string): IREdge[] => edges.filter((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

const branches = (kind: "flow.branch" | "flow.loop"): IRNode[] => nodes.filter((n) => n.kind === kind);

describe("frontend-typescript binds and reads", () => {
  it("binds a const call result", () => {
    expect(calls("loadConfig")).toHaveLength(1);
    expect(calls("loadConfig")[0]?.attrs?.binds).toBe("cfg");
  });

  it("binds a let declaration and a later assignment to the same local", () => {
    const parsed = calls("parse");
    expect(parsed).toHaveLength(2);
    expect(parsed.map((e) => e.attrs?.binds)).toEqual(["count", "count"]);
  });

  it("binds every name of a destructuring", () => {
    expect(calls("pair")).toHaveLength(1);
    expect(calls("pair")[0]?.attrs?.binds).toEqual(["a", "b"]);
  });

  it("binds an awaited call result, with await transparent", () => {
    expect(calls("fetchX")).toHaveLength(1);
    expect(calls("fetchX")[0]?.attrs?.binds).toBe("r");
  });

  it("reads the locals of an if with a compound condition, excluding a module constant", () => {
    const branch = branches("flow.branch").find((n) => String(n.attrs.condition).includes("cfg.debug"));
    expect(branch?.attrs.reads).toEqual(["cfg", "n"]);
  });

  it("reads the locals of a while condition", () => {
    const loop = branches("flow.loop").find((n) => n.attrs.variant === "while");
    expect(loop?.attrs.reads).toEqual(["count", "n"]);
  });

  it("reads the iterable of a for-of loop, not the loop variable", () => {
    const loop = branches("flow.loop").find((n) => n.attrs.variant === "for-of");
    expect(loop?.attrs.reads).toEqual(["items"]);
  });
});
