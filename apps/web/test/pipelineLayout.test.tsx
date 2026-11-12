import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineEdge, PipelineModel, PipelinePoint, SystemComponent } from "@insight/model";
import { ARCH_MODE_KEY, readArchMode, writeArchMode } from "../src/arch/mode";
import { layoutSystem } from "../src/arch/system-layout";
import { hostCalls, pipelineRows, pipelineSystem, pipelineTitles } from "../src/arch/pipeline-layout";
import { PipelineDiagram } from "../src/components/views/PipelineView";
import { PipelineSummary } from "../src/components/views/PipelineSummary";
import { ArchModeToggle } from "../src/components/views/ArchTab";

const H = "packages/indexer";
const BAZEL = "packages/bazel";
const CPP = "packages/cpp";
const TS = "packages/typescript";
const IR = "packages/ir";
const SDK = "packages/sdk";
const LA = "packages/lens-a";
const LB = "packages/lens-b";

const comp = (id: string): SystemComponent => ({ id, label: id, path: id, kind: "package", files: 2, functions: 3, entry: false });
const site = (file: string, line: number) => ({ file, line, fn: `${file}#f` });

const point = (over: Partial<PipelinePoint> & Pick<PipelinePoint, "label" | "components" | "order">): PipelinePoint => ({
  id: `${H}>${over.components.join("+")}`,
  host: H,
  members: [],
  receiver: over.label.toLowerCase(),
  sites: [site(`${H}/src/a.ts`, 10)],
  count: 1,
  role: over.order === 0 ? "source" : "sink",
  ...over,
});

const edge = (from: string, to: string, verb: PipelineEdge["verb"], label: string, confidence: PipelineEdge["confidence"]): PipelineEdge => ({
  id: `${from}>${verb}>${to}`,
  from,
  to,
  verb,
  label,
  count: 1,
  sites: [site(`${H}/src/a.ts`, 10)],
  confidence,
});

/** The packages scope: three frontends feed the indexer, which calls four packages; two lenses take its runs. Resolvers reuses the frontends. */
function sample(): PipelineModel {
  const points: PipelinePoint[] = [
    point({ label: "Frontends", components: [BAZEL, CPP, TS], members: ["detect", "extract"], order: 0 }),
    point({ label: "Resolvers", components: [BAZEL, CPP], members: ["resolve"], order: 1 }),
    point({ label: "Lenses", components: [LA, LB], members: ["run"], order: 2 }),
  ];
  return {
    scope: "packages",
    host: H,
    driver: { id: `${H}/src/run.ts#runIndex`, name: "runIndex" },
    points,
    columns: [[BAZEL, CPP, TS], [H, IR, SDK], [LA, LB]],
    components: [BAZEL, CPP, TS, H, IR, SDK, LA, LB].map(comp),
    edges: [
      edge(BAZEL, H, "produces", "detect, extract", "inferred"),
      edge(CPP, H, "produces", "detect, extract", "inferred"),
      edge(TS, H, "produces", "detect, extract", "inferred"),
      edge(H, LA, "feeds", "run", "inferred"),
      edge(H, LB, "feeds", "run", "inferred"),
      edge(H, IR, "calls", "calls", "exact"),
      edge(H, SDK, "calls", "calls", "inferred"),
    ],
    omitted: 2,
    dropped: 1,
  };
}

const EMPTY: PipelineModel = { scope: "packages/lens", points: [], columns: [], components: [], edges: [], omitted: 0, dropped: 0, reason: "no extension points in this scope" };

describe("pipeline titles and columns", () => {
  it("names the columns: points by label and count, the host by its package", () => {
    expect(pipelineTitles(sample())).toEqual(["Frontends ×3 · detect, extract", "Host · indexer", "Lenses ×2 · run"]);
    const { layout, sys } = pipelineSystem(sample());
    expect(layout.titles).toEqual(["Frontends ×3 · detect, extract", "Host · indexer", "Lenses ×2 · run"]);
    expect(sys.stages).toEqual(sample().columns);
    expect(sys.routes).toEqual([]);
    expect(sys.externals).toEqual([]);
  });

  it("lays the columns out left to right in the order Frontends, Host, Lenses", () => {
    const { sys, layout: opts } = pipelineSystem(sample());
    const layout = layoutSystem(sys, opts);
    expect(layout.columns.map((c) => c.title)).toEqual(["Frontends ×3 · detect, extract", "Host · indexer", "Lenses ×2 · run"]);
    expect(layout.columns[0]?.x).toBeLessThan(layout.columns[1]?.x as number);
    expect(layout.columns[1]?.x).toBeLessThan(layout.columns[2]?.x as number);
    const colOf = (id: string) => layout.boxes.find((b) => b.id === id)?.column;
    expect([colOf(BAZEL), colOf(H), colOf(LA)]).toEqual([0, 1, 2]);
  });

  it("keeps the System view's titles when none are given", () => {
    const { sys } = pipelineSystem(sample());
    expect(layoutSystem(sys).columns[0]?.title).toBe("Entry");
  });
});

