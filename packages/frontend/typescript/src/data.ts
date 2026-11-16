import { relative, sep } from "node:path";
import ts from "typescript";
import type { IREdge, IRNode, Provenance, Span } from "@insight/ir";
import type { Project } from "./extract.js";

/**
 * Data facts: module-level variables, globals written through globalThis/window/self, and class statics (data.variable),
 * and the reads and writes of them (data.read, data.write). A reference is matched by the checker's symbol, so a shadowing
 * local never matches. A variable declared in another project file keeps that file's id. A global is one project-wide
 * variable (see GLOBAL_FILE), and a read of one is recorded only when project code writes it.
 */

export interface DataHelpers {
  project: Project;
  rel: string;
  /** The file's module entry id, `<rel>#(module)`, when its top-level code is executable. Module-level references use it, as calls do. */
  moduleId?: string;
  sf: ts.SourceFile;
  spanOf(node: ts.Node): Span;
  /** The span of a node in another project file (`file`'s source). */
  spanIn(file: string, node: ts.Node): Span;
  provenance: Provenance;
  /** Records that this file depends on another project file (its variable is a write target here). */
  dependOn(rel: string): void;
}

export interface DataOutput {
  nodes: IRNode[];
  edges: IREdge[];
}

type Access = "assign" | "update" | "mutate";

interface VarInfo {
  name: string;
  /** The class that holds a static field. Undefined for a module variable. */
  className?: string;
  storage: "module" | "class-static";
  exported: boolean;
  mutable: boolean;
  /** A `const` bound to a mutable container. It is mutable only when some function writes it (the flow layer decides). */
  constBound?: boolean;
}

/** Names whose property writes count as mutating the receiver. */
const MUTATORS = new Set(["set", "delete", "clear", "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "add"]);
/** Globals whose properties are module-wide state. */
const GLOBAL_HEADS = new Set(["globalThis", "window", "self"]);
/**
 * The file part of a TypeScript global's id. A global is one variable for the whole project: `globalThis.x`, `window.x` and
 * `self.x` written from any file share the node `<global>#global:x`, which the first file that writes it emits (the linker
 * keeps the first of duplicate nodes). A global has no owning file or module.
 */
const GLOBAL_FILE = "<global>";

const isAssignOp = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
const isIncDec = (k: ts.SyntaxKind) => k === ts.SyntaxKind.PlusPlusToken || k === ts.SyntaxKind.MinusMinusToken;

const hasMod = (n: ts.Node, k: ts.SyntaxKind): boolean => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === k);

const exportListCache = new WeakMap<ts.SourceFile, Set<string>>();
/** The local names a file lists in an `export { … }` without a module specifier. */
function exportedLocals(sf: ts.SourceFile): Set<string> {
  let names = exportListCache.get(sf);
  if (names === undefined) {
    names = new Set();
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && st.moduleSpecifier === undefined && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) names.add((e.propertyName ?? e.name).text);
      }
    }
    exportListCache.set(sf, names);
  }
  return names;
}

/** Whether a const's initializer is a function or class value: `(…)`, `as` or `satisfies` wrappers are looked through. */
function isFunctionValue(init: ts.Expression | undefined): boolean {
  let e: ts.Expression | undefined = init;
  while (e !== undefined && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e !== undefined && (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e));
}

/**
 * Whether a const's initializer can hold mutable state: any expression (a literal, a new expression, a call result such as
 * `vi.hoisted(…)`), except a frozen value (`Object.freeze(…)`) or an `as const` literal. A const counts as state only when a
 * write targets it (see `constBound`).
 */
function constIsMutable(init: ts.Expression | undefined): boolean {
  if (init === undefined) return false;
  if (ts.isAsExpression(init) && ts.isTypeReferenceNode(init.type) && ts.isIdentifier(init.type.typeName) && init.type.typeName.text === "const") return false;
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && callee.name.text === "freeze") return false;
  }
  return true;
}

