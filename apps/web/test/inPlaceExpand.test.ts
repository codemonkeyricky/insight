// A roots-only card expands in place: the expansion takes the card's own slot, the layout reflows around it, and the
// calls inside keep the inline behaviour (same-thread nests, thread/process hops open a side box).
import { describe, expect, it } from "vitest";
import { gridRootsLayout, layoutFunction, placeSceneLayout, runtimeOpen, runtimeRootsLayout, type FunctionFlow, type Rect, type Scene, type SceneNode } from "@insight/flow";
import { calloutOf, closeExpansion, footprintOf, isInPlace, openExpansion, refresh, setInline, type Expansion, type ExpandAnchor } from "../src/zoom/expand.js";

const call = (label: string, target?: string, role: "call" | "spawn" = "call") => ({ t: "step" as const, role, label, ...(target ? { target } : {}) });
const make = (id: string, items: ReturnType<typeof call>[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });
const node = (id: string, kind: string, label: string, parent: string | undefined, children: string[]): SceneNode =>
  ({ id, kind, label, parent, children, ref: kind === "function" ? id : undefined }) as unknown as SceneNode;

function sceneOf(threads: Record<string, string[]>): Scene {
  const nodes = new Map<string, SceneNode>();
  for (const [t, cards] of Object.entries(threads)) {
    nodes.set(t, node(t, "thread", t, "root", cards));
    for (const c of cards) nodes.set(c, node(c, "function", c, t, []));
  }
  nodes.set("root", node("root", "project", "root", undefined, Object.keys(threads)));
  return { root: "root", nodes, edges: [], levels: {} } as unknown as Scene;
}
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const placeOf = (scene: Scene, list: readonly Expansion[]) => placeSceneLayout(scene, runtimeRootsLayout(scene, footprintOf(list)), runtimeOpen(scene));
const inPlace = (rect: Rect, nodeId: string): ExpandAnchor => ({ kind: "box", nodeId, rect, inPlace: true });

