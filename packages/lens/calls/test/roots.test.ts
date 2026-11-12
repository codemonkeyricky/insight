import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { lensCalls } from "../src/index.js";

const ctx = () => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config: undefined,
  resultOf: () => undefined,
});

const fn = (file: string, id: string, attrs: Record<string, unknown>) =>
  fx.node(`${file}#${id}`, "structure", "structure.function", { parent: file, attrs: { name: id, ...attrs }, span: fx.span(file, 0, 0, 0, 1) });

/**
 * main.ts starts a worker (its module is a spawn target) and a page entry. worker.ts installs a handler at module level
 * and the handler calls verify. script.ts is run on its own (no file imports it), and calls helper at top level.
 * dead is never called from anywhere.
 */
const view = () =>
  fx.view({
    nodes: [
      fx.node("src/main.ts", "structure", "structure.file"),
      fn("src/main.ts", "main", { exported: true }),
      fx.node("src/main.ts@spawn:2:0", "concurrency", "concurrency.spawn-thread", { parent: "src/main.ts#main", attrs: { api: "Worker" }, span: fx.span("src/main.ts", 2, 0, 2, 9) }),
      fx.node("src/worker.ts", "structure", "structure.file"),
      fn("src/worker.ts", "(module)", { module: true }),
      fn("src/worker.ts", "λ4:17", { anonymous: true }),
      fn("src/verify.ts", "verify", {}),
      fn("src/script.ts", "(module)", { module: true }),
      fn("src/script.ts", "helper", {}),
      fn("src/dead.ts", "dead", {}),
    ],
    edges: [
      fx.edge("src/main.ts@spawn:2:0", "src/worker.ts#(module)", "concurrency", "concurrency.spawns", { attrs: { how: "thread" } }),
      fx.edge("src/worker.ts#(module)", "src/worker.ts#λ4:17", "calls", "calls.reference", { attrs: { how: "handler" } }),
      fx.edge("src/worker.ts#λ4:17", "src/verify.ts#verify", "calls", "calls.call"),
      fx.edge("src/script.ts#(module)", "src/script.ts#helper", "calls", "calls.call"),
    ],
  });

describe("lensCalls roots", () => {
  it("treats a spawned worker module, its handler and a standalone script as roots, and flags only dead code", async () => {
    const result = await lensCalls.run(view(), ctx());
    const flagged = result.findings.map((f) => f.nodes?.[0]).sort();
    expect(flagged).toEqual(["src/dead.ts#dead"]);
  });
});
