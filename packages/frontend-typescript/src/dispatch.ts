import ts from "typescript";
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
  owner: ts.InterfaceDeclaration | ts.ClassDeclaration;
  name: string;
}

function siteOf(member: ts.Node): Site | undefined {
  if ((ts.isMethodSignature(member) || ts.isPropertySignature(member)) && ts.isInterfaceDeclaration(member.parent)) {
    return { kind: "interface", owner: member.parent, name: propName(member.name) };
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
    const out = [...found.values()].sort(byId);
    this.results.set(key, out);
    return out;
  }
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
