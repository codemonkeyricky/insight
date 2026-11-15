import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIRAjv, isCoreFacet, isFacetId, KindRegistry, validateIR } from "../src/index.js";
import { createCoreRegistry, loadIRSchemas } from "../src/node.js";

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
    const registry = new KindRegistry(createIRAjv(loadIRSchemas()));
    expect(() => registry.add([{ kind: "x-a.b", facet: "flow" }], "bad")).toThrow(/not a valid kind definition/);
  });
});

describe("core registry", () => {
  it("contains the base kinds for every core facet", () => {
    const registry = createCoreRegistry();
    const facets = new Set(registry.list().map((k) => k.facet));
    expect([...facets].sort()).toEqual(
      ["calls", "concurrency", "data", "effects", "flow", "packaging", "state", "structure", "sync"],
    );
    expect(registry.subkinds("sync.lock-acquire")).toContain("sync.rwlock-acquire");
  });
});

describe("state facet", () => {
  const ref = { frontend: "test", confidence: "exact" };
  const file = { node: { id: "app/s.ts", facet: "structure", kind: "structure.file", attrs: { path: "app/s.ts", language: "typescript", parseStatus: "ok" }, provenance: ref } };
  const fn = { node: { id: "app/s.ts#f", facet: "structure", kind: "structure.function", parent: "app/s.ts", attrs: { name: "f" }, provenance: ref } };
  const holder = { node: { id: "app/s.ts#status", facet: "state", kind: "state.holder", parent: "app/s.ts", attrs: { name: "status", domainKind: "union", values: ["\"idle\"", "\"busy\""] }, provenance: ref } };
  const write = (attrs: Record<string, unknown>) => ({ node: { id: "app/s.ts#f/write/1", facet: "state", kind: "state.write", parent: "app/s.ts#f", attrs: { holder: "app/s.ts#status", ...attrs }, provenance: ref } });
  const test = { node: { id: "app/s.ts#f/test/1", facet: "state", kind: "state.test", parent: "app/s.ts#f", attrs: { holder: "app/s.ts#status", values: ["\"busy\""] }, provenance: ref } };
  const doc = (...records: unknown[]) => [file, fn, ...records].map((r) => JSON.stringify(r)).join("\n");

  it("isFacetId accepts state", () => {
    expect(isFacetId("state")).toBe(true);
    expect(isCoreFacet("state")).toBe(true);
  });

  it("accepts a holder, a set write and a test", () => {
    const report = validateIR(doc(holder, write({ op: "set", value: "\"busy\"" }), test), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a set write with neither value nor dynamic", () => {
    const report = validateIR(doc(holder, write({ op: "set" })), createCoreRegistry());
    expect(report.ok).toBe(false);
  });

  it("accepts a set write marked dynamic without a value", () => {
    const report = validateIR(doc(holder, write({ op: "set", dynamic: true })), createCoreRegistry());
    expect(report.errors).toEqual([]);
  });

  it("rejects a holder with no values", () => {
    const bad = { node: { ...holder.node, attrs: { name: "status", domainKind: "union" } } };
    const report = validateIR(doc(bad), createCoreRegistry());
    expect(report.ok).toBe(false);
  });

  it("accepts a calls.call edge with knownState and knownStale", () => {
    const edge = { edge: { from: "app/s.ts#f", to: "app/s.ts#f", facet: "calls", kind: "calls.call", attrs: { knownState: { "app/s.ts#status": ["\"busy\""] }, knownStale: ["app/s.ts#status"] }, provenance: ref } };
    const report = validateIR(doc(edge), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
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

describe("system-tab kinds (os.call, syscall, channels, sync)", () => {
  // One file and one node of the given kind, whose attrs are the argument.
  const withNode = (facet: string, kind: string, attrs: unknown) => {
    const file = { node: { id: "app/a.ts", facet: "structure", kind: "structure.file", attrs: { path: "app/a.ts", language: "typescript", parseStatus: "ok" }, provenance: { frontend: "test", confidence: "exact" } } };
    const node = { node: { id: "app/a.ts#n", facet, kind, parent: "app/a.ts", attrs, provenance: { frontend: "test", confidence: "exact" } } };
    return [file, node].map((r) => JSON.stringify(r)).join("\n");
  };
  const check = (ndjson: string) => validateIR(ndjson, createCoreRegistry());

  it("accepts a valid effects.os.call", () => {
    const report = check(withNode("effects", "effects.os.call", { api: "process.kill", op: "signal", syscall: "kill", target: "SIGTERM" }));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects an effects.os.call with an op outside the enum", () => {
    const report = check(withNode("effects", "effects.os.call", { api: "process.kill", op: "bogus" }));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("op must be equal to one of the allowed values"))).toBe(true);
  });

  it("rejects an effects.os.call without api", () => {
    const report = check(withNode("effects", "effects.os.call", { op: "memory" }));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("must have required property 'api'"))).toBe(true);
  });

  it("accepts syscall on effects.fs.write", () => {
    const report = check(withNode("effects", "effects.fs.write", { api: "fs.unlink", path: "x", syscall: "unlink" }));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("accepts a channel-send with channel and guardedBy", () => {
    const report = check(withNode("concurrency", "concurrency.channel-send", { channel: "Queue::items", api: "Queue.put", guardedBy: "m_" }));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a channel-send without channel", () => {
    const report = check(withNode("concurrency", "concurrency.channel-send", { api: "Queue.put" }));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("must have required property 'channel'"))).toBe(true);
  });

  it("accepts a sync.condvar with op wait and lock", () => {
    const report = check(withNode("sync", "sync.condvar", { op: "wait", lock: "m_" }));
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("packaging.external and build-target visibility", () => {
  const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n");
  const external = (attrs: Record<string, unknown>) => ({
    node: { id: "@abseil-cpp", facet: "packaging", kind: "packaging.external", attrs, provenance: { frontend: "frontend-bazel", confidence: "exact" } },
  });

  it("validates a bzlmod external package", () => {
    const report = validateIR(lines(external({ name: "abseil-cpp", version: "20240116.2", source: "bzlmod", manager: "bazel" })), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects an external package without source", () => {
    const report = validateIR(lines(external({ name: "abseil-cpp", version: "20240116.2" })), createCoreRegistry());
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("must have required property 'source'"))).toBe(true);
  });

  it("rejects an external package without manager", () => {
    const report = validateIR(lines(external({ name: "abseil-cpp", version: "20240116.2", source: "bzlmod" })), createCoreRegistry());
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes("must have required property 'manager'"))).toBe(true);
  });

  it("accepts open source and override values from any build system", () => {
    const cmake = validateIR(
      lines(external({ name: "fmt", source: "find_package", manager: "cmake", override: "local" })),
      createCoreRegistry(),
    );
    expect(cmake.errors).toEqual([]);
    expect(cmake.ok).toBe(true);
  });

  it("validates a build target with an output kind", () => {
    const target = {
      node: { id: "cmake:tools", facet: "packaging", kind: "packaging.build-target", attrs: { name: "tools", source: "tool", output: "executable" }, provenance: { frontend: "frontend-cmake", confidence: "exact" } },
    };
    const report = validateIR(lines(target), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a build target output outside the contract", () => {
    const target = {
      node: { id: "//app:x", facet: "packaging", kind: "packaging.build-target", attrs: { name: "x", source: "tool", output: "binary" }, provenance: { frontend: "frontend-bazel", confidence: "exact" } },
    };
    const report = validateIR(lines(target), createCoreRegistry());
    expect(report.ok).toBe(false);
  });

  it("accepts buildSystem on a structure.package", () => {
    const pkg = {
      node: { id: "cmake:lib", facet: "structure", kind: "structure.package", attrs: { name: "lib", root: "lib", buildSystem: "cmake" }, provenance: { frontend: "frontend-cmake", confidence: "exact" } },
    };
    const report = validateIR(lines(pkg), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("validates a build target with visibility", () => {
    const target = {
      node: { id: "//app:main", facet: "packaging", kind: "packaging.build-target", attrs: { name: "main", source: "tool", visibility: ["//visibility:public"] }, provenance: { frontend: "frontend-bazel", confidence: "exact" } },
    };
    const report = validateIR(lines(target), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("data facet", () => {
  const prov = { frontend: "hand-written", confidence: "exact" };
  const variable = (storage: string) =>
    JSON.stringify({
      node: {
        id: "app/state.ts#var:counter",
        facet: "data",
        kind: "data.variable",
        parent: "app/state.ts",
        attrs: { name: "counter", qualifiedName: "counter", storage, exported: true, mutable: true },
        provenance: prov,
      },
    });
  const doc = (storage: string) =>
    [
      JSON.stringify({ node: { id: "app/state.ts", facet: "structure", kind: "structure.file", attrs: { path: "app/state.ts", language: "typescript", parseStatus: "ok" }, provenance: prov } }),
      JSON.stringify({ node: { id: "app/a.ts", facet: "structure", kind: "structure.file", attrs: { path: "app/a.ts", language: "typescript", parseStatus: "ok" }, provenance: prov } }),
      variable(storage),
      JSON.stringify({ node: { id: "app/a.ts#bump", facet: "structure", kind: "structure.function", parent: "app/a.ts", attrs: { name: "bump" }, provenance: prov } }),
      JSON.stringify({ edge: { from: "app/a.ts#bump", to: "app/state.ts#var:counter", facet: "data", kind: "data.write", attrs: { how: "update" }, provenance: prov } }),
      JSON.stringify({ edge: { from: "app/a.ts#bump", to: "app/state.ts#var:counter", facet: "data", kind: "data.read", attrs: {}, provenance: prov } }),
    ].join("\n");

  it("validates data.variable, data.read and data.write", () => {
    const report = validateIR(doc("module"), createCoreRegistry());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.opaqueKinds).toEqual([]);
  });

  it("rejects an unknown storage value", () => {
    const report = validateIR(doc("heap"), createCoreRegistry());
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.line === 3 && e.message.includes("storage"))).toBe(true);
  });
});
