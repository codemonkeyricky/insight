import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import type { SyntaxNode } from "./parser.js";
import {
  declId,
  declName,
  fnBase,
  FRONTEND_ID,
  genNameOf,
  MAX_CANDIDATES,
  moduleDefs,
  nodeKey,
  fileNodeKey,
  qualify,
  resolveCallee,
  subroutineOf,
  varClass,
  type CallTarget,
  type Hdl,
  type Project,
} from "./project.js";

const pt = (p: { row: number; column: number }): [number, number] => [p.row, p.column];
const spanOf = (file: string, n: SyntaxNode): Span => ({ file, start: pt(n.startPosition), end: pt(n.endPosition) });
const rangeOf = (file: string, from: SyntaxNode, to: SyntaxNode): Span => ({ file, start: pt(from.startPosition), end: pt(to.endPosition) });
const clip = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** Process keywords that start a procedural block. */
const PROCESS_TYPES = ["always_construct", "initial_construct", "final_construct"];
/** Definitions that own their own processes, so a module does not count them. */
const OWNER_TYPES = new Set(["module_declaration", "interface_declaration", "program_declaration", "class_declaration", "package_declaration"]);
const processKeyword = (p: SyntaxNode): string =>
  p.type === "always_construct" ? (p.namedChildren.find((c) => c.type === "always_keyword")?.text ?? "always") : p.type === "initial_construct" ? "initial" : "final";

/** Statement wrappers between a process and its body, so the label and the timing control can be found. */
const WRAPPERS = new Set(["statement", "statement_or_null", "statement_item", "procedural_timing_control_statement"]);
/** Sequential and parallel blocks, whose first named child is the label when they have one. */
const BLOCKS = new Set(["seq_block", "par_block"]);

/** The label of a process body `begin : label`, when the body is a labelled block. */
function labelOf(construct: SyntaxNode): string | undefined {
  let cur: SyntaxNode = construct;
  for (;;) {
    const next = cur.namedChildren.find((c) => BLOCKS.has(c.type) || WRAPPERS.has(c.type));
    if (!next) return undefined;
    if (BLOCKS.has(next.type)) {
      const first = next.namedChildren[0];
      return first?.type === "simple_identifier" ? first.text : undefined;
    }
    cur = next;
  }
}

/** The processes directly owned by a module: those not inside a nested definition. */
function ownProcesses(n: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (c: SyntaxNode): void => {
    if (PROCESS_TYPES.includes(c.type)) {
      out.push(c);
      return;
    }
    if (OWNER_TYPES.has(c.type)) return;
    for (const k of c.namedChildren) visit(k);
  };
  for (const k of n.namedChildren) visit(k);
  return out;
}

/**
 * The sensitivity list of a process, such as `posedge clk`, and the first edge signal as its clock.
 * Only the timing control directly in front of the body counts.
 */
function sensitivityOf(construct: SyntaxNode): { list: string[]; clock?: string } {
  let ctl: SyntaxNode | undefined;
  let cur: SyntaxNode | undefined = construct;
  while (cur && !ctl) {
    ctl = cur.namedChildren.find((c) => c.type === "event_control");
    if (!ctl) cur = cur.namedChildren.find((c) => WRAPPERS.has(c.type));
  }
  if (!ctl) return { list: [] };
  if (/^@\s*\(?\s*\*\s*\)?$/.test(ctl.text)) return { list: ["*"] };
  const list: string[] = [];
  let clock: string | undefined;
  for (const e of ctl.descendantsOfType("event_expression")) {
    const expr = e.namedChildren.find((c) => c.type === "expression");
    if (!expr) continue;
    const edge = e.namedChildren.find((c) => c.type === "edge_identifier")?.text;
    const signal = expr.text.replace(/\s+/g, "");
    list.push(edge ? `${edge} ${signal}` : signal);
    if (clock === undefined && (edge === "posedge" || edge === "negedge")) clock = signal;
  }
  return clock === undefined ? { list } : { list, clock };
}

