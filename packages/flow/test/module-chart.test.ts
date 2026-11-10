import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { buildFileFlow, type FileFlow, type FunctionFlow } from "../src/index.js";

// A worker's top-level code installs its handler. The module chart shows that as an "on message ▸" step that opens
// the handler, and the handler's chart shows the call and the postMessage.
const SOURCE = `import { verify } from "./verify";

const ctx = self as unknown as Worker;
ctx.onmessage = (e: MessageEvent) => {
  const r = verify(e.data);
  ctx.postMessage(r);
};
`;
const VERIFY = `export function verify(x: number): number {
  return x + 1;
}
`;

let dir: string;
let flow: FileFlow;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "module-chart-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "worker.ts"), SOURCE);
  writeFileSync(join(dir, "src", "verify.ts"), VERIFY);
  const files = ["src/worker.ts", "src/verify.ts"];
  const ctx = {
    root: { path: dir, name: "worker", allowBuildTools: false },
    files,
    listFiles: () => [...files],
    readFile: async (rel: string) => readFileSync(join(dir, rel), "utf8"),
    log: () => undefined,
  };
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) nodes.push(record.node);
      if ("edge" in record) edges.push(record.edge);
    }
  }
  flow = buildFileFlow("src/worker.ts", nodes, edges);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const topLevel = (): FunctionFlow => {
  const f = flow.functions.find((x) => x.id === "src/worker.ts#(module)");
  if (!f) throw new Error(`no module chart; have ${flow.functions.map((x) => `${x.id}:${x.name}`).join(", ")}`);
  return f;
};

describe("module chart", () => {
  it("names the top-level chart by its file, not (module)", () => {
    expect(topLevel().name).toBe("worker.ts · top level");
    expect(flow.functions.some((f) => f.name === "(module)")).toBe(false);
  });

  it("shows the handler assignment as a clickable step that targets the lambda", () => {
    const step = topLevel().nodes.find((n) => n.label === "on message ▸");
    expect(step).toBeDefined();
    expect(step?.target).toMatch(/^src\/worker\.ts#λ/);
    // The step opens the handler's own chart, which is in the file's charts.
    expect(flow.functions.some((f) => f.id === step?.target)).toBe(true);
  });

  it("opens the handler with the verify call and the postMessage", () => {
    const handler = flow.functions.find((f) => f.id.startsWith("src/worker.ts#λ"));
    expect(handler).toBeDefined();
    const labels = (handler as FunctionFlow).nodes.map((n) => n.label);
    expect(labels).toContain("verify()");
    expect(labels.some((l) => l.includes("postMessage"))).toBe(true);
  });
});
