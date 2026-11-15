import type { SyntaxNode } from "./parser.js";
import { nodeKey, norm, scopeOf, stripTemplates, type Project } from "./project.js";

/**
 * Enum-typed state, heuristically (D12): a field or global whose declared type text names an enum the project
 * declares is a holder. Everything here is syntactic, so every fact built on it is `heuristic`.
 */

export interface EnumInfo {
  name: string;
  qname: string;
  members: string[];
}

export interface Holder {
  id: string;
  rel: string;
  /** The field or variable name. */
  name: string;
  /** The qualified class for a field. Undefined for a global. */
  cls?: string;
  enum: EnumInfo;
  /** `Type.Member` for each enumerator. */
  values: string[];
  declaredType: string;
}

export interface StateIndex {
  byRel: Map<string, Holder[]>;
  /** Class (qualified) to field name to holder. */
  byClass: Map<string, Map<string, Holder>>;
  /** Global name to holders. A name is used only when unique. */
  globals: Map<string, Holder[]>;
  /** Holder by the declarator node that declares it: `${rel}|${nodeKey}`. */
  byDecl: Map<string, Holder>;
  enums: Map<string, EnumInfo[]>;
}

const cache = new WeakMap<Project, StateIndex>();

const walk = (node: SyntaxNode, visit: (n: SyntaxNode) => void): void => {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
};

/** The declared name inside a (possibly wrapped) declarator, when it is a plain identifier. */
function plainName(d: SyntaxNode | null): SyntaxNode | undefined {
  if (!d) return undefined;
  if (d.type === "identifier" || d.type === "field_identifier") return d;
  if (d.type === "init_declarator") return plainName(d.childForFieldName("declarator"));
  return undefined;
}

/** The last name segment of a declared type, when it is a bare (optionally qualified) name. */
function typeName(typeText: string): string | undefined {
  const t = norm(typeText.replace(/\b(?:enum|class|struct|const|volatile|constexpr)\b/g, " "));
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(t)) return undefined;
  return t.split("::").pop();
}

function pickEnum(enums: Map<string, EnumInfo[]>, typeText: string): EnumInfo | undefined {
  const simple = typeName(typeText);
  if (!simple) return undefined;
  const list = enums.get(simple);
  if (!list || list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const wanted = norm(typeText.replace(/\b(?:enum|class|struct|const|volatile)\b/g, " ")).replace(/^::/, "");
  return list.find((e) => e.qname === wanted || e.qname.endsWith(`::${wanted}`)) ?? list[0];
}

const isConst = (decl: SyntaxNode): boolean =>
  decl.namedChildren.some((c) => c.type === "type_qualifier" && /const/.test(c.text)) ||
  decl.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === "extern");

