import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import { layoutMachine, type LaidMachine, type Solve } from "../src/states/layout";
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
