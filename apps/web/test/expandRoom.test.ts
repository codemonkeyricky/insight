// Opened expansions keep their room in the layout: no expansion overlaps a card, another expansion, or a frame's edge.
import { describe, expect, it } from "vitest";
import { gridRootsLayout, placeSceneLayout, runtimeOpen, runtimeRootsLayout, type FunctionFlow, type Rect, type Scene, type SceneNode } from "@insight/flow";
import { type Expansion, type ExpandAnchor, footprintOf, openExpansion, refresh } from "../src/zoom/expand.js";

const chart = (id: string, width: number, height: number) => ({ id, name: id, width, height, nodes: [], edges: [] }) as unknown as FunctionFlow;

const node = (id: string, kind: string, label: string, parent: string | undefined, children: string[]): SceneNode =>
  ({ id, kind, label, parent, children, ref: kind === "function" ? id : undefined }) as unknown as SceneNode;

/** Threads (or none) holding cards: `threads` maps a thread id to its card ids. */
function sceneOf(threads: Record<string, string[]>): Scene {
  const nodes = new Map<string, SceneNode>();
  const root = "root";
  const procChildren: string[] = [];
  for (const [t, cards] of Object.entries(threads)) {
    procChildren.push(t);
    nodes.set(t, node(t, "thread", `Worker · ${t}`, root, cards));
    for (const c of cards) nodes.set(c, node(c, "function", c.toUpperCase(), t, []));
  }
  nodes.set(root, node(root, "project", "root", undefined, procChildren));
  return { root, nodes, edges: [], levels: {} } as unknown as Scene;
}

/** Every rect of the placed scene that is a card, plus the expansions: none may overlap another. */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function place(scene: Scene, opened: readonly Expansion[], runtime: boolean) {
  const fp = footprintOf(opened);
  const layout = runtime ? runtimeRootsLayout(scene, fp) : gridRootsLayout(scene, fp);
  const open = runtime ? runtimeOpen(scene) : new Set([scene.root]);
  return placeSceneLayout(scene, layout, open);
}

/** Opens each root's expansion in turn, placing every expansion on the layout the open ones keep. */
function openRoots(scene: Scene, runtime: boolean, roots: { fn: string; w: number; h: number }[]) {
  let list: Expansion[] = [];
  for (const r of roots) {
    const rect = place(scene, list, runtime).rects.get(r.fn) as Rect;
    list = openExpansion(list, r.fn, { kind: "box", nodeId: r.fn, rect } as ExpandAnchor, chart(r.fn, r.w, r.h), undefined);
  }
  const placed = place(scene, list, runtime);
  return { list: refresh(list, (id) => placed.rects.get(id), undefined), placed };
}

function assertNoOverlap(scene: Scene, runtime: boolean, roots: { fn: string; w: number; h: number }[]) {
  const { list, placed } = openRoots(scene, runtime, roots);
  const boxes: [string, Rect][] = [];
  for (const [id, r] of placed.rects) if (scene.nodes.get(id)?.kind === "function") boxes.push([id, r]);
  const exps: [string, Rect][] = list.map((e) => [`exp:${e.fnId}`, { x: e.x, y: e.y, w: e.w, h: e.h }]);
  const all = [...boxes, ...exps];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [na, ra] = all[i] as [string, Rect];
      const [nb, rb] = all[j] as [string, Rect];
      expect(overlaps(ra, rb), `${na} overlaps ${nb}`).toBe(false);
    }
  }
  expect(list.length).toBe(roots.length);
  return { list, placed };
}

describe("expansions keep their room", () => {
  it("two opened roots in the same thread do not overlap", () => {
    const scene = sceneOf({ t1: ["alpha", "beta", "gamma"] });
    assertNoOverlap(scene, true, [
      { fn: "alpha", w: 420, h: 300 },
      { fn: "beta", w: 380, h: 260 },
    ]);
  });

  it("two opened roots in different threads do not overlap", () => {
    const scene = sceneOf({ t1: ["alpha", "beta"], t2: ["gamma"] });
    assertNoOverlap(scene, true, [
      { fn: "alpha", w: 420, h: 300 },
      { fn: "gamma", w: 380, h: 260 },
    ]);
  });

  it("the flat grid keeps two opened roots apart too", () => {
    const nodes = new Map<string, SceneNode>();
    for (const c of ["alpha", "beta", "gamma"]) nodes.set(c, node(c, "function", c.toUpperCase(), "root", []));
    nodes.set("root", node("root", "project", "root", undefined, ["alpha", "beta", "gamma"]));
    const scene = { root: "root", nodes, edges: [], levels: {} } as unknown as Scene;
    assertNoOverlap(scene, false, [
      { fn: "alpha", w: 420, h: 300 },
      { fn: "beta", w: 380, h: 260 },
    ]);
  });

  it("a chained callee sits right of its parent, and its room is kept", () => {
    const scene = sceneOf({ t1: ["alpha", "beta"] });
    let list: Expansion[] = [];
    const rect = place(scene, list, true).rects.get("alpha") as Rect;
    list = openExpansion(list, "alpha", { kind: "box", nodeId: "alpha", rect }, chart("alpha", 300, 200), undefined);
    const step: ExpandAnchor = { kind: "step", fnId: "alpha", rect: { x: 10, y: 20, w: 60, h: 20 } };
    list = openExpansion(list, "callee", step, chart("callee", 260, 180), undefined);
    const fp = footprintOf(list);
    const placed = place(scene, list, true);
    const expanded = refresh(list, (id) => placed.rects.get(id), undefined);
    const parent = expanded.find((e) => e.fnId === "alpha") as Expansion;
    const child = expanded.find((e) => e.fnId === "callee") as Expansion;
    expect(child.x).toBeGreaterThanOrEqual(parent.x + parent.w);
    const card = placed.rects.get("alpha") as Rect;
    const room = fp.get("alpha") as { w: number; h: number };
    expect(card.x + card.w + room.w).toBeGreaterThanOrEqual(child.x + child.w);
    expect(card.y + room.h).toBeGreaterThanOrEqual(child.y + child.h);
    // The beta card sits past the room, not under the chain.
    expect(overlaps({ x: child.x, y: child.y, w: child.w, h: child.h }, placed.rects.get("beta") as Rect)).toBe(false);
  });
});
