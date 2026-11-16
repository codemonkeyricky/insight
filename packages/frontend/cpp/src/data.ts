import type { IREdge, IRNode, NodeId, Provenance, Span } from "@insight/ir";
import type { SyntaxNode } from "./parser.js";
import { baseTypeOf, functionDeclarator, nodeKey, norm, normName, ownerOf, scopeOf, stripTemplates, type FnDecl, type Project } from "./project.js";

/**
 * Data facts: variables with storage (data.variable), and the reads and writes of them (data.read, data.write).
 * A variable is found through a project-wide declaration index, so a use resolves to the definition in another
 * file. A local or parameter shadows the variable only where it is in scope: in its own block from its declaration on,
 * or inside its lambda or loop. Writes that are heuristic (a mutating method, a write through a subscript or member,
 * an address taken) carry heuristic provenance.
 */

export interface DataOutput {
  nodes: IRNode[];
  edges: IREdge[];
}

type Storage = "global" | "file-static" | "function-static" | "class-static" | "extern-decl";

interface VarDef {
  id: NodeId;
  rel: string;
  /** Qualified name without the file: `ns::name`, `Class::name`, or `fn::name` for a function-static. */
  qname: string;
  name: string;
  storage: Storage;
  exported: boolean;
  mutable: boolean;
  type?: string;
  parent: NodeId;
  decl: SyntaxNode;
}

interface DataIndex {
  /** Variables outside functions, by qualified name. Function-statics are not here: they are found by their function. */
  byQName: Map<string, VarDef[]>;
  /** Function-statics, by the function's node key, then by name. */
  byFn: Map<string, Map<string, VarDef>>;
  /** Every variable, in document order within each file. */
  defs: VarDef[];
  /** Function and lambda definitions by node key, so a callee's parameters can be read. */
  fnNodes: Map<string, SyntaxNode>;
}

/** Methods that change their receiver. A call to one of these on a variable is a mutate write. */
const MUTATORS = new Set([
  "push_back", "push_front", "push", "emplace", "emplace_back", "emplace_front", "emplace_hint", "insert", "insert_or_assign",
  "try_emplace", "erase", "clear", "pop", "pop_back", "pop_front", "assign", "resize", "reserve", "swap", "sort", "store",
  "fetch_add", "fetch_sub", "exchange",
]);

const FUNCTION_TYPES = new Set(["function_definition", "lambda_expression"]);

const indexCache = new WeakMap<Project, DataIndex>();
const sameNode = (a: SyntaxNode | null | undefined, b: SyntaxNode): boolean => a !== null && a !== undefined && nodeKey(a) === nodeKey(b);
const isField = (parent: SyntaxNode, field: string, child: SyntaxNode): boolean => sameNode(parent.childForFieldName(field), child);
const spanOf = (rel: string, n: SyntaxNode): Span => ({ file: rel, start: [n.startPosition.row, n.startPosition.column], end: [n.endPosition.row, n.endPosition.column] });
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

function walk(node: SyntaxNode, visit: (n: SyntaxNode) => void): void {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
}

const hasStorage = (n: SyntaxNode, text: string): boolean => n.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === text);
/** `const` or `constexpr` on the declaration's type. */
const isConstQualified = (n: SyntaxNode): boolean =>
  n.namedChildren.some((c) => (c.type === "type_qualifier" || c.type === "storage_class_specifier") && (c.text === "const" || c.text === "constexpr"));

/** The node types a declarator ends in: a plain name, or a member name in a field declaration. */
const NAME_TYPES = new Set(["identifier", "field_identifier"]);

/** The identifier a declarator declares, or undefined for a function prototype or an out-of-line qualified name. */
function nameNodeOf(d: SyntaxNode): SyntaxNode | undefined {
  let c: SyntaxNode | null | undefined = d;
  while (c && !NAME_TYPES.has(c.type)) {
    if (c.type === "function_declarator" || c.type === "qualified_identifier") return undefined;
    c = c.childForFieldName("declarator") ?? c.namedChildren.find((x) => x.type.endsWith("_declarator") || NAME_TYPES.has(x.type)) ?? null;
  }
  return c ?? undefined;
}

