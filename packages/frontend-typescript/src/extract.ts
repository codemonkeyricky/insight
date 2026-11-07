import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import type { IREdge, IRFinding, IRNode, IRRecord, NodeId, Provenance, Span, UnresolvedRef } from "@insight/ir";
import type { IRBatch } from "@insight/sdk";
import { importBindings, matchCall, matchEnvRead, matchWorker, type ImportBinding } from "./effects.js";
import { scriptKind } from "./digest.js";

export const FRONTEND_ID = "frontend-typescript";
export const SOURCE_RE = /\.(?:[mc]?[jt]sx?)$/;
const PROV: Provenance = { frontend: FRONTEND_ID, confidence: "exact" };

type Entity =
  | { type: "type"; name: string; typeKind: "class" | "interface" | "enum" | "alias" }
  | { type: "function"; name: string; async: boolean; generator: boolean; exported: boolean };

interface Decl {
  id: NodeId;
  rel: string;
  qname: string;
  entity: Entity;
}

/** A parsed set of project files, with a checker and every declaration that can be a call target. */
export interface Project {
  root: string;
  rels: Set<string>;
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  host: ts.CompilerHost;
  decls: Map<ts.Node, Decl>;
  sourceFor(rel: string): ts.SourceFile | undefined;
}

const propName = (name: ts.PropertyName): string => name.getText();
const isFnInit = (n: ts.Expression): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);

/** Decides whether a node becomes a structure node. Shared by the declaration pass and the emit pass. */
function classify(node: ts.Node): Entity | undefined {
  // fnNode carries the async modifier; owner carries the export modifier (for a variable, its statement).
  const fn = (name: string, owner: ts.Node, fnNode: ts.Node): Entity => ({
    type: "function",
    name,
    async: hasModifier(fnNode, ts.SyntaxKind.AsyncKeyword),
    generator: (fnNode as ts.FunctionLikeDeclaration).asteriskToken !== undefined,
    exported: (ts.getCombinedModifierFlags(owner as ts.Declaration) & ts.ModifierFlags.Export) !== 0,
  });
  if (ts.isClassDeclaration(node)) return { type: "type", name: node.name?.text ?? "default", typeKind: "class" };
  if (ts.isInterfaceDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "interface" };
  if (ts.isEnumDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "enum" };
  if (ts.isTypeAliasDeclaration(node)) return { type: "type", name: node.name.text, typeKind: "alias" };
  if (ts.isFunctionDeclaration(node) && node.body) return fn(node.name?.text ?? "default", node, node);
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
    return fn(propName(node.name), node, node);
  }
  if (ts.isConstructorDeclaration(node) && node.body) return fn("constructor", node, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFnInit(node.initializer)) {
    return fn(node.name.text, node, node.initializer);
  }
  if (ts.isPropertyDeclaration(node) && node.initializer && isFnInit(node.initializer)) {
    return fn(propName(node.name), node, node.initializer);
  }
  return undefined;
}

/** Assigns IDs to every declaration in a file: <file>#<qualified name>, with ~N for repeats. */
function assignDecls(rel: string, sf: ts.SourceFile, out: Map<ts.Node, Decl>): void {
  const counts = new Map<string, number>();
  const visit = (node: ts.Node, container: { qname: string } | undefined): void => {
    let next = container;
    const entity = classify(node);
    if (entity) {
      const qname = container ? `${container.qname}.${entity.name}` : entity.name;
      const n = (counts.get(qname) ?? 0) + 1;
      counts.set(qname, n);
      const id = n === 1 ? `${rel}#${qname}` : `${rel}#${qname}~${n}`;
      out.set(node, { id, rel, qname, entity });
      next = { qname };
    }
    ts.forEachChild(node, (child) => {
      visit(child, next);
    });
  };
  visit(sf, undefined);
}

function createSource(abs: string, rel: string, text: string): ts.SourceFile {
  return ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
}

function compilerOptions(root: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  };
  const config = join(root, "tsconfig.json");
  if (existsSync(config)) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
      Object.assign(base, parsed.options);
    }
  }
  return { ...base, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
}

