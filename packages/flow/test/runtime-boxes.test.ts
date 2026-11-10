import { describe, expect, it } from "vitest";
import type { ExecFunctionRef, ExecModel, ExecModelStats, ExecThread } from "../src/exec-model.js";
import { buildExecScene, execThreadId } from "../src/exec-scene.js";
import { gridRootsLayout } from "../src/roots-grid.js";
import { hasRuntimeContext, runtimeOpen, runtimeRootsLayout, runtimeRootsScene, UNTHREADED_ID } from "../src/runtime-boxes.js";
import { execRootsOnly, flattenRoots } from "../src/scene-filter.js";
import { placeSceneLayout } from "../src/scene-layout.js";
import type { Scene } from "../src/scene.js";

const ZERO_STATS: ExecModelStats = {
  threads: 0,
  spawns: 0,
  programs: 0,
  resolved: 0,
  outside: 0,
  unresolved: 0,
  candidates: 0,
  coroutines: 0,
  dispatches: 0,
  locks: 0,
  channels: 0,
  functionsInScope: 0,
  functionsThreaded: 0,
  functionsCoroutineOnly: 0,
  functionsUnthreaded: 0,
  functionsListed: 0,
};

const fn = (id: string, line = 1, extra: Partial<ExecFunctionRef> = {}): ExecFunctionRef => ({
  id,
  name: id,
  file: "src/app.ts",
  line,
  inScope: true,
  runtime: "thread",
  ...extra,
});

function model(parts: { functions: ExecFunctionRef[]; threads: ExecThread[]; unthreaded?: string[]; scope?: string }): ExecModel {
  return {
    scope: parts.scope ?? "",
    truncated: false,
    functions: parts.functions,
    threads: parts.threads,
    dispatches: [],
    programs: [],
    calls: [],
    unthreaded: parts.unthreaded ?? [],
    resources: [],
    stats: ZERO_STATS,
  };
}

const thread = (t: Partial<ExecThread> & { id: string }): ExecThread => ({
  kind: "main",
  grounded: true,
  roots: [],
  reach: 0,
  reached: [],
  coroutines: [],
  coroutineOnly: [],
  ...t,
});

/** Main runs main, which calls a. A worker thread runs w, and helper h runs on both threads. f runs on no thread. */
function twoThreads(): ExecModel {
  return model({
    functions: [fn("main", 1), fn("a", 5), fn("w", 20), fn("h", 30), fn("f", 40)],
    threads: [
      thread({ id: "main", kind: "main", roots: ["main", "h"], reached: ["main", "a", "h"], reach: 3 }),
      thread({
        id: "t2",
        kind: "thread",
        roots: ["w", "h"],
        reached: ["w", "h"],
        reach: 2,
        spawn: { owner: "main", how: "thread", file: "src/app.ts", line: 3, status: "resolved" } as ExecThread["spawn"],
      }),
    ],
    unthreaded: ["f"],
  });
}

const cardsIn = (scene: Scene, container: string): string[] => scene.nodes.get(container)?.children ?? [];

describe("runtimeRootsScene: grouping by thread", () => {
  it("puts each thread's root cards in that thread's box, inside its process", () => {
    const full = buildExecScene(twoThreads());
    const scene = runtimeRootsScene(full, twoThreads());
    expect(scene).toBeDefined();
    const s = scene as Scene;
    const main = execThreadId("main");
    const t2 = execThreadId("t2");
    expect(s.nodes.get(main)?.kind).toBe("thread");
    // Only the roots are cards: main runs main and h, and reaches a without starting it.
    expect(cardsIn(s, main).map((id) => s.nodes.get(id)?.ref)).toEqual(["main", "h"]);
    expect(cardsIn(s, t2).map((id) => s.nodes.get(id)?.ref).sort()).toEqual(["h", "w"]);
    // Both threads share the process of their spawn.
    expect(s.nodes.get(main)?.parent).toBe(s.nodes.get(t2)?.parent);
    expect(s.nodes.get(s.nodes.get(main)?.parent ?? "")?.kind).toBe("program");
  });

  it("keeps the plain code flow in one trailing group, with its cards", () => {
    const s = runtimeRootsScene(buildExecScene(twoThreads()), twoThreads()) as Scene;
    const group = s.nodes.get(UNTHREADED_ID);
    expect(group?.label).toBe("Not on a thread");
    expect(group?.children.map((id) => s.nodes.get(id)?.ref)).toEqual(["f"]);
    const root = s.nodes.get(s.root);
    expect(root?.children.at(-1)).toBe(UNTHREADED_ID);
    expect(root?.children.filter((id) => s.nodes.get(id)?.kind === "function")).toEqual([]);
  });

  it("gives a function that two threads run a card in each, with the thread named in its detail", () => {
    const s = runtimeRootsScene(buildExecScene(twoThreads()), twoThreads()) as Scene;
    const cards = [...s.nodes.values()].filter((n) => n.kind === "function" && n.ref === "h");
    expect(cards.map((n) => n.id).sort()).toEqual([`${execThreadId("main")}>h`, `${execThreadId("t2")}>h`].sort());
    for (const c of cards) expect(c.detail).toMatch(/src\/app\.ts:30 · /);
    const single = [...s.nodes.values()].find((n) => n.kind === "function" && n.ref === "w");
    expect(single?.detail).toBe("src/app.ts:20");
  });
});

