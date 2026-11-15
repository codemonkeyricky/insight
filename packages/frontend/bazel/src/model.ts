import { posix } from "node:path";
import type { Span } from "@insight/ir";
import { globsIn, labelsIn, matchClose, splitArgs, stringsIn, topLevelCalls, tokenize, type Arg, type Call, type Tok } from "./starlark.js";

/** Rules whose names start with cc_ are C++ targets: cc_library, cc_binary, cc_test, and so on. */
const CC_PREFIX = "cc_";
/** Any other *_binary rule is a program too: py_binary, java_binary, go_binary, sh_binary, and so on. */
const BINARY_SUFFIX = "_binary";

/** Whether the rule is one the model reads: a cc_* rule, or a *_binary rule of another language. */
export function isModelledRule(name: string): boolean {
  return name.startsWith(CC_PREFIX) || name.endsWith(BINARY_SUFFIX);
}

/** Whether the rule is a C++ rule, read with its headers and include directories. */
export function isCcRule(kind: string): boolean {
  return kind.startsWith(CC_PREFIX);
}

/**
 * Names that a call with deps and sources can still have without being a C++ target: other languages,
 * filegroups, aliases, and the rest of the Bazel vocabulary.
 */
const NOT_A_TARGET = [
  "py_", "java_", "go_", "rust_", "sh_", "proto_", "js_", "ts_", "kt_", "scala_", "swift_", "objc_", "android_", "apple_",
  "genrule", "filegroup", "alias", "config_setting", "platform", "package_group", "test_suite", "exports_files", "load", "package",
];

/**
 * Whether a top-level call the model does not otherwise read is a C++ target made by a macro or a custom
 * rule: it takes deps, and srcs or hdrs. Test rules (names ending _test) are not.
 */
export function isUnknownRule(call: Call): boolean {
  if (isModelledRule(call.name) || call.name.endsWith("_test")) return false;
  if (NOT_A_TARGET.some((prefix) => call.name.startsWith(prefix))) return false;
  const keys = new Set(call.args.map((a) => a.key));
  return keys.has("deps") && (keys.has("srcs") || keys.has("hdrs"));
}

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
  /** Include directories this target adds for itself and, through deps, for its dependents. Only cc_* rules have them. */
  includes: string[];
  /** Directory stripped from header paths when they are exposed to includes. */
  stripPrefix?: string;
  /** Prefix added to header paths when they are exposed to includes. */
  includePrefix?: string;
  /** Absolute visibility labels: the target's own `visibility`, else its package's `default_visibility`. Absent when neither is set, or when the value is an expression that cannot be read. */
  visibility?: string[];
  /** Whether the target is read like a cc_library: its headers, include directories and cc-only fields. cc_* rules, and macros with deps and sources. */
  cc: boolean;
  /** `heuristic` for a target read from a macro or custom rule rather than a known Bazel rule. */
  confidence: "exact" | "heuristic";
  /** Whether the call sets a `main` attribute: the entry file of a binary. */
  hasMain: boolean;
}

/** What a build target produces, as the build-target `output` attribute: an executable, a library, a test, or other. */
export type BuildOutput = "executable" | "library" | "test" | "other";

/**
 * The output of a target. A *_binary rule is an executable and a *_test rule a test; cc_library is a library.
 * A macro or custom rule read heuristically is a library when it has headers or no `main`, else other.
 */
