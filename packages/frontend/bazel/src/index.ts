import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { IRRecord, NodeId } from "@insight/ir";
import type { ExtractContext, Frontend, IRBatch, ProjectRoot } from "@insight/sdk";
import { buildModel, isBuildFile, outputOf, type BazelModel, type BazelTarget } from "./model.js";
import { EXTERNAL_FILES, externalIdOf, mainRepoNames, parseExternals, repoOf, type Externals } from "./externals.js";

export { resolver } from "./resolve.js";

export const FRONTEND_ID = "frontend-bazel";
/** The build system named on every package and external package this frontend emits. */
const BUILD_SYSTEM = "bazel";
const PROV = { frontend: FRONTEND_ID, confidence: "exact" as const };
const SKIP_DIRS = new Set(["node_modules", ".git", ".insight", "bazel-out", "bazel-bin", "bazel-testlogs"]);

/** The files that declare the project's Bazel module or workspace, at the root. */
const ROOT_MANIFESTS = ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"];

/** Looks for a BUILD file within a few levels of the root. */
function findBuild(dir: string, depth: number): string | undefined {
  if (depth < 0 || !existsSync(dir)) return undefined;
  const entries = readdirSync(dir, { withFileTypes: true });
  const file = entries.find((e) => e.isFile() && isBuildFile(e.name));
  if (file) return file.name;
  if (depth === 3) {
    const root = entries.find((e) => e.isFile() && ROOT_MANIFESTS.includes(e.name));
    if (root) return root.name;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const hit = findBuild(join(dir, entry.name), depth - 1);
    if (hit) return `${entry.name}/${hit}`;
  }
  return undefined;
}

/** The structure.package id of a package directory: "//" for the root, else "//<dir>". */
function packageId(dir: string): string {
  return dir === "" ? "//" : `//${dir}`;
}

/** The external-repository records, emitted once in the anchor batch. */
function externalRecords(externals: Externals): IRRecord[] {
  return [...externals.entries].map(([id, decl]) => ({
    node: {
      id,
      facet: "packaging",
      kind: "packaging.external",
      attrs: { ...decl.attrs, manager: BUILD_SYSTEM },
      ...(decl.span !== undefined ? { span: decl.span } : {}),
      provenance: { frontend: FRONTEND_ID, confidence: decl.confidence },
    },
  }));
}

/** The records for one BUILD file: its package, its targets, what they contain, and their dependencies. */
function batchFor(file: string, model: BazelModel, files: Set<string>, externals: Externals): IRBatch {
  const records: IRRecord[] = [];
  const dir = posix.dirname(file) === "." ? "" : posix.dirname(file);
  records.push({
    node: {
      id: packageId(dir),
      facet: "structure",
      kind: "structure.package",
      attrs: { name: packageId(dir), root: dir === "" ? "." : dir, buildSystem: BUILD_SYSTEM },
      provenance: PROV,
    },
  });
  const own: BazelTarget[] = [...model.targets.values()].filter((t) => t.buildFile === file);
  for (const t of own) {
    records.push({
      node: {
        id: t.id,
        facet: "packaging",
        kind: "packaging.build-target",
        parent: packageId(t.pkg),
        attrs: {
          name: t.name,
          label: t.id,
          targetKind: t.kind,
          output: outputOf(t),
          source: "static",
          ...(t.visibility !== undefined ? { visibility: t.visibility } : {}),
        },
        span: t.span,
        provenance: { frontend: FRONTEND_ID, confidence: t.confidence },
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
    const cc = t.cc;
    for (const dep of t.deps) {
      if (!cc && !model.targets.has(dep)) continue;
      const to: NodeId | { unresolved: { scheme: string; text: string } } = model.targets.has(dep)
        ? dep
        : { unresolved: { scheme: "bazel.label", text: dep } };
      records.push({ edge: { from: t.id, to, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } });
    }
    for (const ext of cc ? t.externalDeps : []) {
      const repo = repoOf(ext);
      const declared = repo === undefined ? undefined : externalIdOf(repo, externals);
      records.push({
        edge: {
          from: t.id,
          to: declared ?? { unresolved: { scheme: "bazel.label", text: ext } },
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
  version: "0.3.2",
  provides: ["packaging", "structure"],

  async detect(root: ProjectRoot) {
    const hit = findBuild(root.path, 3);
    return hit ? { reason: `found ${hit}` } : null;
  },

  async *extract(ctx: ExtractContext) {
    const all = ctx.listFiles();
    // The external declarations are read whole, even when only some files are requested this run.
    const externalTexts = new Map<string, string>();
    for (const f of EXTERNAL_FILES) if (all.includes(f)) externalTexts.set(f, await ctx.readFile(f));
    const texts = new Map<string, string>();
    for (const f of all) if (isBuildFile(f)) texts.set(f, await ctx.readFile(f));
    const model = buildModel(texts, all, mainRepoNames(externalTexts));
    const externals = parseExternals(externalTexts);
    // Every external is emitted once, in the module file's batch, or in the workspace file's when there is no module file.
    const anchor = ["MODULE.bazel", "WORKSPACE", "WORKSPACE.bazel"].find((f) => all.includes(f));
    const fileSet = new Set(all);
    for (const file of ctx.files) {
      if (isBuildFile(file)) yield batchFor(file, model, fileSet, externals);
      else if (file === anchor) yield { file, records: externalRecords(externals) };
      else yield { file, records: [] };
    }
  },
};

export default frontend;