export function stateIndexOf(project: Project): StateIndex {
  const hit = cache.get(project);
  if (hit) return hit;
  const index: StateIndex = { byRel: new Map(), byClass: new Map(), globals: new Map(), byDecl: new Map(), enums: new Map() };
  cache.set(project, index);

  for (const unit of project.units.values()) {
    walk(unit.root, (n) => {
      if (n.type !== "enum_specifier") return;
      const name = n.childForFieldName("name")?.text;
      const body = n.childForFieldName("body");
      if (!name || name.trim() === "" || !body) return;
      const members = body.namedChildren.filter((c) => c.type === "enumerator").map((c) => c.childForFieldName("name")?.text ?? "").filter((m) => m !== "");
      const info: EnumInfo = { name, qname: [...scopeOf(n).path, name].join("::"), members };
      const list = index.enums.get(name) ?? [];
      list.push(info);
      index.enums.set(name, list);
    });
  }

  const usedIds = new Set<string>();
  const add = (holder: Omit<Holder, "id">, base: string, declarator: SyntaxNode) => {
    let id = base;
    for (let k = 2; usedIds.has(id); k++) id = `${base}~${k}`;
    usedIds.add(id);
    const h: Holder = { ...holder, id };
    index.byDecl.set(`${holder.rel}|${nodeKey(declarator)}`, h);
    const list = index.byRel.get(holder.rel) ?? [];
    list.push(h);
    index.byRel.set(holder.rel, list);
    if (h.cls !== undefined) {
      const fields = index.byClass.get(h.cls) ?? new Map<string, Holder>();
      if (!fields.has(h.name)) fields.set(h.name, h);
      index.byClass.set(h.cls, fields);
    } else {
      const gs = index.globals.get(h.name) ?? [];
      gs.push(h);
      index.globals.set(h.name, gs);
    }
  };

  for (const unit of project.units.values()) {
    walk(unit.root, (n) => {
      if (n.type === "field_declaration") {
        const body = n.parent;
        const owner = body?.parent;
        if (body?.type !== "field_declaration_list" || (owner?.type !== "class_specifier" && owner?.type !== "struct_specifier")) return;
        const typeNode = n.childForFieldName("type");
        const en = typeNode ? pickEnum(index.enums, typeNode.text) : undefined;
        if (!en || !typeNode || isConst(n)) return;
        const clsName = owner.childForFieldName("name")?.text;
        if (!clsName) return;
        const cls = [...scopeOf(owner).path, stripTemplates(norm(clsName))].join("::");
        for (const d of n.childrenForFieldName("declarator")) {
          const nameNode = plainName(d);
          if (!nameNode || nameNode.type !== "field_identifier") continue;
          add({ rel: unit.rel, name: nameNode.text, cls, enum: en, values: en.members.map((m) => `${en.name}.${m}`), declaredType: norm(typeNode.text) }, `${unit.rel}#${cls}.${nameNode.text}`, d);
        }
      } else if (n.type === "declaration") {
        const p = n.parent;
        if (p?.type !== "translation_unit" && p?.type !== "declaration_list" && p?.type !== "linkage_specification") return;
        const typeNode = n.childForFieldName("type");
        const en = typeNode ? pickEnum(index.enums, typeNode.text) : undefined;
        if (!en || !typeNode || isConst(n)) return;
        const path = scopeOf(n).path;
        for (const d of n.childrenForFieldName("declarator")) {
          const nameNode = plainName(d);
          if (!nameNode || nameNode.type !== "identifier") continue;
          add({ rel: unit.rel, name: nameNode.text, enum: en, values: en.members.map((m) => `${en.name}.${m}`), declaredType: norm(typeNode.text) }, `${unit.rel}#${[...path, nameNode.text].join("::")}`, d);
        }
      }
    });
  }
  return index;
}

/** What an expression is read against: the enclosing class and the names a local or parameter hides. */
export interface RefCtx {
  index: StateIndex;
  cls?: string;
  shadow: Set<string>;
}

const unparen = (e: SyntaxNode | null | undefined): SyntaxNode | null => {
  let n = e ?? null;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  return n;
};

/** The holder an expression reads or writes: `x_`, `this->x_`, or a global. */
export function holderRef(expr: SyntaxNode | null | undefined, ctx: RefCtx): Holder | undefined {
  const e = unparen(expr);
  if (!e) return undefined;
  if (e.type === "identifier") {
    const name = e.text;
    if (ctx.shadow.has(name)) return undefined;
    const field = ctx.cls !== undefined ? ctx.index.byClass.get(ctx.cls)?.get(name) : undefined;
    if (field) return field;
    const gs = ctx.index.globals.get(name);
    return gs && gs.length === 1 ? gs[0] : undefined;
  }
  if (e.type === "field_expression" && ctx.cls !== undefined) {
    const arg = unparen(e.childForFieldName("argument"));
    const op = e.childForFieldName("operator")?.text ?? e.children.find((c) => c.text === "->" || c.text === ".")?.text;
    const field = e.childForFieldName("field")?.text;
    if (arg?.type === "this" && op === "->" && field) return ctx.index.byClass.get(ctx.cls)?.get(field);
  }
  return undefined;
}