describe("runtimeRootsScene: flat fallbacks", () => {
  it("has no runtime context with no grounded thread and no coroutine: the caller keeps the flat grid", () => {
    const m = model({
      functions: [fn("main"), fn("a")],
      threads: [thread({ id: "main", kind: "main", grounded: false, roots: ["main"], reached: ["main"] })],
    });
    expect(hasRuntimeContext(m)).toBe(false);
    expect(runtimeRootsScene(buildExecScene(m), m)).toBeUndefined();
    // The flat grid still lays out the roots-only cut.
    const flat = flattenRoots(execRootsOnly(buildExecScene(m), m), m);
    expect(gridRootsLayout(flat).containers[flat.root]?.slots.length).toBe(flat.nodes.get(flat.root)?.children.length);
  });

  it("has runtime context from a coroutine alone", () => {
    const m = model({
      functions: [fn("main"), fn("co")],
      threads: [
        thread({
          id: "main",
          kind: "main",
          grounded: false,
          roots: ["main"],
          reached: ["main", "co"],
          coroutines: [{ target: "co", callees: [], dispatchedBy: [], how: "await" } as ExecThread["coroutines"][number]],
        }),
      ],
    });
    expect(hasRuntimeContext(m)).toBe(true);
  });
});

describe("runtimeRootsLayout", () => {
  it("draws each card inside its thread frame, and the thread frames inside their process", () => {
    const m = twoThreads();
    const s = runtimeRootsScene(buildExecScene(m), m) as Scene;
    const placed = placeSceneLayout(s, runtimeRootsLayout(s), runtimeOpen(s));
    const rect = (id: string) => placed.rects.get(id);
    const inside = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    for (const threadId of [execThreadId("main"), execThreadId("t2")]) {
      const frame = rect(threadId);
      expect(frame).toBeDefined();
      for (const c of cardsIn(s, threadId)) expect(inside(rect(c) as never, frame as never)).toBe(true);
    }
    const proc = rect(s.nodes.get(execThreadId("main"))?.parent ?? "");
    expect(inside(rect(execThreadId("main")) as never, proc as never)).toBe(true);
    expect(inside(rect(execThreadId("t2")) as never, proc as never)).toBe(true);
  });

  it("keeps sibling thread frames apart, so opened boxes do not overlap", () => {
    const m = twoThreads();
    const s = runtimeRootsScene(buildExecScene(m), m) as Scene;
    const placed = placeSceneLayout(s, runtimeRootsLayout(s), runtimeOpen(s));
    const a = placed.rects.get(execThreadId("main"));
    const b = placed.rects.get(execThreadId("t2"));
    expect(a && b).toBeTruthy();
    const overlap = (p: { x: number; y: number; w: number; h: number }, q: { x: number; y: number; w: number; h: number }) =>
      p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    expect(overlap(a as never, b as never)).toBe(false);
  });

  it("puts the unthreaded group below the threads, as the flat grid's cards", () => {
    const m = twoThreads();
    const s = runtimeRootsScene(buildExecScene(m), m) as Scene;
    const placed = placeSceneLayout(s, runtimeRootsLayout(s), runtimeOpen(s));
    const group = placed.rects.get(UNTHREADED_ID);
    const thread = placed.rects.get(execThreadId("main"));
    expect(group && thread).toBeTruthy();
    expect((group as { y: number }).y).toBeGreaterThanOrEqual((thread as { y: number; h: number }).y + (thread as { h: number }).h);
  });
});
