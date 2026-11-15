import type { NodeId } from "@insight/ir";
import { createHash } from "node:crypto";
import { getParser, type SyntaxNode } from "./parser.js";

export const FRONTEND_ID = "frontend-systemverilog";
export const SV_RE = /\.(?:v|sv|svh|vh)$/i;

/** Most candidates an edge names. Past this the set is cut. */
export const MAX_CANDIDATES = 32;

export const nodeKey = (n: SyntaxNode): string => `${n.startIndex}:${n.endIndex}:${n.type}`;

/** nodeKey scoped to one file. Byte offsets repeat across files, so the idOf map must include the file. */
export const fileNodeKey = (rel: string, n: SyntaxNode): string => `${rel}\u0000${nodeKey(n)}`;

export type Hdl = "module" | "interface" | "program" | "class" | "package";

/** A named definition that other files can refer to. */
export interface DeclRef {
  name: string;
  hdl: Hdl;
  file: string;
  id: NodeId;
}

/** A function, task, constructor or DPI import defined in a project file. Its scope is the enclosing or qualifying class, package or module. */
export interface FnRef {
  name: string;
  hdl: "function" | "task";
  scope?: string;
  /** Generate labels around the definition, outermost first. Empty outside generate blocks. */
  gen: string[];
  file: string;
  id: NodeId;
}

/** A class's base class, as written in its `extends` clause. */
export interface BaseRef {
  scope?: string;
  name: string;
}

/** A definition the grammar could not parse, found by scanning the raw text of a file with errors. */
export interface ScannedDef {
  name: string;
  hdl: Hdl;
  line: number;
  length: number;
  id: NodeId;
}

/** Keeps node IDs unique within one file. Two nodes with the same base get `~2`, `~3`, and so on. */
export class Ids {
  private readonly seen = new Set<string>();
  take(base: string): string {
    let id = base;
    let n = 2;
    while (this.seen.has(id)) id = `${base}~${n++}`;
    this.seen.add(id);
    return id;
  }
  /** A copy holding the same taken ids, so a later pass takes ids that do not clash with the first. */
  fork(): Ids {
    const copy = new Ids();
    for (const id of this.seen) copy.seen.add(id);
    return copy;
  }
}

/** One file's index. Holds no source text: emit reads the text again. */
export interface Unit {
  rel: string;
  /** Count of ERROR or MISSING nodes. A file with any has inferred facts and one finding. The tree is not kept; emit parses again. */
  errorCount: number;
  /** Ids of this file's declarations, functions and processes. Shared by the project pass and the emitter. */
  ids: Ids;
  /** Definitions found by scanning the text of a file with errors. */
  scanned: ScannedDef[];
  /** Declared type name per scope (module, class, package or "" at file level), then per variable. Null when declarations disagree. */
  varTypes: Map<string, Map<string, string | null>>;
  /**
   * Message of the error that stopped the index pass on this file, when one was thrown. The file keeps whatever
   * was indexed before the error, and the emitter reports the failure as a warning finding on the file.
   */
  indexError?: string;
}

export interface Project {
  units: Map<string, Unit>;
  /** Module, interface, program, package and class definitions, by name. The first file in sorted order wins. */
  decls: Map<string, DeclRef>;
  /** Every definition with a name, in sorted file order. Several can share one name. */
  declsByName: Map<string, DeclRef[]>;
  /**
   * Functions and tasks by scope key, then by name. The key is the declaration id for a module, interface or program
   * (so two files that define `module tb` do not share a scope), the name for a class or package, and "" at file level.
   */
  fnsByScope: Map<string, Map<string, FnRef[]>>;
  /** Functions and tasks declared inside a package, by name. */
  pkgFnsByName: Map<string, FnRef[]>;
  /** Packages a file imports with a wildcard (`pkg::*`), sorted. */
  wildImportsByFile: Map<string, string[]>;
  /** Names a file imports explicitly (`pkg::name`), each with its package. */
  namedImportsByFile: Map<string, Map<string, string>>;
  /** The base class of each class. The first definition wins. */
  bases: Map<string, BaseRef>;
  /** The node id of each declaration and function, keyed by nodeKey. The emitter reads these so the two passes agree. */
  idOf: Map<string, NodeId>;
}

