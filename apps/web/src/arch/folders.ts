import type { ArchEdge, ArchFile, ArchFileImport, ArchModel, ArchPackage } from "@insight/lens-dependencies";
import type { Span } from "../api";

// The folder view of the Arch tab. A project with fewer than three packages draws its folders instead: one card per
// folder that holds code, at the shallowest depth that gives at least three such folders. Folders without code are not
// cards; the tab counts them in a line under the diagram. Pure, so it is unit tested.

/** The fewest cards a diagram should have before the tab descends from packages to folders. */
export const MIN_MODULES = 3;
/** The layer (and grid) every folder card sits in. */
export const FOLDER_LAYER = "folders";
/** Folder cards per row in the folder view. */
export const FOLDER_GRID = 4;

/** The folder of a file at a depth: its first `depth` directories, or "." for a file at the root. */
export function folderOf(file: string, depth: number): string {
  const dirs = file.split("/").slice(0, -1);
  if (dirs.length === 0 || depth < 1) return ".";
  return dirs.slice(0, depth).join("/");
}

export interface FolderTotals {
  fileCount: number;
  functions: number;
}

/** The folders of the files at a depth, with their file and function counts. */
function foldersAt(files: readonly ArchFile[], depth: number): Map<string, FolderTotals> {
  const totals = new Map<string, FolderTotals>();
  for (const f of files) {
    const id = folderOf(f.path, depth);
    const c = totals.get(id) ?? { fileCount: 0, functions: 0 };
    c.fileCount++;
    c.functions += f.functions;
    totals.set(id, c);
  }
  return totals;
}

/**
 * The shallowest depth with at least `min` folders that hold code. A project with no code at all counts every folder
 * instead. When no depth gets there, the deepest one.
 */
export function chooseFolderDepth(files: readonly ArchFile[], min = MIN_MODULES): number {
  const deepest = Math.max(1, ...files.map((f) => f.path.split("/").length - 1));
  const anyCode = files.some((f) => f.functions > 0);
  for (let depth = 1; depth <= deepest; depth++) {
    const count = [...foldersAt(files, depth).values()].filter((c) => !anyCode || c.functions > 0).length;
    if (count >= min) return depth;
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
  /** Folders without code, left out of the cards and counted under the diagram. */
  other: number;
  model: ArchModel;
}

/** The name of a folder card. A folder whose own files are a card beside its subfolders is "(files)". */
function cardName(id: string, ids: ReadonlySet<string>): string {
  if (id === ".") return "(root)";
  const hasChildren = [...ids].some((o) => o.startsWith(`${id}/`));
  return hasChildren ? `${id} (files)` : id;
}

/** The folder view of a model: its cards (folders with code), their edges, and the count of the rest. */
export function folderView(model: ArchModel): DiagramModel & { depth: number } {
  const depth = chooseFolderDepth(model.files);
  const folder = (file: string) => folderOf(file, depth);
  const all = [...foldersAt(model.files, depth)].sort(([a], [b]) => a.localeCompare(b));
  const anyCode = model.files.some((f) => f.functions > 0);
  const cards = all.filter(([, c]) => !anyCode || c.functions > 0);
  const ids = new Set(cards.map(([id]) => id));

  const packages: ArchPackage[] = cards.map(([id, c]) => ({
    id,
    name: cardName(id, ids),
    path: id,
    layer: FOLDER_LAYER,
    fileCount: c.fileCount,
    functions: c.functions,
  }));
  const edges = aggregateFolderEdges(model.fileImports, folder).filter((e) => ids.has(e.from) && ids.has(e.to));
  const unresolved = model.unresolved.map((u) => (u.span ? { ...u, fromPackage: folder(u.span.file) } : u));
  return {
    depth,
    other: all.length - cards.length,
    model: {
      layers: packages.length > 0 ? [FOLDER_LAYER] : [],
      packages,
      edges,
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
  if (model.packages.length >= MIN_MODULES || model.files.length === 0) return { other: 0, model };
  const folders = folderView(model);
  return folders.model.packages.length > model.packages.length ? folders : { other: 0, model };
}
