import ts from "typescript";
import type { IRNode, Span } from "@insight/ir";
import { propName } from "./dispatch.js";
import type { Decl, Project } from "./extract.js";

/**
 * State facts: holders (fields and variables of a finite type), writes, tests and the per-function known-set
 * abstract interpretation that resolves each write's `from`. See .claude/plans/states-lens.md (D2-D7, A1-A3).
 */

const NULL_STATE = "∅";

export interface Holder {
  id: string;
  name: string;
  rel: string;
  parent: string;
  /** Domain values in order, or null for an open holder (useState without a type argument). */
  domain: string[] | null;
  domainKind: "enum" | "union" | "open";
  declaredType?: string;
  decl: ts.Node;
  /** The class that declares the field, when it is one. */
  classId?: string;
  /** The symbol of the declaring class, interface or alias, for the "exactly the declaring type" test. */
  ownerSymbol?: ts.Symbol;
}

export interface StateHelpers {
  project: Project;
  rel: string;
  sf: ts.SourceFile;
  moduleId: string | undefined;
  pos(offset: number): [number, number];
  spanOf(node: ts.Node): Span;
  declOf(sym: ts.Symbol | undefined): Decl | undefined;
  uniqueId(base: string): string;
  /** The id of the flow.branch-arm emitted for this node. */
  armId(node: ts.Node): string | undefined;
  provenance: IRNode["provenance"];
}

export interface StateOutput {
  nodes: IRNode[];
  /** Attrs to merge onto the calls.call edge of a call expression. */
  callAttrs: Map<ts.CallExpression, { knownState?: Record<string, string[]>; knownStale?: string[]; knownEntry?: string[] }>;
}

interface KS {
  holder: Holder;
  receiver: string;
  set: Set<string> | null;
  stale: boolean;
  guards: string[];
  texts: string[];
  /** The distinguished "entry" unknown: the value the holder had when the function was entered (set is null). */
  entry?: boolean;
}
/**
 * `entry` on the map: keys that are absent still hold their entry value (nothing wrote, tested or awaited since the
 * function started). Without it an absent key is plain unknown.
 */
type EnvMap = Map<string, KS> & { entry?: boolean; entryStale?: boolean };
type Env = EnvMap | null;
const entryEnv = (): EnvMap => {
  const m: EnvMap = new Map();
  m.entry = true;
  return m;
};
const entryKS = (r: KS, stale = false): KS => ({ holder: r.holder, receiver: r.receiver, set: null, stale, guards: [], texts: [], entry: true });
const unknownKS = (r: KS): KS => ({ holder: r.holder, receiver: r.receiver, set: null, stale: false, guards: [], texts: [] });

interface Spec {
  holder: Holder;
  receiver: string;
  values: string[];
  negated: boolean;
  node: ts.Node;
}

interface Setter {
  holder: Holder;
  paramIndex: number;
  assign: ts.Node;
  receiverIsThis: boolean;
}

interface WriteRec {
  node: ts.Node;
  parent: string;
  holder: Holder;
  op: "init" | "set";
  value?: string;
  dynamic?: boolean;
  receiver?: string;
  from?: string[];
  stale?: boolean;
  fromEntry?: boolean;
  guards?: string[];
  guardMatch?: "receiver" | "holder";
  event?: string;
  guardText?: string;
  via?: string;
  ownerLabel?: string;
}

interface TestRec {
  node: ts.Node;
  span: Span;
  parent: string;
  spec: Spec;
  arm?: string;
  elseArm?: string;
  exitGuard?: boolean;
}

interface CondMode {
  top: boolean;
  whole: boolean;
  thenArm?: string;
  elseArm?: string;
  exit?: boolean;
  other?: string;
}

const relMaps = new WeakMap<Project, Map<ts.SourceFile, string>>();

const REACT_MODULES = new Set(["react", "preact/hooks", "preact/compat"]);

const stripAll = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression;
  }
  return x;
};
const stripParens = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
};

const isFnLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n);

function alwaysExits(s: ts.Statement | undefined): boolean {
  if (!s) return false;
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s)) return true;
  if (ts.isBlock(s)) return s.statements.some((x) => alwaysExits(x));
  if (ts.isIfStatement(s)) return s.elseStatement !== undefined && alwaysExits(s.thenStatement) && alwaysExits(s.elseStatement);
  return false;
}

/** Whether a statement contains a return, throw, break or continue (outside nested functions). */
function exitsEarly(n: ts.Node): boolean {
  if (ts.isReturnStatement(n) || ts.isThrowStatement(n) || ts.isBreakStatement(n) || ts.isContinueStatement(n)) return true;
  if (isFnLike(n)) return false;
  return ts.forEachChild(n, (c) => (exitsEarly(c) ? true : undefined)) === true;
}

function cloneKS(k: KS): KS {
  return { ...k, set: k.set ? new Set(k.set) : null, guards: [...k.guards], texts: [...k.texts] };
}
function clone(env: Env): Env {
  if (!env) return null;
  const out: EnvMap = new Map();
  if (env.entry) out.entry = true;
  if (env.entryStale) out.entryStale = true;
  for (const [k, v] of env) out.set(k, cloneKS(v));
  return out;
}
function join(a: Env, b: Env): Env {
  if (!a) return b;
  if (!b) return a;
  const out: EnvMap = new Map();
  out.entry = !!(a.entry && b.entry);
  if (out.entry && (a.entryStale || b.entryStale)) out.entryStale = true;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x0 = a.get(k);
    const y0 = b.get(k);
    const ref = (x0 ?? y0)!;
    const x = x0 ?? (a.entry ? entryKS(ref, a.entryStale) : undefined);
    const y = y0 ?? (b.entry ? entryKS(ref, b.entryStale) : undefined);
    if (!x || !y) {
      // Unknown on one side: absent means entry when the result keeps the marker, so spell the unknown out.
      if (out.entry) out.set(k, unknownKS(ref));
      continue;
    }
    out.set(k, {
      holder: x.holder,
      receiver: x.receiver,
      set: x.set && y.set ? new Set([...x.set, ...y.set]) : null,
      stale: x.stale || y.stale,
      guards: x.guards.filter((g) => y.guards.includes(g)),
      texts: x.texts.filter((g) => y.texts.includes(g)),
      ...(x.entry && y.entry ? { entry: true } : {}),
    });
  }
  return out;
}
function sig(env: Env): string {
  if (!env) return "dead";
  return (
    (env.entry ? (env.entryStale ? "E!|" : "E|") : "|") +
    [...env.entries()]
      .map(([k, v]) => `${k}=${v.set ? [...v.set].sort().join(",") : "*"}${v.stale ? "!" : ""}${v.entry ? "E" : ""}`)
      .sort()
      .join(";")
  );
}
/** An await or yield: known sets may be out of date, and the entry value is no longer the current one. */
function markStale(env: Env): void {
  if (!env) return;
  // The entry value stays fillable but stale (E1).
  if (env.entry) env.entryStale = true;
  for (const v of env.values()) {
    if (v.set || v.entry) v.stale = true;
  }
}

