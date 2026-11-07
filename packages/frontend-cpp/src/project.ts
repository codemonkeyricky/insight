import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NodeId } from "@insight/ir";
import { getParser, type SyntaxNode, type Tree } from "./parser.js";

export const FRONTEND_ID = "frontend-cpp";
export const CPP_RE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;

export const norm = (s: string): string => s.replace(/\s+/g, "");
/** Template arguments removed, so std::lock_guard<std::mutex> becomes std::lock_guard. */
export const stripTemplates = (s: string): string => s.replace(/<.*$/, "");
export const nodeKey = (n: SyntaxNode): string => `${n.startIndex}:${n.endIndex}:${n.type}`;

export interface Scope {
  /** Enclosing namespace and class names, outermost first. Anonymous namespaces add nothing. */
  path: string[];
  /** True inside an anonymous namespace, whose names have internal linkage. */
  anon: boolean;
  /** The innermost enclosing class, qualified, when there is one. */
  cls?: string;
}

/** The namespaces and classes around a node, found by walking up its parents. */
export function scopeOf(node: SyntaxNode): Scope {
  const frames: { name: string; isClass: boolean }[] = [];
  let anon = false;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "namespace_definition") {
      const name = p.childForFieldName("name")?.text;
      if (name) frames.unshift({ name, isClass: false });
      else anon = true;
    } else if ((p.type === "class_specifier" || p.type === "struct_specifier") && p.childForFieldName("body")) {
      const name = p.childForFieldName("name")?.text;
      if (name) frames.unshift({ name: stripTemplates(norm(name)), isClass: true });
    }
  }
  const path = frames.map((f) => f.name);
  const lastClass = frames.map((f) => f.isClass).lastIndexOf(true);
  const cls = lastClass >= 0 ? path.slice(0, lastClass + 1).join("::") : undefined;
  return { path, anon, ...(cls !== undefined ? { cls } : {}) };
}

/** The function_declarator inside a function definition, past pointer and reference wrappers. */
export function functionDeclarator(fn: SyntaxNode): SyntaxNode | null {
  let d: SyntaxNode | null = fn.childForFieldName("declarator");
  while (d && d.type !== "function_declarator") d = d.childForFieldName("declarator");
  return d;
}

export interface FnDecl {
  id: NodeId;
  rel: string;
  qname: string;
  simple: string;
  /** The class the function belongs to, qualified. Undefined for free functions. */
  cls?: string;
  exported: boolean;
  key: string;
}

export interface Unit {
  rel: string;
  root: SyntaxNode;
  tree: Tree;
  /** ERROR nodes. A file with any has inferred facts. */
  errors: SyntaxNode[];
}

export interface Project {
  units: Map<string, Unit>;
  /** Every function definition, keyed by `${rel}|${nodeKey}`. */
  fns: Map<string, FnDecl>;
  fnsByFile: Map<string, FnDecl[]>;
  byQName: Map<string, FnDecl[]>;
  bySimple: Map<string, FnDecl[]>;
  /** Field names declared in each class, keyed by qualified class name. */
  members: Map<string, Set<string>>;
}

const walk = (node: SyntaxNode, visit: (n: SyntaxNode) => void): void => {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
};

function declaredName(fn: SyntaxNode): { qname: string; simple: string } | undefined {
  const fd = functionDeclarator(fn);
  const name = fd?.childForFieldName("declarator");
  if (!name) return undefined;
  const bare = stripTemplates(norm(name.text));
  const parts = bare.replace(/^::/, "").split("::");
  return { qname: parts.join("::"), simple: parts[parts.length - 1] ?? bare };
}

function collectMembers(root: SyntaxNode, scopeOfClass: (n: SyntaxNode) => string | undefined, members: Map<string, Set<string>>): void {
  walk(root, (node) => {
    if (node.type !== "class_specifier" && node.type !== "struct_specifier") return;
    const body = node.childForFieldName("body");
    const name = node.childForFieldName("name")?.text;
    if (!body || !name) return;
    const cls = scopeOfClass(node);
    if (cls === undefined) return;
    const set = members.get(cls) ?? new Set<string>();
    for (const field of body.namedChildren) {
      if (field.type !== "field_declaration") continue;
      let d: SyntaxNode | null = field.childForFieldName("declarator");
      let isFunction = false;
      while (d && d.type !== "field_identifier") {
        if (d.type === "function_declarator") isFunction = true;
        d = d.childForFieldName("declarator");
      }
      if (d && !isFunction) set.add(d.text);
    }
    members.set(cls, set);
  });
}

