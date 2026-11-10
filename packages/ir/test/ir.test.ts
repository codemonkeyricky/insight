import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreRegistry, KindRegistry, validateIR } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");
const json = <T>(name: string): T => JSON.parse(fixture(name)) as T;

describe("hand-written .ir.json", () => {
  it("validates", () => {
    const report = validateIR(fixture("hand.ir.json"), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.nodes).toHaveLength(4);
    expect(report.edges).toHaveLength(2);
    expect(report.opaqueKinds).toEqual([]);
  });

  it("fails with line-numbered messages for each problem", () => {
    const report = validateIR(fixture("invalid.ir.json"), createCoreRegistry());
    expect(report.ok).toBe(false);
    const messages = report.errors.map((e) => `${e.line}: ${e.message}`);
    expect(messages).toContain(
      '2: node "app/a.ts#lock": kind "sync.lock-acquire" attrs must have required property \'lock\'',
    );
    expect(messages.some((m) => m.startsWith("3: node: facet must match pattern"))).toBe(true);
    expect(messages.some((m) => m.startsWith("4: not valid JSON"))).toBe(true);
    expect(messages).toContain(
      '5: edge: from "app/a.ts#missing" is not defined in this document',
    );
  });
});

describe("kinds defined as JSON only", () => {
  const selectDef = json<unknown>("kinds/x-test-select.kind.json");

  it("accepts an unknown kind as opaque, so it is stored and shown", () => {
    const report = validateIR(fixture("select.ir.json"), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.opaqueKinds).toEqual(["x-test.select"]);
  });

  it("accepts a kind once a plugin supplies its JSON definition", () => {
    const registry = createCoreRegistry().clone();
    registry.add([selectDef], "test-plugin");
    const report = validateIR(fixture("select.ir.json"), registry);
    expect(report.errors).toEqual([]);
    expect(report.opaqueKinds).toEqual([]);
    expect(registry.get("x-test.select")?.facet).toBe("flow");
  });

  it("inherits the parent's attribute schema and rejects bad attributes with a clear message", () => {
    const registry = createCoreRegistry().clone();
    registry.add([selectDef], "test-plugin");
    const report = validateIR(fixture("select-bad.ir.json"), registry);
    expect(report.ok).toBe(false);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.line).toBe(2);
    expect(report.errors[0]?.message).toContain('kind "x-test.select" attrs.hasDefault must be boolean');
  });

  it("makes the new kind a subkind of its parent for queries", () => {
    const registry = createCoreRegistry().clone();
    registry.add([selectDef], "test-plugin");
    expect(registry.subkinds("flow.branch")).toEqual(["flow.branch", "flow.switch", "x-test.select"]);
    expect(registry.isA("x-test.select", "flow.branch")).toBe(true);
  });

  it("rejects a definition whose parent is not loaded, naming the missing kind", () => {
    const registry = createCoreRegistry().clone();
    const orphan = { ...(selectDef as object), extends: "flow.missing-parent" };
    expect(() => registry.add([orphan], "orphan-plugin")).toThrow(
      /kind "x-test.select" from "orphan-plugin" extends "flow.missing-parent", which no loaded definition provides/,
    );
  });

  it("rejects a plugin kind outside its x- namespace", () => {
    const registry = createCoreRegistry().clone();
    expect(() => registry.add([{ ...(selectDef as object), kind: "flow.select" }], "test-plugin")).toThrow(
      /plugin kinds must use an x-<name>\. namespace/,
    );
  });

  it("names both plugins when two definitions conflict, and adds nothing from the failed batch", () => {
    const registry = createCoreRegistry().clone();
    registry.add([selectDef], "plugin-a");
    const other = { kind: "x-test.other", facet: "flow", on: "node" };
    expect(() => registry.add([other, selectDef], "plugin-b")).toThrow(
      /kind "x-test.select" is defined by both "plugin-a" and "plugin-b"/,
    );
    expect(registry.has("x-test.other")).toBe(false);
  });

  it("rejects an invalid definition with the schema path", () => {
    const registry = new KindRegistry();
    expect(() => registry.add([{ kind: "x-a.b", facet: "flow" }], "bad")).toThrow(/not a valid kind definition/);
  });
});

describe("core registry", () => {
  it("contains the base kinds for every core facet", () => {
    const registry = createCoreRegistry();
    const facets = new Set(registry.list().map((k) => k.facet));
    expect([...facets].sort()).toEqual(
      ["calls", "concurrency", "effects", "flow", "packaging", "structure", "sync"],
    );
    expect(registry.subkinds("sync.lock-acquire")).toContain("sync.rwlock-acquire");
  });
});

describe("calls.reference how", () => {
  const ndjson = (how: unknown) => {
    const node = (id: string) => ({
      node: { id, facet: "structure", kind: "structure.function", parent: "app/a.ts", attrs: { name: id.split("#")[1] }, provenance: { frontend: "test", confidence: "exact" } },
    });
    const edge = { edge: { from: "app/a.ts#a", to: "app/a.ts#onMessage", facet: "calls", kind: "calls.reference", attrs: { how }, provenance: { frontend: "test", confidence: "exact" } } };
    const file = { node: { id: "app/a.ts", facet: "structure", kind: "structure.file", attrs: { path: "app/a.ts", language: "typescript", parseStatus: "ok" }, provenance: { frontend: "test", confidence: "exact" } } };
    return [file, node("app/a.ts#a"), node("app/a.ts#onMessage"), edge].map((r) => JSON.stringify(r)).join("\n");
  };

  it("accepts how \"handler\", the value the TypeScript frontend emits for an installed message handler", () => {
    const report = validateIR(ndjson("handler"), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a how value that no frontend emits", () => {
    const report = validateIR(ndjson("bogus"), createCoreRegistry());
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("how must be equal to one of the allowed values"))).toBe(true);
  });
});