/**
 * Parses every project source file into one program, so calls and imports resolve across files.
 * `texts` maps absolute paths to contents. Files are read once per extraction run.
 */
export function buildProject(root: string, rels: string[], texts: Map<string, string>): Project {
  const options = compilerOptions(root);
  const abs = (rel: string) => join(root, rel);
  const relOf = (file: string) => relative(root, file).split(sep).join("/");
  const cache = new Map<string, ts.SourceFile>();
  const orig = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...orig,
    getSourceFile(name, language, onError, shouldCreate) {
      const text = texts.get(name);
      if (text === undefined) return orig.getSourceFile(name, language, onError, shouldCreate);
      let sf = cache.get(name);
      if (!sf) {
        sf = createSource(name, relOf(name), text);
        cache.set(name, sf);
      }
      return sf;
    },
    fileExists: (f) => texts.has(f) || orig.fileExists(f),
    readFile: (f) => texts.get(f) ?? orig.readFile(f),
  };
  const roots = rels.map(abs);
  const program = ts.createProgram({ rootNames: roots, options, host });
  const checker = program.getTypeChecker();
  const decls = new Map<ts.Node, Decl>();
  for (const rel of rels) {
    const sf = program.getSourceFile(abs(rel));
    if (sf) assignDecls(rel, sf, decls);
  }
  return {
    root,
    rels: new Set(rels),
    program,
    checker,
    options,
    host,
    decls,
    sourceFor: (rel) => program.getSourceFile(abs(rel)),
  };
}

function pos(sf: ts.SourceFile, offset: number): [number, number] {
  const p = sf.getLineAndCharacterOfPosition(offset);
  return [p.line, p.character];
}

function spanOf(rel: string, sf: ts.SourceFile, node: ts.Node): Span {
  return { file: rel, start: pos(sf, node.getStart(sf)), end: pos(sf, node.getEnd()) };
}

