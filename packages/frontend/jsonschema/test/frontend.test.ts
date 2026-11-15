import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import type { IRBatch, ProjectRoot } from "@insight/sdk";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const genericRoot = join(here, "fixtures", "generic");
const repoRoot = resolve(here, "..", "..", "..", "..");

const IGNORED = new Set(["node_modules", "dist", ".git", ".insight", ".claude"]);
function listJson(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!IGNORED.has(e.name)) out.push(...listJson(root, childRel));
    } else if (e.isFile() && e.name.endsWith(".json")) out.push(childRel);
  }
  return out.sort();
}

async function run(root: string, files: string[]): Promise<IRBatch[]> {
  const pr: ProjectRoot = { path: root, name: "t", allowBuildTools: false };
  const out: IRBatch[] = [];
  const ctx = { root: pr, files, listFiles: () => [...files], readFile: async (rel: string) => readFileSync(join(root, rel), "utf8"), log: () => undefined };
  for await (const b of frontend.extract(ctx)) out.push(b);
  return out;
}

const nodes = (bs: IRBatch[]): IRNode[] => bs.flatMap((b) => b.records.flatMap((r) => ("node" in r ? [r.node as IRNode] : [])));
const edges = (bs: IRBatch[]): IREdge[] => bs.flatMap((b) => b.records.flatMap((r) => ("edge" in r ? [r.edge as IREdge] : [])));
const findings = (b: IRBatch | undefined) => (b?.records ?? []).filter((r) => "finding" in r);

describe("generic fixture (no Insight paths, no kinds files)", () => {
  const files = listJson(genericRoot);

  it("is detected by content", async () => {
    expect(await frontend.detect({ path: genericRoot, name: "g", allowBuildTools: false })).not.toBeNull();
  });

  it("yields exactly one batch per file", async () => {
    const bs = await run(genericRoot, files);
    expect(bs.map((b) => b.file).sort()).toEqual(files);
  });

  it("indexes definitions, cross-file refs and validated-by", async () => {
    const bs = await run(genericRoot, files);
    const defNames = nodes(bs).filter((n) => n.kind === "x-schema.def").map((n) => n.attrs.name);
    expect(defNames).toEqual(expect.arrayContaining(["Person", "Name", "Address"]));
    expect(edges(bs).some((e) => e.kind === "packaging.import")).toBe(false);
    const ref = edges(bs).find((e) => e.kind === "x-schema.ref" && e.to === "schemas/address.schema.json#def:Address");
    expect(ref).toBeDefined();
    const vb = edges(bs).filter((e) => e.kind === "x-schema.validated-by");
    expect(vb).toHaveLength(1);
    expect(vb[0]).toMatchObject({ from: "data/alice.json", to: "schemas/person.schema.json#def:$root", attrs: { via: "$schema" } });
    const alice = bs.find((b) => b.file === "data/alice.json");
    expect(alice?.dependsOn).toEqual(["schemas/person.schema.json"]);
    const person = bs.find((b) => b.file === "schemas/person.schema.json");
    expect(person?.dependsOn).toEqual(["schemas/address.schema.json"]);
  });

  it("reports an unknown $schema as an info finding", async () => {
    const bs = await run(genericRoot, files);
    const bob = bs.find((b) => b.file === "data/bob.json");
    const f = findings(bob);
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f[0])).toMatch(/unknown \$schema/);
    expect(JSON.stringify(f[0])).toMatch(/"severity":"info"/);
    expect(bob?.records.some((r) => "edge" in r)).toBe(false);
  });

  it("records the missing schema of an unresolved $schema as a dependency", async () => {
    const bs = await run(genericRoot, files);
    const bob = bs.find((b) => b.file === "data/bob.json");
    expect(bob?.dependsOn).toEqual(["schemas/missing.schema.json"]);
  });

  it("still resolves an instance when ctx.files is a subset of listFiles()", async () => {
    const pr: ProjectRoot = { path: genericRoot, name: "t", allowBuildTools: false };
    const ctx = { root: pr, files: ["data/alice.json"], listFiles: () => [...files], readFile: async (rel: string) => readFileSync(join(genericRoot, rel), "utf8"), log: () => undefined };
    const out: IRBatch[] = [];
    for await (const b of frontend.extract(ctx)) out.push(b);
    expect(out).toHaveLength(1);
    expect(edges(out).find((e) => e.kind === "x-schema.validated-by")).toMatchObject({ from: "data/alice.json", to: "schemas/person.schema.json#def:$root" });
  });

  it("leaves plain JSON alone", async () => {
    const bs = await run(genericRoot, files);
    for (const f of ["package.json", "tsconfig.json", "data/big-list.json"]) expect(bs.find((b) => b.file === f)?.records).toEqual([]);
  });
});

