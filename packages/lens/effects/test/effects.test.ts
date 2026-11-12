import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { type TableView } from "@insight/sdk";
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

/**
 * The scope "src" cut from a project. api (exported, in scope) calls util, which writes a file, and calls lib/x.ts#ext,
 * which is outside. lib/x.ts#caller is outside, and calls util. Stubs are never entry points, even when marked exported.
 * The effect under lib/x.ts#ext is marked external, so it is not this scope's effect.
 */
function scopedFixture() {
  const fn = (file: string, name: string, exported: boolean) =>
    fx.node(`${file}#${name}`, "structure", "structure.function", { parent: file, attrs: { name, exported }, span: fx.span(file, 0, 0, 0, 1) });
  const stub = (id: string, name: string) => fx.node(id, "structure", "structure.function", { attrs: { name, exported: true, external: true } });
  return fx.view({
    nodes: [
      fx.node("src/api.ts", "structure", "structure.file"),
      fx.node("src/util.ts", "structure", "structure.file"),
      fn("src/api.ts", "api", true),
      fn("src/util.ts", "util", false),
      stub("lib/x.ts#ext", "ext"),
      stub("lib/x.ts#caller", "caller"),
      fx.node("src/util.ts@w1", "effects", "effects.fs.write", { parent: "src/util.ts#util", attrs: { api: "fs.writeFileSync" }, span: fx.span("src/util.ts", 2, 4, 2, 30) }),
      fx.node("src/api.ts@e1", "effects", "effects.env.read", { parent: "src/api.ts#api", attrs: { api: "process.env", name: "CONFIG" }, span: fx.span("src/api.ts", 1, 2, 1, 20) }),
      fx.node("lib/x.ts@n1", "effects", "effects.net.connect", { parent: "lib/x.ts#ext", attrs: { api: "net.connect", external: true } }),
    ],
    edges: [
      fx.edge("src/api.ts#api", "src/util.ts#util", "calls", "calls.call"),
      fx.edge("src/api.ts#api", "lib/x.ts#ext", "calls", "calls.call"),
      fx.edge("lib/x.ts#caller", "src/util.ts#util", "calls", "calls.call"),
    ],
  });
}

const runScoped = (config?: unknown) => lensEffects.run(scopedFixture(), { ...ctx(config), scope: "src" });

describe("lens-effects in a partial scope", () => {
  it("uses only local functions as entry points, and counts only this scope's effects", async () => {
    const result = await runScoped();
    expect(table(result.views, "surface").rows).toEqual([["src/api.ts#api", "env.read, fs.write", 2]]);
    expect(result.metrics).toMatchObject({ entries: 1, effectSites: 2, functionsWithEffects: 2 });
  });

  it("does not take a configured entry that lies outside the scope", async () => {
    const result = await runScoped({ entries: ["lib/x.ts#ext", "lib/x.ts#caller"] });
    expect(result.metrics.entries).toBe(0);
    expect(table(result.views, "surface").rows).toEqual([]);
  });

  it("lists the direct effects of a local function that only an outside caller reaches", async () => {
    const result = await runScoped();
    expect(table(result.views, "direct-effects").rows).toEqual([
      ["src/api.ts#api", "env.read", 1],
      ["src/util.ts#util", "fs.write", 1],
    ]);
  });
});
