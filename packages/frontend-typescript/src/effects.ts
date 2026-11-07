import { readFileSync } from "node:fs";
import ts from "typescript";

interface CatalogEntry {
  module: string;
  name: string;
  kind: string;
  api: string;
  attr?: string;
  arg?: number;
}

const catalog = JSON.parse(readFileSync(new URL("../data/effects.json", import.meta.url), "utf8")) as {
  entries: CatalogEntry[];
};

const byKey = new Map(catalog.entries.map((e) => [`${normalizeModule(e.module)}\0${e.name}`, e]));

export function normalizeModule(name: string): string {
  return name.startsWith("node:") ? name.slice(5) : name;
}

export interface ImportBinding {
  module: string;
  /** Set for a named import: the exported name. Unset for a namespace or default import. */
  name?: string;
}

/** Local names bound by import declarations at the top of a file. */
export function importBindings(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const module = normalizeModule(st.moduleSpecifier.text);
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) out.set(clause.name.text, { module });
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) out.set(named.name.text, { module });
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        out.set(el.name.text, { module, name: (el.propertyName ?? el.name).text });
      }
    }
  }
  return out;
}

export interface EffectMatch {
  kind: string;
  attrs: Record<string, unknown>;
}

const DYNAMIC = "<dynamic>";

function argValue(call: ts.CallExpression, index: number): string {
  if (index < 0) return DYNAMIC;
  const arg = call.arguments[index];
  return arg && ts.isStringLiteralLike(arg) ? arg.text : DYNAMIC;
}

/** Matches a call against the effects catalog, using the file's import bindings. */
export function matchCall(call: ts.CallExpression, imports: Map<string, ImportBinding>): EffectMatch | undefined {
  const callee = call.expression;
  let module: string | undefined;
  let name: string | undefined;
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    if (b?.name !== undefined) {
      module = b.module;
      name = b.name;
    }
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const base = callee.expression.text;
    const b = imports.get(base);
    if (b && b.name === undefined) {
      module = b.module;
      name = callee.name.text;
    } else if (!b) {
      module = "";
      name = `${base}.${callee.name.text}`;
    }
  }
  if (module === undefined || name === undefined) return undefined;
  const entry = byKey.get(`${module}\0${name}`);
  if (!entry) return undefined;
  const attrs: Record<string, unknown> = { api: entry.api };
  if (entry.attr) attrs[entry.attr] = argValue(call, entry.arg ?? 0);
  return { kind: entry.kind, attrs };
}

/** process.env.NAME, read as a property access. Returns the name, or undefined. */
export function matchEnvRead(node: ts.PropertyAccessExpression, imports: Map<string, ImportBinding>): string | undefined {
  const inner = node.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.name.text !== "env") return undefined;
  if (!ts.isIdentifier(inner.expression) || inner.expression.text !== "process") return undefined;
  if (imports.has("process")) return undefined;
  return node.name.text;
}

/** `new Worker(file)` from worker_threads, as a named or namespace import. Returns the script it runs. */
export function matchWorker(node: ts.NewExpression, imports: Map<string, ImportBinding>): { api: string; target: string } | undefined {
  const callee = node.expression;
  let isWorker = false;
  if (ts.isIdentifier(callee)) {
    const b = imports.get(callee.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === "Worker";
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === "Worker") {
    const b = imports.get(callee.expression.text);
    isWorker = b !== undefined && b.module === "worker_threads" && b.name === undefined;
  }
  if (!isWorker) return undefined;
  const first = node.arguments?.[0];
  return { api: "worker_threads.Worker", target: first && ts.isStringLiteralLike(first) ? first.text : DYNAMIC };
}