describe("Insight's own repo", () => {
  it("indexes the plugin manifest schema and links insight-plugin.json files by filename", async () => {
    const files = listJson(repoRoot);
    const bs = await run(repoRoot, files);
    expect(bs).toHaveLength(files.length);
    const manifest = "packages/core/indexer/schema/plugin-manifest.schema.json";
    expect(nodes(bs).filter((n) => n.kind === "x-schema.def" && n.id.startsWith(`${manifest}#def:`)).length).toBeGreaterThan(0);
    const vb = edges(bs).filter((e) => e.kind === "x-schema.validated-by" && e.to === `${manifest}#def:$root` && (e.attrs as { via?: string }).via === "filename");
    expect(vb.length).toBeGreaterThanOrEqual(14);
    expect(vb.every((e) => e.from.endsWith("insight-plugin.json"))).toBe(true);
    const kinds = bs.find((b) => b.file === "packages/core/ir/schema/core.kinds.json");
    expect(kinds?.dependsOn).toContain("packages/core/ir/schema/facets/structure.schema.json");
  }, 60_000);
});

/** Runs the frontend over in-memory files (all JSON/TS text keyed by relative path). */
async function runMem(mem: Record<string, string>, files?: string[]): Promise<IRBatch[]> {
  const all = Object.keys(mem).sort();
  const dir = mkdtempSync(join(tmpdir(), "jsonschema-mem-"));
  for (const f of all) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), mem[f] ?? "");
  }
  const pr: ProjectRoot = { path: dir, name: "m", allowBuildTools: false };
  const ctx = { root: pr, files: files ?? all.filter((f) => f.endsWith(".json")), listFiles: () => all, readFile: async (rel: string) => mem[rel] ?? "", log: () => undefined };
  const out: IRBatch[] = [];
  for await (const b of frontend.extract(ctx)) out.push(b);
  return out;
}
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const kindDecl = (kind: string, extra: object = {}) => ({ kind, facet: "structure", on: "node", ...extra });

