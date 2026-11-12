/**
 * The workspace packages of an indexed project: every package.json the scanner kept, by package name. A bare import
 * of a workspace package (`@insight/core`, `@insight/core/sub`) resolves to that package's source files here, so the
 * index needs no node_modules. Reused by the program-entry work (bin and scripts), which reads the same fields.
 */

/** A package.json's fields the frontend reads, with the directory it lives in. */
export interface WorkspacePackage {
  name: string;
  /** Project-relative directory of the package.json, "" for the root. */
  dir: string;
  /** Project-relative path of the package.json. */
  manifest: string;
  main?: string;
  module?: string;
  types?: string;
  /** The "exports" field as written. Undefined when the package has none. */
  exports?: unknown;
  /** The "bin" field as written: a path or a map of command names to paths. */
  bin?: unknown;
}

/** Directory names whose package.json files are not workspace packages: fixtures, samples, dependencies, worktrees. */
const SKIPPED_SEGMENTS = new Set(["node_modules", "fixtures", "samples", ".claude"]);

/** True for a package.json the workspace map may read: not under a fixture, sample, dependency or worktree folder. */
export function isWorkspaceManifest(rel: string): boolean {
  if (rel !== "package.json" && !rel.endsWith("/package.json")) return false;
  return !rel.split("/").some((seg) => SKIPPED_SEGMENTS.has(seg));
}

/**
 * Builds the package map from package.json texts keyed by project-relative path. A package named twice keeps the one
 * nearest the root, then the first by path, so the answer does not depend on the order the scanner listed files.
 * Files that are not JSON objects with a string name are left out.
 */
export function workspacePackages(manifests: Map<string, string>): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  const rels = [...manifests.keys()].filter(isWorkspaceManifest).sort((a, b) => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const manifest of rels) {
    const pkg = parseManifest(manifest, manifests.get(manifest) ?? "");
    if (pkg !== undefined && !out.has(pkg.name)) out.set(pkg.name, pkg);
  }
  return out;
}

function depthOf(rel: string): number {
  return rel.split("/").length;
}

function parseManifest(manifest: string, text: string): WorkspacePackage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null) return undefined;
  const fields = json as Record<string, unknown>;
  if (typeof fields.name !== "string" || fields.name === "") return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const dir = manifest === "package.json" ? "" : manifest.slice(0, -"/package.json".length);
  const pkg: WorkspacePackage = { name: fields.name, dir, manifest };
  const main = str(fields.main);
  const module = str(fields.module);
  const types = str(fields.types) ?? str(fields.typings);
  if (main !== undefined) pkg.main = main;
  if (module !== undefined) pkg.module = module;
  if (types !== undefined) pkg.types = types;
  if (fields.exports !== undefined) pkg.exports = fields.exports;
  if (fields.bin !== undefined) pkg.bin = fields.bin;
  return pkg;
}

/** Conditions an exports target may be chosen by, in the author's order. Others, such as "browser", are never chosen. */
const CONDITIONS = new Set(["types", "import", "require", "node", "module", "default"]);

/** The file an exports target names, from a string, an array of fallbacks or a conditional object. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = exportTarget(v);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const [condition, v] of Object.entries(value)) {
      if (!CONDITIONS.has(condition)) continue;
      const hit = exportTarget(v);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * The target an exports map gives a subpath (`.` or `./sub`), with `*` patterns replaced. Undefined when the map has no
 * entry for it. An exports value that is not a subpath map (a string, array or conditions) only serves `.`.
 */
function exportsEntry(exports: unknown, subpath: string): string | undefined {
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
    return subpath === "." ? exportTarget(exports) : undefined;
  }
  const map = exports as Record<string, unknown>;
  const keys = Object.keys(map);
  if (keys.length === 0 || !keys.some((k) => k.startsWith("."))) return subpath === "." ? exportTarget(exports) : undefined;
  if (Object.prototype.hasOwnProperty.call(map, subpath)) return exportTarget(map[subpath]);
  for (const key of keys) {
    const star = key.indexOf("*");
    if (star < 0 || !key.startsWith(".")) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    const target = exportTarget(map[key]);
    if (target !== undefined) return target.split("*").join(matched);
  }
  return undefined;
}

