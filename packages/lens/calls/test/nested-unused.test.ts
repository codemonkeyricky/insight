import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { lensCalls } from "../src/index.js";

const ctx = () => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config: undefined,
  resultOf: () => undefined,
});

/**
 * export function outer() { function helper() {} function unused() {} return helper(); }, as the TypeScript frontend emits
 * it: outer calls helper, and makes no closure edge to either nested declaration.
 */
const view = () =>
  fx.view({
    nodes: [
      fx.node("src/c.ts", "structure", "structure.file"),
      fx.node("src/c.ts#outer", "structure", "structure.function", { parent: "src/c.ts", attrs: { name: "outer", exported: true }, span: fx.span("src/c.ts", 0, 0, 0, 1) }),
      fx.node("src/c.ts#outer.helper", "structure", "structure.function", { parent: "src/c.ts#outer", attrs: { name: "helper" }, span: fx.span("src/c.ts", 1, 0, 1, 1) }),
      fx.node("src/c.ts#outer.unused", "structure", "structure.function", { parent: "src/c.ts#outer", attrs: { name: "unused" }, span: fx.span("src/c.ts", 2, 0, 2, 1) }),
    ],
    edges: [fx.edge("src/c.ts#outer", "src/c.ts#outer.helper", "calls", "calls.call")],
  });

describe("lensCalls: nested declarations", () => {
  it("still reports a nested function that nothing references as unreachable", async () => {
    const result = await lensCalls.run(view(), ctx());
    const unreachable = result.findings.filter((f) => f.id.startsWith("unreachable:")).map((f) => f.nodes?.[0]).sort();
    expect(unreachable).toEqual(["src/c.ts#outer.unused"]);
  });
});
