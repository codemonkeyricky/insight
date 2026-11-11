import { describe, expect, it } from "vitest";
import type { LensSummary } from "../src/api.js";
import { projectFindingsTotal } from "../src/projectFindings.js";

const lens = (id: string, findings: number): LensSummary => ({ id, title: id, status: "ok", reused: false, findings, metrics: {} });

describe("projectFindingsTotal", () => {
  it("is zero when the project has never run", () => {
    expect(projectFindingsTotal(undefined)).toBe(0);
  });

  it("sums the findings of every lens", () => {
    const last = { findings: 0, lenses: [lens("calls", 344), lens("concurrency-map", 24), lens("dependencies", 3), lens("lock-order", 0)] };
    expect(projectFindingsTotal(last)).toBe(371);
  });

  it("adds the run's own count to the lens sum", () => {
    expect(projectFindingsTotal({ findings: 5, lenses: [lens("a", 2), lens("b", 1)] })).toBe(8);
  });

  it("counts the run's own findings when it has no lenses", () => {
    expect(projectFindingsTotal({ findings: 7 })).toBe(7);
    expect(projectFindingsTotal({ findings: 7, lenses: [] })).toBe(7);
  });

  it("is zero for a run with no findings in any lens", () => {
    expect(projectFindingsTotal({ findings: 0, lenses: [lens("effects", 0)] })).toBe(0);
  });
});
