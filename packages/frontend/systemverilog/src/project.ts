import type { NodeId } from "@insight/ir";
import { getParser, type SyntaxNode, type Tree } from "./parser.js";

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
}

export interface Unit {
  rel: string;
  text: string;
  root: SyntaxNode;
  tree: Tree;
  /** ERROR or MISSING nodes. A file with any has inferred facts and one info finding. */
  errors: SyntaxNode[];
  /** Ids of this file's declarations, functions and processes. Shared by the project pass and the emitter. */
  ids: Ids;
  /** Definitions found by scanning the text of a file with errors. */
  scanned: ScannedDef[];
  /** Declared type name per scope (module, class, package or "" at file level), then per variable. Null when declarations disagree. */
  varTypes: Map<string, Map<string, string | null>>;
}

export interface Project {
  units: Map<string, Unit>;
  /** Module, interface, program, package and class definitions, by name. The first file in sorted order wins. */
  decls: Map<string, DeclRef>;
  /** Every definition with a name, in sorted file order. Several can share one name. */
  declsByName: Map<string, DeclRef[]>;
  /** Functions and tasks by enclosing scope name ("" at file level), then by name. */
  fnsByScope: Map<string, Map<string, FnRef[]>>;
  /** Functions and tasks declared inside a package, by name. */
  pkgFnsByName: Map<string, FnRef[]>;
  /** Packages a file imports, sorted. */
  importsByFile: Map<string, string[]>;
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
function errorNodes(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode): void => {
    if (n.type === "ERROR" || n.isMissing) {
      out.push(n);
      return;
    }
    if (!n.hasError) return;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) visit(c);
    }
  };
  visit(root);
  return out;
}

const addFn = (p: Project, scope: string, ref: FnRef): void => {
  const byName = p.fnsByScope.get(scope) ?? new Map<string, FnRef[]>();
  byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
  p.fnsByScope.set(scope, byName);
};

/** Indexes the definitions, functions, DPI imports, class bases and per-file ids of one unit. */
function collectDecls(unit: Unit, p: Project, imports: Set<string>): void {
  const rel = unit.rel;
  const visit = (n: SyntaxNode, scope: string | undefined, gen: string[], inPackage: boolean): void => {
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
        for (const c of n.namedChildren) visit(c, name, [], hdl === "package");
        return;
      }
    }
    if (SUBROUTINE_TYPES.has(n.type)) {
      const sub = subroutineOf(n);
      if (sub) {
        const s = sub.scope ?? scope;
        const id = unit.ids.take(fnBase(rel, s, gen, sub.name));
        p.idOf.set(fileNodeKey(rel, n), id);
        const ref: FnRef = { name: sub.name, hdl: sub.hdl, file: rel, id, ...(s !== undefined ? { scope: s } : {}) };
        addFn(p, s ?? "", ref);
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
          const ref: FnRef = { name, hdl: hdlKind, file: rel, id, ...(scope !== undefined ? { scope } : {}) };
          addFn(p, scope ?? "", ref);
          if (inPackage) p.pkgFnsByName.set(name, [...(p.pkgFnsByName.get(name) ?? []), ref]);
        }
      }
      return;
    }
    if (n.type === "package_import_item") {
      const pkg = n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      if (pkg) imports.add(pkg);
      return;
    }
    if (n.type === "generate_block") {
      const g = genNameOf(n);
      for (const c of n.namedChildren) visit(c, scope, g ? [...gen, g] : gen, inPackage);
      return;
    }
    for (const c of n.namedChildren) visit(c, scope, gen, inPackage);
  };
  visit(unit.root, undefined, [], false);
}

/**
 * The declared type of each variable, per scope. Covers data declarations (class properties, module
 * variables, locals) and function arguments. The type is the first identifier of the declared type,
 * so `virtual bus_if.mst vif` has type `bus_if`.
 */