/** Node id of a function or task, before the per-file uniqueness suffix. */
export const qualify = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined && p !== "").join(".");
export const fnBase = (rel: string, scope: string | undefined, gen: string[], name: string): NodeId => `${rel}#${qualify(scope, ...gen, name)}`;
export const declId = (rel: string, name: string): NodeId => `${rel}#${name}`;

const DECL_HDL: Record<string, Hdl> = {
  module_declaration: "module",
  interface_declaration: "interface",
  program_declaration: "program",
  class_declaration: "class",
  package_declaration: "package",
};

const SUBROUTINE_TYPES = new Set(["function_declaration", "task_declaration", "class_constructor_declaration"]);

/** The name of a module, interface or program (in its header), or of a package or class. */
export function declName(n: SyntaxNode): string | undefined {
  const header = n.namedChildren.find((c) => c.type.endsWith("_header"));
  return (header ?? n).childForFieldName("name")?.text;
}

/** The class a out-of-class definition qualifies, such as `a` in `function void a::run()`. */
function classScopeOf(n: SyntaxNode): string | undefined {
  const cs = n.namedChildren.find((c) => c.type === "class_scope");
  return cs?.descendantsOfType("simple_identifier").at(-1)?.text;
}

/**
 * The name, kind and qualifying scope of a function, task or constructor. A constructor is named `new`.
 * An out-of-class definition carries its class in the class scope, so `a::run` has scope `a`.
 */
export function subroutineOf(n: SyntaxNode): { name: string; hdl: "function" | "task"; scope?: string } | undefined {
  if (n.type === "class_constructor_declaration") {
    const scope = classScopeOf(n);
    return { name: "new", hdl: "function", ...(scope !== undefined ? { scope } : {}) };
  }
  const body = n.namedChildren.find((c) => c.type === "function_body_declaration" || c.type === "task_body_declaration");
  const name = body?.childForFieldName("name")?.text;
  if (!body || !name) return undefined;
  const scope = classScopeOf(body);
  return { name, hdl: n.type === "task_declaration" ? "task" : "function", ...(scope !== undefined ? { scope } : {}) };
}

/** The name of a generate block, `begin : name`, read from its label when the grammar gives no field name. */
export function genNameOf(n: SyntaxNode): string | undefined {
  return n.childForFieldName("name")?.text ?? n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
}

/** The base class of a class declaration, from its `extends` clause. */
function baseOf(n: SyntaxNode): BaseRef | undefined {
  const ct = n.namedChildren.find((c) => c.type === "class_type");
  if (!ct) return undefined;
  const names = ct.namedChildren.filter((c) => c.type === "simple_identifier").map((c) => c.text);
  const name = names.at(-1);
  if (name === undefined) return undefined;
  return names.length > 1 ? { scope: names[0], name } : { name };
}

/** ERROR and MISSING nodes under a tree that has errors. Each one is returned once, at its top. */
export function errorNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  // Explicit stack, so a deep tree does not overflow the call stack. Children are pushed in reverse, so they pop in source order.
  const work: SyntaxNode[] = [root];
  while (work.length > 0) {
    const n = work.pop() as SyntaxNode;
    if (n.type === "ERROR" || n.isMissing) {
      out.push(n);
      continue;
    }
    if (!n.hasError) continue;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) work.push(c);
    }
  }
  return out;
}

const addFn = (p: Project, key: string, ref: FnRef): void => {
  const byName = p.fnsByScope.get(key) ?? new Map<string, FnRef[]>();
  byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
  p.fnsByScope.set(key, byName);
};

/** The imports one file makes: wildcard packages, and explicitly named items with their package. */
interface FileImports {
  wild: Set<string>;
  named: Map<string, string>;
}

/** True for a scope key that is a module, interface or program id. Those ids hold a `#`, which no name does. */
const isHdlKey = (key: string): boolean => key.includes("#");