/** A top-level `let`, `var` or `const` with a plain name. Undefined for anything else, and for ambient declarations. */
function topLevelVar(d: ts.VariableDeclaration): VarInfo | undefined {
  if (!ts.isIdentifier(d.name)) return undefined;
  const list = d.parent;
  if (!ts.isVariableDeclarationList(list) || !ts.isVariableStatement(list.parent) || !ts.isSourceFile(list.parent.parent)) return undefined;
  const stmt = list.parent;
  if (hasMod(stmt, ts.SyntaxKind.DeclareKeyword)) return undefined;
  const name = d.name.text;
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  // A const bound to a function or class is a function, not data.
  if (isConst && isFunctionValue(d.initializer)) return undefined;
  const exported = hasMod(stmt, ts.SyntaxKind.ExportKeyword) || exportedLocals(d.getSourceFile()).has(name);
  const container = isConst && constIsMutable(d.initializer);
  return { name, storage: "module", exported, mutable: isConst ? container : true, ...(container ? { constBound: true } : {}) };
}

/** A `static` field of a named class. Undefined otherwise. A static of an exported class counts as exported. */
function staticVar(p: ts.PropertyDeclaration): VarInfo | undefined {
  if (!hasMod(p, ts.SyntaxKind.StaticKeyword) || !ts.isIdentifier(p.name)) return undefined;
  const cls = p.parent;
  if (!(ts.isClassDeclaration(cls) || ts.isClassExpression(cls)) || cls.name === undefined) return undefined;
  const exported = ts.isClassDeclaration(cls) && (hasMod(cls, ts.SyntaxKind.ExportKeyword) || exportedLocals(p.getSourceFile()).has(cls.name.text));
  return {
    name: p.name.text,
    className: cls.name.text,
    storage: "class-static",
    exported,
    mutable: !hasMod(p, ts.SyntaxKind.ReadonlyKeyword),
  };
}

/** The id of a variable declared in file `rel`. */
const varId = (rel: string, info: { name: string; className?: string }): string => `${rel}#var:${info.className ? `${info.className}.` : ""}${info.name}`;
const globalId = (name: string): string => `${GLOBAL_FILE}#global:${name}`;

/** The parentheses and type assertions (`as`, `satisfies`, `!`) around an expression, looked through. */
function unwrapExpr(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
}

/** The property name of `globalThis.x`, `window.x` or `self.x` when the head is not a local of this program. Undefined otherwise. */
function globalPropertyName(ref: ts.PropertyAccessExpression, checker: ts.TypeChecker): string | undefined {
  const head = unwrapExpr(ref.expression);
  if (!ts.isIdentifier(head) || !GLOBAL_HEADS.has(head.text)) return undefined;
  const sym = checker.getSymbolAtLocation(head);
  if (sym?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile)) return undefined;
  return ref.name.text;
}

/** A file's first write of a global: the file, and the reference node that writes it. */
interface GlobalWrite {
  rel: string;
  node: ts.Node;
}

const writtenGlobalsCache = new WeakMap<Project, Map<string, GlobalWrite[]>>();
/**
 * Every global property that some file writes, with the files that write it sorted by file, each with its first write. A read
 * of a global is recorded only when some file writes it, so reads of host properties (`window.location`) that no project code
 * writes add no variables.
 */