describe("in-place root expansion", () => {
  const scene = sceneOf({ t1: ["alpha", "beta", "gamma"], t2: ["delta"] });
  const chartA = make("alpha", [call("a()"), call("spawn thread · w", undefined, "spawn")]);

  it("sits at the card's own top-left corner, with no callout", () => {
    const before = placeOf(scene, []);
    const card = before.rects.get("alpha") as Rect;
    const list = openExpansion([], "alpha", inPlace(card, "alpha"), chartA, undefined);
    expect(list[0]).toMatchObject({ x: card.x, y: card.y });
    expect(isInPlace(list[0] as Expansion)).toBe(true);
    expect(calloutOf(list[0] as Expansion, list)).toBeUndefined();
  });

  it("keeps its top-left in the card's slot after the layout reflows, and nothing overlaps", () => {
    let list: Expansion[] = [];
    for (const fn of ["alpha", "delta"]) {
      const rect = placeOf(scene, list).rects.get(fn) as Rect;
      list = openExpansion(list, fn, inPlace(rect, fn), make(fn, [call("a()"), call("b()"), call("c()")]), undefined);
    }
    const placed = placeOf(scene, list);
    list = refresh(list, (id) => placed.rects.get(id), undefined);
    for (const e of list) {
      const slot = placed.rects.get(e.fnId) as Rect;
      expect(e.x).toBe(slot.x);
      expect(e.y).toBe(slot.y);
      // The reserved slot room holds the whole expansion.
      expect(slot.x + slot.w + (footprintOf(list).get(e.fnId)?.w ?? 0)).toBeGreaterThanOrEqual(e.x + e.w);
    }
    const boxes = [...placed.rects].filter(([id]) => scene.nodes.get(id)?.kind === "function");
    const rects: [string, Rect][] = [
      ...boxes.filter(([id]) => !list.some((e) => e.fnId === id)).map(([id, r]) => [id, r] as [string, Rect]),
      ...list.map((e) => [`exp:${e.fnId}`, { x: e.x, y: e.y, w: e.w, h: e.h }] as [string, Rect]),
    ];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(overlaps((rects[i] as [string, Rect])[1], (rects[j] as [string, Rect])[1]), `${rects[i]?.[0]} / ${rects[j]?.[0]}`).toBe(false);
  });

  it("collapsing restores the plain footprint", () => {
    const rect = placeOf(scene, []).rects.get("alpha") as Rect;
    const list = openExpansion([], "alpha", inPlace(rect, "alpha"), chartA, undefined);
    expect(footprintOf(list).get("alpha")?.h).toBeGreaterThan(56);
    const closed = closeExpansion(list, "alpha");
    expect(footprintOf(closed).size).toBe(0);
    expect(placeOf(scene, closed).rects.get("beta")).toEqual(placeOf(scene, []).rects.get("beta"));
  });

  it("a beside-the-card expansion (not in place) still opens to the right", () => {
    const rect = placeOf(scene, []).rects.get("alpha") as Rect;
    const list = openExpansion([], "alpha", { kind: "box", nodeId: "alpha", rect }, chartA, undefined);
    expect((list[0] as Expansion).x).toBeGreaterThan(rect.x + rect.w);
  });

  it("a same-thread call nests inside it and the box grows in place", () => {
    const leaf = make("leaf", [call("z()")]);
    const root = make("root", [call("leaf()", "leaf"), call("tail()")]);
    const rect = placeOf(scene, []).rects.get("alpha") as Rect;
    const open = openExpansion([], "root", inPlace(rect, "alpha"), root, undefined);
    const step = root.nodes.find((n) => n.label === "leaf()")?.id as string;
    const grown = setInline(open, "root", step, leaf, undefined);
    const e = grown[0] as Expansion;
    expect(e.h).toBeGreaterThan((open[0] as Expansion).h);
    expect([e.x, e.y]).toEqual([rect.x, rect.y]);
  });

  it("a thread step still opens a side box right of the in-place box, inside the reserved room", () => {
    const rect = placeOf(scene, []).rects.get("alpha") as Rect;
    let list = openExpansion([], "alpha", inPlace(rect, "alpha"), chartA, undefined);
    const step: ExpandAnchor = { kind: "step", fnId: "alpha", rect: { x: 10, y: 20, w: 60, h: 20 } };
    list = openExpansion(list, "w", step, make("w", [call("x()")]), undefined, { kind: "thread", label: "Worker · w" });
    const placed = placeOf(scene, list);
    const out = refresh(list, (id) => placed.rects.get(id), undefined);
    const parent = out.find((e) => e.fnId === "alpha") as Expansion;
    const child = out.find((e) => e.fnId === "w") as Expansion;
    expect(child.x).toBeGreaterThanOrEqual(parent.x + parent.w);
    const room = footprintOf(list).get("alpha") as { w: number; h: number };
    const slot = placed.rects.get("alpha") as Rect;
    expect(slot.x + slot.w + room.w).toBeGreaterThanOrEqual(child.x + child.w);
  });

  it("the flat grid reflows around an in-place card too", () => {
    const nodes = new Map<string, SceneNode>();
    for (const c of ["a", "b", "c"]) nodes.set(c, node(c, "function", c, "root", []));
    nodes.set("root", node("root", "project", "root", undefined, ["a", "b", "c"]));
    const flat = { root: "root", nodes, edges: [], levels: {} } as unknown as Scene;
    const rect = placeSceneLayout(flat, gridRootsLayout(flat), new Set(["root"])).rects.get("a") as Rect;
    const list = openExpansion([], "a", inPlace(rect, "a"), make("a", [call("x()")]), undefined);
    const placed = placeSceneLayout(flat, gridRootsLayout(flat, footprintOf(list)), new Set(["root"]));
    const out = refresh(list, (id) => placed.rects.get(id), undefined)[0] as Expansion;
    expect(overlaps({ x: out.x, y: out.y, w: out.w, h: out.h }, placed.rects.get("b") as Rect)).toBe(false);
    expect(overlaps({ x: out.x, y: out.y, w: out.w, h: out.h }, placed.rects.get("c") as Rect)).toBe(false);
  });
});