export function outputOf(t: BazelTarget): BuildOutput {
  if (t.kind.endsWith(BINARY_SUFFIX)) return "executable";
  if (t.kind.endsWith("_test")) return "test";
  if (t.kind === "cc_library") return "library";
  if (t.confidence === "heuristic" && (t.hdrs.length > 0 || !t.hasMain)) return "library";
  return "other";
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

/** A label's leading `@` or `@@`, the repository name after it, and the rest (`//p:t`, `:t`, or nothing). */
const LABEL_PARTS = /^@(@?)([^/:]*)(.*)$/;

/**
 * The one place that decides whether a label names the main repository, and writes every label in a form the
 * rest of the frontend reads. The main repository is `@//p:t` and `@@//p:t` (the empty name), or, with a single
 * `@`, the apparent name in `mainRepos` (the root module's repo_name, or its module name when it has none):
 * `@root//p:t` is `//p:t`, and the shorthand `@root` is `//:root`. `@@root//p:t` is a canonical external
 * label, never the main repository. An external shorthand `@foo` is written `@foo//:foo`.
 */
export function normalizeMainLabel(text: string, mainRepos: readonly string[] = []): string {
  const m = LABEL_PARTS.exec(text);
  if (m === null) return text;
  const canonical = m[1] === "@";
  const repo = m[2] ?? "";
  let rest = m[3] ?? "";
  if (repo === "" && rest === "") return text;
  const isMain = repo === "" || (!canonical && mainRepos.includes(repo));
  if (rest === "") rest = `//:${repo}`;
  else if (rest.startsWith(":")) rest = `//${rest}`;
  if (isMain) return rest.startsWith("//") ? rest : text;
  return `@${canonical ? "@" : ""}${repo}${rest}`;
}

/** A label to a target id, or to an external repository when it starts with @. */
export function labelOf(raw: string, pkg: string, mainRepos: readonly string[] = []): { id: string } | { external: string } {
  const text = normalizeMainLabel(raw, mainRepos);
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

/** A value a BUILD expression evaluates to: a list of strings, or undefined when it cannot be read. */
type ListValue = string[] | undefined;

/** Module-level variables bound to lists of strings. A name bound twice (or not at all) is unknown. */
export type ModuleVars = Map<string, ListValue>;

/** Reads one term at `i`: a list literal of strings, or a name bound in `vars`. Anything else is unknown. */
function evalTerm(toks: Tok[], i: number, vars: ModuleVars): { value: ListValue; end: number } {
  const t = toks[i];
  if (t === undefined) return { value: undefined, end: i };
  if (t.kind === "op" && t.value === "[") {
    const close = matchClose(toks, i);
    if (close < 0) return { value: undefined, end: toks.length };
    const out: string[] = [];
    let known = true;
    for (const arg of splitArgs(toks.slice(i + 1, close))) {
      const only = arg.tokens.length === 1 && arg.key === undefined ? arg.tokens[0] : undefined;
      if (only?.kind === "str") out.push(only.value);
      else known = false;
    }
    return { value: known ? out : undefined, end: close + 1 };
  }
  if (t.kind === "id") return { value: vars.get(t.value), end: i + 1 };
  return { value: undefined, end: i };
}

/** Reads a term or a `+` concatenation of terms, from `i`. Returns the value and the index after it. */
function evalExpr(toks: Tok[], i: number, vars: ModuleVars): { value: ListValue; end: number } {
  let { value, end } = evalTerm(toks, i, vars);
  while (toks[end]?.kind === "op" && toks[end]?.value === "+") {
    const next = evalTerm(toks, end + 1, vars);
    value = value !== undefined && next.value !== undefined ? [...value, ...next.value] : undefined;
    end = next.end;
  }
  return { value, end };
}

/** The value of a whole argument expression. Anything left over after the expression makes it unknown. */
function evaluate(toks: Tok[], vars: ModuleVars): ListValue {
  const r = evalExpr(toks, 0, vars);
  return r.end === toks.length ? r.value : undefined;
}

/**
 * Reads the module-level assignments of a BUILD file (`NAME = [...] + OTHER`) into the lists they bind. A name
 * assigned twice is recorded as unknown, since which value a call sees depends on where it stands.
 */
export function moduleVariables(toks: Tok[]): ModuleVars {
  const vars: ModuleVars = new Map();
  const assigned = new Map<string, number>();
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.kind === "op" && ["(", "[", "{"].includes(t.value)) depth++;
    else if (t.kind === "op" && [")", "]", "}"].includes(t.value)) depth--;
    if (depth !== 0 || t.kind !== "id") continue;
    const next = toks[i + 1];
    const after = toks[i + 2];
    // `NAME += ...` is two tokens, `+` and `=`, written side by side.
    const augmented =
      next?.kind === "op" && next.value === "+" && after?.kind === "op" && after.value === "=" && after.line === next.line && after.col === next.col + 1;
    const plain = next?.kind === "op" && next.value === "=";
    if (!augmented && !plain) continue;
    const count = (assigned.get(t.value) ?? 0) + 1;
    assigned.set(t.value, count);
    // Only a first, plain assignment at column 0 binds the name. An augmented assignment, a reassignment, or one
    // inside a block (if, for, def, indented at column > 0) leaves the name unknown.
    if (augmented || count > 1 || t.col !== 0) {
      vars.set(t.value, undefined);
      continue;
    }
    const { value, end } = evalExpr(toks, i + 2, vars);
    vars.set(t.value, end > i + 2 ? value : undefined);
  }
  return vars;
}

/**
 * The attributes whose strings are labels. Only these have a main-repository label (`@root//p:t`) read as an
 * in-repository one; a string anywhere else, such as copts = ["@argsfile"], is left as written.
 */
const LABEL_ATTRS = new Set([
  "deps", "implementation_deps", "srcs", "hdrs", "textual_hdrs", "data", "visibility", "default_visibility",
  "actual", "exports", "runtime_deps", "src",
]);

