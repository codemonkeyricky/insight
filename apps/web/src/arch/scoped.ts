import type { ArchFile, ArchFileImport, ArchModel, ArchPackage, ArchUnresolved, ArchViolation } from "@insight/lens-dependencies";
import type { Span } from "../api";
import { aggregateFolderEdges, chooseFolderDepth, folderOf, MIN_MODULES, type DiagramModel } from "./folders";

// The scoped Arch view: the diagram of one folder or package of the project, derived from the root model. The middle band
// holds the cards inside the scope (its folders, or its files when the folders are too few). The left holds what imports
// the scope, and the right what it imports. Pure, so it is unit tested.

/** The layer of the cards on the left: packages (or folders) that import into the scope. */
export const IMPORTED_BY = "Imported by";
/** The layer of the cards on the right: packages (or folders) the scope imports. */
export const IMPORTS = "Imports";
/** Above this many inner files, a scope keeps its folder cards rather than one card per file. */
export const MAX_FILE_CARDS = 60;
/** Where a package's entry file may be, in the order it is looked for, under the package directory. */
const ENTRY_FILES = ["src/index.ts", "src/index.tsx", "index.ts", "src/index.js", "index.js", "src/main.ts"];

/** A diagram of one scope. `cards` says whether the middle band holds folders or one card per file. */
export interface ScopedDiagram extends DiagramModel {
  /** The scope: a folder path. */
  scope: string;
  /** The file the explorer named, when the scope was a file. The scope is then that file's folder. */
  fromFile?: string;
  /** The package the scope lies in, when one does. */
  pkg?: ArchPackage;
  cards: "folders" | "files";
  /** The name of the middle layer, e.g. "Inside lens-dependencies". */
  inner: string;
  /** Package edges with no import sites at all (calls only), which the diagram cannot draw. */
  notDrawn: number;
}

const spanKey = (s: Span): string => JSON.stringify(s);
/** True when `path` lies under the folder `dir`, and is not `dir` itself. */
const under = (path: string, dir: string): boolean => path.startsWith(`${dir}/`);