describe("pipeline edges", () => {
  it("keeps the verbs, and draws produces and feeds solid even when inferred", () => {
    const { sys } = pipelineSystem(sample());
    const layout = layoutSystem(sys);
    const verbs = new Set(layout.arrows.map((a) => a.edge.verb));
    expect([...verbs].sort()).toEqual(["feeds", "produces"]);
    const produces = layout.arrows.filter((a) => a.edge.verb === "produces");
    expect(produces).toHaveLength(3);
    // The pipeline's produces and feeds edges are facts of the view, so they are solid even when inferred.
    expect(produces.every((a) => !a.inferred && !a.dashed)).toBe(true);
    expect(layout.arrows.filter((a) => a.edge.verb === "feeds").every((a) => !a.inferred)).toBe(true);
  });

  it("draws no edge whose two ends share a column, and folds the host's calls into its note", () => {
    const { sys, layout: opts } = pipelineSystem(sample());
    expect(sys.edges.some((e) => e.verb === "calls")).toBe(false);
    const layout = layoutSystem(sys, opts);
    for (const a of layout.arrows) expect(a.from === H || a.to === H).toBe(true);
    const host = layout.boxes.find((b) => b.id === H);
    expect(host?.chips).toEqual(["uses ir, sdk"]);
    // The model keeps the calls; only the drawing leaves them out.
    expect(sample().edges.filter((e) => e.verb === "calls")).toHaveLength(2);
  });

  it("lists the host's same-column calls in the summary", () => {
    expect(hostCalls(sample())).toEqual(["packages/ir", "packages/sdk"]);
    const html = renderToStaticMarkup(<PipelineSummary pipeline={sample()} />);
    expect(html).toContain("Host calls");
    expect(html).toContain("packages/ir, packages/sdk");
  });

  it("draws the produces arrows from the frontends into the host, and the feeds arrows from the host into the lenses", () => {
    const { sys } = pipelineSystem(sample());
    const layout = layoutSystem(sys);
    const from = (verb: string) => layout.arrows.filter((a) => a.edge.verb === verb).map((a) => `${a.from}>${a.to}`).sort();
    expect(from("produces")).toEqual([`${BAZEL}>${H}`, `${CPP}>${H}`, `${TS}>${H}`].sort());
    expect(from("feeds")).toEqual([`${H}>${LA}`, `${H}>${LB}`].sort());
  });
});

describe("pipeline rows", () => {
  it("lists the points in order, and names the columns that draw a point's components", () => {
    const rows = pipelineRows(sample());
    expect(rows.map((r) => r.label)).toEqual(["Frontends", "Resolvers", "Lenses"]);
    expect(rows[0]?.shownUnder).toBeUndefined();
    expect(rows[1]).toMatchObject({ label: "Resolvers", role: "sink", members: "resolve", shownUnder: "Frontends" });
    expect(rows[1]?.components).toEqual([BAZEL, CPP]);
    expect(rows[2]?.components).toEqual([LA, LB]);
  });

  it("renders the summary: driver, points, omitted and dropped counts", () => {
    const html = renderToStaticMarkup(<PipelineSummary pipeline={sample()} />);
    expect(html).toContain("Driven by");
    expect(html).toContain("runIndex");
    expect(html.indexOf("Frontends")).toBeLessThan(html.indexOf("Resolvers"));
    expect(html).toContain("Resolvers");
    expect(html).toContain("shown under Frontends");
    expect(html).toContain("2 components not in the pipeline");
    expect(html).toContain("1 extension point of other hosts");
  });
});

describe("pipeline empty state", () => {
  it("converts to an empty System model and draws nothing", () => {
    const { sys, layout } = pipelineSystem(EMPTY);
    expect(sys.components).toEqual([]);
    expect(sys.edges).toEqual([]);
    expect(layout.titles).toEqual([]);
    expect(layoutSystem(sys, layout).boxes).toEqual([]);
  });

  it("shows the parent-scope message when the model gives a reason", () => {
    const html = renderToStaticMarkup(<PipelineDiagram id="p" pipeline={EMPTY} tests={false} onTests={() => {}} />);
    expect(html).toContain("No extension points in this scope. Pick a parent scope.");
  });

  it("draws the pipeline legend and the summary panel with nothing selected", () => {
    const html = renderToStaticMarkup(<PipelineDiagram id="p" pipeline={sample()} tests={false} onTests={() => {}} />);
    expect(html).toContain("produces");
    expect(html).toContain("Frontends ×3 · detect, extract");
    expect(html).toContain("Host · indexer");
    expect(html).toContain("Lenses ×2 · run");
  });
});

describe("the Arch mode toggle with Pipeline", () => {
  it("shows System, Pipeline and Packages in that order", () => {
    const html = renderToStaticMarkup(<ArchModeToggle mode="pipeline" onChange={() => {}} />);
    const at = (s: string) => html.indexOf(s);
    expect(at(">System<")).toBeGreaterThan(-1);
    expect(at(">System<")).toBeLessThan(at(">Pipeline<"));
    expect(at(">Pipeline<")).toBeLessThan(at(">Packages<"));
    expect(html).toContain('aria-pressed="true">Pipeline<');
  });

  it("saves and restores the pipeline choice, and still defaults to System", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeArchMode("pipeline", store);
    expect(mem.get(ARCH_MODE_KEY)).toBe("pipeline");
    expect(readArchMode(store)).toBe("pipeline");
    mem.set(ARCH_MODE_KEY, "nonsense");
    expect(readArchMode(store)).toBe("system");
  });
});
