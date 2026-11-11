import { describe, expect, it } from "vitest";
import { irFixtures as fx } from "@insight/sdk";
import { lensCalls } from "../src/index.js";

const ctx = () => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config: undefined,
  resultOf: () => undefined,
});

const fn = (id: string, attrs: Record<string, unknown>) =>
  fx.node(`src/c.ts#${id}`, "structure", "structure.function", { parent: "src/c.ts", attrs: { name: id, ...attrs }, span: fx.span("src/c.ts", 0, 0, 0, 1) });
const closure = (from: string, to: string) => fx.edge(from, to, "calls", "calls.reference", { attrs: { how: "closure" } });

/**
 * main (exported) creates a closure that creates a closure that calls deep. A closure created at module
 * level calls fileCallee. stray is never called and creates a closure of its own.
 */
const view = () =>
  fx.view({
    nodes: [
      fx.node("src/c.ts", "structure", "structure.file"),
      fn("main", { exported: true }),
      fn("main.λ3:4", { anonymous: true }),
      fn("main.λ3:4.λ4:6", { anonymous: true }),
      fn("deep", {}),
      fn("λ9:1", { anonymous: true }),
      fn("fileCallee", {}),
      fn("stray", {}),
      fn("stray.λ12:1", { anonymous: true }),
    ],
    edges: [
      closure("src/c.ts#main", "src/c.ts#main.λ3:4"),
      closure("src/c.ts#main.λ3:4", "src/c.ts#main.λ3:4.λ4:6"),
      fx.edge("src/c.ts#main.λ3:4.λ4:6", "src/c.ts#deep", "calls", "calls.call"),
      closure("src/c.ts", "src/c.ts#λ9:1"),
      fx.edge("src/c.ts#λ9:1", "src/c.ts#fileCallee", "calls", "calls.call"),
      closure("src/c.ts#stray", "src/c.ts#stray.λ12:1"),
    ],
  });

describe("lensCalls closures", () => {
  it("reaches what a closure calls when its creator is reached, however deep, and at module level", async () => {
    const result = await lensCalls.run(view(), ctx());
    expect(result.findings.map((f) => f.nodes?.[0]).sort()).toEqual(["src/c.ts#stray", "src/c.ts#stray.λ12:1"]);
  });
});
