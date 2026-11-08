import { describe, expect, it } from "vitest";
import type { FlowNode, FunctionFlow } from "@insight/flow";
import { nearestScopeContaining, outsideCall, outsideSteps, outsideText, resolutionPercent } from "../src/flowTargets.js";

describe("nearestScopeContaining", () => {
  it("finds the smallest folder above a file that holds the callee", () => {
    expect(nearestScopeContaining("apps/server/src/app.ts", "apps/server/src/reader.ts")).toBe("apps/server/src");
    expect(nearestScopeContaining("apps/server/src/app.ts", "apps/server/lib/x.ts")).toBe("apps/server");
    expect(nearestScopeContaining("apps/server/src/app.ts", "docs/readme.ts")).toBe("");
  });

  it("counts a folder scope itself when it holds the file", () => {
    expect(nearestScopeContaining("apps/server/src", "apps/server/src/x.ts")).toBe("apps/server/src");
  });

  it("answers the project for a file at the top level", () => {
    expect(nearestScopeContaining("src/a.ts", "lib/c.ts")).toBe("");
    expect(nearestScopeContaining("", "lib/c.ts")).toBe("");
  });
});

describe("outsideCall", () => {
  it("names the callee's file and the scope that resolves it", () => {
    expect(outsideCall("apps/server/lib/x.ts#fetch", "apps/server/src/app.ts")).toEqual({ file: "apps/server/lib/x.ts", scope: "apps/server" });
  });

  it("explains an unresolved call in one sentence", () => {
    expect(outsideText("lib/c.ts#c")).toBe("calls c in lib/c.ts — outside this scope. Select a parent folder to resolve it.");
  });
});

describe("resolutionPercent", () => {
  it("is undefined when the scope starts no calls", () => {
    expect(resolutionPercent({ calls: 0, resolved: 0 })).toBeUndefined();
  });

  it("rounds the share of calls that resolve", () => {
    expect(resolutionPercent({ calls: 3, resolved: 2 })).toBe(67);
    expect(resolutionPercent({ calls: 3, resolved: 3 })).toBe(100);
    expect(resolutionPercent({ calls: 4, resolved: 0 })).toBe(0);
  });
});

function step(id: string, target?: string): FlowNode {
  return { id, role: "call", shape: "step", label: id, x: 0, y: 0, w: 40, h: 20, ...(target !== undefined ? { target } : {}) };
}

function fn(nodes: FlowNode[]): FunctionFlow {
  return {
    id: "src/a.ts#a",
    name: "a",
    async: false,
    stats: { steps: nodes.length, decisions: 0, loops: 0, tries: 0, exits: 0, depth: 0 },
    width: 100,
    height: 100,
    nodes,
    edges: [],
  };
}

describe("outsideSteps", () => {
  it("lists the call steps whose callee lies outside the scope, with the scope that resolves each", () => {
    const out = outsideSteps(fn([step("1", "src/a.ts#a"), step("2", "lib/c.ts#c"), step("3")]), "src/a.ts");
    expect(out.map((s) => s.target)).toEqual(["lib/c.ts#c"]);
    expect(out[0]).toMatchObject({ name: "c", file: "lib/c.ts", scope: "" });
  });

  it("lists nothing when the scope holds every callee", () => {
    expect(outsideSteps(fn([step("1", "src/a.ts#a")]), "")).toEqual([]);
  });
});
