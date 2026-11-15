import ts from "typescript";
import { relative, sep } from "node:path";
import type { Decl, Project } from "./extract.js";

/** The most candidates one dispatch site records. Past this, the first ids in order are kept and the edge is marked truncated. */
export const MAX_DISPATCH_TARGETS = 32;

/**
 * A member's name as qualified names spell it: the text of an identifier or literal key, the source text of a computed key.
 * `'a-b'` and `a-b` are both `a-b`, so an object literal and a class name their members the same way.
 */
export function propName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : name.getText();
}

const hasAbstract = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false);

const byId = (a: Decl, b: Decl): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The symbol an alias names, or the alias itself when it does not resolve. */
function aliased(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) return sym;
  try {
    return checker.getAliasedSymbol(sym);
  } catch {
    return sym;
  }
}

/**
 * A member whose call dispatches on the receiver's type: a member of an interface (method or function-typed property),
 * or an abstract member of an abstract class. Such a member has no body, so the call names no implementation.
 */
interface Site {
  kind: "interface" | "abstract";
  owner: ts.InterfaceDeclaration | ts.ClassDeclaration | ts.TypeAliasDeclaration;
  name: string;
}

function siteOf(member: ts.Node): Site | undefined {
  if ((ts.isMethodSignature(member) || ts.isPropertySignature(member)) && ts.isInterfaceDeclaration(member.parent)) {
    return { kind: "interface", owner: member.parent, name: propName(member.name) };
  }
  // A member of a named object type, `type X = { m(): T }`, dispatches like an interface member.
  if ((ts.isMethodSignature(member) || ts.isPropertySignature(member)) && ts.isTypeLiteralNode(member.parent) && ts.isTypeAliasDeclaration(member.parent.parent)) {
    return { kind: "interface", owner: member.parent.parent, name: propName(member.name) };
  }
  if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && hasAbstract(member) && ts.isClassDeclaration(member.parent)) {
    return { kind: "abstract", owner: member.parent, name: propName(member.name) };
  }
  return undefined;
}

/** What a class declares by `extends`, or an interface or class by `implements` and `extends`, as indexed declarations. */
interface Heritage {
  /** The class this class extends. */
  base?: Decl;
  /** The interfaces a class implements, or an interface extends. */
  supers: Decl[];
}

/**
 * Who implements what, over the indexed files only. Built once per project, on the first dispatch that needs it.
 * Implementations are found by walking base classes, so an override is the target and an inherited member is its
 * nearest declaration.
 */
class Hierarchy {
  private readonly heritages = new Map<string, Heritage>();
  private readonly closures = new Map<string, Set<string>>();
  private readonly implemented = new Map<string, Set<string>>();
  private readonly results = new Map<string, Decl[]>();
  private classList: Decl[] | undefined;
  private literalList: { iface: Decl; members: Map<string, Decl> }[] | undefined;

  constructor(private readonly project: Project) {}

  /** The indexed declaration of a class or interface node, or of the source it was built from. */
  declOfNode(node: ts.Node): Decl | undefined {
    return this.project.decls.get(node) ?? this.project.sourceOf(node);
  }

  /** The class or interface an expression's static type is, when the project declares it. */
  receiverType(receiver: ts.Expression): Decl | undefined {
    const decl = this.project.checker.getTypeAtLocation(receiver).getSymbol()?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
    return decl && this.declOfNode(decl);
  }