function writtenGlobals(project: Project): Map<string, GlobalWrite[]> {
  const hit = writtenGlobalsCache.get(project);
  if (hit !== undefined) return hit;
  const names = new Map<string, GlobalWrite[]>();
  for (const rel of project.rels) {
    const sf = project.sourceFor(rel);
    if (sf === undefined) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const name = globalPropertyName(n, project.checker);
        if (name !== undefined && accessOf(n) !== undefined) {
          const writes = names.get(name) ?? [];
          // The walk is in source order, so the first write a file makes is the one kept.
          if (!writes.some((w) => w.rel === rel)) writes.push({ rel, node: n });
          names.set(name, writes);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const writes of names.values()) writes.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  writtenGlobalsCache.set(project, names);
  return names;
}

/**
 * The global writes in a file, found by syntax alone (no checker): each `globalThis.x`, `window.x` or `self.x` written, with
 * its span in the text. The API digest uses it, so a file whose global writes move or change is seen by its readers and
 * writers, even when the write sits in a function body. The head is not checked for shadowing, which only over-matches.
 */
export function globalWritesIn(sf: ts.SourceFile): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      const head = unwrapExpr(n.expression);
      if (ts.isIdentifier(head) && GLOBAL_HEADS.has(head.text) && accessOf(n) !== undefined) {
        out.push({ name: n.name.text, start: n.getStart(sf), end: n.getEnd() });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Whether a reference is a target of a destructuring assignment: an element of an array or object literal pattern (through
 * nested patterns, spreads and shorthand or renamed properties) that is the left side of `=`, or the head of a for-of.
 */
function isPatternTarget(ref: ts.Node): boolean {
  let node: ts.Node = ref;
  for (;;) {
    const p: ts.Node | undefined = node.parent;
    if (p === undefined) return false;
    if (ts.isShorthandPropertyAssignment(p) && p.name === node) node = p;
    else if (ts.isPropertyAssignment(p) && p.initializer === node) node = p;
    else if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) node = p;
    else if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)) node = p;
    else {
      return (ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) || (ts.isForOfStatement(p) && p.initializer === node);
    }
  }
}

/** How a reference is used: a write (with its access kind), or undefined for a read. A write through the reference's own properties or elements writes the reference (`state.cache.set(…)`, `a.b.c = 1`, `x[i].f = v`). */
function accessOf(ref: ts.Expression): Access | undefined {
  let node: ts.Node = ref;
  let p: ts.Node = node.parent;
  // Set once the reference is a link of a property or element chain: a write to the chain then writes the root.
  let deep = false;
  for (;;) {
    while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isNonNullExpression(p)) {
      node = p;
      p = p.parent;
    }
    if (ts.isBinaryExpression(p) && p.left === node && isAssignOp(p.operatorToken.kind)) {
      if (deep) return "mutate";
      return p.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "assign" : "update";
    }
    if (!deep && (ts.isForInStatement(p) || ts.isForOfStatement(p)) && p.initializer === node) return "assign";
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && isIncDec(p.operator)) return deep ? "mutate" : "update";
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) {
      const gp = p.parent;
      if (ts.isPropertyAccessExpression(p) && ts.isCallExpression(gp) && gp.expression === p && MUTATORS.has(p.name.text)) return "mutate";
      deep = true;
      node = p;
      p = gp;
      continue;
    }
    // A destructuring target writes the reference, or the chain it is in (`[a.b] = xs` mutates `a`).
    if (isPatternTarget(node)) return deep ? "mutate" : "assign";
    return undefined;
  }
}

