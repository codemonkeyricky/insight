import type { Span } from "@insight/ir";
import { stringsIn, tokenize, topLevelCalls, type Arg, type Call, type Tok } from "./starlark.js";

/** The files that declare third-party repositories. MODULE.bazel.lock refines the versions of MODULE.bazel. */
export const EXTERNAL_FILES = ["MODULE.bazel", "MODULE.bazel.lock", "WORKSPACE", "WORKSPACE.bazel"] as const;

export interface ExternalDecl {
  attrs: Record<string, string | boolean>;
  span?: Span;
  confidence: "exact" | "inferred";
}

export interface Externals {
  /** External id (@repo) to its declaration, in id order. */
  entries: Map<string, ExternalDecl>;
}

const OVERRIDE_CALLS: Record<string, string> = {
  git_override: "git",
  archive_override: "archive",
  local_path_override: "local",
  single_version_override: "single_version",
  multiple_version_override: "multiple_version",
};
const WORKSPACE_CALLS = new Set(["http_archive", "git_repository", "new_git_repository", "local_repository", "new_local_repository"]);

function arg(call: Call, key: string): Tok[] | undefined {
  return call.args.find((a: Arg) => a.key === key)?.tokens;
}

function str(call: Call, key: string): string | undefined {
  const toks = arg(call, key);
  return toks === undefined ? undefined : stringsIn(toks)[0];
}

function flag(call: Call, key: string): boolean {
  const toks = arg(call, key);
  return toks !== undefined && toks.length === 1 && toks[0]?.value === "True";
}

function spanOf(file: string, call: Call): Span {
  return {
    file,
    start: [call.nameTok.line, call.nameTok.col],
    end: [call.endTok.endLine, call.endTok.endCol],
  };
}

/** The first url of a download: `remote` for a git repository, else the first of `urls`, else `url`. */
function urlOf(call: Call): string | undefined {
  const urls = arg(call, "urls");
  return str(call, "remote") ?? (urls === undefined ? undefined : stringsIn(urls)[0]) ?? str(call, "url");
}

/** Which registry and version the lock records for a module. Only a single version counts. */
function lockVersion(
  name: string,
  graph: unknown,
  hashes: unknown,
): { version: string; registry?: string } | undefined {
  if (graph !== null && typeof graph === "object" && !Array.isArray(graph)) {
    for (const [key, value] of Object.entries(graph as Record<string, unknown>)) {
      const v = value as { name?: unknown; version?: unknown } | null;
      const entryName = typeof v?.name === "string" ? v.name : key.split("@")[0];
      if (entryName !== name) continue;
      const version = typeof v?.version === "string" ? v.version : key.slice(name.length + 1);
      if (version) return { version };
    }
    return undefined;
  }
  if (hashes === null || typeof hashes !== "object") return undefined;
  const found = new Map<string, string>();
  const pattern = /^(.*)\/modules\/([^/]+)\/([^/]+)\/MODULE\.bazel$/;
  for (const key of Object.keys(hashes as Record<string, unknown>)) {
    const m = pattern.exec(key);
    if (m && m[2] === name && m[3] !== undefined) found.set(m[3], m[1] ?? "");
  }
  if (found.size !== 1) return undefined;
  const only = [...found][0];
  if (only === undefined) return undefined;
  const [version, registry] = only;
  return { version, registry: registry || undefined };
}

/**
 * Reads the declarations of third-party repositories: bzlmod modules (MODULE.bazel and the lock that
 * pins them), and WORKSPACE repository rules. The MODULE.bazel declaration wins over WORKSPACE for an
 * id that both declare. Unparseable lock content is ignored.
 */