/** A declarator with no pointer or reference wrapper: `int x`, `int x[3]`, `int x = 1`. */
function isPlainDeclarator(d: SyntaxNode): boolean {
  let c: SyntaxNode | null | undefined = d;
  while (c && !NAME_TYPES.has(c.type)) {
    if (c.type === "pointer_declarator" || c.type === "reference_declarator") return false;
    c = c.childForFieldName("declarator") ?? c.namedChildren.find((x) => x.type.endsWith("_declarator") || NAME_TYPES.has(x.type)) ?? null;
  }
  return true;
}

/**
 * `const` on a pointer declarator itself (`* const k`): the declared object cannot change, whatever its type says. The
 * declarator chain is followed through arrays and functions to the name.
 */
function hasDeclaratorConst(d: SyntaxNode): boolean {
  let c: SyntaxNode | null | undefined = d;
  while (c && !NAME_TYPES.has(c.type)) {
    if (c.type === "pointer_declarator" && c.namedChildren.some((x) => x.type === "type_qualifier" && x.text === "const")) return true;
    c = c.childForFieldName("declarator") ?? c.namedChildren.find((x) => x.type.endsWith("_declarator") || NAME_TYPES.has(x.type)) ?? null;
  }
  return false;
}

/** The name a declarator declares, through pointer, reference, array and function wrappers. */
function declaredName(d: SyntaxNode | null | undefined): string | undefined {
  let c: SyntaxNode | null | undefined = d;
  while (c && !NAME_TYPES.has(c.type)) {
    c = c.childForFieldName("declarator") ?? (c.type.endsWith("_declarator") ? c.namedChildren.find((x) => x.type.endsWith("_declarator") || NAME_TYPES.has(x.type)) ?? null : null);
  }
  return c?.text;
}

/**
 * Every name a declarator declares: one for a plain declarator, every identifier of a structured binding (`auto [k, v] = …`).
 */
function declaredNames(d: SyntaxNode | null | undefined): string[] {
  let c: SyntaxNode | null | undefined = d;
  while (c && c.type !== "structured_binding_declarator" && !NAME_TYPES.has(c.type)) {
    c = c.childForFieldName("declarator") ?? (c.type.endsWith("_declarator") ? c.namedChildren.find((x) => x.type.endsWith("_declarator") || NAME_TYPES.has(x.type)) ?? null : null);
  }
  if (!c) return [];
  if (c.type === "structured_binding_declarator") return c.namedChildren.filter((x) => x.type === "identifier").map((x) => x.text);
  return [c.text];
}

/**
 * Whether a scope node declares `name` where a use at `before` sees it: a declaration in a block that comes before the use,
 * a for-loop or range-for variable (also a structured binding), a lambda's, function's or catch clause's parameter, or a
 * condition's declaration. A declaration in a nested block is not seen here.
 */
function declaresIn(scope: SyntaxNode, name: string, before: number): boolean {
  // A static or extern local names a variable of the function's index, not a shadow of the global.
  const isShadowDecl = (decl: SyntaxNode): boolean => decl.type === "declaration" && !hasStorage(decl, "static") && !hasStorage(decl, "extern");
  const declaresAmong = (decls: readonly SyntaxNode[]): boolean =>
    decls.some((decl) => isShadowDecl(decl) && decl.startIndex < before && decl.childrenForFieldName("declarator").some((d) => declaredNames(d).includes(name)));
  const paramsDeclare = (params: SyntaxNode | null | undefined): boolean =>
    (params?.namedChildren ?? []).some((p) => (p.type === "parameter_declaration" || p.type === "optional_parameter_declaration") && declaredNames(p.childForFieldName("declarator")).includes(name));
  switch (scope.type) {
    case "compound_statement":
      return declaresAmong(scope.namedChildren);
    case "for_statement": {
      const init = scope.childForFieldName("initializer");
      return init !== null && init.type === "declaration" && declaresAmong([init]);
    }
    case "for_range_loop":
      return declaredNames(scope.childForFieldName("declarator")).includes(name);
    case "catch_clause":
      return paramsDeclare(scope.childForFieldName("parameters"));
    case "lambda_expression":
      return paramsDeclare(scope.childForFieldName("declarator")?.childForFieldName("parameters"));
    case "function_definition":
      return paramsDeclare(functionDeclarator(scope)?.childForFieldName("parameters"));
    case "if_statement":
    case "while_statement":
    case "switch_statement": {
      const cond = scope.childForFieldName("condition");
      return cond !== null && cond.namedChildren.some((c) => isShadowDecl(c) && c.startIndex < before && c.childrenForFieldName("declarator").some((d) => declaredNames(d).includes(name)));
    }
    default:
      return false;
  }
}