export function emitData(h: DataHelpers): DataOutput {
  const { project, rel, sf, provenance } = h;
  const moduleId = h.moduleId ?? rel;
  const checker = project.checker;
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const relOf = (file: string) => relative(project.root, file).split(sep).join("/");

  /** The function a reference sits in, by the same rule the walk uses for calls: the nearest function, else the file. */
  const enclosing = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isSourceFile(n)) return moduleId;
      const d = project.decls.get(n);
      if (d !== undefined && d.entity.type === "function" && d.entity.module !== true) return d.id;
    }
    return moduleId;
  };

  const pushNode = (node: IRNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };

  const declare = (decl: ts.VariableDeclaration | ts.PropertyDeclaration, info: VarInfo) => {
    // A static's parent is its class; a module variable's is the file.
    const parent = ts.isPropertyDeclaration(decl) ? project.decls.get(decl.parent)?.id ?? rel : rel;
    pushNode({
      id: varId(rel, info),
      facet: "data",
      kind: "data.variable",
      parent,
      attrs: {
        name: info.name,
        qualifiedName: info.className ? `${info.className}.${info.name}` : info.name,
        storage: info.storage,
        exported: info.exported,
        mutable: info.mutable,
        ...(info.constBound === true ? { constBound: true } : {}),
      },
      span: h.spanOf(decl),
      provenance,
    });
  };

  const pushEdge = (from: string, to: string, kind: "data.read" | "data.write", ref: ts.Node, how: Access | undefined) => {
    const span = h.spanOf(ref);
    const key = `${from}|${to}|${kind}|${JSON.stringify(span)}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      from,
      to,
      facet: "data",
      kind,
      attrs: how === undefined ? {} : { how },
      span,
      provenance: how === "mutate" ? { frontend: provenance.frontend, confidence: "heuristic" } : provenance,
    });
  };

  /** The variable a reference names, by the checker's symbol, when it is a project variable. */
  const variableOf = (ref: ts.Identifier | ts.PropertyAccessExpression): { id: string; declRel: string } | undefined => {
    const nameNode = ts.isPropertyAccessExpression(ref) ? ref.name : ref;
    let sym: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(ref.parent) && ref.parent.name === ref) {
      sym = checker.getShorthandAssignmentValueSymbol(ref.parent);
    } else {
      sym = checker.getSymbolAtLocation(nameNode);
    }
    if (sym !== undefined && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl === undefined) return undefined;
    const declSf = decl.getSourceFile();
    if (declSf.isDeclarationFile) return undefined;
    const declRel = declSf.fileName === sf.fileName ? rel : relOf(declSf.fileName);
    if (declRel !== rel && !project.rels.has(declRel)) return undefined;
    const info = ts.isVariableDeclaration(decl) ? topLevelVar(decl) : ts.isPropertyDeclaration(decl) ? staticVar(decl) : undefined;
    if (info === undefined) return undefined;
    return { id: varId(declRel, info), declRel };
  };

  const consider = (ref: ts.Identifier | ts.PropertyAccessExpression) => {
    const parent = ref.parent;
    if (ts.isExportSpecifier(parent) || ts.isImportSpecifier(parent)) return;
    // A name that belongs to a declaration, a property, an import or export, or a member access is not a reference here.
    if (ts.isIdentifier(ref) && (parent as { name?: ts.Node }).name === ref && !ts.isShorthandPropertyAssignment(parent)) return;
    if (ts.isIdentifier(ref) && ts.isTypeNode(parent)) return;
    if (ts.isPropertyAccessExpression(ref) && ts.isTypeNode(parent)) return;

    if (ts.isPropertyAccessExpression(ref)) {
      const name = globalPropertyName(ref, checker);
      if (name !== undefined) {
        const how = accessOf(ref);
        // A read of a global counts only when project code writes it (see writtenGlobals).
        const writers = writtenGlobals(project).get(name);
        if (how === undefined && writers === undefined) return;
        // Every reference depends on each file that writes the global. A writer change re-extracts the reference, and a
        // read whose writers are all gone is dropped. Writers also depend on each other, since they share the node below.
        for (const w of writers ?? []) h.dependOn(w.rel);
        const id = globalId(name);
        if (how !== undefined) {
          // Every writer emits the same node: the first writer's write is its span, whichever file is extracted.
          const first = writers![0]!;
          pushNode({
            id,
            facet: "data",
            kind: "data.variable",
            attrs: { name, qualifiedName: `globalThis.${name}`, storage: "global", exported: true, mutable: true },
            span: h.spanIn(first.rel, first.node),
            provenance,
          });
        }
        pushEdge(enclosing(ref), id, how === undefined ? "data.read" : "data.write", ref, how);
        return;
      }
    }

    const target = variableOf(ref);
    if (target === undefined) return;
    if (target.declRel !== rel) h.dependOn(target.declRel);
    const how = accessOf(ref);
    pushEdge(enclosing(ref), target.id, how === undefined ? "data.read" : "data.write", ref, how);
  };

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      const info = topLevelVar(n);
      if (info !== undefined) declare(n, info);
    } else if (ts.isPropertyDeclaration(n)) {
      const info = staticVar(n);
      if (info !== undefined) declare(n, info);
    } else if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      consider(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return { nodes, edges };
}
