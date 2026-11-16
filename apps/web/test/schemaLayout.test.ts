import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { SchemaDiagramView, SchemaEntity } from "../src/api";
import { CARD_W, cardMetrics, layoutKinds, layoutRecords, refPath, type CardBox } from "../src/schema/layout";

const require = createRequire(import.meta.url);
const ELK = require("elkjs/lib/elk.bundled.js");
const solve = (g: ElkNode): Promise<ElkNode> => new ELK().layout(g);

const ent = (id: string, group: string, n: number): SchemaEntity => ({
  id,
  label: id,
  group,
  role: "node-kind",
  fields: Array.from({ length: n }, (_, i) => ({ name: `f${i}`, type: "string", required: i % 2 === 0, ...(i === 1 ? { values: ["a", "b"] } : {}) })),
});

const view = (): SchemaDiagramView => {
  const groups = ["structure", "flow", "sync", "calls", "x-cpp"].map((id) => ({ id, label: id }));
  const entities: SchemaEntity[] = [];
  groups.forEach((g, gi) => {
    for (let i = 0; i < 3 + gi * 3; i++) entities.push(ent(`${g.id}.k${i}`, g.id, (i * 7 + gi) % 6));
  });
  return { type: "schema-diagram", id: "d", title: "d", groups, entities, links: [] };
};

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutKinds", () => {
  it("places every entity once, without overlaps, inside its frame", () => {
    const v = view();
    const l = layoutKinds(v);
    expect(l.cards.size).toBe(v.entities.length);
    const cards = [...l.cards.values()];
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlap(cards[i] as CardBox, cards[j] as CardBox)).toBe(false);
    for (let i = 0; i < l.frames.length; i++) for (let j = i + 1; j < l.frames.length; j++) expect(overlap(l.frames[i]!, l.frames[j]!)).toBe(false);
    for (const e of v.entities) {
      const c = l.cards.get(e.id)!;
      const f = l.frames.find((x) => x.id === e.group)!;
      expect(c.x).toBeGreaterThanOrEqual(f.x);
      expect(c.y).toBeGreaterThanOrEqual(f.y);
      expect(c.x + c.w).toBeLessThanOrEqual(f.x + f.w);
      expect(c.y + c.h).toBeLessThanOrEqual(f.y + f.h);
      expect(c.w).toBe(CARD_W);
      expect(c.h).toBe(cardMetrics(e).h);
    }
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });
});

describe("layoutRecords", () => {
  it("places every entity without overlaps", async () => {
    const entities = ["A", "B", "C", "D"].map((id) => ent(id, "records", 3));
    const links = [
      { from: "A", field: "f0", to: "B", kind: "ref" as const },
      { from: "B", field: "f0", to: "C", kind: "ref" as const },
      { from: "A", field: "f2", to: "D", kind: "ref" as const },
    ];
    const l = await layoutRecords({ type: "schema-diagram", id: "r", title: "r", groups: [{ id: "records", label: "records" }], entities, links }, solve);
    expect(l.cards.size).toBe(4);
    const cards = [...l.cards.values()];
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) expect(overlap(cards[i] as CardBox, cards[j] as CardBox)).toBe(false);
    expect(l.cards.get("B")!.x).toBeGreaterThan(l.cards.get("A")!.x);
  });

  it("draws a ref from the field row to the target header", () => {
    const a: CardBox = { id: "a", x: 0, y: 0, w: CARD_W, h: 100 };
    const b: CardBox = { id: "b", x: 400, y: 50, w: CARD_W, h: 100 };
    expect(refPath(a, 60, b).d.startsWith(`M${CARD_W} 60 C`)).toBe(true);
  });
});