/** The directory names a build writes its compiled output into. */
const BUILD_DIRS = new Set(["dist", "build", "out", "lib"]);
/** The suffixes a source file may have, in the order they are tried. */
const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const joinRel = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/** A project-relative path with any leading `./` removed and no `.`, `..` or empty segments left in it. */
function normalizeRel(path: string): string | undefined {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** The path without a declaration, module or script suffix: `dist/a.d.ts` is `dist/a`, `dist/a.mjs` is `dist/a`. */
function stripSuffix(path: string): string {
  return path.replace(/\.d\.[mc]?ts$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * The source files a package target may have been built from, most specific first. A target inside a build-output
 * directory (`dist/a.js`) maps to the same path under `src` (`src/a.ts`). A target that is itself indexed maps to
 * itself. `pkgDir` is the package's project-relative directory and `target` the package.json value, relative to it.
 */
function sourceCandidates(pkgDir: string, target: string): string[] {
  const inner = normalizeRel(target);
  if (inner === undefined || inner === "") return [];
  const segs = inner.split("/");
  const out: string[] = [];
  const bases: string[] = [];
  if (segs.length > 1 && BUILD_DIRS.has(segs[0] ?? "")) {
    bases.push(stripSuffix(`src/${segs.slice(1).join("/")}`));
  }
  bases.push(stripSuffix(inner));
  for (const base of bases) {
    for (const ext of SOURCE_EXTS) out.push(joinRel(pkgDir, base + ext));
    for (const ext of SOURCE_EXTS) out.push(joinRel(pkgDir, `${base}/index${ext}`));
  }
  if (segs.length > 1 && BUILD_DIRS.has(segs[0] ?? "")) out.push(joinRel(pkgDir, inner));
  return out;
}

/** The first candidate that is an indexed source file, not a declaration file. */
function firstSource(candidates: string[], rels: Set<string>): string | undefined {
  return candidates.find((c) => rels.has(c) && !/\.d\.[mc]?ts$/.test(c));
}

/**
 * The indexed source file a bare specifier names through a workspace package, or undefined when no workspace package
 * matches or the match has no source file. The rule, in order:
 *  1. The package's target for the subpath: exports (`.` or `./sub`, with conditions), else types, module or main for
 *     the root, else the subpath itself.
 *  2. That target mapped to source: a `dist|build|out|lib` path becomes `src/...` with a source suffix; an indexed
 *     path maps to itself.
 *  3. For the root only, when 1 and 2 find nothing: `src/index.*` then `index.*` in the package.
 * A subpath with no source file is not guessed at: the caller falls back to the compiler's own resolution.
 */
export function workspaceSource(packages: Map<string, WorkspacePackage>, spec: string, rels: Set<string>): string | undefined {
  const parts = spec.split("/");
  const nameLength = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const pkg = packages.get(name);
  if (pkg === undefined || parts.length < nameLength) return undefined;
  const sub = parts.slice(nameLength).join("/");
  const subpath = sub === "" ? "." : `./${sub}`;

  let target: string | undefined;
  if (pkg.exports !== undefined) {
    target = exportsEntry(pkg.exports, subpath);
  } else if (subpath === ".") {
    target = pkg.types ?? pkg.module ?? pkg.main;
  } else {
    target = subpath;
  }
  if (target !== undefined) {
    const hit = firstSource(sourceCandidates(pkg.dir, target), rels);
    if (hit !== undefined) return hit;
  }
  if (subpath !== ".") return undefined;
  const indexes = [joinRel(joinRel(pkg.dir, "src"), "index"), joinRel(pkg.dir, "index")];
  for (const base of indexes) {
    const hit = firstSource(SOURCE_EXTS.map((ext) => base + ext), rels);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Project-relative paths of every workspace package.json, sorted. The inputs a bare import's answer depends on. */
export function workspaceManifestPaths(manifests: Map<string, string>): string[] {
  return [...manifests.keys()].filter(isWorkspaceManifest).sort();
}
