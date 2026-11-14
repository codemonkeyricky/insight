import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemEdge, SystemExternal, SystemModel, SystemResource, SystemRuntime, SystemSlice } from "@insight/model";
import { GROUP_MIN, layoutSystemFrames, SLICE_LIMIT } from "../src/arch/system-frames";
import type { SysArrow, SysBox, SysFrame, SysLayout } from "../src/arch/system-layout";
import { SystemDiagram } from "../src/components/views/SystemView";

import { site, slice, ext, edge, PA, PB, TW, TI, CO, runtimes, A, B, C, resources, model } from "./systemFixtures";
const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }, m = 2) =>
  p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.h - m;

describe("grounded frames", () => {
  const sys = model();
  const layout: SysLayout = layoutSystemFrames(sys);
  const frames = layout.frames as SysFrame[];
  const byFrame = (id: string) => frames.find((f) => f.id === id) as SysFrame;
  const box = (id: string) => layout.boxes.find((b) => b.id === id) as SysBox;
  const arrowsFrom = (id: string) => layout.arrows.filter((a) => a.from === id);

  it("draws a frame per process and per thread, but none for an implicit thread", () => {
    expect(frames.map((f) => f.id).sort()).toEqual([CO, PA, PB, TW].sort());
    expect(frames.find((f) => f.id === TI)).toBeUndefined();
    expect(byFrame(TW).parent).toBe(PA);
  });

  it("nests frames strictly: children inside parents, siblings apart", () => {
    for (const f of frames) {
      if (f.parent === undefined) continue;
      const p = byFrame(f.parent);
      expect(f.x).toBeGreaterThanOrEqual(p.x);
      expect(f.y).toBeGreaterThanOrEqual(p.y + p.hdrH);
      expect(f.x + f.w).toBeLessThanOrEqual(p.x + p.w);
      expect(f.y + f.h).toBeLessThanOrEqual(p.y + p.h);
    }
    const tops = frames.filter((f) => f.parent === undefined);
    for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) expect(overlap(tops[i] as SysFrame, tops[j] as SysFrame)).toBe(false);
    const kids = frames.filter((f) => f.parent === PA);
    expect(kids.length).toBeGreaterThan(0);
    for (const f of kids) expect(overlap(f, byFrame(PA))).toBe(true);
  });

  it("puts the implicit main thread's slices directly in the process frame", () => {
    const s = box(`${TI}|${A}`);
    expect(s.kind).toBe("slice");
    expect(s.frame).toBe(PB);
    expect(s.x).toBeGreaterThanOrEqual(byFrame(PB).x);
    expect(s.y + s.h).toBeLessThanOrEqual(byFrame(PB).y + byFrame(PB).h);
  });

  it("keeps the slices of each frame inside it", () => {
    for (const b of layout.boxes.filter((x) => x.kind === "slice")) {
      const f = byFrame(b.frame as string);
      expect(b.x).toBeGreaterThanOrEqual(f.x);
      expect(b.y).toBeGreaterThanOrEqual(f.y + f.hdrH);
      expect(b.x + b.w).toBeLessThanOrEqual(f.x + f.w);
      expect(b.y + b.h).toBeLessThanOrEqual(f.y + f.h);
    }
  });

  it("puts resources of a process in its strip, and kernel ops in the band", () => {
    const strip = layout.strips?.find((s) => s.program === PA) as NonNullable<typeof layout.strips>[number];
    expect(strip).toBeDefined();
    for (const id of [`queue:${PA}:inbox`, `lock:${PA}:m`, `env:${PA}`]) {
      const b = box(id);
      expect(b.x).toBeGreaterThanOrEqual(strip.x);
      expect(b.x + b.w).toBeLessThanOrEqual(strip.x + strip.w);
    }
    const band = layout.band as NonNullable<typeof layout.band>;
    expect(box("os:signal").x).toBeGreaterThanOrEqual(band.x);
    expect(box("os:signal").x + box("os:signal").w).toBeLessThanOrEqual(band.x + band.w);
  });

  it("sizes the kernel band to its content, after the processes, with the outside column after it", () => {
    const band = layout.band as NonNullable<typeof layout.band>;
    const items = layout.boxes.filter((b) => b.frame === "band" || b.kind === "chip");
    const bottom = Math.max(...items.map((b) => b.y + b.h));
    expect(band.h).toBeGreaterThanOrEqual(bottom);
    expect(band.h).toBeLessThanOrEqual(bottom + 40);
    for (const f of frames.filter((x) => x.parent === undefined && x.kind !== "unthreaded")) expect(f.x + f.w).toBeLessThan(band.x);
    expect(box("fs").x).toBeGreaterThan(band.x + band.w);
    expect(box("github").x).toBeGreaterThan(band.x + band.w);
  });

  it("puts the config external away when an env resource draws the environment", () => {
    expect(layout.boxes.find((b) => b.id === "config")).toBeUndefined();
  });

  it("dedupes band chips: one chip per syscall or API label", () => {
    const chips = layout.boxes.filter((b) => b.kind === "chip");
    const labels = chips.map((c) => c.chipLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("openat");
    expect(labels).toContain("fs.readFile");
    expect(labels).toContain("GET");
  });

  it("sends every outside edge through the band exactly once, and no in-process edge across it", () => {
    const band = layout.band as NonNullable<typeof layout.band>;
    for (const a of layout.arrows) {
      const xs = a.samples.map((p) => p.x);
      const inBand = (x: number) => x > band.x && x < band.x + band.w;
      if (a.band === "in") {
        const last = a.samples[a.samples.length - 1] as { x: number };
        expect(inBand(last.x)).toBe(true);
        expect(xs.some((x) => x < band.x)).toBe(true);
      } else if (a.band === "out") {
        const first = a.samples[0] as { x: number };
        expect(inBand(first.x)).toBe(true);
        expect(xs.some((x) => x > band.x + band.w)).toBe(true);
      } else if (a.to === "fs" || a.to === "github") {
        expect.fail(`outside edge ${a.id} is not routed through a chip`);
      } else if (!layout.boxes.some((b) => b.id === a.to && b.kind === "os")) {
        expect(xs.every((x) => x < band.x + 0.5)).toBe(true);
      }
    }
  });

  it("routes the spawn edge to the child process frame's header", () => {
    const spawn = layout.arrows.find((a) => a.edge.verb === "spawns") as SysArrow;
    expect(spawn.to).toBe(PB);
  });

  it("keeps verb pills off every card, header and other pill", () => {
    const rects = [
      ...layout.boxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
      ...frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.hdrH })),
    ];
    const pills = layout.arrows.filter((a) => a.pill.text !== "").map((a) => a.pill);
    for (const p of pills) {
      const r = { x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h };
      for (const q of rects) expect(overlap(r, q)).toBe(false);
    }
    for (let i = 0; i < pills.length; i++) for (let j = i + 1; j < pills.length; j++) {
      const p = pills[i] as (typeof pills)[number];
      const q = pills[j] as (typeof pills)[number];
      expect(overlap({ x: p.x - p.w / 2, y: p.y - p.h / 2, w: p.w, h: p.h }, { x: q.x - q.w / 2, y: q.y - q.h / 2, w: q.w, h: q.h })).toBe(false);
    }
  });

  it("routes no edge through a card or frame header that is not one of its ends", () => {
    const headers = frames.map((f) => ({ id: f.id, x: f.x, y: f.y, w: f.w, h: f.hdrH }));
    const cards = layout.boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    for (const a of layout.arrows) {
      for (const p of a.samples.slice(1, -1)) {
        for (const c of cards) if (c.id !== a.from && c.id !== a.to && inside(p, c)) expect.fail(`${a.id} passes through card ${c.id}`);
        for (const h of headers) if (h.id !== a.from && h.id !== a.to && inside(p, h)) expect.fail(`${a.id} passes through header ${h.id}`);
      }
    }
  });

  it("re-attaches a collapsed frame's edges to its header and hides its slices", () => {
    const collapsed = layoutSystemFrames(sys, { collapsed: new Set([TW]) });
    expect(collapsed.boxes.find((b) => b.id === `${TW}|${B}`)).toBeUndefined();
    const f = collapsed.frames?.find((x) => x.id === TW) as SysFrame;
    expect(f.collapsed).toBe(true);
    expect(f.h).toBe(f.hdrH);
    const into = collapsed.arrows.filter((a) => a.to === TW);
    expect(into.length).toBeGreaterThan(0);
    const from = collapsed.arrows.filter((a) => a.from === TW);
    expect(from.length).toBeGreaterThan(0);
  });

  it("shows a +N more chip above the slice limit, and every slice when widened", () => {
    const many: SystemSlice[] = Array.from({ length: SLICE_LIMIT + 1 }, (_, i) => slice(PA, `c${i}`, 1));
    const big: SystemModel = { ...model(), slices: [...many], components: [...model().components, ...many.map((s) => ({ id: s.component, label: s.component, path: s.component, kind: "folder" as const, files: 1, functions: 1, entry: false }))], stages: [[A], [B], [C], many.map((s) => s.component)] };
    const l = layoutSystemFrames(big);
    const more = l.boxes.find((b) => b.kind === "more");
    expect(more?.title).toBe("+1 more");
    const shown = l.boxes.filter((b) => b.kind === "slice" && b.frame === PA).length;
    expect(shown).toBe(SLICE_LIMIT);
    const wide = layoutSystemFrames(big, { widened: new Set([PA]) });
    expect(wide.boxes.filter((b) => b.kind === "slice" && b.frame === PA).length).toBe(SLICE_LIMIT + 1);
    expect(wide.boxes.find((b) => b.kind === "more")).toBeUndefined();
  });

  it("keeps the spawn site, api and status on the child frame", () => {
    const f = byFrame(PB);
    expect(f.spawn?.api).toBe("child_process.fork");
    expect(f.spawn?.status).toBe("resolved");
  });

  it("marks awaited slices and frame headers as focusable markup", () => {
    expect(box(`${TW}|${B}`).awaits).toBe(2);
    const html = renderToStaticMarkup(
      <SystemDiagram id="p" sys={sys} tests={false} onTests={() => undefined} />,
    );
    expect(html).toContain('data-frame="' + PA + '"');
    expect(html).toMatch(/data-frame="[^"]+"[^>]*tabindex="0"/);
    expect(html).toContain("await ×2");
    expect(html).toContain("In process");
    expect(html).toContain("Kernel");
  });

  it("names the coroutine frame under its thread", () => {
    expect(byFrame(CO).parent).toBe(TW);
  });
});