/**
 * Indexes the definitions, functions, DPI imports, class bases and per-file ids of one unit.
 * Each walk item carries the scope name (for ids) and the scope key (for lookup), which differ for modules.
 */
function collectDecls(unit: Unit, root: SyntaxNode, p: Project, imports: FileImports): void {
  const rel = unit.rel;
  type Item = [SyntaxNode, string | undefined, string | undefined, string[], boolean];
  // Explicit stack in place of recursion. Children are queued in reverse, so they run in source order, each before its later siblings.
  const work: Item[] = [];
  const children = (kids: SyntaxNode[], scope: string | undefined, key: string | undefined, gen: string[], inPackage: boolean): void => {
    for (let i = kids.length - 1; i >= 0; i--) work.push([kids[i] as SyntaxNode, scope, key, gen, inPackage]);
  };
  const visit = (n: SyntaxNode, scope: string | undefined, key: string | undefined, gen: string[], inPackage: boolean): void => {
    const hdl = DECL_HDL[n.type];
    if (hdl !== undefined) {
      const name = declName(n);
      if (name) {
        const id = unit.ids.take(declId(rel, name));
        p.idOf.set(fileNodeKey(rel, n), id);
        const ref: DeclRef = { name, hdl, file: rel, id };
        if (!p.decls.has(name)) p.decls.set(name, ref);
        p.declsByName.set(name, [...(p.declsByName.get(name) ?? []), ref]);
        if (hdl === "class") {
          const base = baseOf(n);
          if (base && !p.bases.has(name)) p.bases.set(name, base);
        }
        // Modules, interfaces and programs key their functions by declaration id. Classes and packages key by name.
        const childKey = hdl === "class" || hdl === "package" ? name : id;
        children(n.namedChildren, name, childKey, [], hdl === "package");
        return;
      }
    }
    if (SUBROUTINE_TYPES.has(n.type)) {
      const sub = subroutineOf(n);
      if (sub) {
        const s = sub.scope ?? scope;
        // An out-of-class definition is filed under the class it qualifies.
        const k = sub.scope ?? key;
        const id = unit.ids.take(fnBase(rel, s, gen, sub.name));
        p.idOf.set(fileNodeKey(rel, n), id);
        const ref: FnRef = { name: sub.name, hdl: sub.hdl, file: rel, id, gen, ...(s !== undefined ? { scope: s } : {}) };
        addFn(p, k ?? "", ref);
        if (inPackage && sub.scope === undefined) p.pkgFnsByName.set(sub.name, [...(p.pkgFnsByName.get(sub.name) ?? []), ref]);
      }
      return;
    }
    if (n.type === "dpi_import_export") {
      const spec = n.namedChildren.find((c) => c.type === "dpi_spec_string")?.text ?? "";
      if (/^import\b/.test(n.text) && /DPI/.test(spec)) {
        const proto = n.descendantsOfType(["function_prototype", "task_prototype"])[0];
        const name = proto?.childForFieldName("name")?.text ?? proto?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        if (name && proto) {
          const hdlKind = proto.type === "task_prototype" ? "task" : "function";
          const id = unit.ids.take(fnBase(rel, scope, gen, name));
          p.idOf.set(fileNodeKey(rel, n), id);
          const ref: FnRef = { name, hdl: hdlKind, file: rel, id, gen, ...(scope !== undefined ? { scope } : {}) };
          addFn(p, key ?? "", ref);
          if (inPackage) p.pkgFnsByName.set(name, [...(p.pkgFnsByName.get(name) ?? []), ref]);
        }
      }
      return;
    }
    if (n.type === "package_import_item") {
      // The item text is `pkg::*` for a wildcard or `pkg::name` for one named item.
      const pkg = n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const parts = n.text.replace(/\s+/g, "").split("::");
      const item = parts[1];
      if (pkg && item !== undefined) {
        if (item === "*") imports.wild.add(pkg);
        else if (!imports.named.has(item)) imports.named.set(item, pkg);
      }
      return;
    }
    if (n.type === "generate_block") {
      const g = genNameOf(n);
      children(n.namedChildren, scope, key, g ? [...gen, g] : gen, inPackage);
      return;
    }
    children(n.namedChildren, scope, key, gen, inPackage);
  };
  work.push([root, undefined, undefined, [], false]);
  while (work.length > 0) {
    const [n, scope, key, gen, inPackage] = work.pop() as Item;
    visit(n, scope, key, gen, inPackage);
  }
}

