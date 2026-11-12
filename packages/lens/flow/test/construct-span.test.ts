import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { buildFileFlow, type FileFlow } from "../src/index.js";

// The source spans of control constructs. A click on a construct highlights its whole span in the source panel, so the
// span of a branch, loop, switch or try must cover the whole statement, not only its header.
const SOURCE = `export function pick(a: boolean): number {
  if (a) {
    x();
  } else {
    y();
  }
  for (const i of [1, 2]) {
    z(i);
  }
  return 1;
}

function x(): void {}
function y(): void {}
function z(_i: number): void {}
`;

let flow: FileFlow;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-construct-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "construct-sample", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, "src", "sample.ts"), SOURCE);
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const ctx = {
    root: { path: dir, name: "construct-sample", allowBuildTools: false },
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

describe("construct spans", () => {
  it("gives an if / else branch a span that covers the whole statement, from the if to the closing brace of else", () => {
    const pick = flow.functions.find((f) => f.name === "pick");
    expect(pick).toBeDefined();
    const branch = pick?.nodes.find((n) => n.role === "branch");
    expect(branch?.span).toBeDefined();
    // Lines are 0-based: the `if` is on line 1 and the else's closing brace on line 5.
    expect(branch?.span?.start[0]).toBe(1);
    expect(branch?.span?.end[0]).toBe(5);
  });

  it("gives a loop a span that covers its body", () => {
    const pick = flow.functions.find((f) => f.name === "pick");
    const loop = pick?.nodes.find((n) => n.role === "loop");
    expect(loop?.span?.start[0]).toBe(6);
    expect(loop?.span?.end[0]).toBe(8);
  });
});