  /** The class or interface a heritage clause names, when the project declares it. */
  private typeNamed(expr: ts.Expression): Decl | undefined {
    const checker = this.project.checker;
    const sym = aliased(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr));
    const node = sym?.declarations?.find((d) => ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d));
    return node && this.declOfNode(node);
  }

  heritage(decl: Decl): Heritage {
    const known = this.heritages.get(decl.id);
    if (known) return known;
    const out: Heritage = { supers: [] };
    this.heritages.set(decl.id, out);
    const node = decl.node;
    if (!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) return out;
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        const target = this.typeNamed(type.expression);
        if (target === undefined) continue;
        if (ts.isClassDeclaration(node) && clause.token === ts.SyntaxKind.ExtendsKeyword) {
          if (ts.isClassDeclaration(target.node)) out.base = target;
        } else if (ts.isInterfaceDeclaration(target.node)) {
          out.supers.push(target);
        }
      }
    }
    return out;
  }

  /** An interface and every interface it extends, directly or through others. */
  private closure(iface: Decl): Set<string> {
    const known = this.closures.get(iface.id);
    if (known) return known;
    const out = new Set([iface.id]);
    this.closures.set(iface.id, out);
    for (const s of this.heritage(iface).supers) for (const id of this.closure(s)) out.add(id);
    return out;
  }

  /** Every interface a class implements: its own, those they extend, and those its base classes implement. */
  private implementedBy(cls: Decl): Set<string> {
    const known = this.implemented.get(cls.id);
    if (known) return known;
    const out = new Set<string>();
    this.implemented.set(cls.id, out);
    const h = this.heritage(cls);
    for (const s of h.supers) for (const id of this.closure(s)) out.add(id);
    if (h.base) for (const id of this.implementedBy(h.base)) out.add(id);
    return out;
  }

  private extendsClass(cls: Decl, id: string): boolean {
    const seen = new Set<string>();
    for (let base = this.heritage(cls).base; base && !seen.has(base.id); base = this.heritage(base).base) {
      if (base.id === id) return true;
      seen.add(base.id);
    }
    return false;
  }

  /** Every indexed class, in id order. */
  private classes(): Decl[] {
    this.classList ??= [...this.project.decls.values()]
      .filter((d) => d.entity.type === "type" && d.entity.typeKind === "class" && ts.isClassDeclaration(d.node))
      .sort(byId);
    return this.classList;
  }

  /** The function a class's member of this name is: its own, else the nearest base class's. Undefined when none has a body. */
  private memberOf(start: Decl, name: string): Decl | undefined {
    const seen = new Set<string>();
    for (let cls: Decl | undefined = start; cls && !seen.has(cls.id); cls = this.heritage(cls).base) {
      seen.add(cls.id);
      for (const member of (cls.node as ts.ClassDeclaration).members) {
        const decl = this.project.decls.get(member);
        if (decl?.entity.type === "function" && member.name !== undefined && propName(member.name) === name) return decl;
      }
    }
    return undefined;
  }

  /**
   * The interface an object literal's contextual type names, when the project declares it. Unions are not. A named object
   * type `type X = { … }` counts as an interface for this.
   */
  private contextualInterface(literal: ts.ObjectLiteralExpression): Decl | undefined {
    const type = this.project.checker.getContextualType(literal);
    if (type === undefined || type.isUnion()) return undefined;
    const node =
      type.getSymbol()?.declarations?.find((d) => ts.isInterfaceDeclaration(d)) ??
      type.aliasSymbol?.declarations?.find((d) => ts.isTypeAliasDeclaration(d) && ts.isTypeLiteralNode(d.type));
    return node && this.declOfNode(node);
  }

  /** The function-valued members of an object literal, by name. */
  private functionMembers(literal: ts.ObjectLiteralExpression): Map<string, Decl> {
    return functionMembersOf(this.project, literal);
  }

  /**
   * Every object literal in the indexed files whose contextual type is an indexed interface, with that interface and its
   * function members. A literal returned from `(): I`, assigned to an `I`-annotated variable, `satisfies I`, or passed as an
   * `I` argument all have one. Built once per project.
   */
  private literalImplementations(): { iface: Decl; members: Map<string, Decl> }[] {
    if (this.literalList !== undefined) return this.literalList;
    const out: { iface: Decl; members: Map<string, Decl> }[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const iface = this.contextualInterface(n);
        if (iface) out.push({ iface, members: this.functionMembers(n) });
      }
      ts.forEachChild(n, visit);
    };
    for (const rel of this.project.rels) {
      const sf = this.project.sourceFor(rel);
      if (sf) visit(sf);
    }
    this.literalList = out;
    return out;
  }

  /** The implementations of a site's member, sorted by id. Each is the function the member runs for one concrete type. */
  dispatch(site: Site, owner: Decl): Decl[] {
    const key = `${site.kind}\0${owner.id}\0${site.name}`;
    const known = this.results.get(key);
    if (known) return known;
    const found = new Map<string, Decl>();
    for (const cls of this.classes()) {
      const reached =
        site.kind === "interface" ? this.implementedBy(cls).has(owner.id) : !hasAbstract(cls.node) && this.extendsClass(cls, owner.id);
      if (!reached) continue;
      const impl = this.memberOf(cls, site.name);
      if (impl) found.set(impl.id, impl);
    }
    // An object literal implements the interface its contextual type names, and every interface that one extends.
    if (site.kind === "interface") {
      for (const lit of this.literalImplementations()) {
        if (!this.closure(lit.iface).has(owner.id)) continue;
        const impl = lit.members.get(site.name);
        if (impl) found.set(impl.id, impl);
      }
    }
    const out = [...found.values()].sort(byId);
    this.results.set(key, out);
    return out;
  }
}

/** An expression with its parentheses, type assertions, non-null and `satisfies` wrappers removed. */
function unwrap(expr: ts.Expression): ts.Expression {
  let out = expr;
  while (ts.isParenthesizedExpression(out) || ts.isAsExpression(out) || ts.isNonNullExpression(out) || ts.isSatisfiesExpression(out) || ts.isTypeAssertionExpression(out)) {
    out = out.expression;
  }
  return out;
}

