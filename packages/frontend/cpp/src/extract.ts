import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";

type Confidence = Provenance["confidence"];
import type { SyntaxNode } from "./parser.js";
import {
  blockOf,
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
type SpawnHow = "thread" | "async";
/** Calls that start a thread or task. `arg` is the argument holding the function, or -1 for the first argument that is not a launch policy. */
const SPAWN_CALLS = new Map<string, { arg: number; how: SpawnHow }>([
  ["std::thread", { arg: 0, how: "thread" }],
  ["std::jthread", { arg: 0, how: "thread" }],
  ["std::async", { arg: -1, how: "async" }],
  ["pthread_create", { arg: 2, how: "thread" }],
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

/** The first argument in a parenthesised or braced argument list, as written. */
function firstArgument(list: string | undefined): string | undefined {
  if (list === undefined) return undefined;
  const inner = list.trim().replace(/^[({]/, "").replace(/[)}]$/, "");
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

/** The named children of an argument list, without comments. */
const namedArgs = (list: SyntaxNode | null | undefined): SyntaxNode[] => (list?.namedChildren ?? []).filter((n) => n.type !== "comment");
const argsOf = (call: SyntaxNode): SyntaxNode[] => namedArgs(call.childForFieldName("arguments"));

/** A set of candidate functions, and how sure the frontend is that one of them is the target. */
interface Resolved {
  targets: FnDecl[];
  confidence: Confidence;
}

/** The candidates, or undefined when there are none or too many to be useful. Several candidates are never more than heuristic. */
function candidatesOf(targets: FnDecl[], confidence: Confidence): Resolved | undefined {
  if (targets.length === 0 || targets.length > MAX_CANDIDATES) return undefined;
  return { targets, confidence: targets.length > 1 ? "heuristic" : confidence };
}

/**
 * Candidates for a name written as an identifier or as a qualified name. A defined qualified name is
 * exact; otherwise it matches the definitions whose qualified name ends with it.
 */
function resolveName(project: Project, name: string, qualified: boolean): Resolved | undefined {
  if (!qualified) return candidatesOf(project.bySimple.get(name) ?? [], "inferred");
  const exact = project.byQName.get(name) ?? [];
  if (exact.length > 0) return candidatesOf(exact, "exact");
  const last = name.split("::").pop() ?? name;
  const suffixed = (project.bySimple.get(last) ?? []).filter((d) => d.qname === name || d.qname.endsWith(`::${name}`));
  return candidatesOf(suffixed, "heuristic");
}

/** Candidate targets for a callee. A qualified name that is defined is exact, an ambiguous name is heuristic. */
function resolveCallee(project: Project, fnNode: SyntaxNode): Resolved | undefined {
  switch (fnNode.type) {
    case "identifier":
      return resolveName(project, stripTemplates(norm(fnNode.text)), false);
    case "template_function":
      return resolveName(project, stripTemplates(norm(fnNode.childForFieldName("name")?.text ?? "")), false);
    case "qualified_identifier":
      return resolveName(project, stripTemplates(norm(fnNode.text)).replace(/^::/, ""), true);
    case "field_expression": {
      const simple = fnNode.childForFieldName("field")?.text;
      if (!simple) return undefined;
      return candidatesOf((project.bySimple.get(simple) ?? []).filter((d) => d.cls !== undefined), "heuristic");
    }
    default:
      return undefined;
  }
}

/**
 * The function name a thread or task start names, past the `&`, casts, `+` and parentheses around it.
 * A lambda names itself. Other expressions name no function, so they give undefined.
 */
function functionNameOf(arg: SyntaxNode): SyntaxNode | undefined {
  let n: SyntaxNode | null = arg;
  while (n) {
    switch (n.type) {
      // A type_identifier is here because `std::thread t(worker);` parses as a parameter whose type is the name.
      case "identifier":
      case "type_identifier":
      case "qualified_identifier":
      case "lambda_expression":
        return n;
      case "template_function":
        n = n.childForFieldName("name");
        break;
      case "pointer_expression":
        // Only `&f` names a function. `*p` does not.
        n = n.childForFieldName("operator")?.text === "&" ? n.childForFieldName("argument") : null;
        break;
      case "unary_expression":
        // `+[]{}` converts a captureless lambda to a function pointer, as pthread_create takes one.
        n = n.childForFieldName("operator")?.text === "+" ? n.childForFieldName("argument") : null;
        break;
      case "cast_expression":
        n = n.childForFieldName("value");
        break;
      case "parenthesized_expression":
        n = n.namedChild(0);
        break;
      default:
        n = null;
    }
  }
  return undefined;
}

const isPrefix = (prefix: string[], path: string[]): boolean => prefix.length <= path.length && prefix.every((s, i) => s === path[i]);

/**
 * The lambda a name refers to, when a variable of this name holds one and is visible at the use. A
 * variable is visible inside its block after its declaration. One at namespace or file scope is visible
 * within its namespaces. The innermost visible variable wins, as in C++ name lookup. An assigned lambda
 * is heuristic: the variable may have been set again.
 */
function boundLambda(project: Project, rel: string, use: SyntaxNode): { decl: FnDecl; confidence: Confidence } | undefined {
  const scopePath = scopeOf(use).path;
  let best: { decl: FnDecl; confidence: Confidence; block: number; declEnd: number } | undefined;
  for (const decl of project.lambdaBindings.get(norm(use.text)) ?? []) {
    const b = decl.binding;
    if (!b || decl.rel !== rel) continue;
    if (b.block) {
      const [start, end] = b.block;
      if (use.startIndex < start || use.endIndex > end || use.startIndex < b.declEnd) continue;
    } else if (!isPrefix(b.scope, scopePath)) {
      continue;
    }
    const block = b.block?.[0] ?? -1;
    if (best && (block < best.block || (block === best.block && b.declEnd <= best.declEnd))) continue;
    best = { decl, confidence: b.assigned ? "heuristic" : "exact", block, declEnd: b.declEnd };
  }
  return best && { decl: best.decl, confidence: best.confidence };
}

/** The function a thread or async target names, when the project defines it or a visible variable holds it. */
function resolveSpawnTarget(project: Project, rel: string, arg: SyntaxNode): { name: SyntaxNode; resolved: Resolved } | undefined {
  const name = functionNameOf(arg);
  if (!name) return undefined;
  if (name.type === "lambda_expression") {
    const decl = project.fns.get(`${rel}|${nodeKey(name)}`);
    return decl ? { name, resolved: { targets: [decl], confidence: "exact" } } : undefined;
  }
  if (name.type === "identifier" || name.type === "type_identifier") {
    const bound = boundLambda(project, rel, name);
    if (bound) return { name, resolved: { targets: [bound.decl], confidence: bound.confidence } };
  }
  const resolved = resolveName(project, stripTemplates(norm(name.text)).replace(/^::/, ""), name.type === "qualified_identifier");
  return resolved ? { name, resolved } : undefined;
}

/** An edge target for a set of candidates: one id, or `candidates` when there are several, as calls.call records them. */
function targetOf(targets: FnDecl[]): NodeId | { candidates: [NodeId, ...NodeId[]] } {
  const [first, ...rest] = [...new Set(targets.map((t) => t.id))] as [NodeId, ...NodeId[]];
  return rest.length === 0 ? first : { candidates: [first, ...rest] };
}

/** True when a call is the operand of a co_await, possibly in parentheses. */
function awaitedBy(call: SyntaxNode): boolean {
  let p: SyntaxNode | null = call.parent;
  while (p?.type === "parenthesized_expression") p = p.parent;
  return p?.type === "co_await_expression";
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

  /**
   * A thread or task start. The spawn node is always recorded with the target text. The spawns edge
   * is added only when the target argument names a function the project defines.
   */
  const spawn = (n: SyntaxNode, container: NodeId, how: SpawnHow, target: string | undefined, targetArg: SyntaxNode | undefined) => {
    const id = ids.take(`${rel}@spawn:${n.startPosition.row}:${n.startPosition.column}`);
    node({
      id,
      facet: "concurrency",
      kind: "concurrency.spawn-thread",
      parent: container,
      attrs: target !== undefined ? { target: target.slice(0, 120) } : {},
      span: spanOf(rel, n),
      provenance: prov,
    });
    const hit = targetArg ? resolveSpawnTarget(project, rel, targetArg) : undefined;
    if (!hit) return;
    for (const t of hit.resolved.targets) if (t.rel !== rel) deps.add(t.rel);
    edge({
      from: id,
      to: targetOf(hit.resolved.targets),
      facet: "concurrency",
      kind: "concurrency.spawns",
      attrs: { how },
      span: spanOf(rel, hit.name),
      provenance: { frontend: FRONTEND_ID, confidence: hit.resolved.confidence },
    });
  };

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

    const spawnCall = SPAWN_CALLS.get(callee);
    if (spawnCall) {
      const targetArg =
        spawnCall.arg === -1 ? args.find((a) => !norm(a.text).startsWith("std::launch")) : args[spawnCall.arg];
      spawn(call, container, spawnCall.how, targetArg?.text, targetArg);
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
        for (const t of resolved.targets) if (t.rel !== rel) deps.add(t.rel);
        const to = targetOf(resolved.targets);
        const span = spanOf(rel, fnNode);
        const provenance: Provenance = { frontend: FRONTEND_ID, confidence: resolved.confidence };
        edge({ from: fn.id, to, facet: "calls", kind: "calls.call", attrs: { callee: callee.slice(0, 200) }, span, provenance });
        // Calling a coroutine creates one. Awaited, the caller waits on it; otherwise the caller starts it and goes on.
        if (resolved.targets.every((t) => project.coroutines.has(t.id))) {
          edge({
            from: fn.id,
            to,
            facet: "concurrency",
            kind: "concurrency.dispatches",
            attrs: { how: awaitedBy(call) ? "await" : "start" },
            span,
            provenance,
          });
        }
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
        // `std::thread t(worker);` parses as a function declaration whose one parameter is the name.
        const params = declarator.childForFieldName("parameters");
        const only = params?.namedChildren[0];
        const nameArg =
          only?.type === "parameter_declaration" && !only.childForFieldName("declarator") ? only.childForFieldName("type") : null;
        spawn(decl, container, "thread", firstArgument(params?.text), nameArg ?? undefined);
      } else if (declarator?.type === "init_declarator") {
        // `std::thread t{f, x}` holds its arguments in an initializer list. `std::thread t{}` starts nothing.
        const value = declarator.childForFieldName("value");
        if (value?.type === "argument_list" || (value?.type === "initializer_list" && namedArgs(value).length > 0)) {
          spawn(decl, container, "thread", firstArgument(value.text), namedArgs(value)[0]);
        }
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
      case "lambda_expression": {
        const decl = project.fns.get(`${rel}|${nodeKey(n)}`);
        if (decl) {
          const span = spanOf(rel, n);
          node({
            id: decl.id,
            facet: "structure",
            kind: "structure.function",
            parent: container,
            attrs: { name: decl.simple, qualifiedName: decl.qname, anonymous: true },
            span,
            provenance: prov,
          });
          // The creator reaches the closure. At module level the creator is the file.
          edge({ from: fn ? fn.id : rel, to: decl.id, facet: "calls", kind: "calls.reference", attrs: { how: "closure" }, span, provenance: prov });
          // Everything in the body belongs to the lambda: its calls, spawns, locks, and any co_await.
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