/** A declaration at namespace or file scope, not inside a class or function. */
function isNamespaceScope(decl: SyntaxNode): boolean {
  const p = decl.parent;
  if (p?.type === "translation_unit") return true;
  return p?.type === "declaration_list" && (p.parent?.type === "namespace_definition" || p.parent?.type === "linkage_specification");
}

const typeOf = (decl: SyntaxNode): string | undefined => {
  const t = decl.childForFieldName("type");
  return t ? collapse(t.text) : undefined;
};

/** The project-wide index of variables, built once per project. */
function indexOf(project: Project): DataIndex {
  const hit = indexCache.get(project);
  if (hit) return hit;
  const defs: VarDef[] = [];
  const byFn = new Map<string, Map<string, VarDef>>();
  const fnNodes = new Map<string, SyntaxNode>();
  const usedIds = new Map<string, Set<string>>();

  /** An id unique within its file. A second use of the same name gets the line of its declaration. */
  const idFor = (rel: string, base: string, row: number): string => {
    const used = usedIds.get(rel) ?? new Set<string>();
    usedIds.set(rel, used);
    let id = `${rel}#var:${base}`;
    if (used.has(id)) id = `${rel}#var:${base}@${row + 1}`;
    used.add(id);
    return id;
  };

  for (const unit of project.units.values()) {
    const rel = unit.rel;
    walk(unit.root, (n) => {
      if (FUNCTION_TYPES.has(n.type)) {
        const key = `${rel}|${nodeKey(n)}`;
        if (project.fns.has(key)) fnNodes.set(key, n);
        return;
      }
      if (n.type === "declaration") {
        if (n.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === "typedef")) return;
        const ns = isNamespaceScope(n);
        const isStatic = hasStorage(n, "static");
        const isExtern = hasStorage(n, "extern");
        const constQ = isConstQualified(n);
        const type = typeOf(n);
        const scope = scopeOf(n);
        for (const d of n.childrenForFieldName("declarator")) {
          const nameNode = nameNodeOf(d);
          if (!nameNode) continue;
          const name = nameNode.text;
          const mutable = !((constQ && isPlainDeclarator(d)) || hasDeclaratorConst(d));
          const base = { rel, name, mutable, ...(type !== undefined ? { type } : {}), decl: n };
          if (ns) {
            if (isExtern && !(d.type === "init_declarator")) {
              const qname = [...scope.path, name].join("::");
              defs.push({ ...base, id: idFor(rel, qname, n.startPosition.row), qname, storage: "extern-decl", exported: true, parent: rel });
              continue;
            }
            // Internal linkage: `static`, an anonymous namespace, or a const that is not declared extern.
            const internal = isStatic || scope.anon || (constQ && !isExtern);
            const qname = [...scope.path, name].join("::");
            defs.push({
              ...base,
              id: idFor(rel, qname, n.startPosition.row),
              qname,
              storage: internal ? "file-static" : "global",
              exported: !internal,
              parent: rel,
            });
            continue;
          }
          // Inside a function: only a `static` local is a variable here. Other locals are shadows, found by name.
          if (!isStatic) continue;
          const owner = ownerOf(n, project.fns, rel);
          if (!owner) continue;
          const qname = `${owner.qname}::${name}`;
          const def: VarDef = { ...base, id: idFor(rel, qname, n.startPosition.row), qname, storage: "function-static", exported: false, parent: owner.id };
          defs.push(def);
          const locals = byFn.get(owner.key) ?? new Map<string, VarDef>();
          locals.set(name, def);
          byFn.set(owner.key, locals);
        }
      } else if (n.type === "field_declaration") {
        if (!hasStorage(n, "static")) return;
        const scope = scopeOf(n);
        if (scope.cls === undefined) return;
        const type = typeOf(n);
        const constQ = isConstQualified(n);
        for (const d of n.childrenForFieldName("declarator")) {
          const nameNode = nameNodeOf(d);
          if (!nameNode) continue;
          const qname = [...scope.path, nameNode.text].join("::");
          defs.push({
            id: idFor(rel, qname, n.startPosition.row),
            rel,
            qname,
            name: nameNode.text,
            storage: "class-static",
            exported: !scope.anon,
            mutable: !((constQ && isPlainDeclarator(d)) || hasDeclaratorConst(d)),
            ...(type !== undefined ? { type } : {}),
            parent: `${rel}#${scope.path.join("::")}`,
            decl: n,
          });
        }
      }
    });
  }

  // An extern declaration in the same file as its definition is the same variable, so only the definition stays.
  const kept = defs.filter((v) => !(v.storage === "extern-decl" && defs.some((d) => d.rel === v.rel && d.qname === v.qname && d.storage !== "extern-decl")));
  const byQName = new Map<string, VarDef[]>();
  for (const v of kept) {
    if (v.storage === "function-static") continue;
    const list = byQName.get(v.qname) ?? [];
    list.push(v);
    byQName.set(v.qname, list);
  }
  const index: DataIndex = { byQName, byFn, defs: kept, fnNodes };
  indexCache.set(project, index);
  return index;
}

