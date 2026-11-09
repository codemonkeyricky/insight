import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectPaths } from "../src/paths.js";

describe("projectPaths", () => {
  it("keeps the generated state in <root>/.insight by default", () => {
    const p = projectPaths("/work/proj");
    expect(p.state).toBe("/work/proj/.insight");
    expect(p.indexDb).toBe("/work/proj/.insight/index.sqlite");
    expect(p.localPlugins).toBe("/work/proj/.insight/plugins");
  });

  it("moves the generated state to stateDir, and keeps plugins and lens settings in the project", () => {
    const state = "/home/u/.insight/projects/ab12";
    const p = projectPaths("/work/proj", state);
    expect(p.state).toBe(state);
    expect(p.indexDb).toBe(join(state, "index.sqlite"));
    expect(p.review).toBe(join(state, "review.json"));
    expect(p.localPlugins).toBe("/work/proj/.insight/plugins");
    expect(p.lensConfigs).toBe("/work/proj/.insight/lenses");
  });
});
