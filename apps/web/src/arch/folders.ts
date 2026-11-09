import type { ArchEdge, ArchFileImport, ArchModel, ArchPackage } from "@insight/lens-dependencies";
import type { Span } from "../api";

// The folder view of the Arch tab. A project with one package (a single package.json) would draw one card, so the tab
// draws folders instead: one card per folder at the shallowest depth that gives enough cards. Pure, so it is unit tested.

/** The layer (column) every folder card sits in. */
export const FOLDER_LAYER = "folders";

/** The fewest cards a diagram should have before the tab descends from packages to folders. */
export const MIN_MODULES = 3;

/** The folder of a file at a depth: its first `depth` directories, or "." for a file at the root. */
export function folderOf(file: string, depth: number): string {
  const dirs = file.split("/").slice(0, -1);
  if (dirs.length === 0 || depth < 1) return ".";
  return dirs.slice(0, depth).join("/");
}

/**
 * The shallowest depth whose folders number at least `min`. When no depth gets there, the deepest one, which gives the
 * most folders the files allow.
 */
export function chooseFolderDepth(files: readonly string[], min = MIN_MODULES): number {
  const deepest = Math.max(1, ...files.map((f) => f.split("/").length - 1));
  for (let depth = 1; depth <= deepest; depth++) {
    if (new Set(files.map((f) => folderOf(f, depth))).size >= min) return depth;
  }
  return deepest;
}

const weakest = (a: ArchEdge["confidence"], b: ArchEdge["confidence"]): ArchEdge["confidence"] => {
  const rank = { exact: 0, inferred: 1, heuristic: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

const spanKey = (s: Span): string => JSON.stringify(s);

/**
 * One edge per folder pair, from the file-level imports: the imports between the two folders add up, and imports inside
 * one folder are left out. Sites are kept once each, sorted by file and position.
 */
export function aggregateFolderEdges(imports: readonly ArchFileImport[], folder: (file: string) => string): ArchEdge[] {
  const byKey = new Map<string, ArchEdge & { seen: Set<string> }>();
  for (const i of imports) {
    const from = folder(i.from);
    const to = folder(i.to);
    if (from === to) continue;
    const key = `${from}\0${to}`;
    const cur = byKey.get(key) ?? { from, to, imports: 0, calls: 0, confidence: i.confidence, sites: [], seen: new Set<string>() };
    cur.imports += i.imports;
    cur.confidence = weakest(cur.confidence, i.confidence);
    for (const s of i.sites) {
      const k = spanKey(s);
      if (!cur.seen.has(k)) {
        cur.seen.add(k);
        cur.sites.push(s);
      }
    }
    byKey.set(key, cur);
  }
  return [...byKey.values()]
    .map(({ seen: _seen, ...e }) => ({
      ...e,
      sites: [...e.sites].sort((a, b) => a.file.localeCompare(b.file) || a.start[0] - b.start[0] || a.start[1] - b.start[1]),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** A model the diagram draws. `depth` is set when its cards are folders cut at that depth (1 is the top-level directories). */
export interface DiagramModel {
  depth?: number;
  model: ArchModel;
}

/** The folder view of a model: its cards, edges and unresolved imports, shaped as an ArchModel the layout draws. */
export function folderView(model: ArchModel): DiagramModel & { depth: number } {
  const depth = chooseFolderDepth(model.files.map((f) => f.path));
  const folder = (file: string) => folderOf(file, depth);

  const counts = new Map<string, { fileCount: number; functions: number }>();
  for (const f of model.files) {
    const id = folder(f.path);
    const c = counts.get(id) ?? { fileCount: 0, functions: 0 };
    c.fileCount++;
    c.functions += f.functions;
    counts.set(id, c);
  }
  const packages: ArchPackage[] = [...counts.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const c = counts.get(id) as { fileCount: number; functions: number };
      return { id, name: id === "." ? "(root)" : id, path: id, layer: FOLDER_LAYER, fileCount: c.fileCount, functions: c.functions };
    });
  // One column holds every folder card, stacked by path. Edges between neighbours loop out on the right, so the diagram
  // stays as wide as one card, and the folder count sets its height.
  const layers = packages.length > 0 ? [FOLDER_LAYER] : [];

  const unresolved = model.unresolved.map((u) => (u.span ? { ...u, fromPackage: folder(u.span.file) } : u));
  return {
    depth,
    model: {
      layers,
      packages,
      edges: aggregateFolderEdges(model.fileImports, folder),
      unresolved,
      externals: [],
      violations: [],
      files: model.files,
      fileImports: model.fileImports,
    },
  };
}

/**
 * The model the Arch tab draws: the package model when it has enough packages, otherwise the folder view when that shows
 * more cards than the packages do.
 */
export function diagramModel(model: ArchModel): DiagramModel {
  if (model.packages.length >= MIN_MODULES || model.files.length === 0) return { model };
  const folders = folderView(model);
  return folders.model.packages.length > model.packages.length ? folders : { model };
}
