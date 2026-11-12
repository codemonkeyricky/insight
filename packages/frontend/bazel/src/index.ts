import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IRRecord, NodeId } from "@insight/ir";
import type { ExtractContext, Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { buildModel, isBuildFile, isCcRule, type BazelModel, type BazelTarget } from "./model.js";

export { resolver } from "./resolve.js";

export const FRONTEND_ID = "frontend-bazel";
const PROV = { frontend: FRONTEND_ID, confidence: "exact" as const };
const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "bazel-out", "bazel-bin", "bazel-testlogs"]);

/** Looks for a BUILD file within a few levels of the root. */
function findBuild(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && isBuildFile(e.name));
  if (file) return file.name;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findBuild(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

/** The records for one BUILD file: its targets, what they contain, and their dependencies. */
function batchFor(file: string, model: BazelModel, files: Set<string>): IRBatch {
  const records: IRRecord[] = [];
  const own: BazelTarget[] = [...model.targets.values()].filter((t) => t.buildFile === file);
  for (const t of own) {
    records.push({
      node: {
        id: t.id,
        facet: "packaging",
        kind: "packaging.build-target",
        attrs: { name: t.name, label: t.id, targetKind: t.kind, source: "static" },
        span: t.span,
        provenance: PROV,
      },
    });
    for (const f of new Set([...t.srcs, ...t.hdrs])) {
      if (!files.has(f)) continue;
      records.push({
        edge: { from: t.id, to: f, facet: "packaging", kind: "packaging.target-contains", provenance: PROV },
      });
    }
    // A cc_* rule's dependencies are all recorded, resolved or not. A binary of another language records
    // only the dependencies that name a target this model knows.
    const cc = isCcRule(t.kind);
    for (const dep of t.deps) {
      if (!cc && !model.targets.has(dep)) continue;
      const to: NodeId | { unresolved: { scheme: string; text: string } } = model.targets.has(dep)
        ? dep
        : { unresolved: { scheme: "bazel.label", text: dep } };
      records.push({ edge: { from: t.id, to, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } });
    }
    for (const ext of cc ? t.externalDeps : []) {
      records.push({
        edge: {
          from: t.id,
          to: { unresolved: { scheme: "bazel.label", text: ext } },
          facet: "packaging",
          kind: "packaging.dep-edge",
          provenance: PROV,
        },
      });
    }
  }
  return { file, records };
}

export const frontend: Frontend = {
  id: FRONTEND_ID,
  version: "0.1.0",
  provides: ["packaging"],

  async detect(root: ProjectRoot) {
    const hit = findBuild(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    const all = ctx.listFiles();
    const texts = new Map<string, string>();
    for (const f of all) if (isBuildFile(f)) texts.set(f, await ctx.readFile(f));
    const model = buildModel(texts, all);
    const fileSet = new Set(all);
    for (const file of ctx.files) {
      yield isBuildFile(file) ? batchFor(file, model, fileSet) : { file, records: [] };
    }
  },
};

export default frontend;