const FS_WRITE = ["$fwrite", "$fdisplay", "$fstrobe", "$fmonitor"];
const FS_READ = ["$readmemh", "$readmemb", "$fread", "$fscanf", "$fgets", "$fgetc"];
const CLOCK = ["$time", "$stime", "$realtime"];
/** System tasks with an effect. `$fopen` is classified by its mode, and `$fclose` has no effect of its own. */
const SYSTEM_EFFECTS = new Map<string, { kind: string; key?: "path" | "command" | "name" }>([
  ...FS_WRITE.map((n) => [n, { kind: "effects.fs.write", key: "path" as const }] as const),
  ...FS_READ.map((n) => [n, { kind: "effects.fs.read", key: "path" as const }] as const),
  ...CLOCK.map((n) => [n, { kind: "effects.clock.read" }] as const),
  ["$system", { kind: "effects.proc.exec", key: "command" }],
  ["$test$plusargs", { kind: "effects.env.read", key: "name" }],
  ["$value$plusargs", { kind: "effects.env.read", key: "name" }],
  ["$getenv", { kind: "effects.env.read", key: "name" }],
]);

/** Loop keywords and the flow variant each one maps to. */
const LOOP_VARIANT: Record<string, string> = { for: "for", foreach: "for-in", while: "while", do: "do", repeat: "while", forever: "while" };

const DPI_FN = "dpi";

/** Where the code being walked sits. */
interface Frame {
  /** Parent for structure nodes and for facts outside any function: the file, a module, a package, a class or a type. */
  container: NodeId;
  /** Name of the nearest enclosing class, package or module, or the class a function is defined out of. Qualifies function ids. */
  scope?: string;
  /** The nearest enclosing module, interface or program. Owns its processes and instances. */
  module?: { name: string; id: NodeId; ords: Map<string, number> };
  /** Generate block labels, outermost first. */
  gen: string[];
  /** The function or process whose body is being walked. Flow, calls and effects belong to it. */
  fn?: NodeId;
}

/** Ports of a module-like definition. A non-ANSI header takes its directions from the body. */
function portsOf(n: SyntaxNode, header: SyntaxNode | undefined): Array<{ name: string; dir?: string }> {
  if (header === undefined) return [];
  if (header.type.includes("nonansi")) {
    const dirs = new Map<string, string>();
    for (const pd of n.descendantsOfType("port_declaration")) {
      const decl = pd.namedChildren.find((c) => c.type.endsWith("_declaration"));
      const dir = decl?.type.replace(/_declaration$/, "");
      if (!decl || !dir) continue;
      for (const id of [...decl.descendantsOfType("list_of_port_identifiers"), ...decl.descendantsOfType("list_of_variable_identifiers")]) {
        for (const s of id.namedChildren) if (s.type === "simple_identifier") dirs.set(s.text, dir);
      }
    }
    const list = header.namedChildren.find((c) => c.type === "list_of_ports");
    return (list?.namedChildren ?? [])
      .filter((c) => c.type === "port")
      .map((p) => p.namedChildren.find((c) => c.type === "simple_identifier")?.text)
      .filter((name): name is string => name !== undefined)
      .map((name) => {
        const dir = dirs.get(name);
        return dir ? { name, dir } : { name };
      });
  }
  let dir = "";
  return (header.namedChildren.find((c) => c.type === "list_of_port_declarations")?.namedChildren ?? [])
    .filter((c) => c.type === "ansi_port_declaration")
    .map((p) => {
      if (p.descendantsOfType("interface_port_header").length > 0) dir = "interface";
      else {
        const d = p.descendantsOfType("port_direction")[0]?.text;
        if (d) dir = d;
      }
      const name = p.childForFieldName("port_name")?.text ?? p.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? "";
      return dir ? { name, dir } : { name };
    })
    .filter((p) => p.name !== "");
}

