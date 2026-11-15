import type { NodeId } from "@insight/ir";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { indexIncludes, matchInclude, type IncludeIndex } from "./include-match.js";
import { getParser, type SyntaxNode } from "./parser.js";

export const FRONTEND_ID = "frontend-systemverilog";
export const SV_RE = /\.(?:v|sv|svh|vh)$/i;

/** A whole word that ends a Verilog or SystemVerilog definition. Anywhere in the text, it makes the text HDL. */
const HDL_END_RE = /\b(?:endmodule|endfunction|endtask|endprimitive|endpackage|endinterface|endprogram|endclass|endgenerate|endconfig|endtable|endspecify|endchecker|endclocking|endcase)\b/;
/** A Coq marker at a line start. Verilog fragments that are included into a module body have none of these. */
const COQ_START_RE = /^[ \t]*(?:(?:Require|From\s+\S+\s+Require|Definition|Lemma|Theorem|Inductive|Fixpoint|CoInductive|Section|Instance|Record|Ltac|Notation|Axiom|Hypothesis|Variable|Class|Context|Arguments|Set\s+Implicit)\b|Module [A-Z]|Proof\.|Qed\.|Defined\.)/m;

/**
 * True when a project file is Verilog or SystemVerilog, and so is indexed and emitted. Only `.v` is ambiguous (Coq
 * also uses it), so only `.v` is judged by its text. A `.v` file is not HDL only when it has a Coq line start and no
 * HDL end keyword anywhere. Everything else is HDL, including an empty file and a file of only parameters or wires.
 */
export function isHdlText(rel: string, text: string): boolean {
  if (!/\.v$/i.test(rel)) return true;
  const body = text.replace(/^\uFEFF/, "");
  return !(COQ_START_RE.test(body) && !HDL_END_RE.test(body));
}

/** Most candidates an edge names. Past this the set is cut. */
export const MAX_CANDIDATES = 32;