/** `Type.Member` when the expression is a plain enumerator of the holder's enum. */
export function enumerator(expr: SyntaxNode | null | undefined, holder: Holder, ctx: RefCtx): string | undefined {
  const e = unparen(expr);
  if (!e) return undefined;
  const en = holder.enum;
  if (e.type === "identifier") return en.members.includes(e.text) ? `${en.name}.${e.text}` : undefined;
  if (e.type === "qualified_identifier") {
    const name = e.childForFieldName("name")?.text;
    const scope = e.childForFieldName("scope")?.text;
    if (!name || !en.members.includes(name)) return undefined;
    const last = norm(scope ?? "").split("::").pop() ?? "";
    // `E::M` names the enum; `Cls::M` names an unscoped enumerator through its class.
    if (last === en.name || !ctx.index.enums.has(last)) return `${en.name}.${name}`;
  }
  return undefined;
}

/** Names declared by a parameter or local in a function: they hide fields and globals of the same name. */
export function shadowNames(fn: SyntaxNode): Set<string> {
  const out = new Set<string>();
  const nameOf = (d: SyntaxNode | null): void => {
    let cur: SyntaxNode | null = d;
    while (cur && cur.type !== "identifier") {
      const next: SyntaxNode | null = cur.childForFieldName("declarator") ?? (cur.type === "reference_declarator" ? cur.namedChildren[0] ?? null : null);
      cur = next;
    }
    if (cur) out.add(cur.text);
  };
  walk(fn, (n) => {
    if (n.type === "parameter_declaration" || n.type === "optional_parameter_declaration") nameOf(n.childForFieldName("declarator"));
    else if (n.type === "declaration") for (const d of n.childrenForFieldName("declarator")) nameOf(d);
  });
  return out;
}

/** A comparison of a holder with one of its enumerators. */
export interface Atom {
  holder: Holder;
  value: string;
  /** True for `!=`, or `==` under `!`. */
  negated: boolean;
  node: SyntaxNode;
}

export function atomOf(bin: SyntaxNode, ctx: RefCtx, flip = false): Atom | undefined {
  if (bin.type !== "binary_expression") return undefined;
  const op = bin.childForFieldName("operator")?.text;
  if (op !== "==" && op !== "!=") return undefined;
  const l = bin.childForFieldName("left");
  const r = bin.childForFieldName("right");
  for (const [a, b] of [[l, r], [r, l]] as const) {
    const holder = holderRef(a, ctx);
    if (!holder) continue;
    const value = enumerator(b, holder, ctx);
    if (value) return { holder, value, negated: (op === "!=") !== flip, node: bin };
  }
  return undefined;
}

export interface Condition {
  atoms: Atom[];
  /** The whole condition is one comparison (under parentheses and `!`), so both of its branches are known. */
  whole: boolean;
}

/** The comparisons a condition implies when it is true: itself, or the top-level `&&` conjuncts. */
export function decompose(cond: SyntaxNode | null | undefined, ctx: RefCtx): Condition {
  let root = cond ?? null;
  if (root?.type === "condition_clause") root = root.childForFieldName("value") ?? root.namedChildren[root.namedChildren.length - 1] ?? null;
  const go = (expr: SyntaxNode | null, flip: boolean): { atoms: Atom[]; whole: boolean } => {
    const e = unparen(expr);
    if (!e) return { atoms: [], whole: false };
    if (e.type === "unary_expression" && e.childForFieldName("operator")?.text === "!") return go(e.childForFieldName("argument"), !flip);
    if (e.type === "binary_expression") {
      const op = e.childForFieldName("operator")?.text;
      if (op === "&&" && !flip) {
        const a = go(e.childForFieldName("left"), false);
        const b = go(e.childForFieldName("right"), false);
        return { atoms: [...a.atoms, ...b.atoms], whole: false };
      }
      const atom = atomOf(e, ctx, flip);
      return atom ? { atoms: [atom], whole: true } : { atoms: [], whole: false };
    }
    return { atoms: [], whole: false };
  };
  return go(root, false);
}

export interface WriteSite {
  holder: Holder;
  /** `Type.Member`, absent when the value is not a plain enumerator. */
  value?: string;
}

/** `x = E::M` where the left side is a holder. */
export function writeOf(assign: SyntaxNode, ctx: RefCtx): WriteSite | undefined {
  if (assign.type !== "assignment_expression" || assign.childForFieldName("operator")?.text !== "=") return undefined;
  const holder = holderRef(assign.childForFieldName("left"), ctx);
  if (!holder) return undefined;
  const value = enumerator(assign.childForFieldName("right"), holder, ctx);
  return value ? { holder, value } : { holder };
}