describe("flat and truncated models", () => {
  const flat: SystemModel = {
    scope: "svc",
    runtime: "none",
    components: [{ id: "svc/a.ts", label: "svc/a.ts", path: "svc/a.ts", kind: "file", files: 1, functions: 2, entry: true }],
    routes: [],
    externals: [ext("fs", "Filesystem", "filesystem")],
    edges: [edge("svc/a.ts", "fs", "reads", "fs.readFile", [{ api: "fs.readFile", level: "api", count: 1 }])],
    stages: [["svc/a.ts"]],
    resources: [{ id: "env:flat", kind: "env", label: "Environment", source: "env", names: ["X"] }],
  };
  const layout = layoutSystemFrames(flat);

  it("draws no frames, but the band and the 'In process (no entry found)' strip", () => {
    expect(layout.frames ?? []).toHaveLength(0);
    expect(layout.band).toBeDefined();
    expect(layout.strips?.some((s) => s.title === "In process (no entry found)")).toBe(true);
    expect(layout.boxes.some((b) => b.id === "env:flat")).toBe(true);
  });

  it("routes the component's outside edge through a band chip", () => {
    const a = layout.arrows.find((x) => x.band === "in");
    expect(a?.to).toBe("chip:fs.readFile");
  });

  it("draws the component as a card, with its label and the band after it", () => {
    const comp = layout.boxes.find((b) => b.id === "svc/a.ts") as SysBox;
    expect(comp.kind).toBe("component");
    expect((layout.band as NonNullable<typeof layout.band>).x).toBeGreaterThan(comp.x + comp.w);
  });

  it("lays out an empty model as nothing", () => {
    expect(layoutSystemFrames({ ...flat, components: [], edges: [], externals: [], stages: [] }).boxes).toHaveLength(0);
  });
});