/** How many file-level includes deep a scope's includes are followed. */
export const MAX_INCLUDE_DEPTH = 16;

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
  /** True when the definition was found by scanning the text of a file the grammar could not parse. */
  scanned?: true;
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
  /**
   * The next suffix to try for each base. Every suffix below it was taken when it was probed, and taken ids stay
   * taken, so probing can start here without changing which id a take returns.
   */
  private readonly next = new Map<string, number>();
  take(base: string): string {
    if (!this.seen.has(base)) {
      this.seen.add(base);
      return base;
    }
    let n = this.next.get(base) ?? 2;
    while (this.seen.has(`${base}~${n}`)) n++;
    const id = `${base}~${n}`;
    this.seen.add(id);
    this.next.set(base, n + 1);
    return id;
  }
  /** A copy holding the same taken ids, so a later pass takes ids that do not clash with the first. */
  fork(): Ids {
    const copy = new Ids();
    for (const id of this.seen) copy.seen.add(id);
    for (const [base, n] of this.next) copy.next.set(base, n);
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
   * Every `include directive of this file, with the scope it sits in. Resolved to project files after the index pass.
   * A directive at file level has scopeKey "" and kind "file".
   */
  includes: IncludeSite[];
  /**
   * Message of the error that stopped the index pass on this file, when one was thrown. The file keeps whatever
   * was indexed before the error, and the emitter reports the failure as a warning finding on the file.
   */
  indexError?: string;
}

/** The kind of scope an include sits in. "file" is file level, which gives the included file no scope. */
export type IncludeKind = "package" | "module" | "class" | "file";

/** An `include directive as written in a file: the text, the scope it sits in, and the enclosing scopes, innermost first. */
export interface IncludeSite {
  text: string;
  scopeKey: string;
  kind: IncludeKind;
  name: string;
  chain: ScopeRef[];
}

/**
 * One way a file reaches a scope: a direct include, or an include through the file-level includes of another
 * included file. `from` is the file that directly includes the file; `scopeFile` is the file that declares the scope.
 */
export interface Inclusion {
  scopeKey: string;
  kind: IncludeKind;
  name: string;
  from: string;
  scopeFile: string;
  /**
   * The scopes the include sits in, innermost first, across files: the include's own scopes, then the file-level
   * scope of the file holding it, then that file's own enclosing scopes. Each link names the file that declares it.
   */
  chain: ChainLink[];
}

/** A scope or file level along an include's chain, with the file that declares it. */
export interface ChainLink {
  key: string;
  kind: ScopeRef["kind"] | "file";
  file: string;
}

/** The imports one scope makes: wildcard packages (sorted), and explicitly named items with their package. */
export interface ScopeImports {
  wild: string[];
  named: Map<string, string>;
}

/** An enclosing scope of a call. A class is searched along its bases; a module-like or package scope is looked up by key. */
export interface ScopeRef {
  key: string;
  kind: "class" | "package" | "hdl";
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
  /**
   * The imports each file makes, per scope key ("" at file level). An import belongs to the scope that declares it,
   * so a name imported in one module is not visible in another file's module.
   */
  importsByScope: Map<string, Map<string, ScopeImports>>;
  /** The base class of each class. The first definition wins. */
  bases: Map<string, BaseRef>;
  /** The node id of each declaration and function, keyed by nodeKey. The emitter reads these so the two passes agree. */
  idOf: Map<string, NodeId>;
  /**
   * Each file's includers, sorted by `from` then scopeKey. A file included in a scope gets one entry per way it is
   * reached, including through the file-level includes of other included files (up to MAX_INCLUDE_DEPTH). When
   * several files match an include, the one in the including file's directory is preferred.
   */
  includedIn: Map<string, Inclusion[]>;
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

/**
 * True for `extern module`, `extern interface` and `extern program`: a prototype whose definition is elsewhere. It
 * declares no name of its own in the project, so it is not indexed.
 */
export const isExternDecl = (n: SyntaxNode): boolean => /^extern\b/.test(n.text);

/** The name of a module, interface or program (in its header), or of a package or class. */
export function declName(n: SyntaxNode): string | undefined {
  const header = n.namedChildren.find((c) => c.type.endsWith("_header"));
  const text = (header ?? n).childForFieldName("name")?.text;
  return text === undefined ? undefined : svName(text);
}

/**
 * The name an identifier text stands for. IEEE 1800 says an escaped identifier and its plain form are one name, so
 * the leading backslash and the whitespace that ends an escaped identifier are dropped: `\C ` is `C`.
 */
export function svName(text: string): string {
  return text.replace(/^\\/, "").trim();
}

/** The class a out-of-class definition qualifies, such as `a` in `function void a::run()`. */
function classScopeOf(n: SyntaxNode): string | undefined {
  const cs = n.namedChildren.find((c) => c.type === "class_scope");
  const last = cs?.descendantsOfType(["simple_identifier", "escaped_identifier"]).at(-1);
  return last === undefined ? undefined : svName(last.text);
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
  const raw = body?.childForFieldName("name")?.text;
  const name = raw === undefined ? undefined : svName(raw);
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
  const names = ct.namedChildren.filter((c) => c.type === "simple_identifier" || c.type === "escaped_identifier").map((c) => svName(c.text));
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

/**
 * Indexes the definitions, functions, DPI imports, class bases and per-file ids of one unit.
 * Each walk item carries the scope name (for ids) and the scope key (for lookup), which differ for modules.
 */
function collectDecls(unit: Unit, root: SyntaxNode, p: Project, imports: Map<string, FileImports>): void {
  const rel = unit.rel;
  // The package each item sits in, when it is directly inside a package (not a class or module within one).
  // The chain is the enclosing scopes that can see names, innermost first, as extract.ts builds them.
  type Item = [SyntaxNode, string | undefined, string | undefined, string[], string | undefined, ScopeRef[]];
  // Explicit stack in place of recursion. Children are queued in reverse, so they run in source order, each before its later siblings.
  const work: Item[] = [];
  const children = (kids: SyntaxNode[], scope: string | undefined, key: string | undefined, gen: string[], pkg: string | undefined, chain: ScopeRef[]): void => {
    for (let i = kids.length - 1; i >= 0; i--) work.push([kids[i] as SyntaxNode, scope, key, gen, pkg, chain]);
  };
  /** Records an include directive with the scope it sits in. Directives outside any scope are recorded at file level. */
  const recordInclude = (n: SyntaxNode, scope: string | undefined, chain: ScopeRef[]): void => {
    const m = /"([^"]*)"/.exec(n.text);
    if (!m) return;
    const top = chain[0];
    const kind: IncludeKind = top === undefined ? "file" : top.kind === "class" ? "class" : top.kind === "package" ? "package" : "module";
    unit.includes.push({ text: m[1] ?? "", scopeKey: top?.key ?? "", kind, name: top === undefined ? "" : (scope ?? ""), chain });
  };
  const visit = (n: SyntaxNode, scope: string | undefined, key: string | undefined, gen: string[], pkg: string | undefined, chain: ScopeRef[]): void => {
    const hdl = DECL_HDL[n.type];
    if (hdl !== undefined && isExternDecl(n)) return;
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
        const kind: ScopeRef["kind"] = hdl === "class" ? "class" : hdl === "package" ? "package" : "hdl";
        children(n.namedChildren, name, childKey, [], hdl === "package" ? name : undefined, [{ key: childKey, kind }, ...chain]);
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
        if (pkg !== undefined && sub.scope === undefined) p.pkgFnsByName.set(sub.name, [...(p.pkgFnsByName.get(sub.name) ?? []), ref]);
      }
      // A body cannot declare functions, but it can hold an include of statements. Only includes are taken from it.
      const bodyChain = sub?.scope !== undefined ? [{ key: sub.scope, kind: "class" as const }, ...chain] : chain;
      for (const inc of n.descendantsOfType("include_compiler_directive")) recordInclude(inc, sub?.scope ?? scope, bodyChain);
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
          if (pkg !== undefined) p.pkgFnsByName.set(name, [...(p.pkgFnsByName.get(name) ?? []), ref]);
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
        // The import belongs to the scope it is written in: the enclosing module, package or class, or "" at file level.
        const scopeKey = key ?? "";
        let imp = imports.get(scopeKey);
        if (!imp) {
          imp = { wild: new Set<string>(), named: new Map<string, string>() };
          imports.set(scopeKey, imp);
        }
        if (item === "*") imp.wild.add(pkg);
        else if (!imp.named.has(item)) imp.named.set(item, pkg);
      }
      return;
    }
    if (n.type === "generate_block") {
      const g = genNameOf(n);
      children(n.namedChildren, scope, key, g ? [...gen, g] : gen, pkg, chain);
      return;
    }
    if (n.type === "include_compiler_directive") {
      recordInclude(n, scope, chain);
      return;
    }
    children(n.namedChildren, scope, key, gen, pkg, chain);
  };
  work.push([root, undefined, undefined, [], undefined, []]);
  while (work.length > 0) {
    const [n, scope, key, gen, pkg, chain] = work.pop() as Item;
    visit(n, scope, key, gen, pkg, chain);
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
  const known = new Set<string>();
  for (const refs of p.declsByName.values()) for (const d of refs) if (d.file === unit.rel) known.add(d.name);
  for (const c of candidates) {
    if (known.has(c.name)) continue;
    known.add(c.name);
    const id = unit.ids.take(declId(unit.rel, c.name));
    const ref: DeclRef = { name: c.name, hdl: c.hdl, file: unit.rel, id, scanned: true };
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
  // A file that is not HDL is not indexed at all, so no call can point at a node that is never emitted.
  const rels = [...texts.keys()].sort().filter((rel) => isHdlText(rel, texts.get(rel) ?? ""));
  const parser = await getParser();
  const p: Project = {
    units: new Map(),
    decls: new Map(),
    declsByName: new Map(),
    fnsByScope: new Map(),
    pkgFnsByName: new Map(),
    importsByScope: new Map(),
    bases: new Map(),
    idOf: new Map(),
    includedIn: new Map(),
  };
  const scans = new Map<string, ScanCandidate[]>();
  for (const rel of rels) {
    const text = texts.get(rel) ?? "";
    const tree = parser.parse(text);
    if (!tree) throw new Error(`could not parse ${rel}`);
    const root = tree.rootNode;
    const unit: Unit = { rel, errorCount: root.hasError ? errorNodes(root).length : 0, ids: new Ids(), scanned: [], varTypes: new Map(), includes: [] };
    try {
      // A failure in one file must not fail the project: the error is recorded on its unit and the next file is indexed.
      try {
        const imports = new Map<string, FileImports>();
        collectDecls(unit, root, p, imports);
        collectVars(unit, root);
        p.importsByScope.set(rel, new Map([...imports].map(([key, imp]) => [key, { wild: [...imp.wild].sort(), named: imp.named }])));
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
  linkIncludes(p, [...texts.keys()].sort());
  adoptIncludedFunctions(p);
  return p;
}

/**
 * Maps each file a package includes to that package (see Project.includedIn). The include names a file relative to
 * the including file's directory first. Failing that, it names a file whose path ends with its text, but only when
 * exactly one project file does. The match is taken over every SV path, as the resolver sees them. A match that is
 * not an indexed unit (a file dropped as not HDL) links nothing, and no other file is tried in its place.
 */
function linkIncludes(p: Project, allRels: string[]): void {
  const index = indexIncludes(allRels);
  // Each include resolved to its project file, per including file, in source order.
  const resolved = new Map<string, Array<{ site: IncludeSite; target: string }>>();
  for (const unit of p.units.values()) {
    const list: Array<{ site: IncludeSite; target: string }> = [];
    for (const site of unit.includes) {
      const target = includeTarget(index, unit.rel, site.text);
      if (target !== undefined && target !== unit.rel && p.units.has(target)) list.push({ site, target });
    }
    resolved.set(unit.rel, list);
  }
  // Where each entry's include is written: the file and the site, so the chain can be built from the site.
  const origin = new Map<Inclusion, { file: string; site: IncludeSite }>();
  const addEntry = (target: string, e: Inclusion, o: { file: string; site: IncludeSite }): boolean => {
    const list = p.includedIn.get(target) ?? [];
    if (list.some((x) => x.scopeKey === e.scopeKey && x.scopeFile === e.scopeFile && x.from === e.from)) return false;
    list.push(e);
    p.includedIn.set(target, list);
    origin.set(e, o);
    return true;
  };
  // A file's entry reaches the files it includes at file level, so a scope that includes a file gets that file's includes too.
  const flow = (entry: Inclusion, file: string, path: string[], depth: number): void => {
    if (depth >= MAX_INCLUDE_DEPTH) return;
    const o = origin.get(entry);
    if (o === undefined) return;
    for (const { site, target } of resolved.get(file) ?? []) {
      if (site.scopeKey !== "" || path.includes(target)) continue;
      const e: Inclusion = { ...entry, from: file, chain: [] };
      if (addEntry(target, e, o)) flow(e, target, [...path, target], depth + 1);
    }
  };
  for (const [from, list] of resolved) {
    for (const { site, target } of list) {
      const entry: Inclusion = { scopeKey: site.scopeKey, kind: site.kind, name: site.name, from, scopeFile: from, chain: [] };
      if (addEntry(target, entry, { file: from, site })) flow(entry, target, [from, target], 0);
    }
  }
  for (const list of p.includedIn.values()) {
    list.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : a.scopeFile < b.scopeFile ? -1 : a.scopeFile > b.scopeFile ? 1 : 0));
  }
  // The enclosing chain of a file is the chain of its first scope entry, which is the one lookups use.
  const enclosingMemo = new Map<string, ChainLink[]>();
  const originChain = (o: { file: string; site: IncludeSite }, depth: number): ChainLink[] => [
    ...o.site.chain.map((s) => ({ key: s.key, kind: s.kind, file: o.file })),
    { key: "", kind: "file" as const, file: o.file },
    ...enclosing(o.file, depth + 1),
  ];
  const enclosing = (file: string, depth: number): ChainLink[] => {
    if (depth >= MAX_INCLUDE_DEPTH) return [];
    const hit = enclosingMemo.get(file);
    if (hit !== undefined) return hit;
    enclosingMemo.set(file, []); // a cycle of includes stops here
    const first = (p.includedIn.get(file) ?? []).find((e) => e.scopeKey !== "");
    const o = first === undefined ? undefined : origin.get(first);
    const chain = o === undefined ? [] : originChain(o, depth);
    enclosingMemo.set(file, chain);
    return chain;
  };
  for (const list of p.includedIn.values()) {
    for (const e of list) {
      const o = origin.get(e);
      if (e.scopeKey !== "" && o !== undefined) e.chain = originChain(o, 0);
    }
  }
}

/**
 * The project file an include names, or undefined when none or several match by suffix. The directory-relative
 * file wins; otherwise the one file whose path ends with the include's text (see matchInclude).
 */
function includeTarget(index: IncludeIndex, from: string, text: string): string | undefined {
  const match = matchInclude(from, text, index);
  return match.exact ?? (match.suffix.length === 1 ? match.suffix[0] : undefined);
}

/**
 * Files an included file's top-level functions into the package that includes it, so a package lookup finds them.
 * Only the scope key changes: the functions keep their ids.
 */
function adoptIncludedFunctions(p: Project): void {
  const top = p.fnsByScope.get("");
  if (!top) return;
  for (const [file, entries] of p.includedIn) {
    // One table entry per including scope. A file included only at file level keeps its functions at file level.
    const scopes = [...new Map(entries.filter((e) => e.scopeKey !== "").map((e) => [e.scopeKey, e])).values()];
    if (scopes.length === 0) continue;
    const inPackage = scopes.some((e) => e.kind === "package");
    // The file stays at $unit when a top-level file includes it at file level, so its functions remain there too.
    const atUnit = entries.some((e) => e.scopeKey === "" && !(p.includedIn.get(e.from) ?? []).some((x) => x.scopeKey !== ""));
    for (const [name, refs] of [...top]) {
      const mine = refs.filter((r) => r.file === file);
      if (mine.length === 0) continue;
      if (!atUnit) top.set(name, refs.filter((r) => r.file !== file));
      for (const e of scopes) for (const r of mine) addFn(p, e.scopeKey, r);
      // The package lookup finds a function once, however many packages include the file.
      if (inPackage) for (const r of mine) p.pkgFnsByName.set(name, [...(p.pkgFnsByName.get(name) ?? []), r]);
    }
  }
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

/** Where a call is made: the enclosing scope name, and the enclosing scopes that can see names, innermost first, file level excluded. */
export interface CallSite {
  scope?: string;
  chain?: ScopeRef[];
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
 * What one lookup step decided. A step that returns one stops the search, and `callee` undefined means unresolved.
 * Undefined as a whole means the step found nothing and the search goes on.
 */
interface Step {
  callee: Callee | undefined;
}

/**
 * The imports one scope makes, read from the file that declares them. An explicit import is pinned: it answers
 * with its package's function, or with nothing. Wildcard packages that define the name answer together.
 */
function importStep(p: Project, file: string, key: string, name: string, gen: string[]): Step | undefined {
  const imp = p.importsByScope.get(file)?.get(key);
  const named = imp?.named.get(name);
  if (named !== undefined) return { callee: finish(narrow(lookup(p, named, name), gen), false) };
  const hits = (imp?.wild ?? []).flatMap((wp) => lookup(p, wp, name));
  return hits.length > 0 ? { callee: finish(narrow(hits, gen), false) } : undefined;
}

/** One enclosing scope: its own functions first, then the imports it makes. */
function scopeStep(p: Project, rel: string, file: string, scope: ChainLink, name: string, gen: string[]): Step | undefined {
  // A file level only holds imports: its own functions are the `$unit` ones, looked up after the scopes.
  if (scope.kind === "file") return importStep(p, file, "", name, gen);
  const own = scope.kind === "class" ? chainLookup(p, scope.key, name) : lookup(p, scope.key, name);
  if (own.length > 0) return { callee: pick(own, rel, gen) };
  return importStep(p, file, scope.key, name, gen);
}

/**
 * The functions a call names. Matches are looked up in the given target only, so a member call never
 * falls through to an unrelated function of the same name. `gen` is the caller's generate path.
 *
 * A plain call follows SystemVerilog lookup, first hit wins: each enclosing scope from the innermost out (its own
 * functions, then its explicit imports, then its wildcard imports), then the package that includes this file, then
 * this file's `$unit` functions and file-level imports, then other files' `$unit` functions, then (heuristically)
 * any package function of that name.
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
      // The enclosing scopes, innermost first. A file a package includes sits inside that package, so the package
      // comes just outside the file's own scopes.
      const steps: Array<{ scope: ChainLink; file: string }> = (at.chain ?? []).map((scope) => ({ scope: { ...scope, file: rel }, file: rel }));
      // The first includer that sits in a scope. Its chain runs out through the scopes and files that hold the include.
      const inc = (p.includedIn.get(rel) ?? []).find((e) => e.scopeKey !== "");
      if (inc) for (const link of inc.chain) steps.push({ scope: link, file: link.file });
      for (const { scope, file } of steps) {
        const step = scopeStep(p, rel, file, scope, name, gen);
        if (step !== undefined) return step.callee;
      }
      // File level. `$unit` functions and DPI imports of this file come first: a function of this file beats an import of the same name.
      const unitFns = lookup(p, "", name);
      const here = unitFns.filter((r) => r.file === rel);
      if (here.length > 0) return pick(here, rel, gen);
      const fileLevel = importStep(p, rel, "", name, gen);
      if (fileLevel !== undefined) return fileLevel.callee;
      // `$unit` functions of other files.
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

