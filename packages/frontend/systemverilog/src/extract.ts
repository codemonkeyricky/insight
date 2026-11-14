import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import type { SyntaxNode } from "./parser.js";
import { declId, declName, FRONTEND_ID, fnId, nodeKey, resolveCallee, subroutineOf, type Project, type Hdl } from "./project.js";

const pt = (p: { row: number; column: number }): [number, number] => [p.row, p.column];
const spanOf = (file: string, n: SyntaxNode): Span => ({ file, start: pt(n.startPosition), end: pt(n.endPosition) });
const rangeOf = (file: string, from: SyntaxNode, to: SyntaxNode): Span => ({ file, start: pt(from.startPosition), end: pt(to.endPosition) });
const clip = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** Keeps node IDs unique within one file. Two nodes with the same base get `~2`, `~3`, and so on. */
class Ids {
  private readonly seen = new Set<string>();
  take(base: string): string {
    let id = base;
    let n = 2;
    while (this.seen.has(id)) id = `${base}~${n++}`;
    this.seen.add(id);
    return id;
  }
}

/** Process keywords that start a procedural block. */
const PROCESS_TYPES = ["always_construct", "initial_construct", "final_construct"];
const processKeyword = (p: SyntaxNode): string =>
  p.type === "always_construct" ? (p.namedChildren.find((c) => c.type === "always_keyword")?.text ?? "always") : p.type === "initial_construct" ? "initial" : "final";

/** Statement wrappers between a process and its body, so the label and the timing control can be found. */
const WRAPPERS = new Set(["statement", "statement_or_null", "statement_item", "procedural_timing_control_statement"]);