/**
 * The declared type of each variable, per scope. Covers data declarations (class properties, module
 * variables, locals) and function arguments. The type is the first identifier of the declared type,
 * so `virtual bus_if.mst vif` has type `bus_if`.
 */
function collectVars(unit: Unit, root: SyntaxNode): void {
  const add = (scope: string, name: string, type: string | null): void => {
    let m = unit.varTypes.get(scope);
    if (!m) {
      m = new Map();
      unit.varTypes.set(scope, m);
    }
    if (!m.has(name)) m.set(name, type);
    else if (m.get(name) !== type) m.set(name, null);
  };
  const typeOf = (dt: SyntaxNode | undefined): string | null => {
    const m = dt && /^(?:virtual\s+)?(?:interface\s+)?(?:\w+::)?(\w+)/.exec(dt.text.trim());
    return m?.[1] ?? null;
  };
  // Explicit stack in place of recursion, queued in reverse so the walk stays in source order.
  const work: Array<[SyntaxNode, string]> = [];
  const children = (kids: SyntaxNode[], scope: string): void => {
    for (let i = kids.length - 1; i >= 0; i--) work.push([kids[i] as SyntaxNode, scope]);
  };
  const visit = (n: SyntaxNode, scope: string): void => {
    const hdl = DECL_HDL[n.type];
    if (hdl !== undefined) {
      const name = declName(n);
      if (name) {
        children(n.namedChildren, name);
        return;
      }
    }
    if (SUBROUTINE_TYPES.has(n.type)) {
      const sub = subroutineOf(n);
      const s = sub?.scope ?? scope;
      children(n.namedChildren, s);
      return;
    }
    if (n.type === "data_declaration") {
      const type = typeOf(n.namedChildren.find((c) => c.type === "data_type_or_implicit"));
      for (const v of n.descendantsOfType("variable_decl_assignment")) {
        const name = v.childForFieldName("name")?.text ?? v.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        if (name) add(scope, name, type);
      }
      return;
    }
    if (n.type === "tf_port_item") {
      const name = n.childForFieldName("name")?.text ?? n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      if (name) add(scope, name, typeOf(n.namedChildren.find((c) => c.type === "data_type_or_implicit")));
      return;
    }
    // Inside a module the grammar parses `C c2;` (a class handle after another declaration) as a net declaration.
    // Its type is the first direct identifier; a plain net such as `wire w;` has none and is skipped.
    if (n.type === "net_declaration") {
      const type = n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      if (type !== undefined) {
        for (const a of n.descendantsOfType("net_decl_assignment")) {
          const name = a.namedChildren.find((c) => c.type === "simple_identifier")?.text;
          if (name) add(scope, name, type);
        }
      }
      return;
    }
    children(n.namedChildren, scope);
  };
  work.push([root, ""]);
  while (work.length > 0) {
    const [n, scope] = work.pop() as [SyntaxNode, string];
    visit(n, scope);
  }
}

/** A definition line found by scanning the text of a file the grammar could not parse. */
interface ScanCandidate {
  name: string;
  hdl: Hdl;
  line: number;
  length: number;
}

/**
 * Definition lines of a file the grammar could not parse, such as `module X import pkg::*; #(...)`. The text is
 * scanned line by line. Only the lines are kept, so the text can be dropped once the index is built.
 */
function scanCandidates(text: string): ScanCandidate[] {
  const out: ScanCandidate[] = [];
  // Lifetime keywords (`automatic`, `static`) and the `class` of `interface class` come before the name.
  const re = /^[ \t]*(module|interface|package)\s+((?:(?:static|automatic|class)\s+)*)(\w+)/;
  // Comments are blanked to spaces, keeping line breaks and widths, so the line numbers and lengths stay true.
  const stripped = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
  const rawLines = text.split("\n");
  stripped.split("\n").forEach((line, i) => {
    const m = re.exec(line);
    const name = m?.[3];
    if (!m || name === undefined) return;
    // `interface class` declares a class, which is not instantiable like an interface.
    const hdl: Hdl = m[1] === "module" ? "module" : m[1] === "package" ? "package" : /\bclass\b/.test(m[2] ?? "") ? "class" : "interface";
    out.push({ name, hdl, line: i, length: rawLines[i]?.length ?? line.length });
  });
  return out;
}

