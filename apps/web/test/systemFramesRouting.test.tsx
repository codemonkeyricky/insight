import { describe, expect, it } from "vitest";
import benchmarkSystem from "./fixtures/benchmarkSystem.json";
import type { SystemModel, SystemRuntime } from "@insight/model";
import { clipEnd, frameHeaderText, layoutSystemFrames } from "../src/arch/system-frames";
import type { SysFrame } from "../src/arch/system-layout";
import { crossings, pathPoints, segmentHitsRect } from "./systemGeometry";
import { synthModel } from "./systemBench";
import { slice, edge, A, B, C } from "./systemFixtures";

const tops = (frames: SysFrame[] | undefined): SysFrame[] => (frames ?? []).filter((f) => f.parent === undefined);

describe("edges never run through another process's frame", () => {
  // Wide and short viewport: the grid of process frames takes several columns, so a left column has others to its right.
  const vp = { viewport: { w: 100000, h: 400 } };

  it("the helper sees a crossing: a segment through a rectangle hits it, one along its border does not", () => {
    const r = { x: 10, y: 10, w: 20, h: 20 };
    expect(segmentHitsRect([0, 20], [50, 20], r)).toBe(true);
    expect(segmentHitsRect([0, 10], [50, 10], r)).toBe(false);
    expect(segmentHitsRect([0, 5], [50, 5], r)).toBe(false);
    expect(pathPoints("M0 0 L10 0 L10 10").length).toBe(3);
  });

  for (const [c, e] of [[100, 400], [200, 800]] as const) {
    it(`routes ${c} components / ${e} edges (several columns) with no edge through a foreign frame header or card`, () => {
      const l = layoutSystemFrames(synthModel(c, e), vp);
      const xs = new Set(tops(l.frames).map((f) => f.x));
      expect(xs.size).toBeGreaterThan(1);
      expect((l.trunks ?? []).length).toBeGreaterThan(0);
      expect(crossings(l)).toEqual([]);
      // Collapsed frames and widened ones route the same way.
      const ids = (l.frames ?? []).map((f) => f.id);
      expect(crossings(layoutSystemFrames(synthModel(c, e), { ...vp, collapsed: new Set(ids.slice(0, 5)) }))).toEqual([]);
    });
  }
});

describe("process subtitle", () => {
  const rts: SystemRuntime[] = [
    { id: "program:p", kind: "program", label: "apps/server/src/main.ts", programKind: "node" },
    { id: "thread:a", kind: "thread", label: "A", parent: "program:p" },
    { id: "thread:b", kind: "thread", label: "B", parent: "program:p" },
    { id: "coroutine:b:c", kind: "coroutine", label: "c", parent: "thread:b" },
    { id: "program:q", kind: "program", label: "empty", programKind: "node" },
  ];
  const sys: SystemModel = {
    scope: "",
    runtime: "grounded",
    components: [A, B, C].map((id) => ({ id, label: id, path: id, kind: "folder" as const, files: 1, functions: 3, entry: false })),
    routes: [],
    externals: [],
    edges: [],
    stages: [[A], [B], [C]],
    runtimes: rts,
    slices: [slice("thread:a", A, 2), slice("thread:a", B, 2), slice("thread:b", A, 2), slice("coroutine:b:c", C, 1), slice("program:q", A, 1)],
  };
  it("counts the threads and, recursively, the slices below the process, not just its direct ones", () => {
    const f = (id: string) => (layoutSystemFrames(sys).frames as SysFrame[]).find((x) => x.id === id) as SysFrame;
    expect(f("program:p").sub).toBe("2 threads · 4 slices");
    expect(f("program:q").sub).toBe("1 slice");
  });
});