function collectVars(unit: Unit): void {
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
  const visit = (n: SyntaxNode, scope: string): void => {
    const hdl = DECL_HDL[n.type];
    if (hdl !== undefined) {
      const name = declName(n);
      if (name) {
        for (const c of n.namedChildren) visit(c, name);
        return;
      }
    }
    if (SUBROUTINE_TYPES.has(n.type)) {
      const sub = subroutineOf(n);
      const s = sub?.scope ?? scope;
      for (const c of n.namedChildren) visit(c, s);
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
    for (const c of n.namedChildren) visit(c, scope);
  };
  visit(unit.root, "");
}

/**
 * Definitions in a file the grammar could not parse, such as `module X import pkg::*; #(...)`. The text is
 * scanned line by line, and only names that the tree did not already define are added.
 */
function scanDefs(unit: Unit, p: Project): void {
  if (unit.errors.length === 0) return;
  const known = new Set((p.declsByName.get("") ?? []).map((d) => d.name));
  for (const refs of p.declsByName.values()) for (const d of refs) if (d.file === unit.rel) known.add(d.name);
  const re = /^[ \t]*(module|interface|package)\s+(\w+)/;
  unit.text.split("\n").forEach((line, i) => {
    const m = re.exec(line);
    const name = m?.[2];
    if (!m || name === undefined || known.has(name)) return;
    known.add(name);
    const hdl: Hdl = m[1] === "module" ? "module" : m[1] === "interface" ? "interface" : "package";
    const id = unit.ids.take(declId(unit.rel, name));
    const ref: DeclRef = { name, hdl, file: unit.rel, id };
    if (!p.decls.has(name)) p.decls.set(name, ref);
    p.declsByName.set(name, [...(p.declsByName.get(name) ?? []), ref]);
    unit.scanned.push({ name, hdl, line: i, length: line.length, id });
  });
}

/** Parses every Verilog or SystemVerilog file and indexes the definitions that other files can refer to. */
export async function buildProject(texts: Map<string, string>): Promise<Project> {
  const parser = await getParser();
  const units = new Map<string, Unit>();
  for (const rel of [...texts.keys()].sort()) {
    const text = texts.get(rel) ?? "";
    const tree = parser.parse(text);
    if (!tree) throw new Error(`could not parse ${rel}`);
    const root = tree.rootNode;
    units.set(rel, { rel, text, root, tree, errors: root.hasError ? errorNodes(root) : [], ids: new Ids(), scanned: [], varTypes: new Map() });
  }
  const p: Project = {
    units,
    decls: new Map(),
    declsByName: new Map(),
    fnsByScope: new Map(),
    pkgFnsByName: new Map(),
    importsByFile: new Map(),
    bases: new Map(),
    idOf: new Map(),
  };
  for (const unit of units.values()) {
    const imports = new Set<string>();
    collectDecls(unit, p, imports);
    collectVars(unit);
    p.importsByFile.set(unit.rel, [...imports].sort());
  }
  for (const unit of units.values()) scanDefs(unit, p);
  return p;
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
}

const lookup = (p: Project, scope: string, name: string): FnRef[] => p.fnsByScope.get(scope)?.get(name) ?? [];

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

/**
 * The functions a call names. Matches are looked up in the given target only, so a member call never
 * falls through to an unrelated function of the same name.
 */
export function resolveCallee(p: Project, rel: string, scope: string | undefined, name: string, target: CallTarget): Callee | undefined {
  switch (target.kind) {
    case "none":
      return undefined;
    case "scoped": {
      const refs = chainLookup(p, target.scope, name);
      return finish(refs, refs.length > 0 && refs.every((r) => r.file === rel));
    }
    case "member": {
      const refs = chainLookup(p, target.cls, name);
      return finish(refs, refs.length > 0 && refs.every((r) => r.file === rel));
    }
    case "plain": {
      if (scope !== undefined) {
        const own = chainLookup(p, scope, name);
        if (own.length > 0) return finish(own, own.every((r) => r.file === rel));
      }
      for (const pkg of p.importsByFile.get(rel) ?? []) {
        const refs = lookup(p, pkg, name);
        if (refs.length > 0) return finish(refs, false);
      }
      return finish(p.pkgFnsByName.get(name) ?? [], false);
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

/** Frees the parse trees. The WASM heap is not garbage collected with the JavaScript objects. */
export function disposeProject(project: Project): void {
  for (const unit of project.units.values()) unit.tree.delete();
}