/**
 * Adds the scanned definitions of one unit whose names the tree did not already define. Runs after every file is
 * indexed, so the tree's definitions of the file are known.
 */
function registerScanned(unit: Unit, candidates: ScanCandidate[], p: Project): void {
  if (unit.errorCount === 0) return;
  const known = new Set((p.declsByName.get("") ?? []).map((d) => d.name));
  for (const refs of p.declsByName.values()) for (const d of refs) if (d.file === unit.rel) known.add(d.name);
  for (const c of candidates) {
    if (known.has(c.name)) continue;
    known.add(c.name);
    const id = unit.ids.take(declId(unit.rel, c.name));
    const ref: DeclRef = { name: c.name, hdl: c.hdl, file: unit.rel, id };
    if (!p.decls.has(c.name)) p.decls.set(c.name, ref);
    p.declsByName.set(c.name, [...(p.declsByName.get(c.name) ?? []), ref]);
    unit.scanned.push({ name: c.name, hdl: c.hdl, line: c.line, length: c.length, id });
  }
}

/** How many times the project pass has run. Tests read it to check that a retry reuses the index. */
export const indexStats = { builds: 0 };

/**
 * Indexes the definitions of every file. Each file is parsed once here and its tree is freed at once; the
 * emit step parses it again. Only plain data is kept: no source text is held, so the result is small.
 */