/** One `case` group of a switch: consecutive empty labels merge into the group that holds the statements. */
export interface CaseGroup {
  cases: SyntaxNode[];
  /** The case that holds the statements. */
  last: SyntaxNode;
  values: string[];
  /** True when a label is `default` or names something that is not a plain enumerator. */
  isDefault: boolean;
  opaque: boolean;
  body: SyntaxNode[];
}

export function caseGroups(sw: SyntaxNode, holder: Holder | undefined, ctx: RefCtx): CaseGroup[] {
  const body = sw.childForFieldName("body");
  const cases = (body?.namedChildren ?? []).filter((c) => c.type === "case_statement");
  const groups: CaseGroup[] = [];
  let cur: CaseGroup | undefined;
  cases.forEach((cs, i) => {
    cur ??= { cases: [], last: cs, values: [], isDefault: false, opaque: false, body: [] };
    cur.cases.push(cs);
    cur.last = cs;
    const value = cs.childForFieldName("value");
    if (!value) cur.isDefault = true;
    else {
      const v = holder ? enumerator(value, holder, ctx) : undefined;
      if (v) cur.values.push(v);
      else cur.opaque = true;
    }
    const stmts = cs.namedChildren.filter((c) => c.type !== "comment" && (!value || nodeKey(c) !== nodeKey(value)));
    if (stmts.length > 0 || i === cases.length - 1) {
      cur.body = stmts;
      groups.push(cur);
      cur = undefined;
    }
  });
  return groups;
}

export interface WriteInfo {
  from?: string[];
  guards: string[];
}

export interface Analysis {
  writes: Map<string, WriteInfo>;
  /** Comparisons that are early exits: `if (x != M) return;`. */
  exits: Set<string>;
}

interface Known {
  vals: Set<string> | null;
  guards: string[];
}
type Env = Map<string, Known>;

const clone = (env: Env): Env => new Map(env);

function join(a: Env | null, b: Env | null): Env | null {
  if (!a) return b;
  if (!b) return a;
  const out: Env = new Map();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const ka = a.get(key);
    const kb = b.get(key);
    if (!ka?.vals || !kb?.vals) {
      out.set(key, { vals: null, guards: [] });
      continue;
    }
    out.set(key, { vals: new Set([...ka.vals, ...kb.vals]), guards: ka.guards.filter((g) => kb.guards.includes(g)) });
  }
  return out;
}

export const testId = (rel: string, n: SyntaxNode): string => `${rel}@test:${n.startPosition.row}:${n.startPosition.column}`;

/**
 * A small abstract interpretation over the statements of one function body (D6): the known set of values
 * of each holder, narrowed by if/else arms, early exits and switch cases, and replaced by a write.
 * Calls do not reset it, and there is no cross-call knowledge.
 */
