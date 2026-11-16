import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { tierSystem } from "../src/arch/tier-layout";
import { layoutSystem } from "../src/arch/system-layout";
import { readSystemMode, SYSTEM_MODE_KEY, writeSystemMode } from "../src/arch/system-mode";
import { SystemModeToggle } from "../src/components/views/SystemView";
import { API, DISK, FN, GH, SQLITE, WEB, tierFixture, tierNodes } from "./tierFixtures";

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("tierSystem", () => {
  it("makes the deployable units the components, in a frontend stage and a backend stage", () => {
    const { sys } = tierSystem(tierFixture());
    expect(sys.components.map((c) => c.id).sort()).toEqual([API, FN, WEB].sort());
    expect(sys.stages).toEqual([[WEB], [API, FN]]);
    expect(sys.components.find((c) => c.id === WEB)?.path).toBe(WEB);
  });

  it("makes the stores and services the outside systems, with their categories kept", () => {
    const { sys } = tierSystem(tierFixture());
    const byId = new Map(sys.externals.map((x) => [x.id, x]));
    expect(byId.get(SQLITE)?.category).toBe("store");
    expect(byId.get(DISK)?.category).toBe("filesystem");
    expect(byId.get(DISK)?.label).toBe("Local disk");
    expect(byId.get(GH)?.category).toBe("service");
    expect(byId.get(GH)?.host).toBe("api.github.com");
  });

  it("writes each edge's text as its verb and label, and keeps the confidence", () => {
    const { sys } = tierSystem(tierFixture());
    const edge = (from: string, to: string) => sys.edges.find((e) => e.from === from && e.to === to);
    expect(edge(WEB, API)?.label).toBe("requests GET /api/items");
    expect(edge(API, SQLITE)?.verb).toBe("opens");
    expect(edge(FN, GH)?.confidence).toBe("inferred");
  });

  it("puts a platform note on each card and a role line", () => {
    const { layout } = tierSystem(tierFixture());
    expect(layout.notes?.get(WEB)).toBe("browser");
    expect(layout.notes?.get(FN)).toBe("Vercel Function");
    expect(layout.notes?.get(API)).toBe("local Node");
    expect(layout.subs?.get(API)).toBe("Server · 2 routes");
  });

  it("lays out Frontend, Backend, then Storage and External in the given order", () => {
    const { sys, layout } = tierSystem(tierFixture());
    const out = layoutSystem(sys, layout);
    expect(out.columns.map((c) => c.title)).toEqual(["Frontend", "Backend", "Storage", "External"]);
    const col = (id: string) => out.boxes.find((b) => b.id === id)?.column;
    expect(col(WEB)).toBe(0);
    expect(col(API)).toBe(1);
    expect(col(SQLITE)).toBe(2);
    expect(col(DISK)).toBe(2);
    expect(col(GH)).toBe(3);
  });

  it("follows externalColumns order when it is given reversed", () => {
    const { sys, layout } = tierSystem(tierFixture());
    const out = layoutSystem(sys, { ...layout, externalColumns: [...(layout.externalColumns ?? [])].reverse() });
    expect(out.columns.map((c) => c.title)).toEqual(["Frontend", "Backend", "External", "Storage"]);
  });

  it("keeps the titles with their stages when the frontend stage is empty", () => {
    const nodes = tierNodes.filter((n) => n.tier !== "frontend");
    const edges = tierFixture().edges.filter((e) => e.from !== WEB);
    const { sys, layout } = tierSystem(tierFixture({ nodes, edges }));
    expect(sys.stages[0]).toEqual([]);
    const out = layoutSystem(sys, layout);
    expect(out.columns[0]?.title).toBe("Backend");
    expect(out.boxes.find((b) => b.id === API)?.column).toBe(0);
  });

  it("routes a Frontend to Storage edge around the Backend cards, not through them", () => {
    const { sys, layout } = tierSystem(tierFixture());
    const out = layoutSystem(sys, layout);
    const arrow = out.arrows.find((a) => a.from === WEB && a.to === DISK);
    expect(arrow).toBeDefined();
    expect(arrow?.lane).toBeDefined();
    const backend = out.boxes.filter((b) => b.column === 1);
    for (const p of arrow?.samples ?? []) {
      for (const b of backend) {
        const inside = p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
        expect(inside).toBe(false);
      }
    }
  });
});

describe("system mode", () => {
  it("defaults to Tiers, and remembers a Runtime choice", () => {
    const store = memStore();
    expect(readSystemMode(store)).toBe("tiers");
    writeSystemMode("runtime", store);
    expect(store.getItem(SYSTEM_MODE_KEY)).toBe("runtime");
    expect(readSystemMode(store)).toBe("runtime");
  });

  it("reads as Tiers when storage is blocked or holds an unknown value", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readSystemMode(blocked)).toBe("tiers");
    expect(readSystemMode(fixedStore("packages"))).toBe("tiers");
    expect(readSystemMode(undefined)).toBe("tiers");
  });

  it("renders the two-button toggle with Tiers pressed by default", () => {
    const html = renderToStaticMarkup(<SystemModeToggle mode="tiers" onChange={() => {}} />);
    expect(html).toContain('aria-label="System view"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Tiers</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Runtime</);
  });
});

function fixedStore(v: string) {
  return { getItem: () => v, setItem: () => undefined };
}
