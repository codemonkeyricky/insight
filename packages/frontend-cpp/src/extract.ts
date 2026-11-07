import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";

type Confidence = Provenance["confidence"];
import type { SyntaxNode } from "./parser.js";
import {
  effectCatalog,
  FRONTEND_ID,
  lockIdentity,
  nodeKey,
  norm,
  scopeOf,
  stripTemplates,
  type FnDecl,
  type Project,
} from "./project.js";

/** Guard types and whether they hold the lock shared. */
const GUARDS: Record<string, "exclusive" | "shared"> = {
  "std::lock_guard": "exclusive",
  "std::unique_lock": "exclusive",
  "std::scoped_lock": "exclusive",
  "std::shared_lock": "shared",
};
/** Arguments of a guard that do not take the lock. */
const NO_LOCK_ARGS = new Set(["std::defer_lock", "std::try_to_lock", "std::adopt_lock"]);
const THREAD_TYPES = new Set(["std::thread", "std::jthread"]);
/** Calls that start a thread. The value is the argument holding the function, or -1 for the first argument that is not a launch policy. */
const SPAWN_CALLS = new Map<string, number>([
  ["std::thread", 0],
  ["std::jthread", 0],
  ["std::async", -1],
  ["pthread_create", 2],
]);
/** Above this many possible targets, a call is too ambiguous to record. */
const MAX_CANDIDATES = 8;

const pointSpan = (file: string, p: { row: number; column: number }): Span => ({ file, start: [p.row, p.column], end: [p.row, p.column] });
const spanOf = (file: string, n: SyntaxNode): Span => ({
  file,
  start: [n.startPosition.row, n.startPosition.column],
  end: [n.endPosition.row, n.endPosition.column],
});

/** Keeps node IDs unique within one file. Function IDs are reserved first, so they never change. */
class Ids {
  private readonly seen: Set<string>;
  constructor(reserved: Iterable<string>) {
    this.seen = new Set(reserved);
  }
  take(base: string): string {
    let id = base;
    let n = 2;
    while (this.seen.has(id)) id = `${base}~${n++}`;
    this.seen.add(id);
    return id;
  }
}