/**
 * The definition a name refers to from file `rel`: a definition visible from there (its own file, or external
 * linkage), else the extern declaration. Ambiguous names resolve to nothing.
 */
function pick(hits: VarDef[], rel: string): VarDef | undefined {
  const visible = hits.filter((h) => h.storage !== "extern-decl" && (h.rel === rel || h.exported));
  if (visible.length > 0) {
    const same = visible.filter((h) => h.rel === rel);
    if (same.length > 0) return same[0];
    return visible.length === 1 ? visible[0] : undefined;
  }
  return hits.find((h) => h.storage === "extern-decl");
}

/** Whether the parameter at `index` of a project function is a non-const lvalue reference. */
function takesNonConstRef(index: DataIndex, decl: FnDecl, at: number): boolean {
  const fnNode = index.fnNodes.get(decl.key);
  if (!fnNode) return false;
  const params = functionDeclarator(fnNode)?.childForFieldName("parameters");
  const list = params?.namedChildren.filter((c) => c.type === "parameter_declaration" || c.type === "optional_parameter_declaration") ?? [];
  const p = list[at];
  if (!p) return false;
  const d = p.childForFieldName("declarator");
  if (!d || d.type !== "reference_declarator" || d.text.startsWith("&&")) return false;
  return !p.namedChildren.some((c) => c.type === "type_qualifier" && c.text === "const");
}

/** The one project function a call names, by name; undefined when the name is ambiguous or unknown. */
function calleeOf(project: Project, call: SyntaxNode): FnDecl | undefined {
  const f = call.childForFieldName("function");
  if (!f) return undefined;
  let cands: FnDecl[] = [];
  if (f.type === "identifier") cands = (project.bySimple.get(f.text) ?? []).filter((d) => d.cls === undefined);
  else if (f.type === "qualified_identifier") cands = project.byQName.get(stripTemplates(normName(f.text)).replace(/^::/, "")) ?? [];
  else if (f.type === "field_expression") cands = (project.bySimple.get(f.childForFieldName("field")?.text ?? "") ?? []).filter((d) => d.cls !== undefined);
  return cands.length === 1 ? cands[0] : undefined;
}

