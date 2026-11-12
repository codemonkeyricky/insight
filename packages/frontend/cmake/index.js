// Frontend: one packaging.build-target per cmake target, its sources, and its links.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCmakeModel, isCMakeFile } from "./parse.js";

const FRONTEND_ID = "frontend-cmake";
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
  for (const t of model.targets.values()) {
    if (t.buildFile !== file) continue;
    records.push({
      node: {
        id: t.id,
        facet: "packaging",
        kind: "packaging.build-target",
        attrs: { name: t.name, label: t.id, targetKind: t.kind, source: "static" },
        span: { file, start: t.span.start, end: t.span.end },
        provenance: PROV,
      },
    });
    for (const f of new Set(t.sources)) {
      if (!fileSet.has(f)) continue;
      records.push({ edge: { from: t.id, to: f, facet: "packaging", kind: "packaging.target-contains", provenance: PROV } });
    }
    for (const link of t.links) {
      const dep = model.targets.get(link.name);
      const to = dep ? dep.id : { unresolved: { scheme: "cmake.target", text: link.name } };
      records.push({ edge: { from: t.id, to, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } });
    }
  }
  return { file, records };
}

/** @type {import("@insight/sdk").Frontend} */
const frontend = {
  id: FRONTEND_ID,
  version: "0.1.0",
  provides: ["packaging"],

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