/** Parses every C or C++ file and collects the function definitions that calls can target. */
export async function buildProject(texts: Map<string, string>): Promise<Project> {
  const parser = await getParser();
  const units = new Map<string, Unit>();
  for (const [rel, text] of texts) {
    const tree = parser.parse(text);
    if (!tree) throw new Error(`could not parse ${rel}`);
    const root = tree.rootNode;
    // A file can be wrong without an ERROR node (a MISSING token), so the root stands in for it.
    const found = root.hasError ? root.descendantsOfType("ERROR") : [];
    const errors: SyntaxNode[] = root.hasError ? (found.length > 0 ? found : [root]) : [];
    units.set(rel, { rel, root, tree, errors });
  }

  const fns = new Map<string, FnDecl>();
  const fnsByFile = new Map<string, FnDecl[]>();
  const byQName = new Map<string, FnDecl[]>();
  const bySimple = new Map<string, FnDecl[]>();
  const members = new Map<string, Set<string>>();

  for (const unit of units.values()) {
    const pending: { node: SyntaxNode; qname: string; simple: string; scope: Scope }[] = [];
    walk(unit.root, (node) => {
      if (node.type !== "function_definition") return;
      const names = declaredName(node);
      if (!names) return;
      const scope = scopeOf(node);
      pending.push({ node, ...names, scope });
    });

    const fullNames = pending.map((p) => [...p.scope.path, p.qname].join("::"));
    const counts = new Map<string, number>();
    for (const name of fullNames) counts.set(name, (counts.get(name) ?? 0) + 1);

    const list: FnDecl[] = [];
    pending.forEach((p, i) => {
      const qname = fullNames[i] as string;
      const base = `${unit.rel}#${qname}`;
      const id = (counts.get(qname) ?? 0) > 1 ? `${base}@${p.node.startPosition.row + 1}` : base;
      const cls = p.scope.cls ?? (p.qname.includes("::") ? [...p.scope.path, ...p.qname.split("::").slice(0, -1)].join("::") : undefined);
      const isStatic = p.node.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === "static");
      const decl: FnDecl = {
        id,
        rel: unit.rel,
        qname,
        simple: p.simple,
        ...(cls !== undefined ? { cls } : {}),
        exported: !p.scope.anon && !isStatic,
        key: `${unit.rel}|${nodeKey(p.node)}`,
      };
      fns.set(decl.key, decl);
      list.push(decl);
      const exact = byQName.get(qname) ?? [];
      exact.push(decl);
      byQName.set(qname, exact);
      const simple = bySimple.get(p.simple) ?? [];
      simple.push(decl);
      bySimple.set(p.simple, simple);
    });
    fnsByFile.set(unit.rel, list);
    collectMembers(unit.root, (n) => {
      const scope = scopeOf(n);
      const name = stripTemplates(norm(n.childForFieldName("name")?.text ?? ""));
      return name ? [...scope.path, name].join("::") : undefined;
    }, members);
  }

  return { units, fns, fnsByFile, byQName, bySimple, members };
}

/** A lock name for a mutex expression. Members of the enclosing class are qualified by that class. */
export function lockIdentity(expr: string, cls: string | undefined, members: Map<string, Set<string>>): string {
  const e = norm(expr).replace(/^[&*]+/, "").replace(/^this->/, "").replace(/->/g, ".");
  if (cls !== undefined && /^[A-Za-z_]\w*$/.test(e) && members.get(cls)?.has(e)) return `${cls}::${e}`;
  return e;
}

export interface EffectEntry {
  kind: string;
}

const CATALOG_FILE = fileURLToPath(new URL("../data/effects.json", import.meta.url));

/** Known system calls, by callee name. The list is data, so a project can read it and extend it. */
export const effectCatalog: Map<string, EffectEntry> = new Map(
  (JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as { callee: string; kind: string }[]).map((e) => [e.callee, { kind: e.kind }]),
);

/** Frees the parse trees. The WASM heap is not garbage collected with the JavaScript objects. */
export function disposeProject(project: Project): void {
  for (const unit of project.units.values()) unit.tree.delete();
}