describe("dependencies of lookups that fail or cross files", () => {
  it("depends on an unresolved relative $ref target, and links it once the file exists", async () => {
    const ref = JSON.stringify({ $schema: SCHEMA, title: "A", $defs: { A: { type: "object", properties: { x: { $ref: "./gone.schema.json#/$defs/X" } } } } });
    const before = await runMem({ "s/a.schema.json": ref });
    expect(before.find((b) => b.file === "s/a.schema.json")?.dependsOn).toContain("s/gone.schema.json");
    expect(edges(before).some((e) => e.kind === "x-schema.ref")).toBe(false);
    const gone = JSON.stringify({ $schema: SCHEMA, title: "G", $defs: { X: { type: "string" } } });
    const after = await runMem({ "s/a.schema.json": ref, "s/gone.schema.json": gone });
    expect(edges(after).find((e) => e.kind === "x-schema.ref")).toMatchObject({ to: "s/gone.schema.json#def:X" });
  });

  it("accepts a relative $schema ending in #", async () => {
    const person = JSON.stringify({ $schema: SCHEMA, title: "Person", type: "object" });
    const inst = JSON.stringify({ $schema: "../schemas/person.schema.json#", name: "x" });
    const bs = await runMem({ "schemas/person.schema.json": person, "data/p.json": inst });
    const b = bs.find((x) => x.file === "data/p.json");
    expect(findings(b)).toHaveLength(0);
    expect(edges(bs).find((e) => e.kind === "x-schema.validated-by")).toMatchObject({ from: "data/p.json", to: "schemas/person.schema.json#def:$root" });
  });

  it("depends on the file that declares an extended kind in another kinds file", async () => {
    const mem = {
      "a/core.kinds.json": JSON.stringify([kindDecl("sync.parent")]),
      "b/kinds.json": JSON.stringify([kindDecl("sync.child", { extends: "sync.parent" })]),
    };
    const bs = await runMem(mem);
    expect(bs.find((b) => b.file === "b/kinds.json")?.dependsOn).toContain("a/core.kinds.json");
  });

  it("depends on every kinds file when an extended kind is not found", async () => {
    const mem = {
      "a/core.kinds.json": JSON.stringify([kindDecl("sync.other")]),
      "b/kinds.json": JSON.stringify([kindDecl("sync.child", { extends: "sync.parent" })]),
    };
    const bs = await runMem(mem);
    expect(bs.find((b) => b.file === "b/kinds.json")?.dependsOn).toContain("a/core.kinds.json");
  });

  it("depends on all schema files when an absolute $ref, $schema or filename lookup finds no $id", async () => {
    const other = JSON.stringify({ $schema: SCHEMA, title: "O", type: "object" });
    const ref = JSON.stringify({ $schema: SCHEMA, title: "R", properties: { x: { $ref: "https://example.com/o.json" } } });
    const inst = JSON.stringify({ $schema: "https://example.com/o.json" });
    const bs = await runMem({ "o.schema.json": other, "r.schema.json": ref, "i.json": inst, "insight-plugin.json": "{\"id\":\"x\",\"$schema\":\"https://x/y\"}" });
    expect(bs.find((b) => b.file === "r.schema.json")?.dependsOn).toContain("o.schema.json");
    expect(bs.find((b) => b.file === "i.json")?.dependsOn).toContain("o.schema.json");
    expect(bs.find((b) => b.file === "insight-plugin.json")?.dependsOn).toContain("o.schema.json");
  });

  it("kinds file with an absolute attrs $ref that finds no $id depends on all other JSON files", async () => {
    const other = JSON.stringify({ $schema: SCHEMA, title: "O", type: "object" });
    const kinds = JSON.stringify([kindDecl("sync.thing", { attrs: { $ref: "https://example.com/attrs.json#/$defs/A" } })]);
    const bs = await runMem({ "o.schema.json": other, "x/kinds.json": kinds });
    expect(bs.find((b) => b.file === "x/kinds.json")?.dependsOn).toContain("o.schema.json");
  });

  it("does not fall back to all JSON files for json-schema.org meta-schema URIs", async () => {
    const ref = JSON.stringify({ $schema: SCHEMA, title: "R", properties: { x: { $ref: "https://json-schema.org/draft/2020-12/schema" } } });
    const inst = JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#" });
    const bs = await runMem({ "o.schema.json": JSON.stringify({ $schema: SCHEMA, title: "O" }), "r.schema.json": ref, "i.json": inst });
    expect(bs.find((b) => b.file === "r.schema.json")?.dependsOn ?? []).not.toContain("o.schema.json");
    expect(bs.find((b) => b.file === "i.json")?.dependsOn ?? []).not.toContain("o.schema.json");
  });

  it("matches validated-by by filename with inferred confidence, by $schema with exact", async () => {
    const manifest = JSON.stringify({ $schema: SCHEMA, $id: "https://insight.dev/core/plugin-manifest.json", title: "M", type: "object" });
    const bs = await runMem({
      "m.schema.json": manifest,
      "a/insight-plugin.json": "{\"id\":\"a\"}",
      "b.json": JSON.stringify({ $schema: "https://insight.dev/core/plugin-manifest.json" }),
    });
    const vb = edges(bs).filter((e) => e.kind === "x-schema.validated-by");
    expect(vb.find((e) => e.from === "a/insight-plugin.json")?.provenance.confidence).toBe("inferred");
    expect(vb.find((e) => e.from === "b.json")?.provenance.confidence).toBe("exact");
  });

  it("gives no unknown-$schema finding to instances under fixtures/ or samples/", async () => {
    const bs = await runMem({
      "s.schema.json": JSON.stringify({ $schema: SCHEMA, title: "S" }),
      "a/fixtures/i.json": JSON.stringify({ $schema: "./nope.schema.json" }),
      "a/real.json": JSON.stringify({ $schema: "./nope.schema.json" }),
    });
    expect(findings(bs.find((b) => b.file === "a/fixtures/i.json"))).toHaveLength(0);
    expect(findings(bs.find((b) => b.file === "a/real.json"))).toHaveLength(1);
  });

  it("counts a kind passed to any call as an emit, but not comparisons, case labels or lookups", async () => {
    const ts = [
      'flow(ctx, "flow.return", x);',
      'if (k === "flow.jump") {}',
      'switch (k) { case "flow.block": break; }',
      'if (set.has("flow.throw")) {}',
    ].join("\n");
    const bs = await runMem(
      {
        "packages/x/kinds.json": JSON.stringify(["return", "jump", "block", "throw"].map((n) => kindDecl(`flow.${n}`))),
        "packages/y/a.ts": ts,
      },
      ["packages/x/kinds.json"],
    );
    const how = (to: string) => edges(bs).find((e) => e.kind === "x-schema.uses-kind" && e.to.endsWith(to))?.attrs as { how?: string } | undefined;
    expect(JSON.stringify(edges(bs).filter((e) => e.kind === "x-schema.uses-kind").map((e) => [e.to, (e.attrs as { how: string }).how]))).toContain('"emit"');
    const hows = Object.fromEntries(edges(bs).filter((e) => e.kind === "x-schema.uses-kind").map((e) => [e.to, (e.attrs as { how: string }).how]));
    void how;
    const byName = (n: string) => Object.entries(hows).find(([k]) => k.includes(n))?.[1];
    expect(byName("return")).toBe("emit");
    expect(byName("jump")).toBe("read");
    expect(byName("block")).toBe("read");
    expect(byName("throw")).toBe("read");
  });

  it("links duplicate-$id files in both directions", async () => {
    const mk = (t: string) => JSON.stringify({ $schema: SCHEMA, $id: "https://example.com/d.json", title: t });
    const bs = await runMem({ "a.schema.json": mk("A"), "b.schema.json": mk("B") });
    const a = bs.find((b) => b.file === "a.schema.json");
    const b = bs.find((x) => x.file === "b.schema.json");
    expect(a?.dependsOn).toContain("b.schema.json");
    expect(b?.dependsOn).toContain("a.schema.json");
    expect(findings(b)).toHaveLength(1);
  });

  it("credits a JavaScript emitter of a kind", async () => {
    const bs = await runMem({
      "packages/x/kinds.json": JSON.stringify([kindDecl("packaging.build-target")]),
      "packages/frontend/cmake/index.js": 'emit({ kind: "packaging.build-target" });',
    }, ["packages/x/kinds.json"]);
    expect(edges(bs).find((e) => e.kind === "x-schema.uses-kind")).toMatchObject({ from: "packages/frontend/cmake/index.js", attrs: { how: "emit" } });
  });
});
