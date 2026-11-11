import { describe, expect, it } from "vitest";
import type { Item } from "../src/build.js";
import { layoutFunction, MAX_NODES, relayout, NEST_HEAD, type InlineTree } from "../src/layout.js";
import type { FunctionFlow } from "../src/types.js";

const call = (label: string, target?: string): Item => ({ t: "step", role: "call", label, ...(target ? { target } : {}) });
const make = (id: string, items: Item[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });

describe("nested call steps", () => {
  const leaf = make("f#leaf", [call("a()"), call("b()")]);
  const mid = make("f#mid", [call("leaf()", "f#leaf"), call("x()")]);
  const root = make("f#root", [call("before()"), call("mid()", "f#mid"), call("after()")]);
  const stepId = (f: FunctionFlow, label: string) => f.nodes.find((n) => n.label === label)?.id as string;

  it("keeps the items of a chart for a later layout", () => {
    expect(root.items).toBeDefined();
  });

  it("returns the chart unchanged with nothing expanded", () => {
    expect(relayout(root, new Map())).toBe(root);
  });

  it("draws the callee inside a frame that replaces the step", () => {
    const id = stepId(root, "mid()");
    const out = relayout(root, new Map([[id, { flow: mid }]]));
    const frame = out.nodes.find((n) => n.id === id);
    expect(frame?.shape).toBe("nest");
    expect(frame?.label).toBe("f#mid");
    const inner = out.nodes.filter((n) => n.id.startsWith(`${id}/`));
    expect(inner.map((n) => n.label)).toEqual(["leaf()", "x()"]);
    for (const n of inner) {
      expect(n.x).toBeGreaterThanOrEqual(frame!.x);
      expect(n.y).toBeGreaterThanOrEqual(frame!.y + NEST_HEAD);
      expect(n.x + n.w).toBeLessThanOrEqual(frame!.x + frame!.w);
      expect(n.y + n.h).toBeLessThanOrEqual(frame!.y + frame!.h);
    }
  });

  it("grows the parent chart and moves what follows the step down", () => {
    const id = stepId(root, "mid()");
    const out = relayout(root, new Map([[id, { flow: mid }]]));
    expect(out.height).toBeGreaterThan(root.height);
    const after = (f: FunctionFlow) => f.nodes.find((n) => n.label === "after()")!.y;
    expect(after(out)).toBeGreaterThan(after(root));
    expect(out.nodes.length).toBeGreaterThan(root.nodes.length);
  });

  it("joins the frame to the steps around it and to its first step", () => {
    const id = stepId(root, "mid()");
    const out = relayout(root, new Map([[id, { flow: mid }]]));
    const before = stepId(out, "before()");
    const after = stepId(out, "after()");
    const frame = out.nodes.find((n) => n.id === id)!;
    const into = out.edges.find((e) => e.from === before && e.to === id)!;
    const outOf = out.edges.find((e) => e.from === id && e.to === after)!;
    expect(into.points.at(-1)![1]).toBe(frame.y);
    expect(outOf.points[0]![1]).toBe(frame.y + frame.h);
    expect(out.edges.some((e) => e.from === id && e.to === `${id}/n2`)).toBe(true);
  });

  it("nests recursively, with ids that carry the path", () => {
    const id = stepId(root, "mid()");
    const own = stepId(mid, "leaf()");
    const inner = `${id}/${own}`;
    const tree: InlineTree = new Map([[id, { flow: mid, inline: new Map([[own, { flow: leaf }]]) }]]);
    const out = relayout(root, tree);
    const outer = out.nodes.find((n) => n.id === id)!;
    const deep = out.nodes.find((n) => n.id === inner)!;
    expect(deep.shape).toBe("nest");
    expect(out.nodes.filter((n) => n.id.startsWith(`${inner}/`)).map((n) => n.label)).toEqual(["a()", "b()"]);
    expect(deep.x).toBeGreaterThanOrEqual(outer.x);
    expect(deep.x + deep.w).toBeLessThanOrEqual(outer.x + outer.w);
  });

  it("does not nest a function that is already in the chain", () => {
    const self = make("f#self", [call("again()", "f#self")]);
    const id = stepId(self, "again()");
    const out = relayout(self, new Map([[id, { flow: self }]]));
    expect(out.nodes.find((n) => n.id === id)?.shape).toBe("step");
    const a = make("f#a", [call("b()", "f#b")]);
    const b = make("f#b", [call("a()", "f#a")]);
    const ida = stepId(a, "b()");
    const idb = stepId(b, "a()");
    const out2 = relayout(a, new Map([[ida, { flow: b, inline: new Map([[idb, { flow: a }]]) }]]));
    expect(out2.nodes.find((n) => n.id === ida)?.shape).toBe("nest");
    expect(out2.nodes.find((n) => n.id === `${ida}/${idb}`)?.shape).toBe("step");
  });

  it("stops nesting before a chart passes MAX_NODES", () => {
    const big = make("f#big", Array.from({ length: MAX_NODES - 40 }, (_, i) => call(`s${i}()`)));
    const host = make("f#host", Array.from({ length: 30 }, (_, i) => call(`h${i}()`, "f#big")));
    const tree: InlineTree = new Map(host.nodes.filter((n) => n.target).map((n) => [n.id, { flow: big }]));
    const out = relayout(host, tree);
    expect(out.nodes.length).toBeLessThan(MAX_NODES + 100);
    expect(out.nodes.filter((n) => n.shape === "nest").length).toBeLessThan(30);
  });

  it("applies a target the viewer gave the chart", () => {
    const patched: FunctionFlow = { ...root, nodes: root.nodes.map((n) => (n.label === "after()" ? { ...n, target: "f#leaf", label: "post ▸ x" } : n)) };
    const out = relayout(patched, new Map([[stepId(root, "mid()"), { flow: mid }]]));
    const n = out.nodes.find((x) => x.id === stepId(root, "after()"))!;
    expect(n.target).toBe("f#leaf");
    expect(n.label).toBe("post ▸ x");
  });
});