export async function indexProject(texts: Map<string, string>): Promise<Project> {
  indexStats.builds++;
  const rels = [...texts.keys()].sort();
  const parser = await getParser();
  const p: Project = {
    units: new Map(),
    decls: new Map(),
    declsByName: new Map(),
    fnsByScope: new Map(),
    pkgFnsByName: new Map(),
    wildImportsByFile: new Map(),
    namedImportsByFile: new Map(),
    bases: new Map(),
    idOf: new Map(),
  };
  const scans = new Map<string, ScanCandidate[]>();
  for (const rel of rels) {
    const text = texts.get(rel) ?? "";
    const tree = parser.parse(text);
    if (!tree) throw new Error(`could not parse ${rel}`);
    const root = tree.rootNode;
    const unit: Unit = { rel, errorCount: root.hasError ? errorNodes(root).length : 0, ids: new Ids(), scanned: [], varTypes: new Map() };
    try {
      // A failure in one file must not fail the project: the error is recorded on its unit and the next file is indexed.
      try {
        const imports: FileImports = { wild: new Set<string>(), named: new Map<string, string>() };
        collectDecls(unit, root, p, imports);
        collectVars(unit, root);
        p.wildImportsByFile.set(rel, [...imports.wild].sort());
        p.namedImportsByFile.set(rel, imports.named);
      } catch (e) {
        unit.indexError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      tree.delete();
    }
    p.units.set(rel, unit);
    if (unit.errorCount > 0) scans.set(rel, scanCandidates(text));
  }
  for (const unit of p.units.values()) registerScanned(unit, scans.get(unit.rel) ?? [], p);
  return p;
}

/**
 * The last project indexed, keyed by a digest of the sorted file names and each file's content hash. It holds
 * no source text, only the index, so it is kept for the life of the process: a retry of the same project reuses it.
 */
let lastProject: { key: string; project: Project } | undefined;

/** Drops the cached index. Tests use it to start from an empty cache. Extract runs do not call it. */
export function releaseProject(): void {
  lastProject = undefined;
}

/**
 * Indexes the project's definitions across its files. Reuses the last index when the file names and contents
 * match it, so a retry of the same project does not parse again. Any edited file gives a new key.
 */
export async function buildProject(texts: Map<string, string>): Promise<Project> {
  const digest = createHash("sha256");
  for (const rel of [...texts.keys()].sort()) {
    const content = createHash("sha256").update(texts.get(rel) ?? "").digest("hex");
    digest.update(rel).update("\u0000").update(content).update("\u0000");
  }
  const key = digest.digest("hex");
  if (lastProject?.key === key) return lastProject.project;
  const project = await indexProject(texts);
  lastProject = { key, project };
  return project;
}

/** The class and its base classes, nearest first. A base that is not in the project ends the chain, so it finds nothing. */
export function classChain(p: Project, start: string): string[] {
  const out = [start];
  const seen = new Set(out);
  let cur = start;
  for (;;) {
    const base = p.bases.get(cur);
    if (!base || seen.has(base.name)) break;
    seen.add(base.name);
    out.push(base.name);
    cur = base.name;
  }
  return out;
}

/** Where a call is looked up. */
export type CallTarget =
  /** An unqualified name: the caller's class or module (with its bases), the imported packages, then any package. */
  | { kind: "plain" }
  /** `pkg::f` or `Class::f`: the named scope and its bases. */
  | { kind: "scoped"; scope: string }
  /** A member of a class: `this.f`, `super.f`, or a call through a handle of this class type. */
  | { kind: "member"; cls: string }
  /** A call the frontend cannot place. */
  | { kind: "none" };

export interface Callee {
  /** The functions the call may reach, sorted by id. More than one means candidates. */
  refs: FnRef[];
  /** True when the match is in the caller's own file and scope, so it is not a guess. */
  exact: boolean;
  /** True when more than MAX_CANDIDATES functions matched and the list was cut. */
  truncated: boolean;
  /** True when the match is the any-package guess: no visible scope, import or unit function named it. */
  heuristic?: boolean;
}

/** Where a call is made: the enclosing scope name, its scope key, and the package the code sits in. */
export interface CallSite {
  scope?: string;
  scopeKey?: string;
  pkg?: string;
}

const lookup = (p: Project, key: string, name: string): FnRef[] => p.fnsByScope.get(key)?.get(name) ?? [];

/** The functions named in the first class of the chain that declares the name. */
function chainLookup(p: Project, start: string, name: string): FnRef[] {
  for (const c of classChain(p, start)) {
    const refs = lookup(p, c, name);
    if (refs.length > 0) return refs;
  }
  return [];
}

function finish(refs: FnRef[], exact: boolean): Callee | undefined {
  if (refs.length === 0) return undefined;
  const sorted = [...new Map(refs.map((r) => [r.id, r])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { refs: sorted.slice(0, MAX_CANDIDATES), exact, truncated: sorted.length > MAX_CANDIDATES };
}

/** True when a definition in generate path `at` is visible from generate path `gen`: the caller sits inside that block. */
const onPath = (at: string[], gen: string[]): boolean => at.length <= gen.length && at.every((g, i) => g === gen[i]);

/**
 * The definitions on the caller's own generate path. Of those, only the innermost block counts, so a caller in
 * `g1` takes `g1`'s definition over the same name in `g2`. Empty when no definition is on the path.
 */
function onOwnPath(refs: FnRef[], gen: string[]): FnRef[] {
  const on = refs.filter((r) => onPath(r.gen, gen));
  if (on.length === 0) return [];
  const deepest = Math.max(...on.map((r) => r.gen.length));
  return on.filter((r) => r.gen.length === deepest);
}

/** The definitions to choose from: the caller's own generate path when it has one, otherwise all matches. */
const narrow = (refs: FnRef[], gen: string[]): FnRef[] => {
  const chosen = onOwnPath(refs, gen);
  return chosen.length > 0 ? chosen : refs;
};

/** A callee from matches in the caller's own scope chain. Exact when every match is in the caller's file. */
function pick(refs: FnRef[], rel: string, gen: string[]): Callee | undefined {
  const set = narrow(refs, gen);
  return finish(set, set.length > 0 && set.every((r) => r.file === rel));
}

/**
 * The functions named in a class, package, or module-like definition. A module, interface or program holds its
 * functions under its declaration id, so a name that is not a class or package is looked up through its definitions.
 */
function scopedLookup(p: Project, name: string, scope: string): FnRef[] {
  const inChain = chainLookup(p, scope, name);
  if (inChain.length > 0) return inChain;
  return moduleDefs(p, scope).flatMap((d) => lookup(p, d.id, name));
}

/** True when a class's base chain leaves the project: the chain has a base that is not a class defined in the project. */
function leavesProject(p: Project, start: string | undefined): boolean {
  if (start === undefined) return false;
  const chain = classChain(p, start);
  const last = chain[chain.length - 1] ?? start;
  return chain.length > 1 && p.decls.get(last)?.hdl !== "class";
}

/**
 * The functions a call names. Matches are looked up in the given target only, so a member call never
 * falls through to an unrelated function of the same name. `gen` is the caller's generate path.
 *
 * A plain call follows SystemVerilog lookup, first hit wins: the caller's own scope, its enclosing package,
 * this file's `$unit` functions, an explicitly imported name, wildcard-imported packages, other files' `$unit`
 * functions, then (heuristically) any package function of that name.
 */
export function resolveCallee(p: Project, rel: string, at: CallSite, name: string, target: CallTarget, gen: string[] = []): Callee | undefined {
  switch (target.kind) {
    case "none":
      return undefined;
    case "scoped":
      return pick(scopedLookup(p, name, target.scope), rel, gen);
    case "member":
      return pick(scopedLookup(p, name, target.cls), rel, gen);
    case "plain": {
      // a. The caller's own scope. A module-like scope is keyed by id; a class is searched along its bases.
      const ownKey = at.scopeKey;
      const own =
        ownKey !== undefined && isHdlKey(ownKey) ? lookup(p, ownKey, name) : at.scope !== undefined ? chainLookup(p, at.scope, name) : [];
      if (own.length > 0) return pick(own, rel, gen);
      // b. The package the caller sits in, when it is not the caller's own scope.
      if (at.pkg !== undefined && at.pkg !== at.scope) {
        const inPkg = lookup(p, at.pkg, name);
        if (inPkg.length > 0) return pick(inPkg, rel, gen);
      }
      // c. `$unit` functions and DPI imports of this file. A function of this file beats an import of the same name.
      const unitFns = lookup(p, "", name);
      const here = unitFns.filter((r) => r.file === rel);
      if (here.length > 0) return pick(here, rel, gen);
      // d. An explicitly imported name. It resolves to that package only, or to nothing, so later steps do not run.
      const named = p.namedImportsByFile.get(rel)?.get(name);
      if (named !== undefined) return finish(narrow(lookup(p, named, name), gen), false);
      // e. Wildcard-imported packages that define the name. Several matches are candidates.
      const wildHits = (p.wildImportsByFile.get(rel) ?? []).flatMap((pkg) => lookup(p, pkg, name));
      if (wildHits.length > 0) return finish(narrow(wildHits, gen), false);
      // f. `$unit` functions of other files.
      if (unitFns.length > 0) return finish(narrow(unitFns, gen), false);
      // g. Any package's function of that name. A caller whose class extends a class outside the project skips this,
      // since the call may name something that class inherits.
      if (leavesProject(p, at.scope)) return undefined;
      const anyPkg = finish(p.pkgFnsByName.get(name) ?? [], false);
      return anyPkg && { ...anyPkg, heuristic: true };
    }
  }
}

/** The class or interface a variable is declared with, when that type is in the project. */
export function varClass(p: Project, rel: string, scope: string | undefined, name: string): string | undefined {
  const t = p.units.get(rel)?.varTypes.get(scope ?? "")?.get(name);
  if (!t) return undefined;
  const d = p.decls.get(t);
  return d && (d.hdl === "class" || d.hdl === "interface") ? t : undefined;
}

/** The module, interface and program definitions with a name. */
export function moduleDefs(p: Project, name: string): DeclRef[] {
  return (p.declsByName.get(name) ?? []).filter((d) => d.hdl === "module" || d.hdl === "interface" || d.hdl === "program");
}