describe("toolbar notes", () => {
  const comp = (id: string) => ({ id, label: id, path: id, kind: "folder" as const, files: 1, functions: 1, entry: false });
  const flat = (runtime: SystemModel["runtime"], components: SystemModel["components"]): SystemModel => ({
    scope: "svc",
    components,
    routes: [],
    externals: [],
    edges: [],
    stages: [components.map((c) => c.id)],
    runtime,
  });
  it("says there is no runtime entry when the scope has code but no runtime", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={flat("none", [comp("A")])} tests={false} onTests={() => {}} />);
    expect(html).toContain("No runtime entry in this scope");
    expect(html).not.toContain("Runtime skipped");
  });
  it("shows no runtime note when the scope has no code at all", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={flat("none", [])} tests={false} onTests={() => {}} />);
    expect(html).not.toContain("No runtime entry in this scope");
  });
  it("says runtime was skipped when the model is truncated", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={flat("truncated", [comp("A")])} tests={false} onTests={() => {}} />);
    expect(html).toContain("Runtime skipped:");
    expect(html).not.toContain("No runtime entry in this scope");
  });
});

describe("outside ports and trunks", () => {
  const sys = model();
  const layout: SysLayout = layoutSystemFrames(sys);
  const trunks = layout.trunks ?? [];
  const frames = layout.frames as SysFrame[];

  it("bundles outside edges into one trunk per (process, chip)", () => {
    const keys = trunks.map((t) => `${t.process}>${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(trunks.length).toBeGreaterThan(0);
    for (const t of trunks) expect(t.count).toBe(t.edges.length);
  });

  it("counts the bundled edges on the trunk pill, only when more than one", () => {
    for (const t of trunks) {
      if (t.count > 1) expect(t.pill?.text).toContain(`${t.count}`);
    }
  });

  it("starts every trunk at a port on its process frame's right edge and ends it in the band", () => {
    const band = layout.band as NonNullable<typeof layout.band>;
    for (const t of trunks) {
      const f = frames.find((x) => x.id === t.process) as SysFrame;
      expect(t.port.x).toBeCloseTo(f.x + f.w, 0);
      expect(t.port.y).toBeGreaterThan(f.y);
      expect(t.port.y).toBeLessThan(f.y + f.h);
      const end = t.samples[t.samples.length - 1] as { x: number };
      expect(end.x).toBeGreaterThan(band.x);
    }
  });

  it("keeps bundled edges' inner path inside the frame, and gives them no pill of their own", () => {
    const bundled = layout.arrows.filter((a) => a.bundled === true);
    expect(bundled.length).toBeGreaterThan(0);
    for (const a of bundled) {
      expect(a.noPill).toBe(true);
      const first = a.samples[0] as { x: number; y: number };
      expect(first.x).toBeLessThan((layout.band as NonNullable<typeof layout.band>).x);
    }
  });

  it("stacks the chips in the band without overlap", () => {
    const chips = layout.boxes.filter((b) => b.kind === "chip");
    for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) expect(overlap(chips[i] as SysBox, chips[j] as SysBox)).toBe(false);
  });
});

describe("coroutine frames", () => {
  const withShared = (): SystemModel => {
    const m = model();
    return {
      ...m,
      slices: [...(m.slices ?? []), slice(CO, B, 2)],
      edges: [...m.edges, edge(`${CO}|${B}`, "github", "requests", "POST")],
    };
  };
  const layout = layoutSystemFrames(withShared());
  const co = (layout.frames as SysFrame[]).find((f) => f.id === CO) as SysFrame;

  it("does not repeat a slice its thread already draws", () => {
    expect(layout.boxes.some((b) => b.id === `${CO}|${B}`)).toBe(false);
    expect(layout.boxes.some((b) => b.id === `${CO}|${C}`)).toBe(true);
    expect(layout.boxes.some((b) => b.id === `${TW}|${B}`)).toBe(true);
  });

  it("says in the header how many components it shares with the thread", () => {
    expect(co.sub ?? "").toContain("also runs 1 component of");
  });

  it("re-attaches the shared slice's edges to the coroutine header", () => {
    const a = layout.arrows.find((x) => x.edge.from === `${CO}|${B}` && x.band === "in") as SysArrow;
    expect(a).toBeDefined();
    const first = a.samples[0] as { x: number; y: number };
    expect(first.y).toBeGreaterThanOrEqual(co.y - 1);
    expect(first.y).toBeLessThanOrEqual(co.y + co.hdrH + 1);
  });
});

describe("empty frames and the kernel band", () => {
  it("draws a thread that runs nothing as a header only", () => {
    const m = model();
    const sys: SystemModel = { ...m, slices: (m.slices ?? []).filter((s) => s.runtime !== CO), edges: m.edges.filter((e) => !e.from.startsWith(CO)) };
    const f = (layoutSystemFrames(sys).frames as SysFrame[]).find((x) => x.id === CO) as SysFrame;
    expect(f).toBeDefined();
    expect(f.h).toBe(f.hdrH);
  });

  it("sizes the band from its labels and never truncates a kernel op title", () => {
    const m = model();
    const long = "A deliberately long kernel operation title";
    const sys: SystemModel = { ...m, resources: [...(m.resources ?? []), { id: "os:long", kind: "os", label: long, source: "os" }] };
    const l = layoutSystemFrames(sys);
    const box = l.boxes.find((b) => b.id === "os:long") as SysBox;
    expect(box.title).toBe(long);
    expect(box.title.includes("…")).toBe(false);
    expect(box.w).toBeGreaterThan(long.length * 6);
  });
});

describe("skipped functions note", () => {
  it("adds the number of skipped functions to the runtime note", () => {
    const sys: SystemModel = {
      scope: "svc",
      components: [{ id: "A", label: "A", path: "A", kind: "folder", files: 1, functions: 1, entry: false }],
      routes: [],
      externals: [],
      edges: [],
      stages: [["A"]],
      runtime: "truncated",
      skippedFunctions: 1234,
    };
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={sys} tests={false} onTests={() => {}} />);
    expect(html).toContain("1234 functions skipped");
  });
});

describe("default collapse, 0-fn slices and the grid", () => {
  const rtsMany = (n: number): SystemRuntime[] => [
    { id: PA, kind: "program", label: "svc", programKind: "node" },
    { id: TW, kind: "thread", label: "Worker", parent: PA },
    ...Array.from({ length: n }, (_, i): SystemRuntime => ({ id: `coroutine:c${i}`, kind: "coroutine", label: `c${i}`, parent: TW })),
  ];
  const many = (n: number): SystemModel => {
    const rts = rtsMany(n);
    return {
      scope: "svc",
      runtime: "grounded",
      components: [A, B, C].map((id) => ({ id, label: id, path: id, kind: "folder" as const, files: 1, functions: 3, entry: false })),
      routes: [],
      externals: [],
      edges: [edge(`coroutine:c0|${C}`, `${TW}|${B}`, "calls", "calls")],
      stages: [[A], [B], [C]],
      runtimes: rts,
      slices: [slice(TW, B, 2, { root: true }), ...rts.filter((r) => r.kind === "coroutine").map((r) => slice(r.id, C, 1, { root: true }))],
    };
  };

  it("keeps up to GROUP_MIN coroutines as frames", () => {
    const l = layoutSystemFrames(many(GROUP_MIN));
    expect((l.frames as SysFrame[]).filter((f) => f.kind === "coroutine")).toHaveLength(GROUP_MIN);
  });

  it("draws one summary row for more than GROUP_MIN coroutines, and re-attaches their edges to it", () => {
    const l = layoutSystemFrames(many(GROUP_MIN + 1));
    const co = (l.frames as SysFrame[]).filter((f) => f.kind === "coroutine");
    expect(co).toHaveLength(1);
    const g = co[0] as SysFrame;
    expect(g.title).toBe(`${GROUP_MIN + 1} coroutines`);
    expect(g.collapsed).toBe(true);
    expect(g.openKey).toBe(TW);
    const a = l.arrows.find((x) => x.edge.from === `coroutine:c0|${C}`) as SysArrow;
    expect(a.from).toBe(g.id);
  });

  it("draws the coroutines one by one once the thread is opened", () => {
    const l = layoutSystemFrames(many(GROUP_MIN + 2), { open: new Set([TW]) });
    expect((l.frames as SysFrame[]).filter((f) => f.kind === "coroutine")).toHaveLength(GROUP_MIN + 2);
    expect((l.frames as SysFrame[]).find((f) => f.id === TW)?.coGroup).toEqual({ count: GROUP_MIN + 2, open: true });
  });

  it("collapses a big unthreaded frame by default, and opens it on request", () => {
    const m = many(1);
    const sl = [A, B, C, "D"].map((c) => slice("unthreaded", c, 1));
    const sys: SystemModel = { ...m, components: [...m.components, { id: "D", label: "D", path: "D", kind: "folder", files: 1, functions: 1, entry: false }], stages: [[A], [B], [C], ["D"]], runtimes: [...(m.runtimes ?? []), { id: "unthreaded", kind: "unthreaded", label: "Not on a thread" }], slices: [...(m.slices ?? []), ...sl] };
    const f = (l: SysLayout) => (l.frames as SysFrame[]).find((x) => x.id === "unthreaded") as SysFrame;
    expect(f(layoutSystemFrames(sys)).collapsed).toBe(true);
    expect(f(layoutSystemFrames(sys, { open: new Set(["unthreaded"]) })).collapsed).toBe(false);
  });

  it("draws no slice with 0 functions, and no frame left empty by that", () => {
    const m = many(1);
    const sys: SystemModel = { ...m, runtimes: [...(m.runtimes ?? []), { id: "unthreaded", kind: "unthreaded", label: "Not on a thread" }], slices: [...(m.slices ?? []), slice("unthreaded", A, 0)] };
    const l = layoutSystemFrames(sys);
    expect(l.boxes.some((b) => b.id === `unthreaded|${A}`)).toBe(false);
    expect((l.frames as SysFrame[]).some((f) => f.id === "unthreaded")).toBe(false);
  });

  it("lays many processes out in a grid that fits the viewport better than one column", () => {
    const rts: SystemRuntime[] = Array.from({ length: 8 }, (_, i) => ({ id: `program:p${i}`, kind: "program", label: `p${i}`, programKind: "node" }));
    const sys: SystemModel = { ...many(0), runtimes: rts, edges: [], slices: rts.flatMap((r) => [A, B, C].map((c) => slice(r.id, c, 1))) };
    const l = layoutSystemFrames(sys, { viewport: { w: 100000, h: 300 } });
    const xs = new Set((l.frames as SysFrame[]).map((f) => f.x));
    expect(xs.size).toBeGreaterThan(1);
    const flat = layoutSystemFrames(sys, { viewport: { w: 400, h: 100000 } });
    expect(new Set((flat.frames as SysFrame[]).map((f) => f.x)).size).toBe(1);
  });

  it("puts no pill outside every frame", () => {
    const l = layoutSystemFrames(model());
    const band = l.band as NonNullable<typeof l.band>;
    for (const a of l.arrows) {
      if (a.noPill || a.pill.text === "") continue;
      const inFrame = (l.frames as SysFrame[]).some((f) => f.parent === undefined && a.pill.x > f.x && a.pill.x < f.x + f.w && a.pill.y > f.y && a.pill.y < f.y + f.h);
      expect(inFrame || a.pill.x >= band.x).toBe(true);
    }
  });
});

describe("a collapsed lone process", () => {
  const lone = (): SystemModel => ({
    ...model(),
    components: model().components.filter((c) => c.id === A),
    externals: [],
    edges: [],
    resources: [],
    stages: [[A]],
    runtimes: [{ id: PA, kind: "program", label: "svc · Node", programKind: "node", spawn: { file: "svc/src/main.ts", line: 1, status: "resolved" } }],
    slices: [slice(PA, A, 3, { root: true })],
  });

  it("keeps its frame in the layout when it has no box and no arrow", () => {
    const l = layoutSystemFrames(lone(), { collapsed: new Set([PA]) });
    expect(l.boxes.filter((b) => b.kind === "slice")).toEqual([]);
    expect(l.arrows).toEqual([]);
    expect((l.frames ?? []).map((f) => f.id)).toEqual([PA]);
    expect(l.width).toBeGreaterThan(0);
  });

  it("is not an empty view: the header stays so the process can be expanded again", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={lone()} tests={false} onTests={() => {}} />);
    expect(html).toContain('data-frame="program:svc"');
  });
});