/** The indexed declaration of a node: the node's own, or the source it was built from. */
const declAt = (project: Project, node: ts.Node): Decl | undefined => project.decls.get(node) ?? project.sourceOf(node);

/** The indexed declaration a symbol names, following an alias. A const bound to a value resolves to that value's declaration. */
function symbolDecl(project: Project, sym: ts.Symbol | undefined): Decl | undefined {
  const resolved = aliased(project.checker, sym);
  const node = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  if (node === undefined) return undefined;
  const found = declAt(project, node);
  if (found !== undefined) return found;
  if (ts.isVariableDeclaration(node) && node.initializer !== undefined) return declAt(project, unwrap(node.initializer));
  return undefined;
}

/** The function an expression evaluates to, when the project declares it: a function literal, or a name bound to one. */
function functionOf(project: Project, expr: ts.Expression): Decl | undefined {
  const e = unwrap(expr);
  let decl: Decl | undefined;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    decl = declAt(project, e) ?? declAt(project, expr);
  } else if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    decl = symbolDecl(project, project.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
  }
  return decl?.entity.type === "function" ? decl : undefined;
}

/**
 * The function a member of an object literal is: a method, or a property whose value is a function the project declares.
 * A bound literal's property is keyed by the property itself. Any other is found through its value, a lambda or a name.
 */
function memberDecl(project: Project, m: ts.ObjectLiteralElementLike): Decl | undefined {
  if (ts.isMethodDeclaration(m)) return declAt(project, m);
  if (ts.isPropertyAssignment(m)) return declAt(project, m) ?? functionOf(project, m.initializer);
  if (ts.isShorthandPropertyAssignment(m)) return symbolDecl(project, project.checker.getShorthandAssignmentValueSymbol(m));
  return undefined;
}

/** The function-valued members of an object literal, by name: its methods and its function-valued properties. */
export function functionMembersOf(project: Project, literal: ts.ObjectLiteralExpression): Map<string, Decl> {
  const out = new Map<string, Decl>();
  for (const m of literal.properties) {
    if (m.name === undefined) continue;
    const decl = memberDecl(project, m);
    if (decl?.entity.type === "function") out.set(propName(m.name), decl);
  }
  return out;
}

/** The project-relative path of the file a node is in, when the project indexes that file. */
function relOf(project: Project, node: ts.Node): string | undefined {
  const rel = relative(project.root, node.getSourceFile().fileName).split(sep).join("/");
  return project.rels.has(rel) ? rel : undefined;
}

/**
 * The object or array literal an expression names: the literal itself, or the literal a const declaration is bound to.
 * Only a const counts, so a mutable name is never taken as a fixed registry.
 */
function literalOf(project: Project, expr: ts.Expression): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  let e = unwrap(expr);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const sym = aliased(project.checker, project.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
    const node = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (node === undefined || !ts.isVariableDeclaration(node) || node.initializer === undefined) return undefined;
    if ((ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) === 0) return undefined;
    e = unwrap(node.initializer);
  }
  return ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e) ? e : undefined;
}

/** The value expressions a literal holds: each property's initializer, or each array element. */
function valuesOf(lit: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): ts.Expression[] {
  if (ts.isArrayLiteralExpression(lit)) return [...lit.elements];
  const out: ts.Expression[] = [];
  for (const m of lit.properties) if (ts.isPropertyAssignment(m)) out.push(m.initializer);
  return out;
}

/** Keeps the first declaration of each id, sorted by id. */
function uniqueSorted(decls: Decl[]): Decl[] {
  const byKey = new Map<string, Decl>();
  for (const d of decls) byKey.set(d.id, d);
  return [...byKey.values()].sort(byId);
}

/**
 * The functions a registry lookup can run, for a call whose callee is a lookup into a fixed registry. Forms:
 *  - `X[k](…)`: each function member of the const literal X (or each function element of an array X);
 *  - `X[k].m(…)`: the member `m` of each literal that X holds.
 * Undefined when the callee is neither.
 */
