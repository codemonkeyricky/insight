import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemComponent, SystemEdge, SystemModel } from "@insight/model";
import { ARCH_MODE_KEY, readArchMode, writeArchMode } from "../src/arch/mode";
import { layoutSystem, pillText, shortLabel, type SysBox } from "../src/arch/system-layout";
import { fitCamera, SystemDiagram } from "../src/components/views/SystemView";
import { ArchModeToggle } from "../src/components/views/ArchTab";

const V = "svc/src/vercel.ts";
const I = "svc/src/indexer.ts";
const G = "svc/src/github.ts";
const S = "svc/src/storage.ts";

const comp = (id: string, functions = 1, entry = false): SystemComponent => ({ id, label: id, path: id, kind: "file", files: 1, functions, entry });
const edge = (from: string, to: string, verb: SystemEdge["verb"], label: string, confidence: SystemEdge["confidence"] = "exact"): SystemEdge => ({
  id: `${from}>${verb}>${to}`,
  from,
  to,
  verb,
  label,
  count: 1,
  sites: [{ file: from.startsWith("svc") ? from : G, line: 4, fn: `${from}#f` }],
  confidence,
});

/** The hosted-like system: a Vercel handler, an indexer, GitHub and storage, with the outside systems they reach. */
function sample(): SystemModel {
  return {
    scope: "svc/src",
    components: [comp(G), comp(I), comp(S), comp(V, 1, true)],
    routes: [{ id: "route:1", component: V, framework: "export", method: "POST", path: "", handler: "POST", site: { file: V, line: 4 } }],
    externals: [
      { id: "github", label: "GitHub API", category: "service", host: "api.github.com" },
      { id: "kv", label: "Cloudflare KV", category: "store", host: "api.cloudflare.com" },
      { id: "proc:git", label: "git", category: "process", command: "git" },
      { id: "env", label: "Environment", category: "config", names: ["A", "B", "C", "D"] },
    ],
    edges: [
      edge(V, I, "calls", "calls"),
      edge(I, G, "calls", "calls"),
      edge(I, S, "calls", "calls ×2"),
      edge(I, "proc:git", "runs", "git"),
      edge(G, "github", "reads", "GET"),
      edge(G, "github", "writes", "POST"),
      edge(G, "env", "reads", "1 var"),
      edge(S, "kv", "writes", "PUT ×5", "inferred"),
    ],
    stages: [[V], [I], [G, S]],
  };
}