/** Facts for one file, from the project pass. Files with parse errors get inferred facts and one finding. */
export function emitUnit(project: Project, rel: string): IRBatch {
  const unit = project.units.get(rel);
  if (!unit) return { file: rel, records: [] };

  const prov: Provenance = { frontend: FRONTEND_ID, confidence: unit.errors.length > 0 ? "inferred" : "exact" };
  const heuristic: Provenance = { frontend: FRONTEND_ID, confidence: "heuristic" };
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const ids = unit.ids;
  const node = (n: IRNode): void => {
    records.push({ node: n });
  };
  const edge = (e: IREdge): void => {
    records.push({ edge: e });
  };
  const depend = (file: string): void => {
    if (file !== rel) deps.add(file);
  };
  const basename = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

  const flow = (owner: NodeId, tag: string, kind: string, span: Span, attrs: Record<string, unknown>): void => {
    node({ id: ids.take(`${owner}/${tag}`), facet: "flow", kind, parent: owner, attrs, span, provenance: prov });
  };

  /**
   * A call from the current function, or from the enclosing definition at module level, to what it names.
   * Several matches are candidates. No match is an unresolved reference.
   */
  const emitCall = (f: Frame, at: SyntaxNode, callee: string, name: string, target: CallTarget): void => {
    const from = f.fn ?? f.container;
    const span = spanOf(rel, at);
    const hit = resolveCallee(project, rel, f.scope, name, target);
    if (!hit) {
      const to: UnresolvedRef = { unresolved: { scheme: "sv.call", text: callee } };
      edge({ from, to, facet: "calls", kind: "calls.call", attrs: { callee }, span, provenance: prov });
      return;
    }
    for (const r of hit.refs) depend(r.file);
    const [first, ...rest] = hit.refs.map((r) => r.id) as [NodeId, ...NodeId[]];
    if (rest.length === 0) {
      const provenance: Provenance = { frontend: FRONTEND_ID, confidence: hit.exact ? prov.confidence : "inferred" };
      edge({ from, to: first, facet: "calls", kind: "calls.call", attrs: { callee }, span, provenance });
    } else {
      const to = { candidates: [first, ...rest] as [NodeId, ...NodeId[]] };
      edge({ from, to, facet: "calls", kind: "calls.call", attrs: { callee, ...(hit.truncated ? { truncated: true } : {}) }, span, provenance: heuristic });
    }
  };

  /** A method call written as `this.m()`, `super.m()`, `obj.m()` or a plain `m()` with a method-call body. */
  const methodCall = (f: Frame, n: SyntaxNode): void => {
    const body = n.namedChildren.find((c) => c.type === "method_call_body");
    const nameNode = body?.childForFieldName("name");
    if (!body || !nameNode || !body.text.includes("(")) return;
    const name = nameNode.text;
    const receiver = n.namedChildren.find((c) => c.type === "implicit_class_handle")?.text.trim();
    if (receiver === "this") {
      emitCall(f, nameNode, `this.${name}`, name, f.scope !== undefined ? { kind: "member", cls: f.scope } : { kind: "none" });
      return;
    }
    if (receiver === "super") {
      const base = f.scope !== undefined ? project.bases.get(f.scope) : undefined;
      emitCall(f, nameNode, `super.${name}`, name, base ? { kind: "member", cls: base.name } : { kind: "none" });
      return;
    }
    const primary = n.namedChildren.find((c) => c.type === "primary")?.text.trim();
    if (primary === undefined) {
      emitCall(f, nameNode, name, name, { kind: "plain" });
      return;
    }
    // `pkg::f()` parses as a method call on `pkg`. Only the separator tells a scope from an object.
    const head = n.text.slice(0, body.startIndex - n.startIndex);
    if (head.includes("::")) {
      emitCall(f, nameNode, `${primary}::${name}`, name, /^[A-Za-z_]\w*$/.test(primary) ? { kind: "scoped", scope: primary } : { kind: "none" });
      return;
    }
    const cls = /^[A-Za-z_]\w*$/.test(primary) ? varClass(project, rel, f.scope, primary) : undefined;
    emitCall(f, nameNode, `${primary}.${name}`, name, cls !== undefined ? { kind: "member", cls } : { kind: "none" });
  };

  /** A plain call such as f(x), a scoped call pkg::f(x), or a method call through a variable, obj.m(x). System tasks are not calls. */
  const tfCall = (f: Frame, n: SyntaxNode): void => {
    const hi = n.namedChildren.find((c) => c.type === "hierarchical_identifier");
    if (!hi) return;
    const text = hi.text.replace(/\s+/g, "");
    if (text.includes("::")) {
      const parts = text.split("::");
      const name = parts[parts.length - 1] ?? text;
      const scope = parts.length === 2 ? parts[0] : undefined;
      emitCall(f, hi, text, name, scope !== undefined ? { kind: "scoped", scope } : { kind: "none" });
      return;
    }
    const parts = text.split(".");
    const name = parts[parts.length - 1] ?? text;
    if (parts.length === 1) {
      emitCall(f, hi, name, name, { kind: "plain" });
      return;
    }
    const recv = parts[0] ?? "";
    const cls = parts.length === 2 ? varClass(project, rel, f.scope, recv) : undefined;
    emitCall(f, hi, text, name, cls !== undefined ? { kind: "member", cls } : { kind: "none" });
  };

  /** A system task: an effect when it is in the catalog, otherwise nothing. */
  const systemCall = (f: Frame, n: SyntaxNode): void => {
    const name = n.namedChildren.find((c) => c.type === "system_tf_identifier")?.text;
    if (!name) return;
    const args = n.namedChildren.find((c) => c.type === "list_of_arguments")?.namedChildren ?? [];
    const literalOf = (e: SyntaxNode | undefined): string | undefined => {
      const t = e?.text;
      return t !== undefined && t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : undefined;
    };
    const attrs: Record<string, unknown> = { api: name };
    let kind: string | undefined;
    let key: "path" | "command" | "name" | undefined;
    if (name === "$fopen") {
      // IEEE 1800: no mode opens a multichannel descriptor for writing. A literal mode that
      // starts with r and has no + reads; any other mode (w, a, r+) writes. A non-literal mode
      // is unknown and keeps the read classification.
      const mode = literalOf(args[1]);
      if (args.length < 2) kind = "effects.fs.write";
      else if (mode === undefined) kind = "effects.fs.read";
      else kind = /^r/.test(mode) && !mode.includes("+") ? "effects.fs.read" : "effects.fs.write";
      key = "path";
      if (mode !== undefined) attrs.mode = mode;
    } else {
      const spec = SYSTEM_EFFECTS.get(name);
      if (!spec) return;
      kind = spec.kind;
      key = spec.key;
    }
    if (kind === undefined) return;
    const literal = literalOf(args[0]);
    if (key !== undefined && literal !== undefined) attrs[key] = literal;
    node({
      id: ids.take(`${f.fn ?? f.container}/effect`),
      facet: "effects",
      kind,
      parent: f.fn ?? f.container,
      attrs,
      span: spanOf(rel, n),
      provenance: prov,
    });
  };

  /** Flow for an if chain. Each else-if is a nested branch in the else arm of the one before it. */
  const branchChain = (n: SyntaxNode, owner: NodeId): void => {
    const items = n.namedChildren.filter((c) => c.type === "cond_predicate" || c.type === "statement_or_null");
    let i = 0;
    while (i < items.length) {
      const pred = items[i];
      if (!pred || pred.type !== "cond_predicate") break;
      const then = items[i + 1];
      const after = items[i + 2];
      const elseStmt = after?.type === "statement_or_null" ? after : undefined;
      const chained = after?.type === "cond_predicate" ? after : undefined;
      const span = i === 0 ? spanOf(rel, n) : rangeOf(rel, pred, n);
      flow(owner, "branch", "flow.branch", span, { condition: clip(pred.text, 200) });
      if (then?.type === "statement_or_null") flow(owner, "arm", "flow.branch-arm", spanOf(rel, then), { label: "then" });
      if (elseStmt) flow(owner, "arm", "flow.branch-arm", spanOf(rel, elseStmt), { label: "else" });
      else if (chained) flow(owner, "arm", "flow.branch-arm", rangeOf(rel, chained, n), { label: "else" });
      if (!chained) break;
      i += 2;
    }
  };

  const visitChildren = (n: SyntaxNode, f: Frame): void => {
    for (const c of n.namedChildren) visit(c, f);
  };

  const visit = (n: SyntaxNode, f: Frame): void => {
    switch (n.type) {
      case "module_declaration":
      case "interface_declaration":
      case "program_declaration": {
        const name = declName(n);
        if (!name) break;
        const id = project.idOf.get(fileNodeKey(rel, n)) ?? ids.take(declId(rel, name));
        const hdl: Hdl = n.type === "interface_declaration" ? "interface" : n.type === "program_declaration" ? "program" : "module";
        const header = n.namedChildren.find((c) => c.type.endsWith("_header"));
        const params = (header?.namedChildren.find((c) => c.type === "parameter_port_list")?.descendantsOfType(["param_assignment", "type_assignment"]) ?? [])
          .map((a) => a.namedChildren.find((c) => c.type === "simple_identifier")?.text)
          .filter((p): p is string => p !== undefined);
        const ports = portsOf(n, header);
        // Every process of a module gets its ordinal per keyword, in source order, generate blocks included.
        const ords = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const p of ownProcesses(n)) {
          const kw = processKeyword(p);
          const c = (counts.get(kw) ?? 0) + 1;
          counts.set(kw, c);
          ords.set(nodeKey(p), c);
        }
        // A module is a structure.type. Its typeKind is struct for module and program, since the schema has no hardware kind.
        const typeKind = hdl === "interface" ? "interface" : "struct";
        node({
          id,
          facet: "structure",
          kind: "structure.type",
          parent: f.container,
          attrs: { name, typeKind, hdl, params, ports },
          span: spanOf(rel, n),
          provenance: prov,
        });
        visitChildren(n, { container: id, scope: name, module: { name, id, ords }, gen: [] });
        break;
      }
      case "package_declaration": {
        const name = declName(n);
        if (!name) break;
        const id = project.idOf.get(fileNodeKey(rel, n)) ?? ids.take(declId(rel, name));
        node({ id, facet: "structure", kind: "structure.module", parent: f.container, attrs: { name, hdl: "package" }, span: spanOf(rel, n), provenance: prov });
        visitChildren(n, { container: id, scope: name, gen: [] });
        break;
      }
      case "class_declaration": {
        const name = declName(n);
        if (!name) break;
        const id = project.idOf.get(fileNodeKey(rel, n)) ?? ids.take(declId(rel, name));
        node({
          id,
          facet: "structure",
          kind: "structure.type",
          parent: f.container,
          attrs: { name, typeKind: "class", hdl: "class", params: [], ports: [] },
          span: spanOf(rel, n),
          provenance: prov,
        });
        visitChildren(n, { container: id, scope: name, gen: [] });
        break;
      }
      case "function_declaration":
      case "task_declaration":
      case "class_constructor_declaration": {
        const sub = subroutineOf(n);
        if (!sub) break;
        const scope = sub.scope ?? f.scope;
        const id = project.idOf.get(fileNodeKey(rel, n)) ?? ids.take(fnBase(rel, scope, f.gen, sub.name));
        node({
          id,
          facet: "structure",
          kind: "structure.function",
          parent: f.container,
          attrs: { name: qualify(scope, ...f.gen, sub.name), hdl: sub.hdl },
          span: spanOf(rel, n),
          provenance: prov,
        });
        visitChildren(n, { ...f, fn: id, scope });
        break;
      }
      case "always_construct":
      case "initial_construct":
      case "final_construct": {
        const keyword = processKeyword(n);
        const label = labelOf(n);
        const prefix = [f.module?.name ?? basename, ...f.gen].join(".");
        const ord = f.module?.ords.get(nodeKey(n)) ?? 1;
        const name = label ? `${prefix}.${label}` : `${prefix}.${keyword}#${ord}`;
        const { list, clock } = sensitivityOf(n);
        const id = ids.take(`${rel}#${name}`);
        node({
          id,
          facet: "structure",
          kind: "structure.function",
          parent: f.module?.id ?? f.container,
          attrs: {
            name,
            hdl: "process",
            process: keyword,
            ...(list.length > 0 ? { sensitivity: list } : {}),
            ...(clock !== undefined ? { clock } : {}),
          },
          span: spanOf(rel, n),
          provenance: clock !== undefined ? heuristic : prov,
        });
        visitChildren(n, { ...f, fn: id });
        break;
      }
      case "dpi_import_export": {
        const id = project.idOf.get(fileNodeKey(rel, n));
        if (id === undefined) break;
        const proto = n.descendantsOfType(["function_prototype", "task_prototype"])[0];
        const name = proto?.childForFieldName("name")?.text ?? proto?.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? "";
        const scope = f.scope;
        node({
          id,
          facet: "structure",
          kind: "structure.function",
          parent: f.container,
          attrs: { name: qualify(scope, ...f.gen, name), hdl: proto?.type === "task_prototype" ? "task" : "function", dpi: true },
          span: spanOf(rel, n),
          provenance: prov,
        });
        node({
          id: ids.take(`${id}/${DPI_FN}`),
          facet: "effects",
          kind: "effects.unknown",
          parent: id,
          attrs: { api: name },
          span: spanOf(rel, n),
          provenance: prov,
        });
        break;
      }
      case "module_instantiation": {
        const type = n.childForFieldName("instance_type")?.text;
        if (!type) break;
        const modName = f.module?.name ?? basename;
        const defs = moduleDefs(project, type);
        for (const hi of n.namedChildren.filter((c) => c.type === "hierarchical_instance")) {
          const inst = hi.namedChildren.find((c) => c.type === "name_of_instance")?.childForFieldName("instance_name")?.text;
          if (!inst) continue;
          const local = f.gen.length > 0 ? `${f.gen.join(".")}.${inst}` : inst;
          const id = ids.take(`${rel}#${modName}/${local}`);
          node({
            id,
            facet: "structure",
            kind: "x-sv.instance",
            parent: f.container,
            attrs: { name: inst, module: type, ...(f.gen.length > 0 ? { generate: f.gen.join(".") } : {}) },
            span: spanOf(rel, hi),
            provenance: prov,
          });
          const span = spanOf(rel, hi);
          const attrs = { instance: inst };
          const from = f.container;
          const [first, ...rest] = defs.map((d) => d.id) as NodeId[];
          if (first === undefined) {
            edge({ from, to: { unresolved: { scheme: "sv.module", text: type } }, facet: "structure", kind: "x-sv.instantiates", attrs, span, provenance: prov });
          } else if (rest.length === 0) {
            for (const d of defs) depend(d.file);
            edge({ from, to: first, facet: "structure", kind: "x-sv.instantiates", attrs, span, provenance: { frontend: FRONTEND_ID, confidence: "exact" } });
          } else {
            for (const d of defs) depend(d.file);
            const cands = [...defs.map((d) => d.id)].sort().slice(0, MAX_CANDIDATES) as [NodeId, ...NodeId[]];
            edge({ from, to: { candidates: cands }, facet: "structure", kind: "x-sv.instantiates", attrs, span, provenance: heuristic });
          }
        }
        break;
      }
      case "package_import_declaration": {
        for (const item of n.namedChildren.filter((c) => c.type === "package_import_item")) {
          const pkg = item.namedChildren.find((c) => c.type === "simple_identifier")?.text;
          if (!pkg) continue;
          const decl = project.decls.get(pkg);
          const isPkg = decl !== undefined && decl.hdl === "package";
          if (isPkg) depend(decl.file);
          const to: NodeId | UnresolvedRef = isPkg ? decl.id : { unresolved: { scheme: "sv.package", text: pkg } };
          edge({
            from: f.container,
            to,
            facet: "packaging",
            kind: "packaging.import",
            attrs: { specifier: pkg },
            span: spanOf(rel, item),
            provenance: isPkg ? { frontend: FRONTEND_ID, confidence: "exact" } : prov,
          });
        }
        break;
      }
      case "include_compiler_directive": {
        const m = /"([^"]*)"/.exec(n.text);
        if (!m) break;
        const text = m[1] ?? "";
        const to: UnresolvedRef = { unresolved: { scheme: "sv.include", text } };
        edge({ from: rel, to, facet: "packaging", kind: "packaging.include", attrs: { text }, span: spanOf(rel, n), provenance: prov });
        break;
      }
      case "conditional_statement": {
        if (f.fn) branchChain(n, f.fn);
        visitChildren(n, f);
        break;
      }
      case "case_statement": {
        const items = n.namedChildren.filter((c) => c.type === "case_item" || c.type === "case_inside_item");
        const isDefault = (it: SyntaxNode): boolean =>
          it.type === "case_item" ? !it.namedChildren.some((c) => c.type === "case_item_expression") : !it.namedChildren.some((c) => c.type === "range_list");
        if (f.fn) {
          flow(f.fn, "switch", "flow.switch", spanOf(rel, n), { hasDefault: items.some(isDefault) });
          for (const it of items) {
            const label = isDefault(it)
              ? "default"
              : clip(
                  it.type === "case_item"
                    ? it.namedChildren
                        .filter((c) => c.type === "case_item_expression")
                        .map((c) => c.text)
                        .join(", ")
                    : (it.namedChildren.find((c) => c.type === "range_list")?.text ?? ""),
                  120,
                );
            flow(f.fn, "arm", "flow.branch-arm", spanOf(rel, it), { label });
          }
        }
        visitChildren(n, f);
        break;
      }
      case "loop_statement": {
        const kw = /^(foreach|for|while|do|repeat|forever)\b/.exec(n.text)?.[1] ?? "while";
        if (f.fn) {
          const expr = n.namedChildren.find((c) => c.type === "expression")?.text;
          const condition =
            kw === "forever"
              ? "forever"
              : kw === "foreach"
                ? n.namedChildren.find((c) => c.type === "hierarchical_identifier")?.text
                : kw === "repeat" && expr !== undefined
                  ? `repeat (${expr})`
                  : expr;
          flow(f.fn, "loop", "flow.loop", spanOf(rel, n), {
            variant: LOOP_VARIANT[kw] ?? "while",
            ...(condition !== undefined ? { condition: clip(condition, 200) } : {}),
          });
          const body = n.namedChildren.filter((c) => c.type === "statement_or_null" || c.type === "statement").pop();
          if (body) flow(f.fn, "body", "flow.block", spanOf(rel, body), { label: "body" });
        }
        visitChildren(n, f);
        break;
      }
      case "jump_statement": {
        const kw = /^(return|break|continue)\b/.exec(n.text)?.[1];
        if (f.fn && kw !== undefined) {
          if (kw === "return") flow(f.fn, "return", "flow.return", spanOf(rel, n), {});
          else flow(f.fn, "jump", "flow.jump", spanOf(rel, n), { variant: kw });
        }
        visitChildren(n, f);
        break;
      }
      case "disable_statement": {
        // `disable name` leaves a named block; `disable fork` leaves the fork. Both end the enclosing region, so they are a break.
        if (f.fn) {
          const target = clip(n.text.replace(/^disable\b/, "").replace(/;$/, ""), 120);
          flow(f.fn, "jump", "flow.jump", spanOf(rel, n), { variant: "break", ...(target !== "" ? { label: target } : {}) });
        }
        visitChildren(n, f);
        break;
      }
      case "method_call":
        methodCall(f, n);
        visitChildren(n, f);
        break;
      case "tf_call":
        tfCall(f, n);
        visitChildren(n, f);
        break;
      case "system_tf_call":
        systemCall(f, n);
        visitChildren(n, f);
        break;
      case "generate_block": {
        const name = genNameOf(n);
        visitChildren(n, name ? { ...f, gen: [...f.gen, name] } : f);
        break;
      }
      default:
        visitChildren(n, f);
    }
  };

  // Definitions the grammar could not parse, found by text. They are structure only; their bodies are unknown.
  for (const s of unit.scanned) {
    const span: Span = { file: rel, start: [s.line, 0], end: [s.line, s.length] };
    if (s.hdl === "package") {
      node({ id: s.id, facet: "structure", kind: "structure.module", parent: rel, attrs: { name: s.name, hdl: "package" }, span, provenance: heuristic });
    } else {
      node({
        id: s.id,
        facet: "structure",
        kind: "structure.type",
        parent: rel,
        attrs: { name: s.name, typeKind: s.hdl === "interface" ? "interface" : "struct", hdl: s.hdl, params: [], ports: [] },
        span,
        provenance: heuristic,
      });
    }
  }

  visit(unit.root, { container: rel, gen: [] });

  if (unit.errors.length > 0) {
    const first = unit.errors[0];
    const count = unit.errors.length;
    const finding: IRFinding = {
      severity: "warning",
      message: `${count} syntax ${count === 1 ? "region" : "regions"} not parsed (macros or unsupported syntax)`,
      ...(first ? { span: spanOf(rel, first) } : {}),
      provenance: { frontend: FRONTEND_ID, confidence: "exact" },
    };
    records.push({ finding });
  }

  return { file: rel, records, dependsOn: [...deps].sort() };
}
