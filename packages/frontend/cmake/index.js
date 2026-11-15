// Frontend: packages (one per directory with targets), one packaging.build-target per cmake target with its
// output kind, its sources, its links, and the third-party packages (find_package, FetchContent) it declares.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildCmakeModel, isCMakeFile, outputOfTarget, resolveLink } from "./parse.js";

const FRONTEND_ID = "frontend-cmake";
const BUILD_SYSTEM = "cmake";
const PROV = { frontend: FRONTEND_ID, confidence: "exact" };
const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "build"]);

function findCMake(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && e.name === "CMakeLists.txt");
  if (file) return file.name;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findCMake(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

function batchFor(file, model, fileSet) {
  const records = [];
  const pkg = model.packages.get(file);
  if (pkg !== undefined) {
    records.push({
      node: {
        id: pkg.id,
        facet: "structure",
        kind: "structure.package",
        attrs: { name: pkg.name, root: pkg.root, buildSystem: BUILD_SYSTEM },
        provenance: PROV,
      },
    });
  }
  for (const t of model.targets.values()) {
    if (t.buildFile !== file) continue;
    records.push({
      node: {
        id: t.id,
        facet: "packaging",
        kind: "packaging.build-target",
        parent: pkg.id,
        attrs: { name: t.name, label: t.id, targetKind: t.kind, output: outputOfTarget(t), source: "static" },
        span: { file, start: t.span.start, end: t.span.end },
        provenance: PROV,
      },
    });
    for (const f of new Set(t.sources)) {
      if (!fileSet.has(f)) continue;
      records.push({ edge: { from: t.id, to: f, facet: "packaging", kind: "packaging.target-contains", provenance: PROV } });
    }
    // Headers under the target's include directories: inferred, since the target does not list them.
    const INFERRED = { frontend: FRONTEND_ID, confidence: "inferred" };
    for (const f of new Set(t.headers ?? [])) {
      if (!fileSet.has(f)) continue;
      records.push({ edge: { from: t.id, to: f, facet: "packaging", kind: "packaging.target-contains", provenance: INFERRED } });
    }
    const seen = new Set();
    for (const link of t.links) {
      const r = resolveLink(model, link.name);
      const to = r !== undefined ? r.id : { unresolved: { scheme: "cmake.target", text: link.name } };
      const key = typeof to === "string" ? to : `?${link.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push({ edge: { from: t.id, to, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } });
    }
  }
  for (const ext of model.externals.values()) {
    if (ext.file !== file) continue;
    const attrs = { name: ext.name, manager: BUILD_SYSTEM, source: ext.source };
    if (ext.version !== undefined) attrs.version = ext.version;
    if (ext.url !== undefined) attrs.url = ext.url;
    if (ext.sha256 !== undefined) attrs.sha256 = ext.sha256;
    records.push({
      node: {
        id: ext.id,
        facet: "packaging",
        kind: "packaging.external",
        attrs,
        span: { file, start: ext.span.start, end: ext.span.end },
        provenance: PROV,
      },
    });
  }
  return { file, records };
}

/** @type {import("@insight/sdk").Frontend} */
const frontend = {
  id: FRONTEND_ID,
  version: "0.2.0",
  provides: ["packaging", "structure"],

  async detect(root) {
    const hit = findCMake(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx) {
    const all = ctx.listFiles();
    const texts = new Map();
    for (const f of all) if (isCMakeFile(f)) texts.set(f, await ctx.readFile(f));
    const model = buildCmakeModel(texts, all);
    const fileSet = new Set(all);
    for (const file of ctx.files) {
      yield isCMakeFile(file) ? batchFor(file, model, fileSet) : { file, records: [] };
    }
  },
};

export default frontend;
