import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PipelineModel, PipelineSequence, PipelineStage } from "@insight/model";
import { PipelineSequences } from "../src/components/views/PipelineSequences";
import { PipelineDiagram } from "../src/components/views/PipelineView";

const stage = (order: number, name: string, file: string, component?: string): PipelineStage => ({
  fn: `${file}#${name}`,
  name,
  file,
  ...(component !== undefined ? { component } : {}),
  order,
  site: { file: "src/check/design.ts", line: 10 + order, fn: "src/check/design.ts#checkDesign" },
});

const seq: PipelineSequence = {
  id: "src/verify/verify.ts#checkDesign",
  name: "checkDesign",
  file: "src/verify/verify.ts",
  component: "verify",
  stages: [
    stage(0, "assemblePhysicsModel", "src/physics/assemble.ts", "physics"),
    stage(1, "parsePhysicsModel", "src/physics/parse.ts", "physics"),
    stage(2, "validatePhysicsModel", "src/physics/validate.ts"),
    stage(3, "solveDrive", "src/solve/drive.ts", "solve"),
  ],
  more: 2,
  files: 4,
  score: 16.9,
};

const model = (over: Partial<PipelineModel>): PipelineModel => ({
  scope: "",
  points: [],
  sequences: [],
  columns: [],
  components: [],
  edges: [],
  omitted: 0,
  dropped: 0,
  ...over,
});

describe("PipelineSequences", () => {
  it("renders the stage cards in stage order, with the index, the name, the component and the more count", () => {
    const html = renderToStaticMarkup(<PipelineSequences id="p1" sequences={[seq]} />);
    for (let i = 0; i < seq.stages.length; i++) expect(html).toContain(`<span class="pipe-seq-n mono small muted">${i + 1}</span>`);
    const at = (name: string) => html.indexOf(`>${name}</a>`);
    const names = ["assemblePhysicsModel", "parsePhysicsModel", "validatePhysicsModel", "solveDrive"];
    for (const n of names) expect(at(n)).toBeGreaterThan(-1);
    for (let i = 1; i < names.length; i++) expect(at(names[i - 1])).toBeLessThan(at(names[i]));
    expect(html).toContain("Sequence · ");
    expect(html).toContain("physics · src/physics/assemble.ts");
    expect(html).toContain('<div class="small muted pipe-seq-where">src/physics/validate.ts</div>');
    expect(html).toContain("+2 more");
    expect(html).toContain('role="list"');
  });

  it("links the orchestrator once in the header and gives each card its call site only", () => {
    const html = renderToStaticMarkup(<PipelineSequences id="p1" sequences={[seq]} />);
    expect(html).toContain('<h3 class="pipe-seq-h small muted" id="pipe-seq-src/verify/verify.ts#checkDesign">');
    expect(html).toContain('aria-labelledby="pipe-seq-src/verify/verify.ts#checkDesign"');
    expect(html.match(/>checkDesign<\/a>/g)?.length).toBe(1);
    expect(html).not.toContain(" in Flow</a>");
    expect(html).toContain("src/check/design.ts:10");
    expect(html).toContain("src/check/design.ts:13");
    // A stage links to its own function in Flow, scoped to its folder.
    const href = html.match(/href="([^"]*)"[^>]*>solveDrive</)?.[1] ?? "";
    expect(href).toContain("flow");
    expect(decodeURIComponent(href)).toContain("src/solve/drive.ts#solveDrive");
    expect(decodeURIComponent(href)).toContain("src/solve");
  });

  it("omits the more count when nothing was cut, and the site when the call has no line", () => {
    const one: PipelineSequence = { ...seq, more: 0, stages: [{ ...seq.stages[0], site: { file: "src/check/design.ts", line: 0 } }] };
    const html = renderToStaticMarkup(<PipelineSequences id="p1" sequences={[one]} />);
    expect(html).not.toContain("more</li>");
    expect(html).not.toContain(":0<");
    expect(html).not.toContain("No site recorded");
  });

  it("dims the strip while stale and caps it when the diagram follows", () => {
    const html = renderToStaticMarkup(<PipelineSequences id="p1" sequences={[seq]} capped stale />);
    expect(html).toContain('class="pipe-seqs capped stale"');
  });

  it("renders nothing when there are no sequences", () => {
    expect(renderToStaticMarkup(<PipelineSequences id="p1" sequences={[]} />)).toBe("");
  });
});

describe("PipelineDiagram with sequences and no points", () => {
  it("shows only the strip, with no empty-state text", () => {
    const html = renderToStaticMarkup(
      <PipelineDiagram id="p1" pipeline={model({ sequences: [seq], reason: undefined })} tests={false} onTests={() => {}} />,
    );
    expect(html).toContain("pipe-seq-strip");
    expect(html).not.toContain("No extension points");
    expect(html).not.toContain("No system facts");
    expect(html).not.toContain("sysv-stage");
  });

  it("keeps the scope label and the Show tests toggle, and dims the strip while stale", () => {
    const html = renderToStaticMarkup(
      <PipelineDiagram id="p1" pipeline={model({ scope: "src/verify", sequences: [seq] })} tests={true} onTests={() => {}} stale />,
    );
    expect(html).toContain("Show tests");
    expect(html).toContain("checked");
    expect(html).toContain('Scope <span class="mono">src/verify</span>');
    expect(html).toContain("1 sequence");
    expect(html).toContain('class="pipe-seqs stale"');
  });
});