/** Whether an identifier or qualified name is a use of a name, not a declaration, a name in a using, or a label. */
function isUse(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  // A declared name: the declarator field of any declaration, or a wrapped declarator without a field name.
  if (isField(p, "declarator", n)) return false;
  if (p.type.endsWith("declarator") && !isField(p, "value", n)) return false;
  if (isField(p, "name", n)) return false;
  return !["using_declaration", "alias_declaration", "namespace_alias_definition", "template_argument_list", "type_descriptor"].includes(p.type);
}

/**
 * Whether a use at `n` names a local variable or a parameter, not a project variable (`data.variable`), a member, a
 * namespace name or a called function. Walking outward, the first scope that declares the name before the use makes it
 * local; a function-static is a project variable, so it does not. A class or namespace boundary stops the search.
 */
function isLocalUse(index: DataIndex, rel: string, n: SyntaxNode, name: string): boolean {
  if (n.type !== "identifier") return false;
  const callee = n.parent;
  // A function that is called is not a value the condition reads; a member name is not a local.
  if (callee?.type === "call_expression" && isField(callee, "function", n)) return false;
  if (callee?.type === "field_expression" && isField(callee, "field", n)) return false;
  if (!isUse(n)) return false;
  for (let p: SyntaxNode | null = n.parent; p; p = p.parent) {
    if (FUNCTION_TYPES.has(p.type) && index.byFn.get(`${rel}|${nodeKey(p)}`)?.get(name) !== undefined) return false;
    if (declaresIn(p, name, n.startIndex)) return true;
    if (p.type === "translation_unit" || p.type === "namespace_definition" || p.type === "class_specifier" || p.type === "struct_specifier") break;
  }
  return false;
}

/**
 * The distinct local variable names an expression reads, in first-seen order. Locals are parameters and variables declared
 * in scope; globals, data.variable targets, members and called function names are excluded.
 */
