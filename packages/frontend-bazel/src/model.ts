import { posix } from "node:path";
import type { Span } from "@insight/ir";
import { globsIn, stringsIn, topLevelCalls, tokenize, type Tok } from "./starlark.js";

/** Rules whose names start with cc_ are C++ targets: cc_library, cc_binary, cc_test, and so on. */
const RULE_PREFIX = "cc_";

export interface BazelTarget {
  /** //package:name, the label. */
  id: string;
  name: string;
  kind: string;
  /** Repository-relative package directory. Empty for the root package. */
  pkg: string;
  /** Repository-relative path of the BUILD file that declares the target. */
  buildFile: string;
  span: Span;
  /** Repository-relative source files, globs expanded. */
  srcs: string[];
  hdrs: string[];
  /** Ids of in-repository dependencies. Whether each one exists is checked by the caller. */
  deps: string[];
  /** Labels from other repositories (@name//...). Never resolved here. */
  externalDeps: string[];
  /** Include directories this target adds for itself and, through deps, for its dependents. */
  includes: string[];
  /** Directory stripped from header paths when they are exposed to includes. */
  stripPrefix?: string;
  /** Prefix added to header paths when they are exposed to includes. */
  includePrefix?: string;
}

export interface BazelModel {
  targets: Map<string, BazelTarget>;
}

/** Joins repository-relative paths. The root directory is the empty string. */
export function joinPath(...parts: string[]): string {
  const s = posix.join(...parts.filter((p) => p !== ""));
  return s === "." ? "" : s;
}

export function isBuildFile(path: string): boolean {
  const base = posix.basename(path);
  return base === "BUILD" || base === "BUILD.bazel";
}

function packageOf(buildFile: string): string {
  const dir = posix.dirname(buildFile);
  return dir === "." ? "" : dir;
}

/** Converts a Bazel glob pattern to a regular expression over repository-relative paths. */
export function globRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "*" && pattern.charAt(i + 1) === "*") {
      if (pattern.charAt(i + 2) === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A label to a target id, or to an external repository when it starts with @. */
export function labelOf(text: string, pkg: string): { id: string } | { external: string } {
  if (text.startsWith("@")) return { external: text };
  if (text.startsWith("//")) {
    const body = text.slice(2);
    const colon = body.indexOf(":");
    const p = colon >= 0 ? body.slice(0, colon) : body;
    const name = colon >= 0 ? body.slice(colon + 1) : (p.split("/").pop() ?? p);
    return { id: `//${p}:${name}` };
  }
  if (text.startsWith(":")) return { id: `//${pkg}:${text.slice(1)}` };
  return { id: `//${pkg}:${text}` };
}

/** The repository-relative file a source label names, or undefined for an external label. */
function fileOf(text: string, pkg: string): string | undefined {
  if (text.startsWith("@")) return undefined;
  if (text.startsWith("//")) {
    const body = text.slice(2);
    const colon = body.indexOf(":");
    return colon >= 0 ? joinPath(body.slice(0, colon), body.slice(colon + 1)) : joinPath(body);
  }
  if (text.startsWith(":")) return joinPath(pkg, text.slice(1));
  return joinPath(pkg, text);
}

function fileList(toks: Tok[], pkg: string, files: string[], subpackages: Set<string>): string[] {
  const out = new Set<string>();
  for (const text of stringsIn(toks)) {
    const file = fileOf(text, pkg);
    if (file !== undefined) out.add(file);
  }
  for (const glob of globsIn(toks)) {
    const include = glob.include.map((p) => globRegex(joinPath(pkg, p)));
    const exclude = glob.exclude.map((p) => globRegex(joinPath(pkg, p)));
    for (const f of files) {
      if (!include.some((re) => re.test(f))) continue;
      if (exclude.some((re) => re.test(f))) continue;
      // A directory with its own BUILD file belongs to that package, not to this glob.
      if ([...subpackages].some((sub) => sub !== pkg && f.startsWith(`${sub}/`) && (pkg === "" || sub.startsWith(`${pkg}/`)))) continue;
      out.add(f);
    }
  }
  return [...out].sort();
}

/** Reads one BUILD file and returns the cc_* targets it declares. */
export function parseBuildFile(buildFile: string, text: string, files: string[], subpackages: Set<string>): BazelTarget[] {
  const pkg = packageOf(buildFile);
  const targets: BazelTarget[] = [];
  for (const call of topLevelCalls(tokenize(text))) {
    if (!call.name.startsWith(RULE_PREFIX)) continue;
    const arg = (key: string): Tok[] => call.args.find((a) => a.key === key)?.tokens ?? [];
    const name = stringsIn(arg("name"))[0];
    if (name === undefined) continue;
    const deps: string[] = [];
    const externalDeps: string[] = [];
    for (const label of stringsIn(arg("deps"))) {
      const target = labelOf(label, pkg);
      if ("external" in target) externalDeps.push(target.external);
      else deps.push(target.id);
    }
    const strip = stringsIn(arg("strip_include_prefix"))[0];
    const prefix = stringsIn(arg("include_prefix"))[0];
    targets.push({
      id: `//${pkg}:${name}`,
      name,
      kind: call.name,
      pkg,
      buildFile,
      span: {
        file: buildFile,
        start: [call.nameTok.line, call.nameTok.col],
        end: [call.endTok.endLine, call.endTok.endCol],
      },
      srcs: fileList(arg("srcs"), pkg, files, subpackages),
      hdrs: fileList(arg("hdrs"), pkg, files, subpackages),
      deps,
      externalDeps,
      includes: stringsIn(arg("includes")).map((d) => joinPath(pkg, d)),
      ...(strip !== undefined ? { stripPrefix: strip.startsWith("/") ? strip.slice(1) : joinPath(pkg, strip) } : {}),
      ...(prefix !== undefined ? { includePrefix: prefix.replace(/^\/+|\/+$/g, "") } : {}),
    });
  }
  return targets;
}

/** Every BUILD file in the project, read into one model. */
export function buildModel(buildTexts: Map<string, string>, files: string[]): BazelModel {
  const subpackages = new Set([...buildTexts.keys()].map(packageOf));
  const targets = new Map<string, BazelTarget>();
  for (const [file, text] of [...buildTexts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const target of parseBuildFile(file, text, files, subpackages)) {
      if (!targets.has(target.id)) targets.set(target.id, target);
    }
  }
  return { targets };
}

/** Targets that list the file as a source or header. */
export function ownersOf(model: BazelModel, file: string): BazelTarget[] {
  return [...model.targets.values()].filter((t) => t.srcs.includes(file) || t.hdrs.includes(file));
}

/** A target and everything it depends on inside the repository, the target first. */
export function closureOf(model: BazelModel, start: BazelTarget[]): BazelTarget[] {
  const seen = new Map<string, BazelTarget>();
  const queue = [...start];
  while (queue.length > 0) {
    const t = queue.shift() as BazelTarget;
    if (seen.has(t.id)) continue;
    seen.set(t.id, t);
    for (const dep of t.deps) {
      const d = model.targets.get(dep);
      if (d) queue.push(d);
    }
  }
  return [...seen.values()];
}

