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

/** Where a lambda bound to a variable can be named. */
export interface LambdaBinding {
  /** Namespace and class names around the lambda, outermost first. */
  scope: string[];
  /** The block that holds the variable, as start and end offsets. Undefined at namespace, class or file scope. */
  block?: [number, number];
  /** Offset where the declaration or assignment ends. A use before it does not see the variable. */
  declEnd: number;
  /** True when the lambda is assigned to an existing variable rather than declared with it. */
  assigned: boolean;
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
  /** True for a lambda. It has no declaration of its own, so its name comes from the variable it is bound to, or its position. */
  anonymous?: boolean;
  /** For a lambda bound to a variable, where that variable can be named. */
  binding?: LambdaBinding;
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
  /** Functions whose body suspends. A call to one creates a coroutine rather than running it. */
  coroutines: Set<NodeId>;
  /** Lambdas bound to a variable, by the variable's name. Lambdas are kept out of byQName and bySimple, so a call never reaches one. */
  lambdaBindings: Map<string, FnDecl[]>;
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

/** Nodes that make the function around them a coroutine. */
const SUSPENDING = ["co_await_expression", "co_yield_statement", "co_return_statement"];

/**
 * The function a node belongs to: its nearest enclosing definition or lambda that the project records.
 * This is the same rule the emitter uses to find the caller, so both agree on which functions suspend.
 */
function ownerOf(node: SyntaxNode, fns: Map<string, FnDecl>, rel: string): FnDecl | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== "function_definition" && p.type !== "lambda_expression") continue;
    const decl = fns.get(`${rel}|${nodeKey(p)}`);
    if (decl) return decl;
  }
  return undefined;
}

/** The compound statement a node sits in, if any. */
export function blockOf(node: SyntaxNode): SyntaxNode | null {
  for (let p = node.parent; p; p = p.parent) if (p.type === "compound_statement") return p;
  return null;
}

const sameNode = (a: SyntaxNode | null, b: SyntaxNode): boolean => a !== null && nodeKey(a) === nodeKey(b);
const blockRange = (node: SyntaxNode): { block?: [number, number] } => {
  const block = blockOf(node);
  return block ? { block: [block.startIndex, block.endIndex] } : {};
};

/**
 * The variable a lambda is bound to: the whole initializer of a declared name, or the whole right side
 * of an assignment to a name. Anything else, such as an argument or a member, binds none.
 */
function boundTo(lambda: SyntaxNode): ({ name: string; declEnd: number; assigned: boolean } & { block?: [number, number] }) | undefined {
  let value: SyntaxNode = lambda;
  while (value.parent?.type === "parenthesized_expression") value = value.parent;
  const parent = value.parent;
  if (parent?.type === "init_declarator" && sameNode(parent.childForFieldName("value"), value)) {
    const name = parent.childForFieldName("declarator");
    return name?.type === "identifier" ? { name: name.text, ...blockRange(parent), declEnd: parent.endIndex, assigned: false } : undefined;
  }
  if (parent?.type === "assignment_expression" && sameNode(parent.childForFieldName("right"), value)) {
    const name = parent.childForFieldName("left");
    return name?.type === "identifier" ? { name: name.text, ...blockRange(parent), declEnd: parent.endIndex, assigned: true } : undefined;
  }
  return undefined;
}

/** `base` when no function or lambda has it yet, else the same name with the line, then a counter. */
function uniqueId(base: string, line: number, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let id = `${base}@${line}`;
  for (let n = 2; taken.has(id); n++) id = `${base}@${line}~${n}`;
  return id;
}

/**
 * Registers the lambdas of one file, in source order, so an enclosing function or lambda is always
 * registered before the lambdas inside it. A lambda bound to a variable takes that variable's name.
 * Any other is named `λ<line>:<col>`, 1-based as an editor shows positions.
 */
function addLambdas(rel: string, lambdas: SyntaxNode[], fns: Map<string, FnDecl>, list: FnDecl[], bindings: Map<string, FnDecl[]>): void {
  const taken = new Set(list.map((d) => d.id));
  for (const node of lambdas) {
    const enclosing = ownerOf(node, fns, rel);
    const scope = scopeOf(node);
    const bound = boundTo(node);
    const simple = bound?.name ?? `λ${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
    const qname = enclosing ? `${enclosing.qname}.${simple}` : [...scope.path, simple].join("::");
    const cls = scope.cls ?? enclosing?.cls;
    const id = uniqueId(`${rel}#${qname}`, node.startPosition.row + 1, taken);
    taken.add(id);
    const decl: FnDecl = {
      id,
      rel,
      qname,
      simple,
      ...(cls !== undefined ? { cls } : {}),
      exported: false,
      key: `${rel}|${nodeKey(node)}`,
      anonymous: true,
      ...(bound
        ? { binding: { scope: scope.path, ...(bound.block ? { block: bound.block } : {}), declEnd: bound.declEnd, assigned: bound.assigned } }
        : {}),
    };
    fns.set(decl.key, decl);
    list.push(decl);
    if (bound) {
      const same = bindings.get(simple) ?? [];
      same.push(decl);
      bindings.set(simple, same);
    }
  }
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
  const lambdaBindings = new Map<string, FnDecl[]>();

  for (const unit of units.values()) {
    const pending: { node: SyntaxNode; qname: string; simple: string; scope: Scope }[] = [];
    const lambdas: SyntaxNode[] = [];
    walk(unit.root, (node) => {
      if (node.type === "lambda_expression") lambdas.push(node);
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
    addLambdas(unit.rel, lambdas, fns, list, lambdaBindings);
    fnsByFile.set(unit.rel, list);
    collectMembers(unit.root, (n) => {
      const scope = scopeOf(n);
      const name = stripTemplates(norm(n.childForFieldName("name")?.text ?? ""));
      return name ? [...scope.path, name].join("::") : undefined;
    }, members);
  }

  // A call to a coroutine only creates one, and the callee may sit in a file the emitter has not
  // reached, so coroutines are found here, before any file is emitted.
  const coroutines = new Set<NodeId>();
  for (const unit of units.values()) {
    for (const node of unit.root.descendantsOfType(SUSPENDING)) {
      const owner = ownerOf(node, fns, unit.rel);
      if (owner) coroutines.add(owner.id);
    }
  }

  return { units, fns, fnsByFile, byQName, bySimple, members, coroutines, lambdaBindings };
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