function lookupTargets(project: Project, callee: ts.Expression, dependOn?: (rel: string) => void): Decl[] | undefined {
  const e = unwrap(callee);
  let registry: ts.Expression;
  let member: string | undefined;
  if (ts.isElementAccessExpression(e)) {
    registry = e.expression;
  } else if (ts.isPropertyAccessExpression(e) && ts.isElementAccessExpression(unwrap(e.expression))) {
    registry = (unwrap(e.expression) as ts.ElementAccessExpression).expression;
    member = e.name.text;
  } else {
    return undefined;
  }
  const lit = literalOf(project, registry);
  if (lit === undefined) return undefined;
  const out: Decl[] = [];
  if (member === undefined) {
    if (ts.isObjectLiteralExpression(lit)) out.push(...functionMembersOf(project, lit).values());
    else for (const el of lit.elements) {
      const fn = functionOf(project, el);
      if (fn) out.push(fn);
    }
  } else {
    for (const v of valuesOf(lit)) {
      const inner = literalOf(project, v);
      if (inner === undefined || !ts.isObjectLiteralExpression(inner)) continue;
      const fn = functionMembersOf(project, inner).get(member);
      if (fn) out.push(fn);
      const rel = relOf(project, inner);
      if (rel !== undefined) dependOn?.(rel);
    }
  }
  const rel = relOf(project, lit);
  if (rel !== undefined) dependOn?.(rel);
  return out.length > 0 ? uniqueSorted(out) : undefined;
}

/**
 * The functions a method call may run when its receiver is not typed by an interface, through a fixed registry of functions:
 * a lookup `X[k](…)` into an object or array the project binds to a const, a `X[k].m(…)` lookup into those objects, a const
 * bound to either, or a member name that several object literals in the project all declare, such as `t.parse()` over
 * `Object.values(T)` of an untyped table. Undefined for any other call. `dependOn` receives each project file the answer
 * was read from.
 */
export function registryFor(project: Project, call: ts.CallExpression, dependOn?: (rel: string) => void): Decl[] | undefined {
  const callee = unwrap(call.expression);
  // A const bound to a lookup: `const run = impl[k] as F; run(…)`.
  if (ts.isIdentifier(callee)) {
    const sym = aliased(project.checker, project.checker.getSymbolAtLocation(callee));
    const node = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (node === undefined || !ts.isVariableDeclaration(node) || node.initializer === undefined) return undefined;
    if ((ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) === 0) return undefined;
    return lookupTargets(project, node.initializer, dependOn);
  }
  const looked = lookupTargets(project, callee, dependOn);
  if (looked !== undefined || !ts.isPropertyAccessExpression(callee)) return looked;
  // A member several object literals declare, all in project files: the untyped table's `t.parse()`.
  const decls = project.checker.getSymbolAtLocation(callee.name)?.declarations ?? [];
  if (decls.length < 2) return undefined;
  const out: Decl[] = [];
  for (const d of decls) {
    if (!(ts.isPropertyAssignment(d) || ts.isMethodDeclaration(d) || ts.isShorthandPropertyAssignment(d)) || !ts.isObjectLiteralExpression(d.parent)) return undefined;
    const rel = relOf(project, d);
    if (rel === undefined) return undefined;
    dependOn?.(rel);
    const fn = memberDecl(project, d);
    if (fn?.entity.type === "function") out.push(fn);
  }
  return out.length > 0 ? uniqueSorted(out) : undefined;
}

const hierarchies = new WeakMap<Project, Hierarchy>();

/** The dispatch a callee's symbol makes: the interface or abstract class that owns it, and the implementations it may run. */
export interface Dispatch {
  owner: Decl;
  /** Sorted by id. Not capped: the caller keeps at most MAX_DISPATCH_TARGETS. */
  targets: Decl[];
}

/**
 * The dispatch a call makes when its callee names an interface member or an abstract class member, the symbol the
 * checker reports for a call through an interface-typed or abstract-typed receiver. Undefined for any other symbol.
 *
 * The owner is the receiver's static type when that is an interface (or a class, for an abstract member), so that
 * `(s: Store) => s.save()` with `save` declared on `Repo` dispatches to the implementers of `Store` only. Without a
 * usable receiver type, the owner is the declaration the symbol names.
 */
export function dispatchFor(project: Project, sym: ts.Symbol | undefined, receiver?: ts.Expression): Dispatch | undefined {
  const resolved = aliased(project.checker, sym);
  const node = resolved?.valueDeclaration ?? resolved?.declarations?.[0];
  const site = node && siteOf(node);
  if (!site) return undefined;
  let hierarchy = hierarchies.get(project);
  if (!hierarchy) {
    hierarchy = new Hierarchy(project);
    hierarchies.set(project, hierarchy);
  }
  const declaring = hierarchy.declOfNode(site.owner);
  if (!declaring) return undefined;
  const typed = receiver === undefined ? undefined : hierarchy.receiverType(receiver);
  const owner = typed !== undefined && (site.kind === "interface" ? ts.isInterfaceDeclaration(typed.node) : ts.isClassDeclaration(typed.node)) ? typed : declaring;
  return { owner, targets: hierarchy.dispatch(site, owner) };
}