describe("kernel band", () => {
  it("is not drawn when the scope has no kernel op and no chip", () => {
    const m = synthModel(30, 60);
    const bare: SystemModel = { ...m, edges: m.edges.filter((x) => x.to.includes("|")), resources: (m.resources ?? []).filter((r) => r.kind !== "os") };
    const l = layoutSystemFrames(bare);
    expect(l.band).toBeUndefined();
    expect(l.boxes.some((b) => b.kind === "chip" || b.kind === "os")).toBe(false);
  });
  it("is drawn when a chip or a kernel op is", () => {
    expect(layoutSystemFrames(synthModel(30, 60)).band).toBeDefined();
  });
});

describe("text truncation", () => {
  it("clips from the right, so a label keeps its start", () => {
    expect(clipEnd("inbox (unknown peer)", 12)).toBe("inbox (unkn…");
    expect(clipEnd("short", 12)).toBe("short");
    expect(clipEnd("abcdef", 1)).toBe("…");
    expect(clipEnd("abcdef", 0)).toBe("");
  });
  it("draws the 'inbox (unknown peer)' resource from its start", () => {
    const m = synthModel(30, 60);
    const sys: SystemModel = { ...m, resources: [...(m.resources ?? []), { id: "queue:peer", kind: "queue", label: "inbox (unknown peer)", program: "program:p0", source: "message" }] };
    const l = layoutSystemFrames(sys);
    const t = l.boxes.find((b) => b.id === "queue:peer")?.title as string;
    expect(t.startsWith("inbox")).toBe(true);
    expect(t.endsWith("…")).toBe(true);
  });
  it("fits a header subtitle into the room right of the title, with the full text kept", () => {
    const sub = "coroutine · starts in server/src/very/long/path · also runs 12 components of Main thread";
    const w = 420;
    const h = frameHeaderText("scopeExecLayoutOf", sub, w, false);
    expect(h.title).toBe("scopeExecLayoutOf");
    expect(h.sub.endsWith("…")).toBe(true);
    expect(h.sub.startsWith("▾ coroutine")).toBe(true);
    expect(h.subFull).toBe(`▾ ${sub}`);
    // Title and subtitle together fit the header (14 px sides, 14 px between), at the font's width estimates.
    expect(h.title.length * 8.6 + h.sub.length * 7.2 + 14).toBeLessThanOrEqual(w - 28 + 1);
  });
  it("keeps a short subtitle whole, and drops it to the arrow when nothing useful fits", () => {
    expect(frameHeaderText("run", "coroutine", 400, true).sub).toBe("▸ coroutine");
    expect(frameHeaderText("a-very-long-title-that-takes-all-the-room-here", "coroutine", 120, false).sub.length).toBeLessThanOrEqual(11);
    expect(frameHeaderText("t".repeat(200), "x".repeat(200), 300, false).title.endsWith("…")).toBe(true);
  });
});

