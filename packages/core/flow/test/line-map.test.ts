import { describe, expect, it } from "vitest";
import type { Item } from "../src/build.js";
import { layoutFunction, relayout, ROW_H, LANE_W, LINE_X0, stationOf, type InlineTree } from "../src/index.js";
import type { FlowNode, FunctionFlow } from "../src/index.js";
import { FIXTURE, NESTED, branch, brk, call, ret } from "./line-map-fixture.js";

const make = (id: string, items: Item[]): FunctionFlow => layoutFunction({ id, name: id, async: false, items });
const by = (f: FunctionFlow, label: string): FlowNode => {
  const n = f.nodes.find((x) => x.label === label);
  if (!n) throw new Error(`no node ${label}`);
  return n;
};
const fixture = make("f#x", FIXTURE);

describe("line map layout", () => {
  it("(a) gives every node a lane and label x, on its own row", () => {
    const rows = fixture.nodes.filter((n) => n.shape !== "nest");
    for (const n of fixture.nodes) {
      expect(n.lane).toBeTypeOf("number");
      expect(n.labelX).toBeTypeOf("number");
    }
    expect(new Set(rows.map((n) => n.y)).size).toBe(rows.length);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.y - rows[i - 1]!.y).toBeGreaterThanOrEqual(ROW_H);
    // Without a loop, rows sit exactly one ROW_H apart from y = 0.
    const flat = make("f#flat", [call("a()"), call("b()"), ret]);
    expect(flat.nodes.map((n) => n.y)).toEqual([0, ROW_H, 2 * ROW_H, 3 * ROW_H]);
  });

  it("(b) puts the true arm on the next lane and the else arm on the head's lane with an else tag", () => {
    const head = by(fixture, "a > 0");
    expect(head.lane).toBe(0);
    expect(by(fixture, "t1()").lane).toBe(1);
    expect(by(fixture, "e1()").lane).toBe(0);
    expect(by(fixture, "e1()").tag).toBe("else");
    expect(by(fixture, "e2()").tag).toBeUndefined();
    expect(by(fixture, "e1()").y).toBeGreaterThan(by(fixture, "t1()").y);
  });

  it("(c) shifts the else labels one lane right only when the true arm falls through", () => {
    const falls = make("f#falls", [branch("c", [call("t()")], [call("e()")])]);
    const ends = make("f#ends", [branch("c", [ret], [call("e()")])]);
    expect(by(falls, "e()").labelX).toBe(by(ends, "e()").labelX! + LANE_W);
    expect(by(falls, "e()").lane).toBe(by(ends, "e()").lane);
  });

  it("(d) gives a loop no turn row: the last step has the back edge, with a track, and a dotted exit", () => {
    const head = by(fixture, "for x of xs");
    const last = by(fixture, "use(x)");
    expect(fixture.nodes.some((n) => n.shape === ("turn" as string) || n.id === `${head.id}t`)).toBe(false);
    const back = fixture.edges.filter((e) => e.kind === "back" && e.to === head.id);
    expect(back.map((e) => e.from)).toEqual([last.id]);
    expect(back[0]?.style).toBe("back");
    expect(back[0]?.track).toBeGreaterThan(stationOf(last)[0]);
    const exit = fixture.edges.find((e) => e.kind === "exit" && e.from === head.id)!;
    expect(exit.style).toBe("done");
    // A body that ends in break or return has no back edge.
    const w = by(fixture, "while ok");
    expect(fixture.edges.some((e) => e.kind === "back" && e.to === w.id)).toBe(false);
    const r = make("f#r", [{ t: "loop", label: "loop", body: [call("a()"), ret] }]);
    expect(r.edges.some((e) => e.kind === "back")).toBe(false);
  });

  it("(d2) returns from each arm that falls through, and nested loops nest", () => {
    const b = make("f#b", [{ t: "loop", label: "loop", body: [branch("c", [call("t()")], [call("e()")])] }]);
    const head = by(b, "loop");
    expect(b.edges.filter((e) => e.kind === "back" && e.to === head.id).map((e) => e.from).sort()).toEqual([by(b, "e()").id, by(b, "t()").id].sort());
    const n = make("f#n", [{ t: "loop", label: "outer", body: [{ t: "loop", label: "inner", body: [call("a()")] }] }]);
    const inner = n.edges.find((e) => e.kind === "back" && e.to === by(n, "inner").id)!;
    const outer = n.edges.find((e) => e.kind === "back" && e.to === by(n, "outer").id)!;
    expect(inner.track).toBeLessThan(outer.track!);
    expect(outer.from).toBe(by(n, "inner").id);
  });

  it("(e) makes no join nodes and keeps every other node's id", () => {
    expect(fixture.nodes.some((n) => n.shape === "join" || n.role === "join")).toBe(false);
    expect(fixture.nodes.map((n) => `${n.id}:${n.label}`)).toEqual([
      "n1:f#x", "n2:prep()", "n3:a > 0", "n4:t1()", "n5:e1()", "n6:e2()", "n8:for x of xs", "n9:x < 0", "n10:neg()", "n12:use(x)",
      "n14:while ok", "n15:tick()", "n16:break", "n18:switch", "n19:doA()", "n20:return", "n22:try", "n23:risky()", "n24:recover()", "n26:tail()", "n27:return",
    ]);
  });

  it("(g) gives every edge a path that runs from its source to its target", () => {
    for (const f of [fixture, make("f#b", [brk])]) {
      const byId = new Map(f.nodes.map((n) => [n.id, n]));
      for (const e of f.edges) {
        expect(e.d).toMatch(/^M/);
        expect(e.points.length).toBeGreaterThanOrEqual(2);
        expect(e.lane).toBeTypeOf("number");
        expect(e.style).toBeDefined();
        const [sx, sy] = stationOf(byId.get(e.from)!);
        const [tx, ty] = stationOf(byId.get(e.to)!);
        const first = e.points[0]!;
        const last = e.points.at(-1)!;
        expect(first).toEqual([sx, sy]);
        // A back edge points at the head's station rather than into its centre.
        const tol = e.kind === "back" ? 12 : 0.01;
        expect(Math.abs(last[0] - tx)).toBeLessThanOrEqual(tol);
        expect(Math.abs(last[1] - ty)).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("(h) keeps every node rectangle inside the chart", () => {
    for (const n of fixture.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(fixture.width + 0.01);
      expect(n.y + n.h).toBeLessThanOrEqual(fixture.height);
    }
    expect(fixture.width).toBeGreaterThanOrEqual(260);
  });

  it("draws the trunk and sidings of a switch and a try", () => {
    const sw = by(fixture, "switch");
    expect(by(fixture, "doA()").lane).toBe(sw.lane! + 1);
    expect(by(fixture, "doA()").tag).toBe('case "a"');
    expect(by(fixture, "return").lane).toBe(sw.lane! + 1);
    const rec = by(fixture, "recover()");
    expect(rec.tag).toBe("catch");
    expect(fixture.edges.find((e) => e.to === rec.id)?.style).toBe("throws");
    expect(by(fixture, "risky()").tag).toBeUndefined();
    // The try body falls through to the code after it by an edge.
    expect(fixture.edges.some((e) => e.from === by(fixture, "risky()").id)).toBe(true);
    // A switch's trunk reaches the next code since the first case falls through.
    expect(fixture.edges.some((e) => e.from === sw.id && e.kind === "next")).toBe(true);
  });

  it("draws an empty else as a dotted skip on the head's lane", () => {
    const f = make("f#skip", [branch("c", [call("t()")], []), call("after()")]);
    const skip = f.edges.find((e) => e.style === "skip")!;
    expect(skip.from).toBe(by(f, "c").id);
    expect(skip.to).toBe(by(f, "after()").id);
    expect(skip.lane).toBe(0);
  });

  describe("(f) nest", () => {
    const callee = make("f#mid", [call("a()"), call("b()")]);
    const ends = make("f#ends", [call("a()"), ret]);
    const root = make("f#root", [call("before()"), call("mid()", "f#mid"), call("after()")]);
    const id = by(root, "mid()").id;
    const out = relayout(root, new Map([[id, { flow: callee }]]));

    it("prefixes nested ids and keeps the band around every body row", () => {
      const band = out.nodes.find((n) => n.id === id)!;
      expect(band.shape).toBe("nest");
      const inner = out.nodes.filter((n) => n.id.startsWith(`${id}/`));
      expect(inner.map((n) => n.label)).toEqual(["a()", "b()"]);
      for (const n of inner) {
        expect(n.lane).toBe(band.lane! + 1);
        expect(n.y).toBeGreaterThanOrEqual(band.y + ROW_H);
        expect(n.y + n.h).toBeLessThanOrEqual(band.y + band.h);
        expect(n.x).toBeGreaterThanOrEqual(band.x);
        expect(n.x + n.w).toBeLessThanOrEqual(band.x + band.w);
      }
      expect(band.x).toBe(LINE_X0 - 13);
      expect(out.edges.some((e) => e.from === id && e.to === `${id}/n2`)).toBe(true);
      // The id numbering outside the band is unchanged.
      expect(out.nodes.filter((n) => !n.id.includes("/")).map((n) => n.id)).toEqual(root.nodes.map((n) => n.id));
    });

    it("does not end the caller's line when the callee returns", () => {
      const o = relayout(root, new Map([[id, { flow: ends }]]));
      const after = by(o, "after()");
      const into = o.edges.filter((e) => e.to === after.id);
      expect(into.map((e) => e.from)).toEqual([id]);
      expect(into[0]?.style).toBe("solid");
      expect(into[0]?.lane).toBe(0);
    });

    it("nests recursively", () => {
      const leaf = make("f#leaf", [call("z()")]);
      const mid = make("f#mid2", [call("leaf()", "f#leaf")]);
      const r = make("f#r2", [call("mid()", "f#mid2")]);
      const tree: InlineTree = new Map([[by(r, "mid()").id, { flow: mid, inline: new Map([["n2", { flow: leaf }]]) }]]);
      const o = relayout(r, tree);
      const deep = o.nodes.find((n) => n.id === "n2/n2")!;
      expect(deep.shape).toBe("nest");
      expect(deep.lane).toBe(1);
      expect(o.nodes.find((n) => n.id === "n2/n2/n2")?.lane).toBe(2);
    });
  });

  describe("loop return tracks", () => {
    type Seg = [[number, number], [number, number]];
    const segs = (pts: [number, number][]): Seg[] => pts.slice(1).map((p, i) => [pts[i]!, p] as Seg);
    const ccw = (a: number[], b: number[], c: number[]) => (c[1]! - a[1]!) * (b[0]! - a[0]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
    const cross = (s: Seg, t: Seg) => {
      const [a, b] = s;
      const [c, d] = t;
      return ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(a, b, c) * ccw(a, b, d) < 0;
    };
    const touch = (s: Seg, t: Seg) => {
      // collinear overlap or a point of one lying on the other
      const on = (p: number[], q: Seg) => Math.abs(ccw(q[0], q[1], p)) < 1e-6 && p[0]! >= Math.min(q[0][0], q[1][0]) - 1e-6 && p[0]! <= Math.max(q[0][0], q[1][0]) + 1e-6 && p[1]! >= Math.min(q[0][1], q[1][1]) - 1e-6 && p[1]! <= Math.max(q[0][1], q[1][1]) + 1e-6;
      return cross(s, t) || on(s[0], t) || on(s[1], t) || on(t[0], s) || on(t[1], s);
    };
    const nested = make("f#nested", NESTED);
    interface Ring { head: FlowNode; track: number; ys: [number, number]; body: FlowNode[]; points: [number, number][]; fromHead: boolean }
    // One ring per back edge. The ring's lower end is where the line leaves the body (a nested loop's exit leaves below its last row).
    const rings = (f: FunctionFlow): Ring[] =>
      f.edges
        .filter((e) => e.kind === "back")
        .map((e) => {
          const head = f.nodes.find((n) => n.id === e.to)!;
          const src = f.nodes.find((n) => n.id === e.from)!;
          const low = e.points.reduce((m, p) => Math.max(m, p[1]), 0);
          const body = f.nodes.filter((n) => n.y > head.y && n.y <= Math.max(src.y, low - ROW_H / 2));
          return { head, track: e.track!, ys: [head.y + ROW_H / 2, low] as [number, number], body, points: e.points, fromHead: src.shape === "loop" };
        });

    it("(r1) keeps every point of a back edge right of its track except the ends, and the track right of the body", () => {
      for (const f of [fixture, nested]) {
        const rs = rings(f);
        expect(rs.length).toBeGreaterThan(0);
        for (const r of rs) {
          expect(r.track).toBeTypeOf("number");
          for (const p of r.points.slice(-4, -2)) expect(p[0]).toBeGreaterThanOrEqual(r.track - 0.01);
          const end = r.points[r.points.length - 1]!;
          expect(end[0]).toBeLessThan(r.track);
          expect(end[1]).toBeCloseTo(r.head.y + ROW_H / 2);
          expect(end[0]).toBeGreaterThan(stationOf(r.head)[0]);
          for (const n of r.body) expect(r.track).toBeGreaterThan(stationOf(n)[0]);
        }
      }
    });

    it("(r2) puts an inner ring strictly inside its outer ring", () => {
      const rs = rings(nested);
      const outer = rs.find((r) => r.head.label === "for a of as")!;
      for (const label of ["for b of a.bs", "for c of b.cs", "for d of a.ds"]) {
        const inner = rs.find((r) => r.head.label === label)!;
        expect(inner.track).toBeLessThan(outer.track);
        expect(inner.ys[0]).toBeGreaterThan(outer.ys[0]);
        expect(inner.ys[1]).toBeLessThan(outer.ys[1]);
      }
      const b = rs.find((r) => r.head.label === "for b of a.bs")!;
      const cc = rs.find((r) => r.head.label === "for c of b.cs")!;
      expect(cc.track).toBeLessThan(b.track);
      expect(cc.ys[0]).toBeGreaterThan(b.ys[0]);
      expect(cc.ys[1]).toBeLessThan(b.ys[1]);
    });

    it("(r3) does not let the head's way into the body meet the back edge", () => {
      for (const f of [fixture, nested]) {
        for (const r of rings(f)) {
          if (r.fromHead) continue;
          const into = f.edges.find((e) => e.from === r.head.id && e.kind === "each")!;
          const back = segs(r.points).slice(1); // the first run starts at the step the way in may end on
          for (const s of segs(into.points)) for (const t of back) expect(touch(s, t)).toBe(false);
        }
      }
    });

    it("(r4) puts the labels of rows inside a loop right of its track", () => {
      for (const f of [fixture, nested]) {
        for (const r of rings(f)) {
          for (const n of [r.head, ...r.body]) expect(n.labelX).toBeGreaterThan(r.track);
        }
      }
    });

    it("(r5) keeps the exit on the head's lane, clear of the ring", () => {
      for (const r of rings(nested)) {
        const exit = nested.edges.find((e) => e.from === r.head.id && e.kind === "exit");
        if (exit === undefined) continue;
        for (const p of exit.points.slice(0, 2)) expect(p[0]).toBeLessThan(r.track);
      }
    });
  });
});
