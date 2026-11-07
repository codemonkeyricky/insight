import { describe, expect, it } from "vitest";
import { irFixtures as fx, type TableView } from "@insight/sdk";
import { lensEffects } from "../src/index.js";

const ctx = (config?: unknown) => ({
  root: { path: "/unused", name: "fixture", allowBuildTools: false },
  config,
  resultOf: () => undefined,
});

/**
 * api (exported) calls util, which writes a file. api reads an env var itself. unknown() makes a
 * call the frontend could not classify. main (exported) has no effects.
 */
function fixture() {
  const fn = (file: string, name: string, exported: boolean) =>
    fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name, exported }, span: fx.span(file, 0, 0, 0, 1) });
  return fx.view({
    nodes: [
      fx.node("src/api.ts", "structure", "structure.file"),
      fx.node("src/util.ts", "structure", "structure.file"),
      fn("src/api.ts", "api", true),
      fn("src/util.ts", "util", false),
      fn("src/api.ts", "main", true),
      fx.node("src/util.ts@w1", "effects", "effects.fs.write", { parent: "src/util.ts#util", attrs: { api: "fs.writeFileSync" }, span: fx.span("src/util.ts", 2, 4, 2, 30) }),
      fx.node("src/api.ts@e1", "effects", "effects.env.read", { parent: "src/api.ts#api", attrs: { api: "process.env", name: "CONFIG" }, span: fx.span("src/api.ts", 1, 2, 1, 20) }),
      fx.node("src/util.ts@u1", "effects", "effects.unknown", { parent: "src/util.ts#util", attrs: { api: "weird.call" }, span: fx.span("src/util.ts", 3, 4, 3, 12) }),
    ],
    edges: [fx.edge("src/api.ts#api", "src/util.ts#util", "calls", "calls.call")],
  });
}

const table = (views: { type: string; id?: string }[] | undefined, id: string) => {
  const t = views?.find((v): v is TableView => v.type === "table" && (v as TableView).id === id);
  if (!t) throw new Error(`missing ${id}`);
  return t;
};

describe("lensEffects", () => {
  it("shows the effects each entry point can reach through calls", async () => {
    const result = await lensEffects.run(fixture(), ctx());
    const surface = table(result.views, "surface").rows;
    expect(surface).toEqual([
      ["src/api.ts#api", "env.read, fs.write, unknown", 2],
      ["src/api.ts#main", "none", 0],
    ]);
  });

  it("lists direct effects by owning function", async () => {
    const result = await lensEffects.run(fixture(), ctx());
    expect(table(result.views, "direct-effects").rows).toEqual([
      ["src/api.ts#api", "env.read", 1],
      ["src/util.ts#util", "fs.write, unknown", 2],
    ]);
  });

  it("reports unclassified effects as info", async () => {
    const result = await lensEffects.run(fixture(), ctx());
    expect(result.findings.find((f) => f.id === "unknown:src/util.ts@u1")).toMatchObject({ severity: "info" });
    expect(result.metrics.unknownEffects).toBe(1);
  });

  it("reports forbidden direct effects in matching files as errors", async () => {
    const result = await lensEffects.run(
      fixture(),
      ctx({ forbid: [{ module: "src/util.ts", effects: ["effects.fs.write"], reason: "util is pure" }] }),
    );
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: "forbid:0:src/util.ts@w1", nodes: ["src/util.ts@w1"] });
    expect(errors[0]?.message).toContain("util is pure");
    expect(result.metrics.forbidViolations).toBe(1);
  });

  it("does not flag effects outside the rule's module glob", async () => {
    const result = await lensEffects.run(fixture(), ctx({ forbid: [{ module: "src/api.ts", effects: ["fs.write"] }] }));
    expect(result.findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });
});