/** The label of a process body `begin : label`, when the body is a labelled sequential block. */
function labelOf(construct: SyntaxNode): string | undefined {
  let cur: SyntaxNode | undefined = construct;
  while (cur) {
    if (cur.type === "seq_block") {
      const first = cur.namedChildren[0];
      return first?.type === "simple_identifier" ? first.text : undefined;
    }
    cur = cur.namedChildren.find((c) => WRAPPERS.has(c.type));
  }
  return undefined;
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

const FS_WRITE = ["$fopen", "$fwrite", "$fdisplay", "$fstrobe", "$fmonitor", "$fclose"];
const FS_READ = ["$readmemh", "$readmemb", "$fread", "$fscanf", "$fgets", "$fgetc"];
const CLOCK = ["$time", "$stime", "$realtime"];
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

/** Where the code being walked sits. */
interface Frame {
  /** Parent for structure nodes and for facts outside any function: the file, a module, a package, a class or a type. */
  container: NodeId;
  /** Name of the nearest enclosing class, package or module. Qualifies function ids. */
  scope?: string;
  /** The nearest enclosing module, interface or program. Owns its processes and instances. */
  module?: { name: string; id: NodeId; ords: Map<string, number> };
  /** Generate block labels, outermost first. */
  gen: string[];
  /** The function or process whose body is being walked. Flow, calls and effects belong to it. */
  fn?: NodeId;
}

/** Facts for one file, from the project pass. Files with parse errors get inferred facts and one finding. */
export function emitUnit(project: Project, rel: string): IRBatch {
  const unit = project.units.get(rel);
  if (!unit) return { file: rel, records: [] };

  const prov: Provenance = { frontend: FRONTEND_ID, confidence: unit.errors.length > 0 ? "inferred" : "exact" };
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const ids = new Ids();
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
  const seenImports = new Set<string>();

  const flow = (owner: NodeId, tag: string, kind: string, span: Span, attrs: Record<string, unknown>): void => {
    node({ id: ids.take(`${owner}/${tag}`), facet: "flow", kind, parent: owner, attrs, span, provenance: prov });
  };

  /** A call from the current function or process to the function it names, or an unresolved reference. */
  const emitCall = (f: Frame, nameNode: SyntaxNode, name: string, explicit: string | undefined): void => {
    if (!f.fn) return;
    const hit = resolveCallee(project, rel, f.scope, name, explicit);
    const span = spanOf(rel, nameNode);
    const callee = explicit !== undefined ? `${explicit}::${name}` : name;
    if (hit) {
      depend(hit.ref.file);
      const provenance: Provenance = { frontend: FRONTEND_ID, confidence: hit.exact ? prov.confidence : "inferred" };
      edge({ from: f.fn, to: hit.ref.id, facet: "calls", kind: "calls.call", attrs: { callee }, span, provenance });
    } else {
      const to: UnresolvedRef = { unresolved: { scheme: "sv.call", text: name } };
      edge({ from: f.fn, to, facet: "calls", kind: "calls.call", attrs: { callee }, span, provenance: prov });
    }
  };

  /** A call written as obj.m(...) or pkg::f(...). Without parentheses it is a reference to a constant, not a call. */
  const methodCall = (f: Frame, n: SyntaxNode): void => {
    const body = n.namedChildren.find((c) => c.type === "method_call_body");
    const nameNode = body?.childForFieldName("name");
    if (!body || !nameNode || !body.text.includes("(")) return;
    const primary = n.namedChildren.find((c) => c.type === "primary")?.text.trim();
    const explicit = primary !== undefined && /^[A-Za-z_]\w*$/.test(primary) ? primary : undefined;
    emitCall(f, nameNode, nameNode.text, explicit);
  };

  /** A plain call such as f(x), or obj.m(x) through a hierarchical name. System tasks are not calls. */
  const tfCall = (f: Frame, n: SyntaxNode): void => {
    const hi = n.namedChildren.find((c) => c.type === "hierarchical_identifier");
    if (!hi) return;
    const parts = hi.text.split(/::|\./);
    const name = parts[parts.length - 1] ?? hi.text;
    const explicit = parts.length > 1 ? parts[parts.length - 2] : undefined;
    emitCall(f, hi, name, explicit);
  };

  /** A system task: an effect when it is in the catalog, otherwise nothing. */
  const systemCall = (f: Frame, n: SyntaxNode): void => {
    const name = n.namedChildren.find((c) => c.type === "system_tf_identifier")?.text;
    const spec = name !== undefined ? SYSTEM_EFFECTS.get(name) : undefined;
    if (!name || !spec) return;
    const first = n.namedChildren.find((c) => c.type === "list_of_arguments")?.namedChildren[0]?.text;
    const literal = first !== undefined && first.startsWith('"') ? first.slice(1, -1) : undefined;
    const attrs: Record<string, unknown> = { api: name };
    if (spec.key !== undefined && literal !== undefined) attrs[spec.key] = literal;
    node({
      id: ids.take(`${f.fn ?? f.container}/effect`),
      facet: "effects",
      kind: spec.kind,
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
        const id = declId(rel, name);
        const hdl: Hdl = n.type === "interface_declaration" ? "interface" : n.type === "program_declaration" ? "program" : "module";
        const header = n.namedChildren.find((c) => c.type.endsWith("_header"));
        const params = (header?.namedChildren.find((c) => c.type === "parameter_port_list")?.descendantsOfType("param_assignment") ?? [])
          .map((a) => a.namedChildren.find((c) => c.type === "simple_identifier")?.text)
          .filter((p): p is string => p !== undefined);
        let dir = "";
        const ports = (header?.namedChildren.find((c) => c.type === "list_of_port_declarations")?.namedChildren ?? [])
          .filter((c) => c.type === "ansi_port_declaration")
          .map((p) => {
            const d = p.descendantsOfType("port_direction")[0]?.text;
            if (d) dir = d;
            return { name: p.childForFieldName("port_name")?.text ?? "", dir };
          })
          .filter((p) => p.name !== "");
        // Every process of a module gets its ordinal per keyword, in source order, generate blocks included.
        const ords = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const p of n.descendantsOfType(PROCESS_TYPES)) {
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
        const id = declId(rel, name);
        node({ id, facet: "structure", kind: "structure.module", parent: f.container, attrs: { name, hdl: "package" }, span: spanOf(rel, n), provenance: prov });
        visitChildren(n, { container: id, scope: name, gen: [] });
        break;
      }
      case "class_declaration": {
        const name = declName(n);
        if (!name) break;
        const id = declId(rel, name);
        node({
          id,
          facet: "structure",
          kind: "structure.type",
          parent: f.container,
          attrs: { name, typeKind: "class", hdl: "class", params: [], ports: [] },
          span: spanOf(rel, n),
          provenance: prov,
        });
        visitChildren(n, { ...f, container: id, scope: name });
        break;
      }
      case "function_declaration":
      case "task_declaration": {
        const sub = subroutineOf(n);
        if (!sub) break;
        const id = fnId(rel, f.scope, sub.name);
        node({
          id,
          facet: "structure",
          kind: "structure.function",
          parent: f.container,
          attrs: { name: f.scope ? `${f.scope}.${sub.name}` : sub.name, hdl: sub.hdl },
          span: spanOf(rel, n),
          provenance: prov,
        });
        visitChildren(n, { ...f, fn: id });
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
          provenance: clock !== undefined ? { frontend: FRONTEND_ID, confidence: "heuristic" } : prov,
        });
        visitChildren(n, { ...f, fn: id });
        break;
      }
      case "module_instantiation": {
        const type = n.childForFieldName("instance_type")?.text;
        if (!type) break;
        const modName = f.module?.name ?? basename;
        const target = project.decls.get(type);
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
          const resolved = target !== undefined && target.hdl !== "package" && target.hdl !== "class";
          if (resolved) depend(target.file);
          const to: NodeId | UnresolvedRef = resolved ? target.id : { unresolved: { scheme: "sv.module", text: type } };
          edge({ from: f.container, to, facet: "structure", kind: "x-sv.instantiates", attrs: { instance: inst }, span: spanOf(rel, hi), provenance: { frontend: FRONTEND_ID, confidence: "exact" } });
        }
        break;
      }
      case "package_import_declaration": {
        for (const item of n.namedChildren.filter((c) => c.type === "package_import_item")) {
          const pkg = item.namedChildren.find((c) => c.type === "simple_identifier")?.text;
          if (!pkg) continue;
          const key = `${f.container}|${pkg}`;
          if (seenImports.has(key)) continue;
          seenImports.add(key);
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
      case "dpi_import_export": {
        const spec = n.namedChildren.find((c) => c.type === "dpi_spec_string")?.text ?? "";
        if (!/^import\b/.test(n.text) || !/DPI/.test(spec)) break;
        const name = n.descendantsOfType(["function_prototype", "task_prototype"])[0]?.childForFieldName("name")?.text;
        if (!name) break;
        node({
          id: ids.take(`${f.container}@dpi:${name}`),
          facet: "effects",
          kind: "effects.unknown",
          parent: f.container,
          attrs: { api: name },
          span: spanOf(rel, n),
          provenance: prov,
        });
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
        const name = n.childForFieldName("name")?.text;
        visitChildren(n, name ? { ...f, gen: [...f.gen, name] } : f);
        break;
      }
      default:
        visitChildren(n, f);
    }
  };

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