export function analyze(body: SyntaxNode, rel: string, ctx: RefCtx): Analysis {
  const result: Analysis = { writes: new Map(), exits: new Set() };
  const breaks: (Env | null)[][] = [];

  const narrow = (env: Env, holder: Holder, values: string[], holds: boolean, id: string): Env => {
    const out = clone(env);
    const cur = env.get(holder.id);
    let vals: Set<string>;
    if (holds) vals = cur?.vals ? new Set([...cur.vals].filter((v) => values.includes(v))) : new Set(values);
    else vals = new Set((cur?.vals ? [...cur.vals] : holder.values).filter((v) => !values.includes(v)));
    out.set(holder.id, { vals, guards: [...(cur?.guards ?? []), id] });
    return out;
  };

  const writtenIn = (n: SyntaxNode): Set<string> => {
    const ids = new Set<string>();
    walk(n, (c) => {
      if (c.type !== "assignment_expression") return;
      const w = writeOf(c, ctx);
      if (w) ids.add(w.holder.id);
    });
    return ids;
  };
  const widen = (env: Env, ids: Set<string>): Env => {
    const out = clone(env);
    for (const id of ids) out.set(id, { vals: null, guards: [] });
    return out;
  };

  const exec = (n: SyntaxNode | null | undefined, env: Env): Env | null => {
    if (!n) return env;
    switch (n.type) {
      case "compound_statement": {
        let cur: Env | null = env;
        for (const c of n.namedChildren) {
          if (!cur) break;
          cur = exec(c, cur);
        }
        return cur;
      }
      case "expression_statement": {
        const e = n.namedChild(0);
        if (e?.type !== "assignment_expression") return env;
        const w = writeOf(e, ctx);
        if (!w) return env;
        const cur = env.get(w.holder.id);
        result.writes.set(nodeKey(e), {
          ...(cur?.vals && cur.vals.size > 0 ? { from: [...cur.vals] } : {}),
          guards: cur?.guards ?? [],
        });
        const out = clone(env);
        out.set(w.holder.id, { vals: w.value ? new Set([w.value]) : null, guards: [] });
        return out;
      }
      case "if_statement": {
        const cond = decompose(n.childForFieldName("condition"), ctx);
        const alt = n.childForFieldName("alternative");
        const altStmt = alt?.type === "else_clause" ? alt.namedChild(0) : alt;
        let thenEnv = env;
        for (const a of cond.atoms) thenEnv = narrow(thenEnv, a.holder, [a.value], !a.negated, testId(rel, a.node));
        let elseEnv = env;
        const only = cond.whole ? cond.atoms[0] : undefined;
        if (only) elseEnv = narrow(env, only.holder, [only.value], only.negated, testId(rel, only.node));
        const thenOut = exec(n.childForFieldName("consequence"), thenEnv);
        const elseOut = altStmt ? exec(altStmt, elseEnv) : elseEnv;
        if (only?.negated && !altStmt && thenOut === null) result.exits.add(nodeKey(only.node));
        return join(thenOut, elseOut);
      }
      case "switch_statement": {
        const cond = n.childForFieldName("condition");
        const disc = holderRef(cond?.type === "condition_clause" ? cond.childForFieldName("value") ?? cond.namedChildren[cond.namedChildren.length - 1] : cond, ctx);
        const groups = caseGroups(n, disc, ctx);
        const all = groups.flatMap((g) => g.values);
        breaks.push([]);
        let fall: Env | null = null;
        const hasDefault = groups.some((g) => g.isDefault);
        for (const g of groups) {
          let entry: Env = env;
          if (disc && !g.opaque && !g.isDefault) entry = narrow(env, disc, g.values, true, testId(rel, g.cases[0] as SyntaxNode));
          else if (disc && g.isDefault && !g.opaque) entry = narrow(env, disc, all, false, testId(rel, g.cases[0] as SyntaxNode));
          let cur: Env | null = join(entry, fall);
          for (const s of g.body) {
            if (!cur) break;
            cur = exec(s, cur);
          }
          fall = cur;
        }
        const outs = breaks.pop() ?? [];
        let out: Env | null = fall;
        for (const b of outs) out = join(out, b);
        if (!hasDefault) out = join(out, disc ? narrow(env, disc, all, false, testId(rel, n)) : env);
        return out;
      }
      case "break_statement":
        breaks[breaks.length - 1]?.push(env);
        return null;
      case "continue_statement":
      case "return_statement":
      case "throw_statement":
      case "goto_statement":
      case "co_return_statement":
        return null;
      case "for_statement":
      case "for_range_loop":
      case "while_statement":
      case "do_statement": {
        const widened = widen(env, writtenIn(n));
        breaks.push([]);
        exec(n.childForFieldName("body"), widened);
        breaks.pop();
        return widened;
      }
      case "try_statement": {
        const tryBody = n.childForFieldName("body");
        const widened = widen(env, tryBody ? writtenIn(tryBody) : new Set());
        let out = exec(tryBody, env);
        for (const c of n.namedChildren) if (c.type === "catch_clause") out = join(out, exec(c.childForFieldName("body"), widened));
        return out;
      }
      case "labeled_statement":
        return exec(n.namedChildren[n.namedChildren.length - 1], env);
      default:
        return env;
    }
  };

  exec(body, new Map());
  return result;
}