export function parseExternals(texts: Map<string, string>): Externals {
  const entries = new Map<string, ExternalDecl>();
  const moduleIds = new Map<string, string>();

  const moduleText = texts.get("MODULE.bazel");
  if (moduleText !== undefined) {
    const calls = topLevelCalls(tokenize(moduleText));
    for (const call of calls) {
      if (call.name !== "bazel_dep") continue;
      const name = str(call, "name");
      if (name === undefined) continue;
      const repo = str(call, "repo_name");
      const id = `@${repo ?? name}`;
      const version = str(call, "version");
      const attrs: Record<string, string | boolean> = { name, source: "bzlmod" };
      if (version !== undefined) attrs.version = version;
      if (repo !== undefined) attrs.repoName = repo;
      if (flag(call, "dev_dependency")) attrs.dev = true;
      if (!entries.has(id)) entries.set(id, { attrs, span: spanOf("MODULE.bazel", call), confidence: "exact" });
      moduleIds.set(name, id);
    }
    for (const call of calls) {
      if (call.name !== "use_repo") continue;
      for (const a of call.args) {
        if (a.key === undefined) {
          // The first positional argument is the extension proxy, an identifier rather than a string.
          const repo = a.tokens[0]?.kind === "str" ? stringsIn(a.tokens)[0] : undefined;
          if (repo === undefined) continue;
          const id = `@${repo}`;
          if (!entries.has(id)) entries.set(id, { attrs: { name: repo, source: "bzlmod" }, span: spanOf("MODULE.bazel", call), confidence: "inferred" });
        } else {
          // Keyword form: the local name is the id, and the string names the repository.
          const repo = stringsIn(a.tokens)[0];
          if (repo === undefined) continue;
          const id = `@${a.key}`;
          if (!entries.has(id)) entries.set(id, { attrs: { name: repo, source: "bzlmod" }, span: spanOf("MODULE.bazel", call), confidence: "inferred" });
        }
      }
    }
  }

  const lockText = texts.get("MODULE.bazel.lock");
  if (lockText !== undefined && moduleIds.size > 0) {
    let lock: { moduleDepGraph?: unknown; registryFileHashes?: unknown } | undefined;
    try {
      const parsed: unknown = JSON.parse(lockText);
      lock = parsed !== null && typeof parsed === "object" ? (parsed as typeof lock) : undefined;
    } catch {
      lock = undefined;
    }
    if (lock !== undefined) {
      for (const [name, id] of moduleIds) {
        const decl = entries.get(id);
        if (decl === undefined) continue;
        const found = lockVersion(name, lock.moduleDepGraph, lock.registryFileHashes);
        if (found === undefined) continue;
        decl.attrs.version = found.version;
        decl.attrs.source = "lockfile";
        if (found.registry !== undefined) decl.attrs.registry = found.registry;
      }
    }
  }

  const modulePresent = moduleText !== undefined;
  if (modulePresent) {
    for (const call of topLevelCalls(tokenize(moduleText))) {
      const override = OVERRIDE_CALLS[call.name];
      if (override === undefined) continue;
      const name = str(call, "module_name");
      const id = name === undefined ? undefined : moduleIds.get(name);
      const decl = id === undefined ? undefined : entries.get(id);
      if (decl === undefined) continue;
      decl.attrs.override = override;
      if (override === "git" || override === "archive") {
        const url = override === "git" ? str(call, "remote") : (stringsIn(arg(call, "urls") ?? [])[0] ?? str(call, "url"));
        if (url !== undefined) decl.attrs.url = url;
      }
      if (override === "single_version") {
        const version = str(call, "version");
        if (version !== undefined) decl.attrs.version = version;
      }
    }
  }

  for (const file of ["WORKSPACE", "WORKSPACE.bazel"] as const) {
    const text = texts.get(file);
    if (text === undefined) continue;
    for (const call of topLevelCalls(tokenize(text))) {
      if (!WORKSPACE_CALLS.has(call.name)) continue;
      const name = str(call, "name");
      if (name === undefined) continue;
      const id = `@${name}`;
      if (entries.has(id)) continue;
      const attrs: Record<string, string | boolean> = { name, source: "workspace" };
      const url = urlOf(call);
      const sha = str(call, "sha256");
      const tag = str(call, "tag");
      if (url !== undefined) attrs.url = url;
      if (sha !== undefined) attrs.sha256 = sha;
      if (tag !== undefined) attrs.version = tag;
      entries.set(id, { attrs, span: spanOf(file, call), confidence: "exact" });
    }
  }

  return { entries: new Map([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}

/**
 * The repository a label names, by its apparent name. A module's canonical name is the module name and a
 * version or nothing (`@@name+//p`, `@@name~1.0//p`), which gives `name`. An extension's canonical name has
 * more segments (`@@rules_cc++ext+foo//:x`, `@@+ext+foo//p`, the older `@@rules_cc~0.1.5~cc~foo//:x`), and
 * its apparent name is the last one, `foo`. `@//p` and `@@//p` name the main repository, which has no
 * repository here: see mainRepoNames.
 */
export function repoOf(label: string): string | undefined {
  if (!label.startsWith("@")) return undefined;
  const body = label.replace(/^@@?/, "");
  const canonical = body.split(/\/\/|:/)[0] ?? "";
  const segments = canonical.split(/[+~]/);
  const repo = segments.length >= 3 ? segments.filter((s) => s !== "").pop() : segments[0];
  return repo === undefined || repo === "" ? undefined : repo;
}

/**
 * The external id a repository name refers to, or undefined when no declaration matches it. A declared
 * repo_name matches first. Otherwise a module's canonical name matches the module name, whatever its source
 * (bzlmod, or lockfile once the lock has pinned it).
 */
export function externalIdOf(repo: string, externals: Externals): string | undefined {
  if (externals.entries.has(`@${repo}`)) return `@${repo}`;
  // A canonical name (@@googletest+) names the module, which may be declared under another repo_name.
  for (const [id, decl] of externals.entries) if (decl.attrs.name === repo) return id;
  return undefined;
}

/**
 * The apparent names by which a BUILD label reaches the main repository besides `@//` and `@@//`. From
 * MODULE.bazel it is the root module()'s repo_name when it sets one, which replaces the module name, else the
 * module name. From WORKSPACE or WORKSPACE.bazel it is the workspace() name. A repo with both files gets both
 * names, de-duplicated, because WORKSPACE names are still honoured in hybrid mode. So with
 * module(name = "me", repo_name = "my_repo"), `@my_repo//a:b` is `//a:b` and `@me//a:b` is not.
 * Callers pass every file that exists among MODULE.bazel, WORKSPACE and WORKSPACE.bazel.
 */
export function mainRepoNames(texts: Map<string, string>): string[] {
  const names: string[] = [];
  const moduleText = texts.get("MODULE.bazel");
  if (moduleText !== undefined) {
    const call = topLevelCalls(tokenize(moduleText)).find((c) => c.name === "module");
    const name = call === undefined ? undefined : (str(call, "repo_name") ?? str(call, "name"));
    if (name !== undefined) names.push(name);
  }
  for (const file of ["WORKSPACE", "WORKSPACE.bazel"]) {
    const text = texts.get(file);
    if (text === undefined) continue;
    const call = topLevelCalls(tokenize(text)).find((c) => c.name === "workspace");
    const name = call === undefined ? undefined : str(call, "name");
    if (name !== undefined) names.push(name);
  }
  return [...new Set(names)];
}
