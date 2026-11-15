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
    const at = (name: string) => html.indexOf(`>${name}</a>`);
    const names = ["assemblePhysicsModel", "parsePhysicsModel", "validatePhysicsModel", "solveDrive"];
    for (const n of names) expect(at(n)).toBeGreaterThan(-1);
    for (let i = 1; i < names.length; i++) expect(at(names[i - 1])).toBeLessThan(at(names[i]));
    expect(html).toContain("Sequence · ");
    expect(html).toContain("physics · src/physics/assemble.ts");
    expect(html).toContain("src/physics/validate.ts");
    expect(html).toContain("+2 more");
    expect(html).toContain("pipe-seq-strip");
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
});