/** The call with each label attribute's strings normalised by normalizeMainLabel. */
function withLabelArgs(call: Call, mainRepos: readonly string[]): Call {
  const args = call.args.map((a) =>
    a.key !== undefined && LABEL_ATTRS.has(a.key)
      ? { ...a, tokens: a.tokens.map((t) => (t.kind === "str" ? { ...t, value: normalizeMainLabel(t.value, mainRepos) } : t)) }
      : a,
  );
  return { ...call, args };
}

/** Absolute form of a visibility label: ":__subpackages__" in package p becomes "//p:__subpackages__". */
function visibilityOf(args: Arg[], key: string, pkg: string, vars: ModuleVars, mainRepos: readonly string[]): string[] | undefined {
  const arg = args.find((a) => a.key === key);
  if (arg === undefined) return undefined;
  const values = evaluate(arg.tokens, vars);
  return values?.map((text) => {
    const target = labelOf(text, pkg, mainRepos);
    return "external" in target ? target.external : target.id;
  });
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

/**
 * Reads one BUILD file and returns the targets it declares: the cc_* rules, the *_binary rules of
 * other languages, and macro or custom rules that look like C++ targets. A non-cc binary's `main` file is one of its sources.
 */
export function parseBuildFile(
  buildFile: string,
  text: string,
  files: string[],
  subpackages: Set<string>,
  mainRepos: readonly string[] = [],
): BazelTarget[] {
  const pkg = packageOf(buildFile);
  const targets: BazelTarget[] = [];
  const toks = tokenize(text);
  const vars = moduleVariables(toks);
  // Only label-typed attributes have their main-repository labels read as in-repository labels.
  const calls = topLevelCalls(toks).map((c) => withLabelArgs(c, mainRepos));
  const pkgCall = calls.find((c) => c.name === "package");
  const defaultVisibility = pkgCall === undefined ? undefined : visibilityOf(pkgCall.args, "default_visibility", pkg, vars, mainRepos);
  for (const call of calls) {
    const modelled = isModelledRule(call.name);
    if (!modelled && !isUnknownRule(call)) continue;
    const cc = modelled ? isCcRule(call.name) : true;
    const arg = (key: string): Tok[] => call.args.find((a) => a.key === key)?.tokens ?? [];
    const name = stringsIn(arg("name"))[0];
    if (name === undefined) continue;
    const deps: string[] = [];
    const externalDeps: string[] = [];
    // Outside C++, a deps entry can be a call such as requirement("numpy"), which is not a label.
    for (const label of cc ? stringsIn(arg("deps")) : labelsIn(arg("deps"))) {
      const target = labelOf(label, pkg, mainRepos);
      if ("external" in target) externalDeps.push(target.external);
      else deps.push(target.id);
    }
    const strip = cc ? stringsIn(arg("strip_include_prefix"))[0] : undefined;
    const prefix = cc ? stringsIn(arg("include_prefix"))[0] : undefined;
    // py_binary names its entry file in `main`; it is one of the binary's sources.
    const main = cc ? undefined : stringsIn(arg("main"))[0];
    const mainFile = main === undefined ? undefined : fileOf(main, pkg);
    const srcs = fileList(arg("srcs"), pkg, files, subpackages);
    if (mainFile !== undefined && !srcs.includes(mainFile)) srcs.push(mainFile);
    // A target that sets visibility never takes the package default, even when its value cannot be read.
    const hasOwnVisibility = call.args.some((a) => a.key === "visibility");
    const ownVisibility = hasOwnVisibility ? visibilityOf(call.args, "visibility", pkg, vars, mainRepos) : defaultVisibility;
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
      srcs: srcs.sort(),
      hdrs: cc ? fileList(arg("hdrs"), pkg, files, subpackages) : [],
      deps,
      externalDeps,
      includes: cc ? stringsIn(arg("includes")).map((d) => joinPath(pkg, d)) : [],
      ...(strip !== undefined ? { stripPrefix: strip.startsWith("/") ? strip.slice(1) : joinPath(pkg, strip) } : {}),
      ...(prefix !== undefined ? { includePrefix: prefix.replace(/^\/+|\/+$/g, "") } : {}),
      ...(ownVisibility !== undefined ? { visibility: ownVisibility } : {}),
      cc,
      confidence: modelled ? "exact" : "heuristic",
      hasMain: arg("main").length > 0,
    });
  }
  return targets;
}

/** Every BUILD file in the project, read into one model. */
export function buildModel(buildTexts: Map<string, string>, files: string[], mainRepos: readonly string[] = []): BazelModel {
  const subpackages = new Set([...buildTexts.keys()].map(packageOf));
  const targets = new Map<string, BazelTarget>();
  for (const [file, text] of [...buildTexts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const target of parseBuildFile(file, text, files, subpackages, mainRepos)) {
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

