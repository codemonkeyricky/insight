import type { IRView } from "@insight/sdk";
import type { IREdge, NodeId, Span } from "@insight/ir";
import { buildModuleGraph } from "./index.js";

/** Layer order used when the caller does not supply its own `layerOf`. */
export const DEFAULT_LAYERS = ["project", "frontend", "ir", "lens", "app"] as const;

const FRONTEND_LENS_RULE = "frontends and lenses never import each other";

/** Maps a package directory (for example "packages/lens-calls") to a layer name, or undefined for "other". */
export function defaultLayerOf(pkgPath: string): string | undefined {
  if (/^(packages|plugins)\/frontend-/.test(pkgPath)) return "frontend";
  if (/^packages\/lens-/.test(pkgPath)) return "lens";
  if (pkgPath === "packages/ir" || pkgPath === "packages/sdk" || pkgPath === "packages/core") return "ir";
  if (pkgPath.startsWith("apps/")) return "app";
  return undefined;
}

export interface ArchOptions {
  layerOf?: (pkgPath: string) => string | undefined;
}

export interface ArchPackage {
  /** The package directory, relative to the project root. Unique. */
  id: string;
  name: string;
  path: string;
  layer: string;
  /** Source files (structure.file nodes) whose nearest package is this one. */
  fileCount: number;
}

export interface ArchEdge {
  from: string;
  to: string;
  imports: number;
  calls: number;
  confidence: IREdge["provenance"]["confidence"];
  /** Import spans from every module pair of the two packages, merged and sorted. */
  sites: Span[];
}

export interface ArchUnresolved {
  fromPackage: string;
  text: string;
  span?: Span;
}

export interface ArchViolation {
  from: string;
  to: string;
  rule: string;
  sites: Span[];
}

export interface ArchModel {
  layers: string[];
  packages: ArchPackage[];
  edges: ArchEdge[];
  unresolved: ArchUnresolved[];
  violations: ArchViolation[];
}

interface PkgRoot {
  path: string;
  name: string;
}

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : ".";
};

const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Package roots come from structure.package nodes when a frontend emits them, and otherwise
 * from package.json files among the structure.file nodes. The TypeScript frontend emits no
 * package nodes, so the second source is the one that usually applies.
 */
function packageRoots(view: IRView): PkgRoot[] {
  const roots = new Map<string, PkgRoot>();
  for (const node of view.nodes({ kind: "structure.package" })) {
    const attrs = node.attrs as { name?: unknown; root?: unknown };
    const path = typeof attrs.root === "string" ? attrs.root : node.id;
    if (roots.has(path)) continue;
    roots.set(path, { path, name: typeof attrs.name === "string" ? attrs.name : path === "." ? "." : lastSegment(path) });
  }
  for (const node of view.nodes({ kind: "structure.file" })) {
    if (lastSegment(node.id) !== "package.json") continue;
    const dir = dirOf(node.id);
    if (roots.has(dir)) continue;
    roots.set(dir, { path: dir, name: dir === "." ? "." : lastSegment(dir) });
  }
  return [...roots.values()];
}

/** The nearest package root above a file. The root "." matches everything but ranks lowest. */
function rootOf(roots: PkgRoot[], file: NodeId): PkgRoot | undefined {
  let best: PkgRoot | undefined;
  let bestRank = -2;
  for (const root of roots) {
    if (root.path !== "." && !file.startsWith(`${root.path}/`)) continue;
    const rank = root.path === "." ? -1 : root.path.length;
    if (rank > bestRank) {
      best = root;
      bestRank = rank;
    }
  }
  return best;
}

const weakest = (a: ArchEdge["confidence"], b: ArchEdge["confidence"]): ArchEdge["confidence"] => {
  const rank = { exact: 0, inferred: 1, heuristic: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

/** Sorts spans by file and position, and drops exact duplicates. */
function mergeSpans(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const unique: Span[] = [];
  for (const span of spans) {
    const key = JSON.stringify(span);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return unique.sort((a, b) => a.file.localeCompare(b.file) || a.start[0] - b.start[0] || a.start[1] - b.start[1]);
}

/**
 * Package-level architecture model: packages with layers, package-to-package edges that keep
 * their import spans, unresolved imports, and rule violations. Plain JSON, no UI.
 */
export function archModel(view: IRView, options: ArchOptions = {}): ArchModel {
  const layerOf = options.layerOf ?? defaultLayerOf;
  const layerName = (pkgPath: string): string => layerOf(pkgPath) ?? "other";
  const roots = packageRoots(view);
  const pathOf = (file: NodeId): string | undefined => rootOf(roots, file)?.path;

  const packages = new Map<string, ArchPackage>();
  for (const root of roots) {
    packages.set(root.path, { id: root.path, name: root.name, path: root.path, layer: layerName(root.path), fileCount: 0 });
  }
  for (const node of view.nodes({ kind: "structure.file" })) {
    const path = pathOf(node.id);
    if (path !== undefined) packages.get(path)!.fileCount++;
  }

  const { pairs, from, unresolvedImports } = buildModuleGraph(view);
  const rolled = new Map<string, { from: string; to: string; imports: number; calls: number; confidence: ArchEdge["confidence"]; sites: Span[] }>();
  for (const [key, info] of pairs) {
    const [a, b] = from.get(key) as [NodeId, NodeId];
    const pa = pathOf(a);
    const pb = pathOf(b);
    if (pa === undefined || pb === undefined || pa === pb) continue;
    const edgeKey = `${pa}\0${pb}`;
    const cur = rolled.get(edgeKey) ?? { from: pa, to: pb, imports: 0, calls: 0, confidence: info.confidence, sites: [] };
    cur.imports += info.imports;
    cur.calls += info.calls;
    cur.confidence = weakest(cur.confidence, info.confidence);
    cur.sites.push(...info.spans);
    rolled.set(edgeKey, cur);
  }
  const edges: ArchEdge[] = [...rolled.values()]
    .map((e) => ({ ...e, sites: mergeSpans(e.sites) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // Unresolved imports whose importing file belongs to no package are left out: they have no package to report under.
  const unresolved: ArchUnresolved[] = [];
  for (const u of unresolvedImports) {
    const fromPackage = pathOf(u.from);
    if (fromPackage === undefined) continue;
    unresolved.push({ fromPackage, text: u.text, ...(u.span ? { span: u.span } : {}) });
  }

  const violations: ArchViolation[] = [];
  for (const edge of edges) {
    if (edge.imports === 0) continue;
    const layers = new Set([packages.get(edge.from)?.layer, packages.get(edge.to)?.layer]);
    if (!(layers.has("frontend") && layers.has("lens"))) continue;
    violations.push({ from: edge.from, to: edge.to, rule: FRONTEND_LENS_RULE, sites: edge.sites });
  }

  const packageList = [...packages.values()].sort((a, b) => a.path.localeCompare(b.path));
  const layers: string[] = [...DEFAULT_LAYERS];
  for (const pkg of packageList) {
    if (pkg.layer !== "other" && !layers.includes(pkg.layer)) layers.push(pkg.layer);
  }
  if (packageList.some((pkg) => pkg.layer === "other")) layers.push("other");

  return { layers, packages: packageList, edges, unresolved, violations };
}