/** The nearest package of a path: the one with the longest path that contains it. Undefined outside all packages. */
function packageOf(path: string, packages: readonly ArchPackage[]): ArchPackage | undefined {
  let best: ArchPackage | undefined;
  let bestScore = -2;
  for (const p of packages) {
    if (!(p.path === "." || path === p.path || under(path, p.path))) continue;
    const score = p.path === "." ? -1 : p.path.length;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** The files a boundary card stands for: its package's count, or the files under its folder key. */
function countUnder(files: readonly ArchFile[], key: string, p: ArchPackage | undefined): number {
  if (p !== undefined) return p.fileCount;
  return files.filter((f) => key === "." || f.path === key || under(f.path, key)).length;
}

/**
 * The diagram of a scope, derived from the root model. Null for the root scope, and for a file at the root (its folder is
 * the project), so the caller draws the whole project then.
 */
export function scopedView(model: ArchModel, scope: string): ScopedDiagram | null {
  if (scope === "") return null;
  const fromFile = model.files.some((f) => f.path === scope) ? scope : undefined;
  const dir = fromFile === undefined ? scope : scope.includes("/") ? scope.slice(0, scope.lastIndexOf("/")) : ".";
  if (dir === ".") return null;

  const pkg = packageOf(dir, model.packages);
  const inner = `Inside ${dir.split("/").pop() ?? dir}`;
  const innerFiles = model.files.filter((f) => under(f.path, dir));
  // Card ids of the inner files, by their path relative to the scope. Files without a card are absent.
  const cardOfRel = new Map<string, string>();
  const cards = new Map<string, ArchPackage>();
  let kind: "folders" | "files" = "folders";
  let depth: number | undefined;
  let other = 0;

  if (innerFiles.length > 0) {
    const rel = innerFiles.map((f) => ({ path: f.path.slice(dir.length + 1), functions: f.functions }));
    depth = chooseFolderDepth(rel);
    const totals = new Map<string, { fileCount: number; functions: number }>();
    for (const f of rel) {
      const fd = folderOf(f.path, depth);
      const c = totals.get(fd) ?? { fileCount: 0, functions: 0 };
      c.fileCount++;
      c.functions += f.functions;
      totals.set(fd, c);
    }
    const anyCode = rel.some((f) => f.functions > 0);
    const kept = [...totals].filter(([, c]) => !anyCode || c.functions > 0);
    other = totals.size - kept.length;

    if (kept.length >= MIN_MODULES || innerFiles.length > MAX_FILE_CARDS) {
      const keptIds = new Set(kept.map(([fd]) => fd));
      for (const [fd, c] of kept) {
        const id = fd === "." ? dir : `${dir}/${fd}`;
        const hasChildren = [...keptIds].some((o) => under(o, fd));
        const name = fd === "." ? "(files)" : hasChildren ? `${fd} (files)` : fd;
        cards.set(id, { id, name, path: id, layer: inner, fileCount: c.fileCount, functions: c.functions });
      }
      for (const f of rel) {
        const fd = folderOf(f.path, depth);
        cardOfRel.set(f.path, fd === "." ? dir : `${dir}/${fd}`);
      }
    } else {
      kind = "files";
      depth = undefined;
      other = 0;
      for (const f of innerFiles) {
        const id = f.path;
        cards.set(id, { id, name: id.split("/").pop() ?? id, path: id, layer: inner, fileCount: 1, functions: f.functions });
        cardOfRel.set(f.path.slice(dir.length + 1), id);
      }
    }
  }

  /** The card of an inner file, or undefined when the file is outside the scope or has no card. */
  const cardOf = (file: string): string | undefined => {
    if (!under(file, dir)) return undefined;
    const id = cardOfRel.get(file.slice(dir.length + 1));
    return id !== undefined && cards.has(id) ? id : undefined;
  };

  // Boundary cards. An outside file's end is its package, or for a file of the scope's own package, the sibling folder at the
  // scope's depth. A file in no package is keyed by its top-level directory.
  const boundary = new Map<string, ArchPackage>();
  const depthOfDir = dir.split("/").length;
  const boundaryCard = (layer: string, prefix: string, key: string, p: ArchPackage | undefined): string => {
    const id = `${prefix}${key}`;
    if (!boundary.has(id)) {
      boundary.set(id, { id, name: p?.name ?? key, path: key, layer, fileCount: countUnder(model.files, key, p) });
    }
    return id;
  };
  const keyOf = (file: string): { key: string; pkg?: ArchPackage } => {
    const p = packageOf(file, model.packages);
    if (pkg !== undefined && p?.id === pkg.id) {
      const dirs = file.split("/").slice(0, -1);
      return { key: dirs.slice(0, depthOfDir).join("/") || "." };
    }
    if (p !== undefined) return { key: p.id, pkg: p };
    const segs = file.split("/");
    return { key: segs.length > 1 ? (segs[0] as string) : "." };
  };

  // The file-level imports at the ends of cards. Imports between two outside files are left out.
  const mapped: ArchFileImport[] = [];
  const seen = new Set<string>();
  for (const i of model.fileImports) for (const s of i.sites) seen.add(spanKey(s));
  for (const i of model.fileImports) {
    const fromIn = under(i.from, dir);
    const toIn = under(i.to, dir);
    if (fromIn && toIn) {
      const from = cardOf(i.from);
      const to = cardOf(i.to);
      if (from !== undefined && to !== undefined) mapped.push({ ...i, from, to });
    } else if (fromIn) {
      const from = cardOf(i.from);
      if (from === undefined) continue;
      const { key, pkg: p } = keyOf(i.to);
      mapped.push({ ...i, from, to: boundaryCard(IMPORTS, "out:", key, p) });
    } else if (toIn) {
      const to = cardOf(i.to);
      if (to === undefined) continue;
      const { key, pkg: p } = keyOf(i.from);
      mapped.push({ ...i, from: boundaryCard(IMPORTED_BY, "in:", key, p), to });
    }
  }

  // Package edges for imports the IR could not resolve to a file (workspace specifiers). A site already counted as a file
  // import is skipped, so nothing counts twice. An edge with no sites at all cannot be drawn and is counted.
  let notDrawn = 0;
  if (pkg !== undefined) {
    const entry = ENTRY_FILES.map((c) => (pkg.path === "." ? c : `${pkg.path}/${c}`)).find((c) => model.files.some((f) => f.path === c));
    for (const e of model.edges) {
      const outgoing = e.from === pkg.id && e.to !== pkg.id;
      const incoming = e.to === pkg.id && e.from !== pkg.id;
      if (!outgoing && !incoming) continue;
      if (e.sites.length === 0) {
        notDrawn++;
        continue;
      }
      // A boundary card is made only when an edge is drawn from it, so no card is left without arrows.
      if (outgoing) {
        for (const site of e.sites) {
          const from = seen.has(spanKey(site)) ? undefined : cardOf(site.file);
          if (from === undefined) continue;
          const to = boundaryCard(IMPORTS, "out:", e.to, model.packages.find((p) => p.id === e.to));
          mapped.push({ from, to, imports: 1, confidence: e.confidence, sites: [site] });
        }
      } else {
        const to = entry === undefined ? undefined : cardOf(entry);
        if (to === undefined) continue;
        for (const site of e.sites) {
          if (seen.has(spanKey(site))) continue;
          const from = boundaryCard(IMPORTED_BY, "in:", e.from, model.packages.find((p) => p.id === e.from));
          mapped.push({ from, to, imports: 1, confidence: e.confidence, sites: [site] });
        }
      }
    }
  }

  const edges = aggregateFolderEdges(mapped, (id) => id);
  const packages = [...cards.values(), ...boundary.values()].sort((a, b) => a.id.localeCompare(b.id));
  const layers = [IMPORTED_BY, inner, IMPORTS].filter((l) => packages.some((p) => p.layer === l));

  const unresolved: ArchUnresolved[] = model.unresolved.filter((u) => u.span !== undefined && under(u.span.file, dir));
  const externals: ArchModel["externals"] = pkg === undefined ? [] : model.externals.filter((x) => x.fromPackage === pkg.id);
  const violations: ArchViolation[] = model.violations.filter((v) => pkg !== undefined && (v.from === pkg.id || v.to === pkg.id));

  return {
    scope: dir,
    ...(fromFile !== undefined ? { fromFile } : {}),
    ...(pkg !== undefined ? { pkg } : {}),
    cards: kind,
    inner,
    notDrawn,
    ...(depth !== undefined ? { depth } : {}),
    other,
    model: {
      layers,
      packages,
      edges,
      unresolved,
      externals,
      violations,
      files: model.files,
      fileImports: model.fileImports,
    },
  };
}