/** Records and dependencies for one file. */
export function emitFile(project: Project, rel: string): IRBatch {
  const sf = project.sourceFor(rel);
  if (!sf) return { file: rel, records: [] };
  const records: IRRecord[] = [];
  const deps = new Set<string>();
  const imports = importBindings(sf);
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = `${rel}@${base}`;
    for (let n = 2; usedIds.has(id); n++) id = `${rel}@${base}~${n}`;
    usedIds.add(id);
    return id;
  };
  const push = (node: IRNode) => records.push({ node });
  const pushEdge = (edge: IREdge) => records.push({ edge });

  const dependOn = (target: string) => {
    if (target !== rel) deps.add(target);
  };

  const emitModule = (from: string, spec: string, specNode: ts.Node, typeOnly: boolean, dynamic: boolean, kind: "packaging.import" | "packaging.re-export") => {
    const resolved = ts.resolveModuleName(spec, sf.fileName, project.options, project.host).resolvedModule;
    let to: NodeId | UnresolvedRef;
    const target = resolved && !resolved.isExternalLibraryImport ? relative(project.root, resolved.resolvedFileName).split(sep).join("/") : undefined;
    if (target !== undefined && project.rels.has(target)) {
      to = target;
      dependOn(target);
    } else {
      to = { unresolved: { scheme: "ts.import", text: spec } };
      if (spec.startsWith(".")) {
        for (const c of importCandidates(rel, spec)) deps.add(c);
      }
    }
    const attrs: Record<string, unknown> = kind === "packaging.import" ? { specifier: spec, typeOnly, dynamic } : { specifier: spec };
    pushEdge({ from, to, facet: "packaging", kind, attrs, span: spanOf(rel, sf, specNode), provenance: PROV });
  };

  const visit = (node: ts.Node, container: string, fn: string): void => {
    let nextContainer = container;
    let nextFn = fn;
    const decl = project.decls.get(node);
    if (decl && decl.rel === rel) {
      const span = spanOf(rel, sf, node);
      if (decl.entity.type === "type") {
        push({
          id: decl.id,
          facet: "structure",
          kind: "structure.type",
          parent: container,
          attrs: { name: decl.entity.name, typeKind: decl.entity.typeKind },
          span,
          provenance: PROV,
        });
      } else {
        push({
          id: decl.id,
          facet: "structure",
          kind: "structure.function",
          parent: container,
          attrs: {
            name: decl.entity.name,
            qualifiedName: decl.qname,
            async: decl.entity.async,
            exported: decl.entity.exported,
          },
          span,
          provenance: PROV,
        });
        nextFn = decl.id;
        if (decl.entity.async) {
          push({
            id: `async:${decl.id}`,
            facet: "concurrency",
            kind: "concurrency.async-task",
            parent: decl.id,
            attrs: { name: decl.entity.name },
            span,
            provenance: PROV,
          });
        }
        if (decl.entity.generator) {
          // A generator is a coroutine: it suspends at each yield and is resumed by its caller.
          push({
            id: `coroutine:${decl.id}`,
            facet: "concurrency",
            kind: "concurrency.coroutine",
            parent: decl.id,
            attrs: { name: decl.entity.name, variant: decl.entity.async ? "async-generator" : "generator" },
            span,
            provenance: PROV,
          });
        }
      }
      nextContainer = decl.id;
    }

    const emitCall = (call: ts.CallExpression) => {
      const callee = call.expression;
      const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      let sym = project.checker.getSymbolAtLocation(nameNode);
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = project.checker.getAliasedSymbol(sym);
        } catch {
          // an unresolvable alias simply has no target
        }
      }
      const declNode = sym?.valueDeclaration ?? sym?.declarations?.[0];
      const target = declNode ? project.decls.get(declNode) : undefined;
      if (target && target.entity.type === "function") {
        pushEdge({
          from: fn,
          to: target.id,
          facet: "calls",
          kind: "calls.call",
          attrs: { callee: callee.getText(sf).slice(0, 200) },
          span: spanOf(rel, sf, callee),
          provenance: PROV,
        });
        dependOn(target.rel);
      }
      const effect = matchCall(call, imports);
      if (effect) {
        push({
          id: uniqueId(`effect:${pos(sf, call.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: effect.kind,
          parent: container,
          attrs: effect.attrs,
          span: spanOf(rel, sf, call),
          provenance: PROV,
        });
        if (effect.kind === "effects.proc.exec") {
          // Running a command starts a child process, which is also a concurrency fact.
          push({
            id: uniqueId(`spawn:${pos(sf, call.getStart(sf)).join(":")}`),
            facet: "concurrency",
            kind: "concurrency.spawn-process",
            parent: container,
            attrs: { target: effect.attrs.command, api: effect.attrs.api },
            span: spanOf(rel, sf, call),
            provenance: PROV,
          });
        }
      }
    };

    const flow = (tag: string, kind: string, attrs: Record<string, unknown>, at: ts.Node = node) =>
      push({
        id: uniqueId(`${tag}:${pos(sf, at.getStart(sf)).join(":")}`),
        facet: "flow",
        kind,
        parent: container,
        attrs,
        span: spanOf(rel, sf, at),
        provenance: PROV,
      });
    const arm = (label: string, at: ts.Node) => flow("arm", "flow.branch-arm", { label }, at);
    const block = (label: string, at: ts.Node) => flow("block", "flow.block", { label }, at);

    if (ts.isIfStatement(node)) {
      flow("if", "flow.branch", { condition: node.expression.getText(sf).slice(0, 200) });
      arm("then", node.thenStatement);
      if (node.elseStatement) arm("else", node.elseStatement);
    } else if (ts.isConditionalExpression(node)) {
      flow("cond", "flow.branch", { condition: node.condition.getText(sf).slice(0, 200) });
      arm("then", node.whenTrue);
      arm("else", node.whenFalse);
    } else if (ts.isSwitchStatement(node)) {
      flow("switch", "flow.switch", { hasDefault: node.caseBlock.clauses.some((c) => ts.isDefaultClause(c)) });
      for (const clause of node.caseBlock.clauses) {
        arm(ts.isDefaultClause(clause) ? "default" : `case ${clause.expression.getText(sf).slice(0, 60)}`, clause);
      }
    } else if (ts.isForStatement(node)) {
      flow("loop", "flow.loop", { variant: "for", condition: node.condition?.getText(sf).slice(0, 200) ?? "" });
      block("body", node.statement);
    } else if (ts.isForOfStatement(node)) {
      flow("loop", "flow.loop", { variant: "for-of", condition: `${node.initializer.getText(sf)} of ${node.expression.getText(sf)}`.slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isForInStatement(node)) {
      flow("loop", "flow.loop", { variant: "for-in", condition: `${node.initializer.getText(sf)} in ${node.expression.getText(sf)}`.slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isWhileStatement(node)) {
      flow("loop", "flow.loop", { variant: "while", condition: node.expression.getText(sf).slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isDoStatement(node)) {
      flow("loop", "flow.loop", { variant: "do", condition: node.expression.getText(sf).slice(0, 200) });
      block("body", node.statement);
    } else if (ts.isTryStatement(node)) {
      flow("try", "flow.try", { hasFinally: node.finallyBlock !== undefined });
      block("try", node.tryBlock);
      if (node.catchClause) block("catch", node.catchClause);
      if (node.finallyBlock) block("finally", node.finallyBlock);
    } else if (ts.isThrowStatement(node)) {
      flow("throw", "flow.throw", {});
    } else if (ts.isReturnStatement(node)) {
      flow("return", "flow.return", {});
    } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      flow("jump", "flow.jump", { variant: ts.isBreakStatement(node) ? "break" : "continue", ...(node.label ? { label: node.label.text } : {}) });
    }

    if (ts.isAwaitExpression(node)) {
      push({
        id: uniqueId(`await:${pos(sf, node.getStart(sf)).join(":")}`),
        facet: "concurrency",
        kind: "concurrency.await",
        parent: container,
        attrs: {},
        span: spanOf(rel, sf, node),
        provenance: PROV,
      });
    }

    if (ts.isNewExpression(node)) {
      const worker = matchWorker(node, imports);
      if (worker !== undefined) {
        push({
          id: uniqueId(`spawn:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "concurrency",
          kind: "concurrency.spawn-thread",
          parent: container,
          attrs: { target: worker.target, api: worker.api },
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, node.importClause?.isTypeOnly ?? false, false, "packaging.import");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      emitModule(rel, node.moduleSpecifier.text, node.moduleSpecifier, false, false, "packaging.re-export");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        emitModule(rel, node.arguments[0].text, node.arguments[0], false, true, "packaging.import");
      }
      emitCall(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      const name = matchEnvRead(node, imports);
      if (name !== undefined) {
        push({
          id: uniqueId(`env:${pos(sf, node.getStart(sf)).join(":")}`),
          facet: "effects",
          kind: "effects.env.read",
          parent: container,
          attrs: { api: "process.env", name },
          span: spanOf(rel, sf, node),
          provenance: PROV,
        });
      }
    }

    ts.forEachChild(node, (child) => {
      visit(child, nextContainer, nextFn);
    });
  };
  visit(sf, rel, rel);

  for (const d of project.program.getSyntacticDiagnostics(sf)) {
    const start = d.start ?? 0;
    const finding: IRFinding = {
      severity: "error",
      message: `syntax: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
      span: { file: rel, start: pos(sf, start), end: pos(sf, start + (d.length ?? 0)) },
      provenance: PROV,
    };
    records.push({ finding });
  }

  return { file: rel, records, dependsOn: [...deps].sort() };
}

/** Paths a relative import could resolve to. Creating one of them re-extracts the importer. */
export function importCandidates(fromFile: string, specifier: string): string[] {
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const joined = [dir, specifier].filter((p) => p !== "").join("/");
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  const exts = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
  const out = new Set<string>([base]);
  for (const e of exts) {
    out.add(`${base}${e}`);
    out.add(`${base}/index${e}`);
  }
  return [...out];
}