export function emitState(h: StateHelpers): StateOutput {
  const { project, rel, sf } = h;
  const checker = project.checker;
  const nodes: IRNode[] = [];
  const callAttrs: StateOutput["callAttrs"] = new Map();

  // ---------- types and values ----------

  const encodeType = (t: ts.Type): string | undefined => {
    if (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return NULL_STATE;
    if (t.isUnion()) return undefined;
    if (t.flags & ts.TypeFlags.BooleanLiteral) return undefined;
    if (t.flags & ts.TypeFlags.EnumLiteral && t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) return checker.typeToString(t);
    if (t.isStringLiteral()) return JSON.stringify(t.value);
    if (t.isNumberLiteral()) return String(t.value);
    return undefined;
  };

  const domainOf = (t: ts.Type): { values: string[]; kind: "enum" | "union" } | undefined => {
    const parts = t.isUnion() ? t.types : [t];
    const values: string[] = [];
    let hasNull = false;
    let allEnum = true;
    for (const p of parts) {
      if (p.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
        hasNull = true;
      } else if (p.flags & ts.TypeFlags.BooleanLiteral) {
        return undefined;
      } else if (p.flags & ts.TypeFlags.EnumLiteral && p.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)) {
        values.push(checker.typeToString(p));
      } else if (p.isStringLiteral()) {
        values.push(JSON.stringify(p.value));
        allEnum = false;
      } else if (p.isNumberLiteral()) {
        values.push(String(p.value));
        allEnum = false;
      } else {
        return undefined;
      }
    }
    if (values.length === 0) return undefined;
    if (hasNull) values.push(NULL_STATE);
    if (values.length < 2) return undefined;
    return { values, kind: allEnum ? "enum" : "union" };
  };

  const valueOf = (e: ts.Expression): string | undefined => {
    const inner = stripAll(e);
    if (inner.kind === ts.SyntaxKind.NullKeyword) return NULL_STATE;
    if (ts.isIdentifier(inner) && inner.text === "undefined") return NULL_STATE;
    return encodeType(checker.getTypeAtLocation(inner));
  };

  // ---------- holders ----------

  const holderCache = new Map<ts.Symbol, Holder | null>();
  const holderByDecl = new Map<ts.Node, Holder | null>();
  const useStateValue = new Map<ts.Symbol, Holder>();
  const useStateSetter = new Map<ts.Symbol, Holder>();
  const holderById = new Map<string, Holder>();

  const resolveAlias = (sym: ts.Symbol | undefined): ts.Symbol | undefined => {
    if (sym && sym.flags & ts.SymbolFlags.Alias) {
      try {
        return checker.getAliasedSymbol(sym);
      } catch {
        return sym;
      }
    }
    return sym;
  };

  const relOfNode = (n: ts.Node): string | undefined => {
    const file = n.getSourceFile();
    if (file === sf) return rel;
    if (file.isDeclarationFile) return undefined;
    let m = relMaps.get(project);
    if (!m) {
      m = new Map();
      for (const r of project.rels) {
        const f = project.sourceFor(r);
        if (f) m.set(f, r);
      }
      relMaps.set(project, m);
    }
    return m.get(file);
  };

  const enclosingFn = (n: ts.Node): ts.Node | undefined => {
    for (let p = n.parent; p; p = p.parent) {
      if (project.decls.has(p) && project.decls.get(p)?.entity.type === "function") return p;
    }
    return undefined;
  };

  /**
   * For a write inside an arrow or function expression: `<enclosing function> › <name>` when the lambda is assigned to a
   * named property or variable (`onClose: () => …`, `x.onclose = () => …`), else `<enclosing function> › λ`.
   */
  const lambdaLabel = (n: ts.Node): string | undefined => {
    const fn = enclosingFn(n);
    const d = fn ? project.decls.get(fn) : undefined;
    if (!fn || !d || d.entity.type !== "function" || !d.entity.anonymous) return undefined;
    let outer: string | undefined;
    for (let p: ts.Node | undefined = fn.parent; p; p = p.parent) {
      const od = project.decls.get(p);
      if (od && od.entity.type === "function" && !od.entity.anonymous) {
        outer = od.entity.name;
        break;
      }
    }
    const par = fn.parent;
    let name: string | undefined;
    const nameOf = (e: ts.Node): string | undefined =>
      ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isStringLiteralLike(e) ? e.text : undefined;
    if (par && ts.isPropertyAssignment(par) && par.initializer === fn) name = nameOf(par.name);
    else if (par && ts.isBinaryExpression(par) && par.right === fn && par.operatorToken.kind === ts.SyntaxKind.EqualsToken) name = nameOf(par.left);
    else if (par && ts.isVariableDeclaration(par) && par.initializer === fn) name = nameOf(par.name);
    const tail = name ?? "λ";
    return outer ? `${outer} › ${tail}` : tail;
  };

  const typeOfDecl = (decl: ts.Node & { type?: ts.TypeNode }): ts.Type => (decl.type ? checker.getTypeFromTypeNode(decl.type) : checker.getTypeAtLocation(decl));

  const ownerOf = (decl: ts.Node): { decl: Decl; node: ts.Node } | undefined => {
    let p: ts.Node | undefined = decl.parent;
    if (p && ts.isConstructorDeclaration(p)) p = p.parent;
    if (!p) return undefined;
    if (ts.isTypeLiteralNode(p)) p = p.parent;
    if (ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) {
      const d = project.decls.get(p);
      return d ? { decl: d, node: p } : undefined;
    }
    return undefined;
  };

  const holderOfDecl = (decl: ts.Node): Holder | null => {
    const nameNode = (decl as ts.NamedDeclaration).name;
    if (!nameNode) return null;
    const hrel = relOfNode(decl);
    if (hrel === undefined) return null;
    const dsf = decl.getSourceFile();
    if (dsf.isDeclarationFile) return null;
    let id: string;
    let name: string;
    let parent: string;
    let classId: string | undefined;
    let ownerSymbol: ts.Symbol | undefined;
    const isParamProp =
      ts.isParameter(decl) &&
      ts.isConstructorDeclaration(decl.parent) &&
      ts.isIdentifier(decl.name) &&
      (ts.getModifiers(decl)?.some((m) => m.kind !== ts.SyntaxKind.OverrideKeyword) ?? false);
    if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || isParamProp) {
      const owner = ownerOf(decl);
      if (!owner) return null;
      const prop = ts.isParameter(decl) ? (decl.name as ts.Identifier).text : propName(decl.name as ts.PropertyName);
      id = `${owner.decl.id}.${prop}`;
      name = `${owner.decl.entity.name}.${prop}`;
      parent = owner.decl.id;
      if (ts.isClassDeclaration(owner.node)) classId = owner.decl.id;
      const on = (owner.node as ts.NamedDeclaration).name;
      ownerSymbol = on ? checker.getSymbolAtLocation(on) : undefined;
    } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      const list = decl.parent;
      if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) return null;
      if (ts.isCatchClause(list)) return null;
      const fn = enclosingFn(decl);
      if (fn) {
        const fd = project.decls.get(fn);
        if (!fd) return null;
        id = `${hrel}#${fd.qname}/${decl.name.text}`;
        name = `${fd.qname}/${decl.name.text}`;
        parent = fd.id;
      } else {
        id = `${hrel}#${decl.name.text}`;
        name = decl.name.text;
        parent = hrel;
      }
    } else {
      return null;
    }
    const t = typeOfDecl(decl as ts.Node & { type?: ts.TypeNode });
    const dom = domainOf(t);
    if (!dom) return null;
    const typeNode = (decl as { type?: ts.TypeNode }).type;
    return {
      id,
      name,
      rel: hrel,
      parent,
      domain: dom.values,
      domainKind: dom.kind,
      ...(typeNode ? { declaredType: typeNode.getText().slice(0, 120) } : {}),
      decl,
      ...(classId ? { classId } : {}),
      ...(ownerSymbol ? { ownerSymbol } : {}),
    };
  };

  const holderOfSym = (symIn: ts.Symbol | undefined): Holder | null => {
    const sym = resolveAlias(symIn);
    if (!sym) return null;
    const vs = useStateValue.get(sym);
    if (vs) return vs;
    const hit = holderCache.get(sym);
    if (hit !== undefined) return hit;
    let res: Holder | null = null;
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (decl && (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl) || ts.isVariableDeclaration(decl) || ts.isParameter(decl))) {
      // One holder object per declaration, whichever symbol (mapped, merged) led here.
      const known = holderByDecl.get(decl);
      res = known !== undefined ? known : holderOfDecl(decl);
      holderByDecl.set(decl, res);
    }
    holderCache.set(sym, res);
    if (res) holderById.set(res.id, res);
    return res;
  };

  // React useState --------------------------------------------------

  const isReactUseState = (call: ts.CallExpression): boolean => {
    const callee = call.expression;
    const fromReact = (sym: ts.Symbol | undefined): boolean => {
      const d = sym?.declarations?.[0];
      if (!d) return false;
      let n: ts.Node = d;
      while (n && !ts.isImportDeclaration(n)) n = n.parent;
      if (!n || !ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) return false;
      return REACT_MODULES.has(n.moduleSpecifier.text);
    };
    if (ts.isIdentifier(callee)) {
      if (callee.text !== "useState") {
        const d = checker.getSymbolAtLocation(callee)?.declarations?.[0];
        if (!(d && ts.isImportSpecifier(d) && d.propertyName?.text === "useState")) return false;
      }
      const sym = checker.getSymbolAtLocation(callee);
      const d = sym?.declarations?.[0];
      return d !== undefined && ts.isImportSpecifier(d) && fromReact(sym);
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "useState" && ts.isIdentifier(callee.expression)) {
      return fromReact(checker.getSymbolAtLocation(callee.expression));
    }
    return false;
  };

  const registerUseState = (decl: ts.VariableDeclaration): Holder | undefined => {
    if (!decl.initializer || !ts.isCallExpression(decl.initializer) || !ts.isArrayBindingPattern(decl.name)) return undefined;
    const call = decl.initializer;
    const [valueEl, setterEl] = decl.name.elements;
    if (!valueEl || !ts.isBindingElement(valueEl) || !ts.isIdentifier(valueEl.name)) return undefined;
    if (!isReactUseState(call)) return undefined;
    const fn = enclosingFn(decl);
    const fd = fn ? project.decls.get(fn) : undefined;
    if (!fd) return undefined;
    const valueSym = checker.getSymbolAtLocation(valueEl.name);
    if (!valueSym) return undefined;
    const known = useStateValue.get(valueSym);
    if (known) return known;
    let domain: string[] | null = null;
    let kind: "enum" | "union" | "open" = "open";
    let declaredType: string | undefined;
    const targ = call.typeArguments?.[0];
    if (targ) {
      const dom = domainOf(checker.getTypeFromTypeNode(targ));
      if (!dom) return undefined;
      domain = dom.values;
      kind = dom.kind;
      declaredType = targ.getText().slice(0, 120);
    } else {
      const init = call.arguments[0];
      const v = init ? valueOf(init) : undefined;
      if (v === undefined) return undefined;
      domain = null;
      kind = "open";
    }
    const holder: Holder = {
      id: `${rel}#${fd.qname}/${valueEl.name.text}`,
      name: `${fd.qname}/${valueEl.name.text}`,
      rel,
      parent: fd.id,
      domain,
      domainKind: kind,
      ...(declaredType ? { declaredType } : {}),
      decl: valueEl,
    };
    if (domain === null) {
      const init = call.arguments[0];
      const v = init ? valueOf(init) : undefined;
      (holder as { openValues?: string[] }).openValues = v !== undefined ? [v] : [];
    }
    useStateValue.set(valueSym, holder);
    holderById.set(holder.id, holder);
    if (setterEl && ts.isBindingElement(setterEl) && ts.isIdentifier(setterEl.name)) {
      const ss = checker.getSymbolAtLocation(setterEl.name);
      if (ss) useStateSetter.set(ss, holder);
    }
    return holder;
  };

  // ---------- reads, setters, predicates ----------

  const recvText = (e: ts.Expression): string => stripAll(e).getText(sf).replace(/\s+/g, "");

  const readOf = (e: ts.Expression): { holder: Holder; receiver: string } | undefined => {
    const x = stripAll(e);
    if (ts.isPropertyAccessExpression(x)) {
      const hd = holderOfSym(checker.getSymbolAtLocation(x.name));
      return hd ? { holder: hd, receiver: recvText(x.expression) } : undefined;
    }
    if (ts.isIdentifier(x)) {
      const hd = holderOfSym(checker.getSymbolAtLocation(x));
      return hd ? { holder: hd, receiver: "" } : undefined;
    }
    return undefined;
  };

  const fnNodeFromDecl = (d: ts.Node | undefined): ts.FunctionLikeDeclaration | undefined => {
    if (!d) return undefined;
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isGetAccessorDeclaration(d)) return d.body ? d : undefined;
    if ((ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && d.initializer) {
      const i = stripAll(d.initializer);
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) return i;
    }
    return undefined;
  };

  const setterCache = new Map<ts.Node, Setter | null>();
  const setterOf = (fn: ts.FunctionLikeDeclaration): Setter | null => {
    const hit = setterCache.get(fn);
    if (hit !== undefined) return hit;
    let res: Setter | null = null;
    const body = fn.body;
    if (body && ts.isBlock(body)) {
      for (const s of body.statements) {
        // A statement before the assignment that can leave the function makes the assignment conditional.
        if (exitsEarly(s)) break;
        if (!ts.isExpressionStatement(s)) continue;
        const e = stripParens(s.expression);
        if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const r = stripAll(e.right);
        if (!ts.isIdentifier(r)) continue;
        const pi = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === r.text);
        if (pi < 0) continue;
        const l = stripAll(e.left);
        let hd: Holder | null = null;
        let isThis = false;
        if (ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword) {
          hd = holderOfSym(checker.getSymbolAtLocation(l.name));
          isThis = true;
        } else if (ts.isIdentifier(l)) {
          hd = holderOfSym(checker.getSymbolAtLocation(l));
        }
        if (!hd) continue;
        // "At most once": no other assignment to the holder anywhere in the body.
        let count = 0;
        const scan = (n: ts.Node): void => {
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const rd = readOf(n.left);
            if (rd && rd.holder === hd) count++;
          }
          ts.forEachChild(n, scan);
        };
        scan(body);
        if (count === 1) res = { holder: hd, paramIndex: pi, assign: e, receiverIsThis: isThis };
        break;
      }
    }
    setterCache.set(fn, res);
    return res;
  };

  interface Pred {
    holder: Holder;
    values: string[];
    negated: boolean;
  }
  const predCache = new Map<ts.Node, Pred | null>();
  const predicateOfFn = (fn: ts.FunctionLikeDeclaration, depth = 0): Pred | null => {
    const hit = predCache.get(fn);
    if (hit !== undefined) return hit;
    predCache.set(fn, null);
    let res: Pred | null = null;
    if (depth < 3 && fn.parameters.length === 0 && fn.body && ts.isBlock(fn.body) && fn.body.statements.length === 1) {
      const s = fn.body.statements[0];
      if (s && ts.isReturnStatement(s) && s.expression) res = predOfExpr(s.expression, depth);
    }
    predCache.set(fn, res);
    return res;
  };
  const predOfExpr = (ex: ts.Expression, depth: number): Pred | null => {
    const e = stripAll(ex);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = predOfExpr(e.operand, depth + 1);
      return inner ? { ...inner, negated: !inner.negated } : null;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (!eq && !ne) return null;
      const l = stripAll(e.left);
      if (ts.isPropertyAccessExpression(l) && l.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const hd = holderOfSym(checker.getSymbolAtLocation(l.name));
        const v = valueOf(e.right);
        if (hd && v !== undefined) return { holder: hd, values: [v], negated: ne };
      }
      return null;
    }
    // this.p or this.p() of another predicate
    const p = predicateUse(e, depth + 1);
    return p ? { holder: p.holder, values: p.values, negated: p.negated } : null;
  };
  const predicateUse = (ex: ts.Expression, depth = 0): (Pred & { receiver: string }) | undefined => {
    const e = stripAll(ex);
    let access: ts.PropertyAccessExpression | undefined;
    if (ts.isPropertyAccessExpression(e)) access = e;
    else if (ts.isCallExpression(e) && e.arguments.length === 0 && ts.isPropertyAccessExpression(stripAll(e.expression))) access = stripAll(e.expression) as ts.PropertyAccessExpression;
    if (!access) return undefined;
    const sym = resolveAlias(checker.getSymbolAtLocation(access.name));
    const d = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (!d) return undefined;
    const isGetter = ts.isGetAccessorDeclaration(d);
    const isMethod = ts.isMethodDeclaration(d);
    if (ts.isCallExpression(e) ? !isMethod : !isGetter) return undefined;
    const p = predicateOfFn(d as ts.FunctionLikeDeclaration, depth);
    return p ? { ...p, receiver: recvText(access.expression) } : undefined;
  };

  /** A comparison of a holder with literals, or a predicate use. */
  const specOf = (ex: ts.Expression): Spec | undefined => {
    const e = stripParens(ex);
    if (ts.isBinaryExpression(e)) {
      const k = e.operatorToken.kind;
      const eq = k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken;
      const ne = k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
      if (!eq && !ne) return undefined;
      for (const [a, b] of [
        [e.left, e.right],
        [e.right, e.left],
      ] as const) {
        const rd = readOf(a);
        if (!rd) continue;
        const v = valueOf(b);
        if (v !== undefined) return { holder: rd.holder, receiver: rd.receiver, values: [v], negated: ne, node: e };
      }
      return undefined;
    }
    const pu = predicateUse(e);
    if (pu) return { holder: pu.holder, receiver: pu.receiver, values: pu.values, negated: pu.negated, node: e };
    return undefined;
  };

  // ---------- interpretation state ----------

  const writes = new Map<ts.Node, WriteRec>();
  const tests = new Map<ts.Node, TestRec>();
  const testIds = new Map<ts.Node, string>();
  const testId = (n: ts.Node): string => {
    let id = testIds.get(n);
    if (id === undefined) {
      id = h.uniqueId(`test:${h.pos(n.getStart(sf)).join(":")}`);
      testIds.set(n, id);
    }
    return id;
  };
  const writeIds = new Map<ts.Node, string>();

  const keyOf = (hd: Holder, receiver: string): string => `${hd.id}\u0000${receiver}`;
  const orderSet = (hd: Holder, s: Set<string>): string[] => {
    const dom = hd.domain ?? [];
    return [...s].sort((a, b) => {
      const ia = dom.indexOf(a);
      const ib = dom.indexOf(b);
      return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib) || (a < b ? -1 : a > b ? 1 : 0);
    });
  };

  /** Narrows an env by a test; returns null when `empty` is true and the result is empty. */
  const narrow = (env: Env, spec: Spec, positive: boolean, id: string | undefined, other: string | undefined, emptyDead = false): Env => {
    if (!env) return env;
    const hd = spec.holder;
    const key = keyOf(hd, spec.receiver);
    let target: Set<string> | null;
    if (positive) target = new Set(spec.values);
    else if (hd.domain) target = new Set(hd.domain.filter((v) => !spec.values.includes(v)));
    else target = null;
    const own = env.get(key);
    const cur: KS | undefined = own ?? (env.entry ? entryKS({ holder: hd, receiver: spec.receiver } as KS, env.entryStale) : undefined);
    let next: Set<string> | null;
    let stale = false;
    if (target === null) {
      next = cur?.set ? cur.set : null;
      stale = cur?.stale ?? false;
    } else if (!cur || cur.set === null) {
      next = target;
    } else if (cur.stale) {
      next = target;
    } else {
      const inter = new Set([...cur.set].filter((v) => target!.has(v)));
      if (inter.size === 0) {
        if (emptyDead) return null;
        next = null;
      } else next = inter;
    }
    const guards = cur ? [...cur.guards] : [];
    const texts = cur ? [...cur.texts] : [];
    if (id !== undefined && !guards.includes(id)) guards.push(id);
    if (other && !texts.includes(other)) texts.push(other);
    env.set(key, { holder: hd, receiver: spec.receiver, set: next, stale, guards, texts, ...(target === null && cur?.entry ? { entry: true } : {}) });
    return env;
  };

  interface Jump {
    kind: "switch" | "loop" | "block";
    breaks: Env[];
    continues: Env[];
    labels: string[];
  }
  let silent = false;
  let unitParent = "";
  let jumps: Jump[] = [];
  let caseStack: { label: string; key?: string }[] = [];
  interface TryCollector {
    writes: { key: string; hd: Holder; value: string | undefined; at: number; receiver: string }[];
    throwables: number[];
    awaited: boolean;
  }
  let tryStack: TryCollector[] = [];
  let currentFn: ts.Node | undefined;
  let currentClassId: string | undefined;

  /** Only the innermost try records; a closing try hands its record to the next one out. */
  const noteThrowable = (at: number, isAwait: boolean): void => {
    const t = tryStack[tryStack.length - 1];
    if (!t) return;
    t.throwables.push(at);
    if (isAwait) t.awaited = true;
  };
  let work = 0;
  const WORK_BUDGET = 20000;

  const enclosingClass = (n: ts.Node): ts.ClassLikeDeclaration | undefined => {
    for (let p = n.parent; p; p = p.parent) if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p;
    return undefined;
  };

  const eventFor = (key: string): string | undefined => {
    for (let i = caseStack.length - 1; i >= 0; i--) {
      const c = caseStack[i]!;
      if (c.key !== key) return c.label;
    }
    return undefined;
  };

  const lookupForWrite = (env: Env, hd: Holder, receiver: string | undefined): { ks?: KS; match?: "receiver" | "holder" } => {
    if (!env) return {};
    if (receiver !== undefined) {
      const ks = env.get(keyOf(hd, receiver));
      return ks ? { ks, match: "receiver" } : {};
    }
    for (const ks of env.values()) {
      if (ks.holder === hd && ks.guards.length > 0) return { ks, match: "holder" };
    }
    return {};
  };

  const doWrite = (
    env: Env,
    node: ts.Node,
    hd: Holder,
    op: "init" | "set",
    value: string | undefined,
    receiver: string | undefined,
    at: number,
    via?: string,
  ): void => {
    const { ks, match } = lookupForWrite(env, hd, receiver);
    const atEntry = op === "set" && receiver === "this" && env !== null && (ks ? ks.entry === true : match === undefined && env.entry === true);
    const rec: WriteRec = { node, parent: unitParent, holder: hd, op };
    if (value !== undefined) rec.value = value;
    else rec.dynamic = true;
    if (receiver !== undefined && receiver !== "") rec.receiver = receiver;
    if (ks && ks.set && ks.set.size > 0) {
      rec.from = orderSet(hd, ks.set);
      if (ks.stale) rec.stale = true;
    } else if (atEntry) {
      rec.fromEntry = true;
      if (ks ? ks.stale : env?.entryStale) rec.stale = true;
    }
    if (ks && ks.guards.length > 0 && match) {
      rec.guards = [...ks.guards];
      rec.guardMatch = match;
      if (ks.texts.length > 0) rec.guardText = ks.texts.join(" && ").slice(0, 120);
    }
    const ev = eventFor(keyOf(hd, receiver ?? ""));
    if (ev !== undefined) rec.event = ev;
    if (via) rec.via = via;
    const ol = lambdaLabel(node);
    if (ol) rec.ownerLabel = ol;
    if (!silent) writes.set(node, rec);
    if (receiver !== undefined && env) {
      const key = keyOf(hd, receiver);
      env.set(key, { holder: hd, receiver, set: value !== undefined ? new Set([value]) : null, stale: false, guards: [], texts: [] });
      tryStack[tryStack.length - 1]?.writes.push({ key, hd, value, at, receiver });
    }
  };

  // ---------- expression walker ----------

  const assignValue = (e: ts.Expression): string | undefined => valueOf(e);

  const objectLiteralHolder = (lit: ts.ObjectLiteralExpression, name: string): Holder | null => {
    const ctx = checker.getContextualType(lit);
    if (!ctx) return null;
    const parts = ctx.isUnion() ? ctx.types : [ctx];
    for (const t of parts) {
      const p = t.getProperty(name);
      const hd = p ? holderOfSym(p) : null;
      if (hd) return hd;
    }
    return null;
  };

  const exactlyDeclaring = (lit: ts.ObjectLiteralExpression, hd: Holder): boolean => {
    if (lit.properties.some((p) => ts.isSpreadAssignment(p))) return false;
    const ctx = checker.getContextualType(lit);
    if (!ctx || !hd.ownerSymbol) return false;
    return ctx.symbol === hd.ownerSymbol || ctx.aliasSymbol === hd.ownerSymbol;
  };

  const effectsAll = (nodesIn: readonly ts.Node[], env: Env): Env => {
    let cur = env;
    for (const n of nodesIn) cur = effects(n, cur);
    return cur;
  };

  const classUnit = (cls: ts.ClassLikeDeclaration): void => {
    const d = project.decls.get(cls);
    const savedParent = unitParent;
    const savedClass = currentClassId;
    const savedJumps = jumps;
    const savedCase = caseStack;
    const savedTry = tryStack;
    unitParent = d ? d.id : unitParent;
    currentClassId = d?.id;
    jumps = [];
    caseStack = [];
    tryStack = [];
    for (const m of cls.members) {
      if (ts.isPropertyDeclaration(m) && m.initializer && !fnNodeFromDecl(m)) {
        const env: Env = new Map();
        const hd = holderOfSym(checker.getSymbolAtLocation(m.name));
        const after = effects(m.initializer, env);
        void after;
        if (hd) doWrite(env, m.initializer, hd, "init", assignValue(m.initializer), undefined, m.end);
      }
    }
    unitParent = savedParent;
    currentClassId = savedClass;
    jumps = savedJumps;
    caseStack = savedCase;
    tryStack = savedTry;
  };

  const recordCallState = (call: ts.CallExpression, env: Env): void => {
    if (silent) return;
    const callee = stripAll(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    const cls = enclosingClass(call);
    const cd = cls ? project.decls.get(cls) : undefined;
    callAttrs.delete(call);
    if (!cd || !env) return;
    const state: Record<string, string[]> = {};
    const stale: string[] = [];
    const entry: string[] = [];
    for (const ks of env.values()) {
      if (ks.receiver !== "this" || ks.holder.classId !== cd.id || !ks.set || ks.set.size === 0) continue;
      state[ks.holder.id] = orderSet(ks.holder, ks.set);
      if (ks.stale) stale.push(ks.holder.id);
    }
    for (const hd of declared) {
      if (hd.classId !== cd.id || state[hd.id]) continue;
      const ks = env.get(keyOf(hd, "this"));
      if (ks ? ks.entry === true : env.entry === true) {
        entry.push(hd.id);
        if (ks ? ks.stale : env.entryStale) stale.push(hd.id);
      }
    }
    if (Object.keys(state).length === 0 && entry.length === 0) return;
    callAttrs.set(call, {
      ...(Object.keys(state).length ? { knownState: state } : {}),
      ...(stale.length ? { knownStale: stale.sort() } : {}),
      ...(entry.length ? { knownEntry: entry.sort() } : {}),
    });
  };

  const handleCall = (call: ts.CallExpression, env: Env): void => {
    noteThrowable(call.getStart(sf), false);
    recordCallState(call, env);
    const callee = stripAll(call.expression);
    // useState setter
    if (ts.isIdentifier(callee)) {
      const hd = useStateSetter.get(resolveAlias(checker.getSymbolAtLocation(callee)) as ts.Symbol);
      if (hd) {
        const a = call.arguments[0];
        const v = a && !ts.isArrowFunction(a) && !ts.isFunctionExpression(a) ? assignValue(a) : undefined;
        doWrite(env, call, hd, "set", v, "", call.getStart(sf), undefined);
        return;
      }
    }
    // setter helper
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
    if (!nameNode) return;
    const sym = resolveAlias(checker.getSymbolAtLocation(nameNode));
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    const fn = fnNodeFromDecl(decl);
    if (!fn || ts.isGetAccessorDeclaration(fn)) return;
    const st = setterOf(fn);
    if (!st) return;
    const receiver = ts.isPropertyAccessExpression(callee) ? recvText(callee.expression) : "";
    if (st.receiverIsThis !== ts.isPropertyAccessExpression(callee)) return;
    const a = call.arguments[st.paramIndex];
    const v = a ? assignValue(a) : undefined;
    const via = h.declOf(sym)?.id;
    doWrite(env, call, st.holder, "set", v, receiver, call.getStart(sf), via);
  };

  function effects(n: ts.Node, env: Env): Env {
    if (!env) env = new Map();
    if (isFnLike(n)) return env;
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
      classUnit(n);
      return env;
    }
    if (ts.isAwaitExpression(n)) {
      env = effects(n.expression, env);
      markStale(env);
      noteThrowable(n.getStart(sf), true);
      return env;
    }
    if (ts.isYieldExpression(n)) {
      if (n.expression) env = effects(n.expression, env);
      markStale(env);
      noteThrowable(n.getStart(sf), true);
      return env;
    }
    if (ts.isBinaryExpression(n)) {
      const k = n.operatorToken.kind;
      if (k === ts.SyntaxKind.EqualsToken) {
        env = effects(n.right, env);
        const l = stripAll(n.left);
        if (ts.isPropertyAccessExpression(l) || ts.isIdentifier(l)) {
          if (ts.isPropertyAccessExpression(l)) env = effects(l.expression, env);
          const rd = readOf(l);
          if (!rd && ts.isPropertyAccessExpression(l)) {
            // A set accessor that just stores its parameter in a holder: the assignment is the write.
            const asym = resolveAlias(checker.getSymbolAtLocation(l.name));
            const aset = asym?.declarations?.find((d) => ts.isSetAccessorDeclaration(d)) as ts.SetAccessorDeclaration | undefined;
            const st = aset ? setterOf(aset) : null;
            if (aset && st && st.receiverIsThis) {
              const inCtor = currentFn !== undefined && ts.isConstructorDeclaration(currentFn) && recvText(l.expression) === "this" && st.holder.classId !== undefined && st.holder.classId === currentClassId;
              doWrite(env, n, st.holder, inCtor ? "init" : "set", assignValue(n.right), recvText(l.expression), n.end, h.declOf(asym)?.id);
            }
            return env;
          }
          if (rd) {
            const sd = currentFn ? setterOfNode(currentFn) : null;
            if (sd && sd.assign === n) return env;
            const inCtor = currentFn !== undefined && ts.isConstructorDeclaration(currentFn) && rd.receiver === "this" && rd.holder.classId !== undefined && rd.holder.classId === currentClassId;
            doWrite(env, n, rd.holder, inCtor ? "init" : "set", assignValue(n.right), rd.receiver, n.end);
          }
          return env;
        }
        return effects(n.left, env);
      }
      if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
        if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
          const r = cond(n.left, env, { top: true, whole: false });
          const t2 = effects(n.right, r.t);
          return join(t2, r.f);
        }
        env = effects(n.left, env);
        const rt = effects(n.right, clone(env));
        return join(rt, env);
      }
    }
    if (ts.isConditionalExpression(n)) {
      const r = cond(n.condition, env, { top: true, whole: true, thenArm: h.armId(n.whenTrue), elseArm: h.armId(n.whenFalse) });
      return join(effects(n.whenTrue, r.t), effects(n.whenFalse, r.f));
    }
    if (ts.isCallExpression(n)) {
      env = effects(n.expression, env);
      env = effectsAll(n.arguments, env);
      handleCall(n, env);
      return env;
    }
    if (ts.isNewExpression(n)) {
      env = effects(n.expression, env);
      if (n.arguments) env = effectsAll(n.arguments, env);
      noteThrowable(n.getStart(sf), false);
      return env;
    }
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          env = effects(p.initializer, env);
          const name = ts.isComputedPropertyName(p.name) ? undefined : propName(p.name);
          if (name !== undefined) {
            const hd = objectLiteralHolder(n, name);
            if (hd) doWrite(env, p, hd, exactlyDeclaring(n, hd) ? "init" : "set", assignValue(p.initializer), undefined, p.end);
          }
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const hd = objectLiteralHolder(n, p.name.text);
          if (hd) {
            const vs = checker.getShorthandAssignmentValueSymbol(p);
            const t = vs ? checker.getTypeOfSymbolAtLocation(vs, p.name) : undefined;
            doWrite(env, p, hd, exactlyDeclaring(n, hd) ? "init" : "set", t ? encodeType(t) : undefined, undefined, p.end);
          }
        } else if (ts.isSpreadAssignment(p)) {
          env = effects(p.expression, env);
        }
      }
      return env;
    }
    if (ts.isVariableDeclaration(n)) {
      if (n.initializer) env = effects(n.initializer, env);
      if (ts.isArrayBindingPattern(n.name)) {
        const hd = registerUseState(n);
        if (hd && n.initializer && ts.isCallExpression(n.initializer)) {
          const a = n.initializer.arguments[0];
          if (a) doWrite(env, n.initializer, hd, "init", assignValue(a), "", n.initializer.end);
        }
        return env;
      }
      if (ts.isIdentifier(n.name) && n.initializer) {
        const hd = holderOfSym(checker.getSymbolAtLocation(n.name));
        if (hd) doWrite(env, n, hd, "init", assignValue(n.initializer), "", n.end);
      }
      return env;
    }
    ts.forEachChild(n, (c) => {
      env = effects(c, env);
    });
    return env;
  }

  const setterOfNode = (fn: ts.Node): Setter | null => {
    const f = ts.isConstructorDeclaration(fn) ? undefined : fnNodeFromDecl(fn) ?? (isFnLike(fn) ? (fn as ts.FunctionLikeDeclaration) : undefined);
    return f ? setterOf(f) : null;
  };

  // ---------- conditions ----------

  function flattenAnd(e: ts.Expression): ts.Expression[] {
    const x = stripParens(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...flattenAnd(x.left), ...flattenAnd(x.right)];
    return [e];
  }

  function cond(e0: ts.Expression, env0: Env, m: CondMode): { t: Env; f: Env } {
    let env: Env = env0 ?? new Map();
    const e = stripParens(e0);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const r = cond(e.operand, env, { ...m, thenArm: m.elseArm, elseArm: m.thenArm });
      return { t: r.f, f: r.t };
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const parts = flattenAnd(e);
      const fs: Env[] = [];
      let cur: Env = env;
      for (let i = 0; i < parts.length; i++) {
        const others = parts.filter((_, j) => j !== i).map((p) => p.getText(sf)).join(" && ");
        const r = cond(parts[i]!, cur, { top: m.top, whole: false, thenArm: m.thenArm, other: others });
        fs.push(r.f);
        cur = r.t;
      }
      let f: Env = fs[0] ?? null;
      for (let i = 1; i < fs.length; i++) f = join(f, fs[i]!);
      return { t: cur, f };
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const l = cond(e.left, env, { top: false, whole: false });
      const r = cond(e.right, l.f ?? env, { top: false, whole: false });
      const merged = join(l.t, r.t);
      return { t: merged, f: r.f };
    }
    const spec = specOf(e);
    if (!spec) {
      env = effects(e, env);
      return { t: env, f: clone(env) };
    }
    // Evaluate side effects of the operands (awaits and the like).
    if (ts.isBinaryExpression(e)) env = effects(e.left, effects(e.right, env));
    else env = effects(e, env);
    const id = testId(spec.node);
    const rec: TestRec = { node: spec.node, span: h.spanOf(spec.node), parent: unitParent, spec };
    if (m.top) {
      const arm = spec.negated ? m.elseArm : m.thenArm;
      const elseArm = spec.negated ? m.thenArm : m.elseArm;
      if (arm) rec.arm = arm;
      if (elseArm) rec.elseArm = elseArm;
      if (m.exit && m.whole) rec.exitGuard = true;
    }
    if (!silent) tests.set(spec.node, rec);
    if (!m.top) return { t: env, f: clone(env) };
    const other = m.other;
    const envF = clone(env);
    const t = narrow(env, spec, !spec.negated, id, other);
    const f = narrow(envF, spec, spec.negated, id, other);
    return { t, f };
  }

  // ---------- statements ----------

  const labelOf = (clause: ts.CaseClause | ts.DefaultClause): string => (ts.isCaseClause(clause) ? clause.expression.getText(sf).slice(0, 60) : "default");

  /** Every label directly in front of this statement. */
  const labelsOf = (s: ts.Node): string[] => {
    const out: string[] = [];
    for (let p = s.parent; p && ts.isLabeledStatement(p); p = p.parent) out.push(p.label.text);
    return out;
  };

  function stmts(list: readonly ts.Statement[], env: Env): Env {
    let cur: Env = env;
    let dead = false;
    for (const s of list) {
      const r = stmt(s, dead ? new Map() : cur);
      if (!dead) {
        cur = r;
        if (cur === null) dead = true;
      }
    }
    return dead ? null : cur;
  }

  const widenAll = (entry: Env): Env => {
    const out = clone(entry);
    if (!out) return out;
    out.entry = false;
    out.entryStale = false;
    for (const [k, v] of out) out.set(k, unknownKS(v));
    return out;
  };

  function loopFix(entry: Env, step: (head: Env) => Env): Env {
    // Out of budget (deeply nested loops): unknown and not entry, without iterating.
    if (work > WORK_BUDGET) return widenAll(entry);
    let head: Env = clone(entry);
    const saved = silent;
    silent = true;
    for (let i = 0; i < 3; i++) {
      const back = step(clone(head));
      const nh = join(clone(entry), back);
      if (sig(nh) === sig(head)) break;
      head = nh;
      if (work > WORK_BUDGET) {
        head = widenAll(head);
        break;
      }
      if (i === 2) {
        // widen: drop whatever still changes
        if (head) {
          for (const k of [...head.keys()]) {
            if (!entry || !entry.has(k) || sig(new Map([[k, head.get(k)!]])) !== sig(new Map([[k, entry.get(k)!]]))) head.set(k, unknownKS(head.get(k)!));
          }
        }
      }
    }
    silent = saved;
    return head;
  }

  function loop(s: ts.IterationStatement, env: Env): Env {
    const j: Jump = { kind: "loop", breaks: [], continues: [], labels: labelsOf(s) };
    let afterCond: (e: Env) => { t: Env; f: Env };
    let isDo = false;
    let isAwaitLoop = false;
    if (ts.isForStatement(s)) {
      if (s.initializer) env = ts.isVariableDeclarationList(s.initializer) ? effectsAll(s.initializer.declarations, env) : effects(s.initializer, env);
      afterCond = (e) => (s.condition ? cond(s.condition, e, { top: true, whole: true }) : { t: e, f: null });
    } else if (ts.isWhileStatement(s)) {
      afterCond = (e) => cond(s.expression, e, { top: true, whole: true });
    } else if (ts.isDoStatement(s)) {
      isDo = true;
      afterCond = (e) => cond(s.expression, e, { top: true, whole: true });
    } else {
      // for-of / for-in
      env = effects((s as ts.ForOfStatement | ts.ForInStatement).expression, env);
      afterCond = (e) => ({ t: e, f: clone(e) });
      if (ts.isForOfStatement(s) && s.awaitModifier) isAwaitLoop = true;
    }
    const body = s.statement;
    const run = (head: Env): { end: Env; f: Env } => {
      const saved = jumps;
      j.breaks = [];
      j.continues = [];
      jumps = [...saved, j];
      let bodyEnd: Env;
      let f: Env;
      if (isAwaitLoop) {
        // `for await` awaits the iterator on every pass, and that await can throw.
        markStale(head);
        noteThrowable(s.getStart(sf), true);
      }
      if (isDo) {
        const be = stmt(body, head);
        const merged = j.continues.reduce<Env>((acc, c) => join(acc, c), be);
        const r = afterCond(merged ?? new Map());
        bodyEnd = merged ? r.t : null;
        f = merged ? r.f : null;
        jumps = saved;
        return { end: bodyEnd, f };
      }
      const r = afterCond(head ?? new Map());
      f = r.f;
      const be = stmt(body, r.t);
      if (ts.isForStatement(s) && s.incrementor && be) effects(s.incrementor, be);
      bodyEnd = j.continues.reduce<Env>((acc, c) => join(acc, c), be);
      jumps = saved;
      return { end: bodyEnd, f };
    };
    const head = loopFix(env, (hd) => run(hd).end);
    const r = run(head);
    let after: Env = r.f;
    for (const b of j.breaks) after = join(after, b);
    return after;
  }

  function stmt(s: ts.Statement, env: Env): Env {
    work++;
    if (!env) env = new Map();
    if (ts.isBlock(s)) return stmts(s.statements, env);
    if (ts.isExpressionStatement(s)) return effects(s.expression, env);
    if (ts.isVariableStatement(s)) return effectsAll(s.declarationList.declarations, env);
    if (ts.isReturnStatement(s)) {
      if (s.expression) effects(s.expression, env);
      return null;
    }
    if (ts.isThrowStatement(s)) {
      effects(s.expression, env);
      noteThrowable(s.getStart(sf), false);
      return null;
    }
    if (ts.isBreakStatement(s)) {
      const target = s.label ? [...jumps].reverse().find((x) => x.labels.includes(s.label!.text)) : [...jumps].reverse().find((x) => x.kind !== "block");
      target?.breaks.push(env);
      return null;
    }
    if (ts.isContinueStatement(s)) {
      const target = s.label ? [...jumps].reverse().find((x) => x.labels.includes(s.label!.text)) : [...jumps].reverse().find((x) => x.kind === "loop");
      target?.continues.push(env);
      return null;
    }
    if (ts.isLabeledStatement(s)) {
      if (ts.isLabeledStatement(s.parent)) return stmt(s.statement, env); // the outermost label does the work
      let inner: ts.Statement = s.statement;
      while (ts.isLabeledStatement(inner)) inner = inner.statement;
      // Loops and switches register their own labels; any other labelled statement is a break target of its own.
      if (ts.isIterationStatement(inner, false) || ts.isSwitchStatement(inner)) return stmt(inner, env);
      const j: Jump = { kind: "block", breaks: [], continues: [], labels: labelsOf(inner) };
      const saved = jumps;
      jumps = [...saved, j];
      let out: Env = stmt(inner, env);
      jumps = saved;
      for (const b of j.breaks) out = join(out, b);
      return out;
    }
    if (ts.isIfStatement(s)) {
      const exitsThen = alwaysExits(s.thenStatement);
      const exitsElse = alwaysExits(s.elseStatement);
      const r = cond(s.expression, env, {
        top: true,
        whole: true,
        thenArm: h.armId(s.thenStatement),
        elseArm: s.elseStatement ? h.armId(s.elseStatement) : undefined,
        exit: exitsThen !== exitsElse,
      });
      const te = stmt(s.thenStatement, r.t);
      const ee = s.elseStatement ? stmt(s.elseStatement, r.f) : r.f;
      return join(te, ee);
    }
    if (ts.isForStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s)) return loop(s, env);
    if (ts.isSwitchStatement(s)) return switchStmt(s, env);
    if (ts.isTryStatement(s)) return tryStmt(s, env);
    if (ts.isClassDeclaration(s)) {
      classUnit(s);
      return env;
    }
    if (isFnLike(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s) || ts.isEmptyStatement(s)) return env;
    let cur: Env = env;
    ts.forEachChild(s, (c) => {
      cur = effects(c, cur);
    });
    return cur;
  }

  function switchStmt(s: ts.SwitchStatement, env0: Env): Env {
    let env: Env = effects(s.expression, env0 ?? new Map());
    const rd = readOf(s.expression);
    const clauses = s.caseBlock.clauses;
    const allValues: string[] = [];
    if (rd) {
      for (const c of clauses) {
        if (ts.isCaseClause(c)) {
          const v = valueOf(c.expression);
          if (v !== undefined) allValues.push(v);
        }
      }
    }
    const j: Jump = { kind: "switch", breaks: [], continues: [], labels: labelsOf(s) };
    const saved = jumps;
    jumps = [...saved, j];
    const key = rd ? keyOf(rd.holder, rd.receiver) : undefined;
    // Groups: consecutive clauses where the earlier ones have no statements.
    let fall: Env = null;
    let i = 0;
    const entryBase = env;
    while (i < clauses.length) {
      const group: (ts.CaseClause | ts.DefaultClause)[] = [];
      let k = i;
      for (;;) {
        const c = clauses[k]!;
        group.push(c);
        if (c.statements.length > 0 || k === clauses.length - 1) break;
        k++;
      }
      i = k + 1;
      const last = group[group.length - 1]!;
      const hasDefault = group.some((c) => ts.isDefaultClause(c));
      let entry: Env = clone(entryBase);
      const labels = group.filter(ts.isCaseClause).map((c) => labelOf(c));
      if (rd) {
        const vals: string[] = [];
        for (const c of group) {
          if (ts.isCaseClause(c)) {
            const v = valueOf(c.expression);
            if (v !== undefined) vals.push(v);
          }
        }
        if (vals.length > 0) {
          const first = group.find(ts.isCaseClause)!;
          const lastCase = [...group].reverse().find(ts.isCaseClause)! as ts.CaseClause;
          const spec: Spec = { holder: rd.holder, receiver: rd.receiver, values: vals, negated: false, node: first };
          const id = testId(first);
          const armTarget = hasDefault ? undefined : h.armId(last);
          const rec: TestRec = {
            node: first,
            span: { file: rel, start: h.pos(first.getStart(sf)), end: h.pos(lastCase.expression.getEnd()) },
            parent: unitParent,
            spec,
          };
          if (armTarget) rec.arm = armTarget;
          if (!silent) tests.set(first, rec);
          if (!hasDefault) entry = narrow(entry, spec, true, id, undefined);
        }
        if (hasDefault) {
          // Default is reached by anything the other groups do not take (this group's own case values stay in).
          const mine = new Set(vals);
          const others = allValues.filter((v) => !mine.has(v));
          if (others.length > 0) entry = narrow(entry, { holder: rd.holder, receiver: rd.receiver, values: others, negated: false, node: s }, false, undefined, undefined);
        }
      }
      const merged: Env = fall ? join(fall, entry) : entry;
      // The event of a switch on a different discriminant.
      const pushed = labels.length > 0 || hasDefault;
      if (pushed && !hasDefault) caseStack.push({ label: labels.join(" | ").slice(0, 60), key });
      let end: Env = merged;
      for (const c of group) end = stmts(c.statements, end ?? new Map());
      if (pushed && !hasDefault) caseStack.pop();
      fall = end;
    }
    jumps = saved;
    let after: Env = fall;
    for (const b of j.breaks) after = join(after, b);
    if (!clauses.some((c) => ts.isDefaultClause(c))) {
      let none: Env = clone(env);
      if (rd && allValues.length > 0) none = narrow(none, { holder: rd.holder, receiver: rd.receiver, values: allValues, negated: false, node: s }, false, undefined, undefined, true);
      after = join(after, none);
    }
    return after;
  }

  function tryStmt(s: ts.TryStatement, env: Env): Env {
    const entry = clone(env);
    const col: TryCollector = { writes: [], throwables: [], awaited: false };
    tryStack.push(col);
    const tryEnd = stmt(s.tryBlock, env);
    tryStack.pop();
    const outer = tryStack[tryStack.length - 1];
    if (outer) {
      outer.writes.push(...col.writes);
      outer.throwables.push(...col.throwables);
      if (col.awaited) outer.awaited = true;
    }
    // Catch / exceptional entry (A2).
    const exc: EnvMap = clone(entry) ?? new Map();
    let lastThrow = -1;
    for (const t of col.throwables) if (t > lastThrow) lastThrow = t;
    const followed = col.writes.filter((w) => lastThrow >= w.at);
    const touched = new Set(col.writes.map((w) => w.key));
    for (const key of touched) {
      const any = col.writes.find((w) => w.key === key)!;
      // An absent key still holds the entry value when the env keeps the marker.
      const base = entry?.get(key) ?? (entry?.entry ? entryKS({ holder: any.hd, receiver: any.receiver } as KS, entry.entryStale) : undefined);
      const ws = followed.filter((w) => w.key === key);
      if (base?.entry && base.set === null && ws.length === 0) {
        // No write can be seen by the catch: it still holds the entry value (E1 keeps it, stale or not).
        exc.set(key, cloneKS(base));
        continue;
      }
      if (!base || base.set === null) {
        exc.set(key, unknownKS({ holder: any.hd, receiver: any.receiver } as KS));
        continue;
      }
      const set = new Set(base.set);
      let unknown = false;
      for (const w of ws) {
        if (w.value === undefined) unknown = true;
        else set.add(w.value);
      }
      if (unknown) exc.set(key, unknownKS({ holder: any.hd, receiver: any.receiver } as KS));
      else exc.set(key, { holder: any.hd, receiver: any.receiver, set, stale: base.stale, guards: [...base.guards], texts: [...base.texts] });
    }
    if (col.awaited) markStale(exc);
    let catchEnd: Env = null;
    if (s.catchClause) {
      catchEnd = stmt(s.catchClause.block, clone(exc));
    }
    let after: Env = s.catchClause ? join(tryEnd, catchEnd) : tryEnd;
    if (s.finallyBlock) {
      // The finally block's own facts see every way in (normal and exceptional)...
      const finEntry = join(clone(after), clone(exc));
      stmt(s.finallyBlock, finEntry);
      // ...but what follows it comes only from the normal paths.
      if (after === null) return null;
      const saved = silent;
      silent = true;
      after = stmt(s.finallyBlock, after);
      silent = saved;
    }
    return after;
  }

  // ---------- units ----------

  // useState bindings and holder declarations for this file.
  const declared: Holder[] = [];
  const seenHolder = new Set<string>();
  const scan = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name)) {
      const hd = registerUseState(n);
      if (hd && !seenHolder.has(hd.id)) {
        seenHolder.add(hd.id);
        declared.push(hd);
      }
    } else if (ts.isPropertyDeclaration(n) || ts.isPropertySignature(n) || ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      const nm = (n as ts.NamedDeclaration).name;
      if (nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isPrivateIdentifier(nm))) {
        const hd = holderOfSym(checker.getSymbolAtLocation(nm));
        if (hd && hd.rel === rel && hd.decl === n && !seenHolder.has(hd.id)) {
          seenHolder.add(hd.id);
          declared.push(hd);
        }
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);

  const runUnit = (parent: string, fn: ts.Node | undefined, body: () => void): void => {
    unitParent = parent;
    currentFn = fn;
    currentClassId = fn ? (() => {
      const c = enclosingClass(fn);
      return c ? project.decls.get(c)?.id : undefined;
    })() : undefined;
    jumps = [];
    caseStack = [];
    tryStack = [];
    silent = false;
    work = 0;
    body();
  };

  const unitDecls: Decl[] = [];
  const collect = (n: ts.Node): void => {
    const d = project.decls.get(n);
    if (d && d.rel === rel && d.entity.type === "function" && !d.entity.module) unitDecls.push(d);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const decl of unitDecls) {
    const fn = fnNodeFromDecl(decl.node) ?? (isFnLike(decl.node) ? (decl.node as ts.FunctionLikeDeclaration) : undefined) ?? fnFromProp(decl.node);
    if (!fn || !fn.body) continue;
    const f = fn;
    runUnit(decl.id, f, () => {
      const env = entryEnv();
      if (ts.isConstructorDeclaration(f)) {
        // `constructor(private s: S = S.A)` initialises the field before the body runs.
        for (const p of f.parameters) {
          if (!p.initializer || !ts.isIdentifier(p.name)) continue;
          const hd = holderOfSym(checker.getSymbolAtLocation(p.name));
          if (hd && hd.decl === p) doWrite(env, p.initializer, hd, "init", assignValue(p.initializer), "this", p.end);
        }
      }
      if (ts.isBlock(f.body!)) stmts(f.body.statements, env);
      else effects(f.body!, env);
    });
  }
  function fnFromProp(n: ts.Node): ts.FunctionLikeDeclaration | undefined {
    if (ts.isPropertyAssignment(n)) {
      const i = stripAll(n.initializer);
      if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) return i;
    }
    return undefined;
  }
  // Lambdas are decls too: their node is the function itself and was handled above.
  runUnit(h.moduleId ?? rel, undefined, () => {
    stmts(sf.statements, new Map());
  });

  // ---------- emit ----------

  for (const hd of declared) {
    const values = hd.domain ?? (hd as { openValues?: string[] }).openValues ?? [];
    nodes.push({
      id: hd.id,
      facet: "state",
      kind: "state.holder",
      parent: hd.parent,
      attrs: { name: hd.name, domainKind: hd.domainKind, values, ...(hd.declaredType ? { declaredType: hd.declaredType } : {}) },
      span: h.spanOf(ts.isVariableDeclaration(hd.decl) || ts.isPropertyDeclaration(hd.decl) || ts.isPropertySignature(hd.decl) || ts.isBindingElement(hd.decl) || ts.isParameter(hd.decl) ? hd.decl : hd.decl),
      provenance: h.provenance,
    } as IRNode);
  }
  const emittedTests = new Set<string>();
  for (const t of tests.values()) {
    const id = testId(t.node);
    emittedTests.add(id);
    nodes.push({
      id,
      facet: "state",
      kind: "state.test",
      parent: t.parent,
      attrs: {
        holder: t.spec.holder.id,
        values: t.spec.values,
        ...(t.spec.negated ? { negated: true } : {}),
        ...(t.spec.receiver ? { receiver: t.spec.receiver } : {}),
        ...(t.arm ? { arm: t.arm } : {}),
        ...(t.elseArm ? { elseArm: t.elseArm } : {}),
        ...(t.exitGuard ? { exitGuard: true } : {}),
      },
      span: t.span,
      provenance: h.provenance,
    } as IRNode);
  }
  for (const w of writes.values()) {
    let id = writeIds.get(w.node);
    if (!id) {
      id = h.uniqueId(`write:${h.pos(w.node.getStart(sf)).join(":")}`);
      writeIds.set(w.node, id);
    }
    const guards = w.guards?.filter((g) => emittedTests.has(g));
    nodes.push({
      id,
      facet: "state",
      kind: "state.write",
      parent: w.parent,
      attrs: {
        holder: w.holder.id,
        op: w.op,
        ...(w.value !== undefined ? { value: w.value } : {}),
        ...(w.dynamic ? { dynamic: true } : {}),
        ...(w.receiver ? { receiver: w.receiver } : {}),
        ...(w.from ? { from: w.from } : {}),
        ...(w.stale ? { stale: true } : {}),
        ...(w.fromEntry ? { fromEntry: true } : {}),
        ...(guards && guards.length ? { guards, guardMatch: w.guardMatch } : {}),
        ...(w.event !== undefined ? { event: w.event } : {}),
        ...(guards && guards.length && w.guardText ? { guardText: w.guardText } : {}),
        ...(w.via ? { via: w.via } : {}),
        ...(w.ownerLabel ? { ownerLabel: w.ownerLabel } : {}),
      },
      span: h.spanOf(w.node),
      provenance: h.provenance,
    } as IRNode);
  }
  return { nodes, callAttrs };
}
