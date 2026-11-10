import { describe, expect, it } from "vitest";
import { cardWidth, CARD_H, CARD_GAP } from "../src/roots-grid.js";
import { runtimeRootsLayout } from "../src/runtime-boxes.js";
import type { Scene, SceneNode } from "../src/scene.js";

/** A project holding one thread, which holds `count` function cards with the given label. */
function threadScene(count: number, threadLabel: string, cardLabel = (i: number) => `fn${i}`): Scene {
  const nodes = new Map<string, SceneNode>();
  nodes.set("project", { id: "project", kind: "project", label: "Project", children: ["prog"] });
  nodes.set("prog", { id: "prog", kind: "program", label: "Browser · index.html — 1 thread", parent: "project", children: ["thread:t"] });
  const kids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `thread:t>f${i}`;
    kids.push(id);
    nodes.set(id, { id, kind: "function", label: cardLabel(i), parent: "thread:t", children: [], ref: `f${i}` });
  }
  nodes.set("thread:t", { id: "thread:t", kind: "thread", label: threadLabel, parent: "prog", children: kids });
  return {
    root: "project",
    nodes,
    edges: [],
    levels: { project: { box: { w: 300, h: 64 } }, program: { box: { w: 300, h: 64 } }, thread: { box: { w: 260, h: 60 } }, function: { box: { w: 160, h: 56 } } },
  };
}

describe("thread card grid", () => {
  it.each([6, 12, 20, 30])("wraps %i cards into a block near 16:10", (count) => {
    const layout = runtimeRootsLayout(threadScene(count, "Worker · verify.worker.ts"));
    const thread = layout.containers["thread:t"];
    expect(thread).toBeDefined();
    const cols = new Set(thread?.slots.map((s) => s.x)).size;
    expect(cols).toBeGreaterThan(1);
    const aspect = (thread?.w ?? 0) / (thread?.h ?? 1);
    expect(aspect).toBeGreaterThan(1.2);
    expect(aspect).toBeLessThan(2.1);
  });

  it("uses one column when there is one card, and a grid of equal cells otherwise", () => {
    const layout = runtimeRootsLayout(threadScene(1, "Worker · a.ts"));
    expect(layout.containers["thread:t"]?.slots).toHaveLength(1);
    const slots = runtimeRootsLayout(threadScene(9, "Worker · a.ts")).containers["thread:t"]?.slots ?? [];
    expect(new Set(slots.map((s) => s.w)).size).toBe(1);
    expect(new Set(slots.map((s) => s.h)).size).toBe(1);
  });

  it("keeps a thread's header width: its frame is at least as wide as a long worker label", () => {
    const label = "Worker · verify.worker.ts";
    const layout = runtimeRootsLayout(threadScene(1, label));
    // 7.2 px per character at 12px monospace, plus the header's own padding.
    expect(layout.containers["thread:t"]?.w).toBeGreaterThanOrEqual(Math.ceil(label.length * 7.2) + 24);
  });

  it("sizes a card to its full name up to the card maximum", () => {
    expect(cardWidth("short")).toBeLessThan(cardWidth("a-much-longer-function-name-here"));
    expect(CARD_H).toBeGreaterThan(0);
    expect(CARD_GAP).toBeGreaterThan(0);
  });
});