const overlap = (a: SysBox, b: SysBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutSystem", () => {
  const sys = sample();
  const layout = layoutSystem(sys);

  it("puts no two cards on top of each other", () => {
    for (let i = 0; i < layout.boxes.length; i++) {
      for (let j = i + 1; j < layout.boxes.length; j++) expect(overlap(layout.boxes[i] as SysBox, layout.boxes[j] as SysBox)).toBe(false);
    }
  });

  it("keeps every card inside the canvas", () => {
    for (const b of layout.boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(layout.width);
      expect(b.y + b.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it("orders the component columns by stage, left to right, with the outside systems after them", () => {
    const col = (id: string) => (layout.boxes.find((b) => b.id === id) as SysBox).column;
    expect(col(V)).toBeLessThan(col(I));
    expect(col(I)).toBeLessThan(col(G));
    expect(col(G)).toBe(col(S));
    const xOf = (id: string) => (layout.boxes.find((b) => b.id === id) as SysBox).x;
    const externals = layout.boxes.filter((b) => b.kind === "external");
    expect(externals.length).toBeGreaterThan(0);
    for (const e of externals) expect(e.x).toBeGreaterThan(xOf(S));
    expect(layout.columns.map((c) => c.index)).toEqual(layout.columns.map((_, i) => i));
  });

  it("draws every edge, with both its endpoints among the cards", () => {
    expect(layout.arrows).toHaveLength(sys.edges.length);
    const ids = new Set(layout.boxes.map((b) => b.id));
    for (const a of layout.arrows) {
      expect(ids.has(a.from)).toBe(true);
      expect(ids.has(a.to)).toBe(true);
      expect(a.d).toMatch(/^M[\d. -]+C/);
    }
  });

  it("groups the outside systems by category, with a header for each group", () => {
    const cats = new Set(layout.boxes.filter((b) => b.kind === "external").map((b) => b.category));
    expect(new Set(layout.groups.map((g) => g.category))).toEqual(cats);
  });

  it("writes route chips on the entry card and draws dashed runs edges", () => {
    expect((layout.boxes.find((b) => b.id === V) as SysBox).chips).toEqual(["POST handler"]);
    expect(layout.arrows.find((a) => a.edge.verb === "runs")?.dashed).toBe(true);
    expect(layout.arrows.find((a) => a.edge.verb === "writes")?.dashed).toBe(false);
  });

  it("keeps verb pills off the cards", () => {
    for (const a of layout.arrows) {
      const p = { x: a.pill.x - a.pill.w / 2, y: a.pill.y - a.pill.h / 2, w: a.pill.w, h: a.pill.h };
      for (const b of layout.boxes) expect(p.x < b.x + b.w && b.x < p.x + p.w && p.y < b.y + b.h && b.y < p.y + p.h).toBe(false);
    }
  });

  it("is deterministic", () => {
    expect(JSON.stringify(layoutSystem(sample()))).toBe(JSON.stringify(layout));
  });

  it("lays out an empty model as nothing", () => {
    expect(layoutSystem({ scope: "", components: [], routes: [], externals: [], edges: [], stages: [] }).boxes).toEqual([]);
  });

  it("shortens long labels at a segment and writes pills with the verb first", () => {
    expect(shortLabel("packages/hosted/src/github.ts", 20)).toBe("…/src/github.ts");
    expect(shortLabel("a/b.ts", 20)).toBe("a/b.ts");
    expect(pillText({ verb: "writes", label: "PUT ×5" })).toBe("writes · PUT ×5");
    expect(pillText({ verb: "calls", label: "calls ×3" })).toBe("calls ×3");
  });

  it("fits a wide layout into the view without shrinking below readable text", () => {
    const cam = fitCamera({ width: 4000, height: 800 }, 1000, 600);
    expect(cam.k).toBeGreaterThanOrEqual(0.12);
    expect(fitCamera({ width: 500, height: 300 }, 1000, 600).k).toBeLessThanOrEqual(1.15);
  });
});

describe("SystemDiagram", () => {
  it("renders cards, verbs and the route chip from a small model", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={sample()} tests={false} onTests={() => {}} />);
    expect(html).toContain("svc/src/vercel.ts");
    expect(html).toContain("POST handler");
    expect(html).toContain("GitHub API");
    expect(html).toContain("Cloudflare KV");
    expect(html).toContain("writes · PUT");
    expect(html).toContain("runs · git");
    expect(html).toContain("Show tests");
    expect(html).toContain("Outside");
  });

  it("notes the folder it passed through", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={{ ...sample(), via: "src" }} tests={false} onTests={() => {}} />);
    expect(html).toMatch(/via <span class="mono">src<\/span>/);
  });

  it("shows an empty state when the scope has no facts", () => {
    const html = renderToStaticMarkup(<SystemDiagram id="p" sys={{ scope: "x", components: [], routes: [], externals: [], edges: [], stages: [] }} tests={false} onTests={() => {}} />);
    expect(html).toContain("No system facts in this scope");
    expect(html).not.toContain("<svg");
  });
});

describe("Arch mode toggle", () => {
  it("renders System and Packages, with the chosen one pressed", () => {
    const html = renderToStaticMarkup(<ArchModeToggle mode="system" onChange={() => {}} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>System</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Packages</);
    const pk = renderToStaticMarkup(<ArchModeToggle mode="packages" onChange={() => {}} />);
    expect(pk).toMatch(/aria-pressed="true"[^>]*>Packages</);
  });

  it("defaults to System and persists the choice", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(readArchMode(store)).toBe("system");
    writeArchMode("packages", store);
    expect(mem.get(ARCH_MODE_KEY)).toBe("packages");
    expect(readArchMode(store)).toBe("packages");
    mem.set(ARCH_MODE_KEY, "nonsense");
    expect(readArchMode(store)).toBe("system");
  });

  it("works when storage throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readArchMode(bad)).toBe("system");
    expect(() => writeArchMode("packages", bad)).not.toThrow();
  });
});
