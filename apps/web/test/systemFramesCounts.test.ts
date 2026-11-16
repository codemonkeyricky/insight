import { describe, expect, it } from "vitest";
import type { SystemModel } from "@insight/model";
import { layoutSystemFrames } from "../src/arch/system-frames";
import type { SysBox } from "../src/arch/system-layout";
import { model } from "./systemFixtures";

describe("component sub-text without counts", () => {
  it("omits the file and function counts of a component the model has no counts for, instead of printing 0 files", () => {
    const base = model();
    const sys: SystemModel = { ...base, runtimes: [], slices: [], components: base.components.map(({ files: _f, functions: _n, ...c }) => c) };
    const boxes = layoutSystemFrames(sys).boxes.filter((b): b is SysBox => b.kind === "component");
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b.sub ?? "").not.toMatch(/\b0 (files?|functions?)\b/);
  });
});