describe("placeholder thread frames (unresolved spawns)", () => {
  const P = "program:bench";
  const M = "thread:main";
  const PH = "thread:ph";
  const rts: SystemRuntime[] = [
    { id: P, kind: "program", label: "bench · native", programKind: "native" },
    { id: M, kind: "thread", label: "Main thread", parent: P },
    { id: PH, kind: "thread", label: "Thread · std::thread", parent: P, spawn: { file: "a.cpp", line: 4, api: "std::thread", status: "unresolved" }, unresolved: true, note: "target unresolved: fn" },
  ];
  const sys: SystemModel = {
    scope: "",
    runtime: "grounded",
    components: [A, B].map((id) => ({ id, label: id, path: id, kind: "folder" as const, files: 1, functions: 3, entry: false })),
    routes: [],
    externals: [],
    edges: [edge(`${M}|${A}`, PH, "spawns", "spawns std::thread")],
    stages: [[A], [B]],
    runtimes: rts,
    slices: [slice(M, A, 2), slice(M, B, 2)],
  };
  const l = layoutSystemFrames(sys);
  const ph = (l.frames as SysFrame[]).find((f) => f.id === PH) as SysFrame;

  it("keeps the compact placeholder frame inside its process, with its note", () => {
    expect(ph).toBeDefined();
    expect(ph.parent).toBe(P);
    expect(ph.title).toBe("Thread · std::thread");
    expect(ph.unresolved).toBe("target unresolved: fn");
    expect(ph.h).toBeLessThan(80);
    expect(ph.collapsed).toBe(false);
  });
  it("routes the spawns edge (dashed) to the placeholder frame", () => {
    const a = l.arrows.find((x) => x.edge.verb === "spawns");
    expect(a).toBeDefined();
    expect(a?.to).toBe(PH);
    expect(a?.dashed).toBe(true);
    const pts = pathPoints(a?.d ?? "");
    const end = pts[pts.length - 1] as [number, number];
    // It enters from the left, at mid-height of the header, or lands on the top edge when the source is above.
    const left = end[0] === ph.x && Math.abs(end[1] - (ph.y + ph.hdrH / 2)) < 0.01;
    const top = end[1] === ph.y && end[0] > ph.x && end[0] < ph.x + ph.w;
    expect(left || top).toBe(true);
    if (left) expect((pts[pts.length - 2] as [number, number])[0]).toBeLessThan(ph.x);
    if (top) expect((pts[pts.length - 2] as [number, number])[1]).toBeLessThan(ph.y);
    expect(end[0] === ph.x + ph.w).toBe(false);
    expect(crossings(l)).toEqual([]);
  });
  it("shows plain 'unresolved' in the header, with no fold arrow", () => {
    expect(ph.sub).toBe("unresolved");
    const t = frameHeaderText(ph.title, ph.sub, ph.w, ph.collapsed, false);
    expect(t.sub).toBe("unresolved");
    expect(t.sub).not.toMatch(/[▾▸]/);
    expect(frameHeaderText("Process", "2 slices", 300, false).sub).toContain("▾");
  });
  it("has no undefined in any label", () => {
    const text = JSON.stringify([(l.frames ?? []).map((f) => [f.title, f.sub, f.unresolved]), l.arrows.map((x) => [x.pill.text, x.edge.label]), l.boxes.map((b) => [b.title, b.sub])]);
    expect(text).not.toContain("undefined");
    expect(JSON.stringify(l.frames)).not.toContain("undefined");
  });
});

describe("kernel band top", () => {
  it("hugs its content: its top is within the title height + 16 px of the first card or chip", () => {
    const l = layoutSystemFrames(synthModel(30, 60));
    const band = l.band as NonNullable<typeof l.band>;
    expect(band).toBeDefined();
    const inBand = l.boxes.filter((b) => b.x >= band.x && b.x + b.w <= band.x + band.w);
    expect(inBand.length).toBeGreaterThan(0);
    const first = Math.min(...inBand.map((b) => b.y));
    expect(first - band.y).toBeGreaterThanOrEqual(0);
    expect(first - band.y).toBeLessThanOrEqual(40 + 16);
  });
});

describe("edge clearance", () => {
  const CLEAR = 4;
  // Distance-aware variant of the crossing test: no segment of an edge may come within CLEAR px of a card or header it does not belong to.
  const near = (l: ReturnType<typeof layoutSystemFrames>): string[] => {
    const rects = [
      ...(l.frames ?? []).map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.hdrH })),
      ...l.boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h })),
    ];
    const hits: string[] = [];
    const check = (label: string, d: string, own: string[]) => {
      const pts = pathPoints(d);
      for (const r of rects) {
        if (own.includes(r.id)) continue;
        const grown = { x: r.x - CLEAR, y: r.y - CLEAR, w: r.w + 2 * CLEAR, h: r.h + 2 * CLEAR };
        for (let i = 0; i + 1 < pts.length; i++) {
          if (segmentHitsRect(pts[i] as [number, number], pts[i + 1] as [number, number], grown)) {
            hits.push(`${label} within ${CLEAR}px of ${r.id}`);
            break;
          }
        }
      }
    };
    for (const a of l.arrows) check(`arrow ${a.id}`, a.d, [a.from, a.to]);
    for (const t of l.trunks ?? []) check(`trunk ${t.id}`, t.d, [t.process, t.to]);
    return hits;
  };
  it("keeps the benchmark root's lock edges (cmake -> m) off the bindings card border", () => {
    const l = layoutSystemFrames(benchmarkSystem as unknown as SystemModel, { viewport: { w: 1600, h: 900 } });
    expect(l.arrows.some((a) => a.id.includes("lock:"))).toBe(true);
    expect(near(l)).toEqual([]);
    expect(crossings(l)).toEqual([]);
  });
  for (const [c, e] of [[100, 400], [200, 800]] as const) {
    it(`keeps ${CLEAR} px clear of non-endpoint cards (${c} components / ${e} edges)`, () => {
      expect(near(layoutSystemFrames(synthModel(c, e), { viewport: { w: 100000, h: 400 } }))).toEqual([]);
    });
  }
});

