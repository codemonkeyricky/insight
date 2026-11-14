import type { NodeId } from "@insight/ir";
import { getParser, type SyntaxNode, type Tree } from "./parser.js";

export const FRONTEND_ID = "frontend-systemverilog";
export const SV_RE = /\.(?:v|sv|svh|vh)$/i;

export const nodeKey = (n: SyntaxNode): string => `${n.startIndex}:${n.endIndex}:${n.type}`;

export type Hdl = "module" | "interface" | "program" | "class" | "package";

/** A named definition that other files can refer to. */
export interface DeclRef {
  name: string;
  hdl: Hdl;
  file: string;
  id: NodeId;
}

/** A function or task defined in a project file. Its scope is the enclosing class, package or module name. */
export interface FnRef {
  name: string;
  hdl: "function" | "task";
  scope?: string;
  file: string;
  id: NodeId;
}

export interface Unit {
  rel: string;
  root: SyntaxNode;
  tree: Tree;
  /** ERROR or MISSING nodes. A file with any has inferred facts and one info finding. */
  errors: SyntaxNode[];
}

export interface Project {
  units: Map<string, Unit>;
  /** Module, interface, program, package and class definitions, by name. The first file in sorted order wins. */
  decls: Map<string, DeclRef>;
  /** Functions and tasks by enclosing scope name ("" at file level), then by name. */
  fnsByScope: Map<string, Map<string, FnRef[]>>;
  /** Functions and tasks declared inside a package, by name. */
  pkgFnsByName: Map<string, FnRef[]>;
  /** Packages a file imports, sorted. */
  importsByFile: Map<string, string[]>;
}

/** Node id of a function or task. Shared by the project pass and the emitter, so both agree. */
export const fnId = (rel: string, scope: string | undefined, name: string): NodeId => `${rel}#${scope ? `${scope}.${name}` : name}`;
export const declId = (rel: string, name: string): NodeId => `${rel}#${name}`;

const DECL_HDL: Record<string, Hdl> = {
  module_declaration: "module",
  interface_declaration: "interface",
  program_declaration: "program",
  class_declaration: "class",
  package_declaration: "package",
};

/** The name of a module, interface or program (in its header), or of a package or class. */
export function declName(n: SyntaxNode): string | undefined {
  const header = n.namedChildren.find((c) => c.type.endsWith("_header"));
  return (header ?? n).childForFieldName("name")?.text;
}

/** The name and kind of a function or task declaration, read from its body. */
export function subroutineOf(n: SyntaxNode): { name: string; hdl: "function" | "task" } | undefined {
  const body = n.namedChildren.find((c) => c.type === "function_body_declaration" || c.type === "task_body_declaration");
  const name = body?.childForFieldName("name")?.text;
  if (!name) return undefined;
  return { name, hdl: n.type === "task_declaration" ? "task" : "function" };
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

function collectDecls(rel: string, root: SyntaxNode, p: Project, imports: Set<string>): void {
  const visit = (n: SyntaxNode, scope: string | undefined, inPackage: boolean): void => {
    const hdl = DECL_HDL[n.type];
    if (hdl !== undefined) {
      const name = declName(n);
      if (name) {
        if (!p.decls.has(name)) p.decls.set(name, { name, hdl, file: rel, id: declId(rel, name) });
        for (const c of n.namedChildren) visit(c, name, hdl === "package");
        return;
      }
    }
    if (n.type === "function_declaration" || n.type === "task_declaration") {
      const sub = subroutineOf(n);
      if (sub) {
        const ref: FnRef = { name: sub.name, hdl: sub.hdl, file: rel, id: fnId(rel, scope, sub.name), ...(scope ? { scope } : {}) };
        const byName = p.fnsByScope.get(scope ?? "") ?? new Map<string, FnRef[]>();
        byName.set(sub.name, [...(byName.get(sub.name) ?? []), ref]);
        p.fnsByScope.set(scope ?? "", byName);
        if (inPackage) p.pkgFnsByName.set(sub.name, [...(p.pkgFnsByName.get(sub.name) ?? []), ref]);
      }
      return;
    }
    if (n.type === "package_import_item") {
      const pkg = n.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      if (pkg) imports.add(pkg);
      return;
    }
    for (const c of n.namedChildren) visit(c, scope, inPackage);
  };
  visit(root, undefined, false);
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
    units.set(rel, { rel, root, tree, errors: root.hasError ? errorNodes(root) : [] });
  }
  const p: Project = { units, decls: new Map(), fnsByScope: new Map(), pkgFnsByName: new Map(), importsByFile: new Map() };
  for (const unit of units.values()) {
    const imports = new Set<string>();
    collectDecls(unit.rel, unit.root, p, imports);
    p.importsByFile.set(unit.rel, [...imports].sort());
  }
  return p;
}

export interface Callee {
  ref: FnRef;
  /** True when the name was written in the same scope of the same file, so the match is not a guess. */
  exact: boolean;
}

const unique = (refs: FnRef[] | undefined): FnRef | undefined => (refs && refs.length === 1 ? refs[0] : undefined);

/**
 * The function a call names. An explicit scope (pkg::fn) is looked up first, then the caller's own scope,
 * then the packages the file imports, then the one package function with this name in the project.
 */
export function resolveCallee(p: Project, rel: string, scope: string | undefined, name: string, explicit: string | undefined): Callee | undefined {
  if (explicit !== undefined) {
    const ref = unique(p.fnsByScope.get(explicit)?.get(name));
    return ref ? { ref, exact: ref.file === rel } : undefined;
  }
  const own = unique(p.fnsByScope.get(scope ?? "")?.get(name));
  if (own) return { ref: own, exact: own.file === rel };
  for (const pkg of p.importsByFile.get(rel) ?? []) {
    const ref = unique(p.fnsByScope.get(pkg)?.get(name));
    if (ref) return { ref, exact: false };
  }
  const global = unique(p.pkgFnsByName.get(name));
  return global ? { ref: global, exact: false } : undefined;
}

/** Frees the parse trees. The WASM heap is not garbage collected with the JavaScript objects. */
export function disposeProject(project: Project): void {
  for (const unit of project.units.values()) unit.tree.delete();
}