export function localReads(project: Project, rel: string, node: SyntaxNode | null | undefined): string[] {
  if (!node) return [];
  const index = indexOf(project);
  const out = new Set<string>();
  const visit = (n: SyntaxNode): void => {
    if (n.type === "qualified_identifier") return;
    if (n.type === "identifier") {
      if (isLocalUse(index, rel, n, n.text)) out.add(n.text);
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return [...out];
}

export function emitData(project: Project, rel: string, provenance: Provenance): DataOutput {
  const unit = project.units.get(rel);
  if (!unit) return { nodes: [], edges: [] };
  const index = indexOf(project);
  const heuristic: Provenance = { frontend: provenance.frontend, confidence: "heuristic" };
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const edgeKeys = new Set<string>();

  for (const v of index.defs) {
    if (v.rel !== rel) continue;
    nodes.push({
      id: v.id,
      facet: "data",
      kind: "data.variable",
      parent: v.parent,
      attrs: {
        name: v.name,
        qualifiedName: v.qname,
        storage: v.storage,
        exported: v.exported,
        mutable: v.mutable,
        ...(v.type !== undefined ? { type: v.type } : {}),
      },
      span: spanOf(rel, v.decl),
      provenance,
    });
  }

  /**
   * How the variable's value is used at this reference: a write (and its kind), a read (undefined). A write through the
   * reference's own elements or members, or a mutating method on them, writes the variable (`state.cache.push_back(x)`,
   * `a.b.c = 1`, `x[i].f = v`); such a write is heuristic.
   */
  const accessOf = (ref: SyntaxNode): { how: "assign" | "update" | "mutate" | "address" } | undefined => {
    let node = ref;
    let p = node.parent;
    // Set once the reference is a link of an element or member chain: a write to the chain then writes the root.
    let deep = false;
    for (;;) {
      while (p?.type === "parenthesized_expression") {
        node = p;
        p = p.parent;
      }
      if (!p) return undefined;
      if (p.type === "assignment_expression" && isField(p, "left", node)) {
        if (deep) return { how: "mutate" };
        return { how: p.childForFieldName("operator")?.text === "=" ? "assign" : "update" };
      }
      if (p.type === "update_expression") return { how: deep ? "mutate" : "update" };
      if (!deep && p.type === "pointer_expression" && p.childForFieldName("operator")?.text === "&") return { how: "address" };
      if (!deep && p.type === "argument_list" && p.parent?.type === "call_expression") {
        const args = p.namedChildren.filter((c) => c.type !== "comment");
        const at = args.findIndex((a) => sameNode(a, node));
        const callee = at >= 0 ? calleeOf(project, p.parent) : undefined;
        if (callee && takesNonConstRef(index, callee, at)) return { how: "address" };
        return undefined;
      }
      if ((p.type === "subscript_expression" || p.type === "field_expression") && isField(p, "argument", node)) {
        const gp = p.parent;
        if (p.type === "field_expression" && gp?.type === "call_expression" && isField(gp, "function", p)) {
          if (MUTATORS.has(p.childForFieldName("field")?.text ?? "")) return { how: "mutate" };
        }
        deep = true;
        node = p;
        p = gp;
        continue;
      }
      return undefined;
    }
  };

  /** The variable a name refers to at this point, or undefined when it is not a project variable. */
  const resolve = (n: SyntaxNode, name: string): VarDef | undefined => {
    const leadingGlobal = name.startsWith("::");
    const bare = name.replace(/^::/, "");
    if (!leadingGlobal && n.type === "identifier") {
      // Walking outwards: a function-static of an enclosing function is visible, and a local declared in a scope that
      // holds this use shadows the global. A declaration in a sibling block does not.
      for (let p = n.parent; p; p = p.parent) {
        if (FUNCTION_TYPES.has(p.type)) {
          const local = index.byFn.get(`${rel}|${nodeKey(p)}`)?.get(bare);
          if (local) return local;
        }
        if (declaresIn(p, bare, n.startIndex)) return undefined;
      }
    }
    const fn = ownerOf(n, project.fns, rel);
    const prefixes: string[][] = [];
    if (!leadingGlobal) {
      if (fn?.cls !== undefined) {
        const c = fn.cls.split("::");
        for (let i = c.length; i >= 1; i--) prefixes.push(c.slice(0, i));
      }
      const s = scopeOf(n).path;
      for (let i = s.length; i >= 0; i--) prefixes.push(s.slice(0, i));
    } else prefixes.push([]);
    for (const p of prefixes) {
      const qn = [...p, bare].join("::");
      const hits = index.byQName.get(qn);
      if (hits) return pick(hits, rel);
      // An instance member of the enclosing class hides a namespace variable of the same name.
      if (!bare.includes("::") && p.length > 0 && project.members.get(p.join("::"))?.has(bare)) return undefined;
    }
    return undefined;
  };

  const consider = (n: SyntaxNode) => {
    if (!isUse(n)) return;
    const name = n.type === "qualified_identifier" ? stripTemplates(normName(n.text)) : n.text;
    const target = resolve(n, name);
    if (!target) return;
    const from = ownerOf(n, project.fns, rel)?.id ?? rel;
    const access = accessOf(n);
    const kind = access ? "data.write" : "data.read";
    const span = spanOf(rel, n);
    const key = `${from}|${target.id}|${kind}|${JSON.stringify(span)}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    const heur = access?.how === "mutate" || access?.how === "address";
    edges.push({
      from,
      to: target.id,
      facet: "data",
      kind,
      attrs: access ? { how: access.how } : {},
      span,
      provenance: heur ? heuristic : provenance,
    });
  };

  const visit = (n: SyntaxNode): void => {
    if (n.type === "identifier" || n.type === "qualified_identifier") {
      // A qualified name is one reference; its parts are not visited again.
      if (n.parent?.type !== "qualified_identifier") consider(n);
      if (n.type === "qualified_identifier") return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(unit.root);

  return { nodes, edges };
}
