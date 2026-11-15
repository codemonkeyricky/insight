import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { layoutMachine, nearestArc, polylineHitsRect, type LaidMachine, type Solve } from "../src/states/layout";
import { hubConnectionMachine, syntheticMachine, twoStateMachine } from "./fixtures/hubConnectionMachine";

const require = createRequire(import.meta.url);
const ELK = require("elkjs/lib/elk.bundled.js");
const solve: Solve = (g: ElkNode) => new ELK().layout(g);

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe("layoutMachine", () => {
  it("places no two state boxes on top of each other", async () => {
    for (const view of [hubConnectionMachine, twoStateMachine, syntheticMachine(9)]) {
      const laid = await layoutMachine(view, solve);
      for (let i = 0; i < laid.states.length; i++) {
        for (let j = i + 1; j < laid.states.length; j++) {
          expect(overlaps(laid.states[i]!, laid.states[j]!), `${laid.states[i]!.label} / ${laid.states[j]!.label}`).toBe(false);
        }
      }
    }
  });

  it("gives every arc with a label a position, and every arc a path", async () => {
    const laid = await layoutMachine(hubConnectionMachine, solve);
    expect(laid.arcs).toHaveLength(hubConnectionMachine.transitions.length);
    for (const t of hubConnectionMachine.transitions) {
      const arc = laid.arcs.find((a) => a.id === t.id)!;
      expect(arc.d.startsWith("M")).toBe(true);
      expect(arc.arrow.startsWith("M")).toBe(true);
      if (t.label) {
        expect(arc.label).toBeDefined();
        expect(Number.isFinite(arc.label!.x) && Number.isFinite(arc.label!.y)).toBe(true);
        expect(arc.label!.w).toBeGreaterThan(0);
      } else {
        expect(arc.label).toBeUndefined();
      }
    }
    expect(laid.arcs.filter((a) => a.selfLoop)).toHaveLength(1);
  });

  it("puts the start dot in the top layer", async () => {
    const laid = await layoutMachine(hubConnectionMachine, solve);
    const dot = laid.states.find((s) => s.kind === "initial")!;
    for (const s of laid.states) if (s.kind !== "initial" && s.kind !== "any") expect(dot.y + dot.h).toBeLessThanOrEqual(s.y);
  });

  it("does not let two labels overlap", async () => {
    const laid = await layoutMachine(hubConnectionMachine, solve);
    const labels = laid.arcs.flatMap((a) => (a.label ? [a.label] : []));
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) expect(overlaps(labels[i]!, labels[j]!)).toBe(false);
  });

  it("is the same across two runs", async () => {
    const run = async (): Promise<LaidMachine> => layoutMachine(hubConnectionMachine, solve);
    expect(await run()).toEqual(await run());
  });
});

describe("terminal states and any-state arcs", () => {
  const mk = (names: string[], targets: string[]) => {
    const states = [
      { id: "H|*", label: "any state", kind: "any" as const },
      ...names.map((n) => ({ id: `H|${n}`, label: n, kind: "state" as const })),
    ];
    const transitions = targets.map((t) => ({
      id: `H|*>${t}#f`, from: "H|*", to: `H|${t}`, label: "f", confidence: "exact" as const, sites: [],
    }));
    return { ...twoStateMachine, states, transitions } as typeof twoStateMachine;
  };

  it("counts a `* -> X` arc as an exit for every state except X", async () => {
    const laid = await layoutMachine(mk(["A", "B", "C"], ["A", "B", "C"]), solve);
    expect(laid.states.filter((s) => s.terminal)).toEqual([]);
  });

  it("leaves only the target terminal for a single `* -> A`", async () => {
    const laid = await layoutMachine(mk(["A", "B"], ["A"]), solve);
    expect(laid.states.filter((s) => s.terminal).map((s) => s.label)).toEqual(["A"]);
  });
});

describe("label placement", () => {
  it("polylineHitsRect sees a line through a box and not one beside it", () => {
    const r = { x: 10, y: 10, w: 20, h: 10 };
    expect(polylineHitsRect([{ x: 20, y: 0 }, { x: 20, y: 40 }], r)).toBe(true);
    expect(polylineHitsRect([{ x: 50, y: 0 }, { x: 50, y: 40 }], r)).toBe(false);
    expect(polylineHitsRect([{ x: 0, y: 15 }, { x: 5, y: 15 }, { x: 5, y: 40 }], r, 0)).toBe(false);
  });

  it("keeps a label off every other arc's line, so a click on that line reaches its own arc", async () => {
    for (const view of [hubConnectionMachine, syntheticMachine(9)]) {
      const laid = await layoutMachine(view, solve);
      for (const a of laid.arcs) {
        if (!a.label) continue;
        for (const b of laid.arcs) {
          if (a === b || b.points.length < 2) continue;
          expect(polylineHitsRect(b.points, a.label, 0), `${view.title}: label of ${a.id} covers ${b.id}`).toBe(false);
        }
      }
    }
  });
});

describe("nearestArc", () => {
  const arc = (id: string, points: { x: number; y: number }[]) => ({ id, from: "a", to: "b", selfLoop: false, d: "", arrow: "", points });
  it("picks the nearer of two lines under one pointer, and none when far from all", () => {
    const vertical = arc("v", [{ x: 314, y: 270 }, { x: 314, y: 374 }]);
    const diagonal = arc("d", [{ x: 297, y: 238 }, { x: 335, y: 350 }]);
    expect(nearestArc([vertical, diagonal], 314, 280)?.id).toBe("v");
    expect(nearestArc([diagonal, vertical], 314, 280)?.id).toBe("v");
    expect(nearestArc([vertical, diagonal], 303, 280)?.id).toBe("d");
    expect(nearestArc([vertical, diagonal], 500, 500)).toBeUndefined();
  });
});
