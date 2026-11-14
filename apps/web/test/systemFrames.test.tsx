import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemEdge, SystemExternal, SystemModel, SystemResource, SystemRuntime, SystemSlice } from "@insight/model";
import { layoutSystemFrames, SLICE_LIMIT } from "../src/arch/system-frames";
import type { SysArrow, SysBox, SysFrame, SysLayout } from "../src/arch/system-layout";
import { SystemDiagram } from "../src/components/views/SystemView";

const site = { file: "svc/src/a.ts", line: 3 };
const slice = (rt: string, comp: string, functions = 2, extra: Partial<SystemSlice> = {}): SystemSlice => ({ id: `${rt}|${comp}`, runtime: rt, component: comp, functions, root: false, ...extra });
const ext = (id: string, label: string, category: SystemExternal["category"]): SystemExternal => ({ id, label, category });
const edge = (from: string, to: string, verb: SystemEdge["verb"], label: string, evidence?: SystemEdge["evidence"]): SystemEdge => ({
  id: `${from}>${verb}>${to}`,
  from,
  to,
  verb,
  label,
  count: 1,
  sites: [site],
  confidence: "exact",
  ...(evidence !== undefined ? { evidence } : {}),
});

const PA = "program:svc"; // a grounded process with a worker thread and a coroutine
const PB = "program:other"; // a process whose only thread is implicit
const TW = "thread:worker";
const TI = "thread:other-main";
const CO = "coroutine:worker:run";
const runtimes: SystemRuntime[] = [
  { id: PA, kind: "program", label: "svc · Node", programKind: "node", spawn: { file: "svc/src/main.ts", line: 1, status: "resolved" } },
  { id: TW, kind: "thread", label: "Worker · w.ts", parent: PA },
  { id: CO, kind: "coroutine", label: "run", parent: TW },
  { id: PB, kind: "program", label: "other · Node", programKind: "node", spawn: { file: "svc/src/a.ts", line: 3, api: "child_process.fork", status: "resolved" } },
  { id: TI, kind: "thread", label: "Main thread", parent: PB, implicit: true },
  { id: "unthreaded", kind: "unthreaded", label: "Not on a thread" },
];
const A = "A";
const B = "B";
const C = "C";
const resources: SystemResource[] = [
  { id: `queue:${PA}:inbox`, kind: "queue", label: "inbox", program: PA, source: "message" },
  { id: `lock:${PA}:m`, kind: "lock", label: "mutex m_", program: PA, source: "sync" },
  { id: `env:${PA}`, kind: "env", label: "Environment", program: PA, source: "env", names: ["PORT"] },
  { id: "os:signal", kind: "os", label: "Signals", source: "os" },
];

function model(): SystemModel {
  const slices: SystemSlice[] = [
    slice(PA, A, 3, { root: true }),
    slice(PA, B, 1),
    slice(TW, B, 4, { root: true, awaits: 2 }),
    slice(CO, C, 1, { root: true }),
    slice(TI, A, 5, { root: true }),
  ];
  const ev = [{ api: "openat", syscall: "openat", level: "syscall" as const, count: 2 }];
  return {
    scope: "svc",
    runtime: "grounded",
    components: [A, B, C].map((id) => ({ id, label: `svc/${id}`, path: `svc/${id}`, kind: "folder" as const, files: 1, functions: 3, entry: false })),
    routes: [],
    externals: [ext("fs", "Filesystem", "filesystem"), ext("github", "GitHub API", "service"), ext("config", "Config", "config")],
    edges: [
      edge(`${PA}|${A}`, `${TW}|${B}`, "calls", "calls"),
      edge(`${PA}|${A}`, `queue:${PA}:inbox`, "enqueues", "message"),
      edge(`queue:${PA}:inbox`, `${TW}|${B}`, "dequeues", "message"),
      edge(`${PA}|${A}`, `lock:${PA}:m`, "locks", "acquire"),
      edge(`${PA}|${A}`, `env:${PA}`, "reads", "1 var"),
      edge(`${PA}|${A}`, "fs", "reads", "openat ×2", ev),
      edge(`${TW}|${B}`, "fs", "reads", "fs.readFile", [{ api: "fs.readFile", level: "api", count: 1 }]),
      edge(`${TW}|${B}`, "github", "requests", "GET"),
      edge(`${PA}|${A}`, PB, "spawns", "spawns fork"),
      edge(`${PA}|${A}`, "os:signal", "signals", "SIGTERM"),
      edge(`${CO}`.replace(CO, `${CO}|${C}`), "github", "requests", "GET"),
    ],
    stages: [[A], [B], [C]],
    runtimes,
    slices,
    resources,
  };
}

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
    expect(frames.map((f) => f.id).sort()).toEqual([CO, PA, PB, TW, "unthreaded"].sort().filter((x) => x !== undefined));
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

  it("draws the kernel band full height, after the processes, with the outside column after it", () => {
    const band = layout.band as NonNullable<typeof layout.band>;
    expect(band.h).toBeGreaterThanOrEqual(layout.height - 1);
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