describe("frame borders", () => {
  const l = layoutSystemFrames(benchmarkSystem as unknown as SystemModel, { viewport: { w: 1600, h: 900 } });
  const frames = l.frames ?? [];
  it("the benchmark fixture has the std::thread placeholder with its api in the title and the spawns label", () => {
    const ph = frames.find((f) => f.unresolved !== undefined) as SysFrame;
    expect(ph.title).toBe("Thread · std::thread");
    const a = l.arrows.find((x) => x.edge.verb === "spawns");
    expect(a?.pill.text).toBe("spawns std::thread");
  });
  it("no horizontal or vertical run lies within 4 px of a frame border (its own end points excepted)", () => {
    const bad: string[] = [];
    for (const a of l.arrows) {
      const pts = pathPoints(a.d);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [p, q] = [pts[i] as [number, number], pts[i + 1] as [number, number]];
        const isEnd = (r: [number, number]) => r === pts[0] || r === pts[pts.length - 1];
        for (const f of frames) {
          if (p[1] === q[1] && !isEnd(p) && !isEnd(q) && Math.min(p[0], q[0]) < f.x + f.w && Math.max(p[0], q[0]) > f.x) {
            for (const by of [f.y, f.y + f.h]) if (Math.abs(p[1] - by) < 3.5) bad.push(`${a.id} y=${p[1]} near ${f.id}`);
          }
          if (p[0] === q[0] && !isEnd(p) && !isEnd(q) && Math.min(p[1], q[1]) < f.y + f.h && Math.max(p[1], q[1]) > f.y) {
            for (const bx of [f.x, f.x + f.w]) if (Math.abs(p[0] - bx) < 3.5) bad.push(`${a.id} x=${p[0]} near ${f.id}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
  it("no pill sits on a frame border or header", () => {
    const bad: string[] = [];
    for (const a of l.arrows) {
      if (a.pill.text === "") continue;
      const r = { x: a.pill.x - a.pill.w / 2, y: a.pill.y - a.pill.h / 2, w: a.pill.w, h: a.pill.h };
      for (const f of frames) {
        const xo = r.x < f.x + f.w && r.x + r.w > f.x;
        const yo = r.y < f.y + f.h && r.y + r.h > f.y;
        if (xo && r.y <= f.y && r.y + r.h >= f.y) bad.push(`${a.id} on top border of ${f.id}`);
        if (xo && r.y <= f.y + f.h && r.y + r.h >= f.y + f.h) bad.push(`${a.id} on bottom border of ${f.id}`);
        if (yo && r.x <= f.x && r.x + r.w >= f.x) bad.push(`${a.id} on left border of ${f.id}`);
        if (yo && r.x <= f.x + f.w && r.x + r.w >= f.x + f.w) bad.push(`${a.id} on right border of ${f.id}`);
        if (overlapsRect(r, { x: f.x, y: f.y, w: f.w, h: f.hdrH })) bad.push(`${a.id} on header of ${f.id}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

const overlapsRect = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