/** The first argument in a parenthesised argument list, as written. */
function firstArgument(list: string | undefined): string | undefined {
  if (list === undefined) return undefined;
  const inner = list.trim().replace(/^\(/, "").replace(/\)$/, "");
  let depth = 0;
  let out = "";
  for (const ch of inner) {
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim() || undefined;
}

const argsOf = (call: SyntaxNode): SyntaxNode[] => (call.childForFieldName("arguments")?.namedChildren ?? []).filter((n) => n.type !== "comment");

const blockOf = (node: SyntaxNode): SyntaxNode | null => {
  for (let p = node.parent; p; p = p.parent) if (p.type === "compound_statement") return p;
  return null;
};

/** Candidate targets for a callee. A qualified name that is defined is exact, an ambiguous name is heuristic. */
function resolveCallee(project: Project, fnNode: SyntaxNode): { targets: FnDecl[]; confidence: Confidence } | undefined {
  let targets: FnDecl[] = [];
  let confidence: Confidence = "inferred";
  switch (fnNode.type) {
    case "identifier":
    case "template_function": {
      const simple = stripTemplates(norm(fnNode.type === "identifier" ? fnNode.text : (fnNode.childForFieldName("name")?.text ?? "")));
      targets = project.bySimple.get(simple) ?? [];
      break;
    }
    case "qualified_identifier": {
      const qn = stripTemplates(norm(fnNode.text)).replace(/^::/, "");
      targets = project.byQName.get(qn) ?? [];
      if (targets.length > 0) {
        confidence = "exact";
      } else {
        const last = qn.split("::").pop() ?? qn;
        targets = (project.bySimple.get(last) ?? []).filter((d) => d.qname === qn || d.qname.endsWith(`::${qn}`));
        confidence = "heuristic";
      }
      break;
    }
    case "field_expression": {
      const simple = fnNode.childForFieldName("field")?.text;
      if (!simple) return undefined;
      targets = (project.bySimple.get(simple) ?? []).filter((d) => d.cls !== undefined);
      confidence = "heuristic";
      break;
    }
    default:
      return undefined;
  }
  if (targets.length === 0 || targets.length > MAX_CANDIDATES) return undefined;
  if (targets.length > 1) confidence = "heuristic";
  return { targets, confidence };
}

/** Facts for one file, from the project pass. Files with parse errors give inferred facts and a warning. */
export function emitUnit(project: Project, rel: string): IRBatch {
  const unit = project.units.get(rel);
  if (!unit) return { file: rel, records: [] };

  const prov: Provenance = { frontend: FRONTEND_ID, confidence: unit.errors.length > 0 ? "inferred" : "exact" };
  const syncProv: Provenance = { frontend: FRONTEND_ID, confidence: "inferred" };
  const ids = new Ids((project.fnsByFile.get(rel) ?? []).map((d) => d.id));
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const node = (n: IRNode) => records.push({ node: n });
  const edge = (e: IREdge) => records.push({ edge: e });
  const coroutines = new Set<NodeId>();

  const flow = (n: SyntaxNode, tag: string, kind: string, container: NodeId, attrs: Record<string, unknown>) =>
    node({
      id: ids.take(`${rel}@${tag}:${n.startPosition.row}:${n.startPosition.column}`),
      facet: "flow",
      kind,
      parent: container,
      attrs,
      span: spanOf(rel, n),
      provenance: prov,
    });

  const markCoroutine = (n: SyntaxNode, fn: FnDecl | undefined) => {
    if (!fn || coroutines.has(fn.id)) return;
    coroutines.add(fn.id);
    node({
      id: ids.take(`${fn.id}@coroutine`),
      facet: "concurrency",
      kind: "concurrency.coroutine",
      parent: fn.id,
      attrs: { name: fn.simple },
      span: spanOf(rel, n),
      provenance: prov,
    });
  };

  const spawn = (n: SyntaxNode, container: NodeId, target: string | undefined) =>
    node({
      id: ids.take(`${rel}@spawn:${n.startPosition.row}:${n.startPosition.column}`),
      facet: "concurrency",
      kind: "concurrency.spawn-thread",
      parent: container,
      attrs: target !== undefined ? { target: target.slice(0, 120) } : {},
      span: spanOf(rel, n),
      provenance: prov,
    });

  const handleInclude = (n: SyntaxNode) => {
    const path = n.childForFieldName("path");
    if (!path) return;
    const text = path.text.replace(/^["<]|[">]$/g, "");
    const to: UnresolvedRef = { unresolved: { scheme: "cpp.include", text } };
    edge({
      from: rel,
      to,
      facet: "packaging",
      kind: "packaging.include",
      attrs: { text, system: path.type === "system_lib_string" },
      span: spanOf(rel, n),
      provenance: prov,
    });
  };

  const handleCall = (call: SyntaxNode, container: NodeId, fn: FnDecl | undefined) => {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) return;
    const callee = stripTemplates(norm(fnNode.text)).replace(/^::/, "");
    const args = argsOf(call);

    const spawnIndex = SPAWN_CALLS.get(callee);
    if (spawnIndex !== undefined) {
      const target =
        spawnIndex === -1
          ? args.find((a) => !norm(a.text).startsWith("std::launch"))?.text
          : args[spawnIndex]?.text;
      spawn(call, container, target);
    }

    const effect = effectCatalog.get(callee);
    if (effect) {
      node({
        id: ids.take(`${rel}@effect:${call.startPosition.row}:${call.startPosition.column}`),
        facet: "effects",
        kind: effect.kind,
        parent: container,
        attrs: { api: callee },
        span: spanOf(rel, call),
        provenance: prov,
      });
    }

    if (fnNode.type === "field_expression" && args.length === 0) {
      const method = fnNode.childForFieldName("field")?.text;
      const recv = fnNode.childForFieldName("argument")?.text;
      if (recv !== undefined && (method === "lock" || method === "unlock")) {
        const lock = lockIdentity(recv, scopeOf(call).cls ?? fn?.cls, project.members);
        node({
          id: ids.take(`${rel}@${method}:${call.startPosition.row}:${call.startPosition.column}`),
          facet: "sync",
          kind: method === "lock" ? "sync.lock-acquire" : "sync.lock-release",
          parent: container,
          attrs: method === "lock" ? { lock, mode: "exclusive", api: "lock" } : { lock, api: "unlock" },
          span: spanOf(rel, call),
          provenance: syncProv,
        });
      }
    }

    if (fn) {
      const resolved = resolveCallee(project, fnNode);
      if (resolved) {
        const targets = resolved.targets.map((t) => t.id);
        for (const t of resolved.targets) if (t.rel !== rel) deps.add(t.rel);
        const [first, ...rest] = targets as [NodeId, ...NodeId[]];
        edge({
          from: fn.id,
          to: rest.length === 0 ? first : { candidates: [first, ...rest] },
          facet: "calls",
          kind: "calls.call",
          attrs: { callee: callee.slice(0, 200) },
          span: spanOf(rel, fnNode),
          provenance: { frontend: FRONTEND_ID, confidence: resolved.confidence },
        });
      }
    }
  };

  const handleDeclaration = (decl: SyntaxNode, container: NodeId, fn: FnDecl | undefined) => {
    const typeNode = decl.childForFieldName("type");
    const base = stripTemplates(norm(typeNode?.text ?? ""));
    const declarator = decl.childForFieldName("declarator");

    // `std::thread t(f, x)` parses as a declaration whose parameter list holds the arguments. A
    // `std::thread(f)` expression is a call, and handleCall records it.
    // Inside a function body the same text parses as an init_declarator whose value is an
    // argument_list, so both shapes are read.
    if (THREAD_TYPES.has(base)) {
      if (declarator?.type === "function_declarator") {
        spawn(decl, container, firstArgument(declarator.childForFieldName("parameters")?.text));
      } else if (declarator?.type === "init_declarator") {
        const value = declarator.childForFieldName("value");
        if (value?.type === "argument_list") spawn(decl, container, firstArgument(value.text));
      }
    }

    const mode = GUARDS[base];
    if (mode === undefined || declarator?.type !== "function_declarator") return;
    const params = (declarator.childForFieldName("parameters")?.namedChildren ?? []).filter((p) => p.type !== "comment");
    const locks = params.map((p) => p.text).filter((t) => !NO_LOCK_ARGS.has(norm(t)));
    const block = blockOf(decl);
    // An out-of-line definition (void Store::put) has no class in its scope; its name carries it.
    const cls = scopeOf(decl).cls ?? fn?.cls;
    locks.forEach((arg, i) => {
      const lock = lockIdentity(arg, cls, project.members);
      node({
        id: ids.take(`${rel}@guard:${decl.startPosition.row}:${decl.startPosition.column}:${i}`),
        facet: "sync",
        kind: "x-cpp.scoped-lock",
        parent: container,
        attrs: { lock, mode, api: base },
        span: spanOf(rel, decl),
        provenance: syncProv,
      });
      if (block) {
        node({
          id: ids.take(`${rel}@release:${block.endPosition.row}:${block.endPosition.column}:${i}`),
          facet: "sync",
          kind: "sync.lock-release",
          parent: container,
          attrs: { lock, api: base },
          span: pointSpan(rel, block.endPosition),
          provenance: syncProv,
        });
      }
    });
  };

  const visit = (n: SyntaxNode, container: NodeId, fn: FnDecl | undefined): void => {
    let nextContainer = container;
    let nextFn = fn;

    switch (n.type) {
      case "preproc_include":
        handleInclude(n);
        break;
      case "namespace_definition": {
        const name = n.childForFieldName("name")?.text ?? "(anonymous)";
        const id = ids.take(`${rel}#namespace:${name}@${n.startPosition.row + 1}`);
        node({ id, facet: "structure", kind: "structure.namespace", parent: container, attrs: { name }, span: spanOf(rel, n), provenance: prov });
        nextContainer = id;
        break;
      }
      case "class_specifier":
      case "struct_specifier": {
        const nameNode = n.childForFieldName("name");
        if (nameNode && nameNode.text.trim() !== "" && n.childForFieldName("body")) {
          const qname = [...scopeOf(n).path, stripTemplates(norm(nameNode.text))].join("::");
          const id = ids.take(`${rel}#${qname}`);
          node({
            id,
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: stripTemplates(norm(nameNode.text)), typeKind: n.type === "class_specifier" ? "class" : "struct" },
            span: spanOf(rel, n),
            provenance: prov,
          });
          nextContainer = id;
        }
        break;
      }
      case "enum_specifier": {
        const nameNode = n.childForFieldName("name");
        // Anonymous enums (and error-recovery nodes with empty text) have no usable name; skip them.
        if (nameNode && nameNode.text.trim() !== "" && n.childForFieldName("body")) {
          node({
            id: ids.take(`${rel}#enum:${[...scopeOf(n).path, nameNode.text].join("::")}`),
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: nameNode.text, typeKind: "enum" },
            span: spanOf(rel, n),
            provenance: prov,
          });
        }
        break;
      }
      case "alias_declaration": {
        const nameNode = n.childForFieldName("name");
        if (nameNode) {
          node({
            id: ids.take(`${rel}#alias:${[...scopeOf(n).path, nameNode.text].join("::")}`),
            facet: "structure",
            kind: "structure.type",
            parent: container,
            attrs: { name: nameNode.text, typeKind: "alias" },
            span: spanOf(rel, n),
            provenance: prov,
          });
        }
        break;
      }
      case "function_definition": {
        const decl = project.fns.get(`${rel}|${nodeKey(n)}`);
        if (decl) {
          node({
            id: decl.id,
            facet: "structure",
            kind: "structure.function",
            parent: container,
            attrs: { name: decl.simple, qualifiedName: decl.qname, exported: decl.exported },
            span: spanOf(rel, n),
            provenance: prov,
          });
          nextContainer = decl.id;
          nextFn = decl;
        }
        break;
      }
      case "call_expression":
        handleCall(n, container, fn);
        break;
      case "declaration":
        handleDeclaration(n, container, fn);
        break;
      case "if_statement":
        flow(n, "if", "flow.branch", container, { condition: (n.childForFieldName("condition")?.text ?? "").slice(0, 200) });
        break;
      case "conditional_expression":
        flow(n, "cond", "flow.branch", container, { condition: (n.childForFieldName("condition")?.text ?? "").slice(0, 200) });
        break;
      case "switch_statement": {
        const body = n.childForFieldName("body");
        const hasDefault = body?.namedChildren.some((c) => c.type === "case_statement" && !c.childForFieldName("value")) ?? false;
        flow(n, "switch", "flow.switch", container, { hasDefault });
        break;
      }
      case "for_statement":
        flow(n, "loop", "flow.loop", container, { variant: "for" });
        break;
      case "for_range_loop":
        flow(n, "loop", "flow.loop", container, { variant: "for-of" });
        break;
      case "while_statement":
        flow(n, "loop", "flow.loop", container, { variant: "while" });
        break;
      case "do_statement":
        flow(n, "loop", "flow.loop", container, { variant: "do" });
        break;
      case "try_statement":
        flow(n, "try", "flow.try", container, { hasFinally: false });
        break;
      case "throw_statement":
        flow(n, "throw", "flow.throw", container, {});
        break;
      case "co_await_expression":
        node({
          id: ids.take(`${rel}@await:${n.startPosition.row}:${n.startPosition.column}`),
          facet: "concurrency",
          kind: "concurrency.await",
          parent: container,
          attrs: {},
          span: spanOf(rel, n),
          provenance: prov,
        });
        markCoroutine(n, fn);
        break;
      case "co_return_statement":
      case "co_yield_statement":
        markCoroutine(n, fn);
        break;
      default:
        break;
    }

    for (const child of n.namedChildren) visit(child, nextContainer, nextFn);
  };

  visit(unit.root, rel, undefined);

  if (unit.errors.length > 0) {
    const first = unit.errors[0] as SyntaxNode;
    const finding: IRFinding = {
      severity: "warning",
      message: `parse errors in ${unit.errors.length} place(s); facts from this file are inferred and may be incomplete`,
      span: spanOf(rel, first),
      provenance: { frontend: FRONTEND_ID, confidence: "exact" },
    };
    records.push({ finding });
  }

  return { file: rel, records, dependsOn: [...deps].sort() };
}
