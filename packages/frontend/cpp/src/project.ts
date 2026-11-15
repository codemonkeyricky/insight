import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NodeId } from "@insight/ir";
import { blankAttrMacros, closeParen, discoverAttrMacros } from "./macros.js";
import { getParser, type SyntaxNode, type Tree } from "./parser.js";

export const FRONTEND_ID = "frontend-cpp";
export const CPP_RE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;

export const norm = (s: string): string => s.replace(/\s+/g, "");
/**
 * A name with its whitespace removed, except the single space that `operator new` keeps between the keyword and a
 * word operator. Declared operator names and callee names both take this form, so they match.
 */
export const normName = (s: string): string =>
  norm(s.replace(/\s+/g, " ").replace(/\boperator (?=[A-Za-z_])/g, "operator")).replace(//g, " ");
/** An export macro word: at least two characters, and either containing `_` or at least three characters. */
const isExportMacro = (word: string): boolean => word.includes("_") || word.length >= 3;

const MACRO_WORD_RE = /[A-Z][A-Z0-9_]+/y;
const NAME_RE = /(?:::)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*/y;
const TERMINATOR_RE = /\s*(?:final\b|:(?!:)|\{|<|;)/y;
const KEYWORD_RE = /\b(class|struct|union)\b/g;
const WS_RE = /\s*/y;
const MAX_ARGS = 400;

const matchAt = (re: RegExp, text: string, at: number): RegExpExecArray | null => {
  re.lastIndex = at;
  return re.exec(text);
};

/** The end of an argument list that opens at i, or -1 when it holds `;`, `{` or `}` or is too long. */
function argsEnd(text: string, i: number): number {
  const end = closeParen(text, i);
  if (end < 0 || end - i > MAX_ARGS || /[;{}]/.test(text.slice(i, end))) return -1;
  return end;
}

/**
 * The source with the export macros in class heads blanked. `class BENCHMARK_EXPORT Counter {` reads as
 * `class                 Counter {`, so tree-sitter sees the real name and body. This is the fallback for macros the
 * project does not define. After the keyword it accepts ALL_CAPS macro words (with nested argument lists), `[[...]]`,
 * `alignas(...)`, `__attribute__((...))` and `__declspec(...)`, then a possibly qualified name, then `final`, `:`,
 * `{`, `<` or `;`. Only the macro words are blanked. Every blanked character becomes a space and newlines are kept, so
 * byte offsets, lines and columns are the same as in the original text.
 */
export function blankClassHeadMacros(text: string): string {
  if (!/\b(?:class|struct|union)\s/.test(text)) return text;
  const ranges: [number, number][] = [];
  KEYWORD_RE.lastIndex = 0;
  for (let kw = KEYWORD_RE.exec(text); kw; kw = KEYWORD_RE.exec(text)) {
    let p = kw.index + kw[0].length;
    const found: [number, number][] = [];
    for (;;) {
      p += matchAt(WS_RE, text, p)?.[0].length ?? 0;
      const name = matchAt(NAME_RE, text, p);
      if (name && name[0] !== "final" && matchAt(TERMINATOR_RE, text, p + name[0].length)) {
        ranges.push(...found);
        KEYWORD_RE.lastIndex = Math.max(KEYWORD_RE.lastIndex, p);
        break;
      }
      const word = matchAt(MACRO_WORD_RE, text, p);
      if (word && isExportMacro(word[0]) && !/\w/.test(text[p + word[0].length] ?? "")) {
        let q = p + word[0].length;
        const gap = matchAt(WS_RE, text, q)?.[0].length ?? 0;
        if (text[q + gap] === "(") {
          const end = argsEnd(text, q + gap);
          if (end < 0) break;
          q = end;
        }
        found.push([p, q]);
        p = q;
        continue;
      }
      const attr = /(?:alignas|__attribute__|__declspec)(?=\s*\()/y;
      attr.lastIndex = p;
      const a = attr.exec(text);
      if (a) {
        const open = text.indexOf("(", p);
        const end = argsEnd(text, open);
        if (end < 0) break;
        p = end;
        continue;
      }
      if (text.startsWith("[[", p)) {
        const end = text.indexOf("]]", p);
        if (end < 0 || end - p > MAX_ARGS) break;
        p = end + 2;
        continue;
      }
      break;
    }
  }
  if (ranges.length === 0) return text;
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    out += text.slice(at, a) + text.slice(a, b).replace(/[^\n]/g, " ");
    at = b;
  }
  return out + text.slice(at);
}

/** One piece of a name. `top` is false for anything inside a template argument list. */
interface ScanToken {
  text: string;
  top: boolean;
}

/** Operator symbols that start with `<` or `>`. Longer first, so `<=>` wins over `<=` and `<`. */
const ANGLE_OPERATOR_SYMBOLS = ["<=>", "<<=", ">>=", "<<", ">>", "<=", ">=", "<", ">"];

/** `operator<`, `operator<<`, `operator<=>` and so on, starting at i, with the whitespace before the symbol dropped. */
function angleOperatorAt(s: string, i: number): { text: string; end: number } | undefined {
  if (!s.startsWith("operator", i) || (i > 0 && /[\w$]/.test(s[i - 1] ?? ""))) return undefined;
  let j = i + "operator".length;
  if (/[\w$]/.test(s[j] ?? "")) return undefined;
  while (j < s.length && /\s/.test(s[j] ?? "")) j++;
  const sym = ANGLE_OPERATOR_SYMBOLS.find((x) => s.startsWith(x, j));
  return sym ? { text: `operator${sym}`, end: j + sym.length } : undefined;
}

/**
 * Splits a name into tokens, marking the ones outside template argument lists. A `<` or `>` inside parentheses
 * does not count, `<=`, `<=>`, `>=` and `<<` are not brackets, and `>>` closes two levels. An unclosed `<` leaves
 * the rest of the string inside a template argument list.
 */
function scanTopLevel(s: string): ScanToken[] {
  const out: ScanToken[] = [];
  let depth = 0;
  let parens = 0;
  let i = 0;
  while (i < s.length) {
    if (depth === 0) {
      const op = angleOperatorAt(s, i);
      if (op) {
        out.push({ text: op.text, top: true });
        i = op.end;
        continue;
      }
    }
    const ch = s[i];
    let len = 1;
    let bracket = false;
    if (s.startsWith("<=>", i)) len = 3;
    else if (s.startsWith("<=", i) || s.startsWith(">=", i) || s.startsWith("<<", i)) len = 2;
    else if (s.startsWith(">>", i)) {
      len = 2;
      if (parens === 0 && depth > 0) {
        depth = Math.max(0, depth - 2);
        bracket = true;
      }
    } else if (ch === "<") {
      if (parens === 0) {
        depth++;
        bracket = true;
      }
    } else if (ch === ">") {
      if (parens === 0 && depth > 0) {
        depth--;
        bracket = true;
      }
    } else if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    if (!bracket) out.push({ text: s.slice(i, i + len), top: depth === 0 });
    i += len;
  }
  return out;
}

/**
 * Template argument lists removed, nested ones too, so std::lock_guard<std::mutex> becomes std::lock_guard and
 * Foo<T>::bar becomes Foo::bar. Operator names keep their symbol, so operator<< stays operator<<. An unclosed `<`
 * (not part of an operator) drops the rest of the string, as before.
 * A copy of this lives in packages/core/indexer/src/narrow.ts (stripTemplateArgs). Keep the two in step.
 */
export const stripTemplates = (s: string): string =>
  scanTopLevel(s)
    .filter((t) => t.top)
    .map((t) => t.text)
    .join("");
export const nodeKey = (n: SyntaxNode): string => `${n.startIndex}:${n.endIndex}:${n.type}`;

export interface Scope {
  /** Enclosing namespace and class names, outermost first. Anonymous namespaces add nothing. */
  path: string[];
  /** True inside an anonymous namespace, whose names have internal linkage. */
  anon: boolean;
  /** The innermost enclosing class, qualified, when there is one. */
  cls?: string;
}

/** The namespaces and classes around a node, found by walking up its parents. */
export function scopeOf(node: SyntaxNode): Scope {
  const frames: { name: string; isClass: boolean }[] = [];
  let anon = false;
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "namespace_definition") {
      const name = p.childForFieldName("name")?.text;
      if (name) frames.unshift({ name, isClass: false });
      else anon = true;
    } else if ((p.type === "class_specifier" || p.type === "struct_specifier") && p.childForFieldName("body")) {
      const name = p.childForFieldName("name")?.text;
      if (name) frames.unshift({ name: stripTemplates(norm(name)), isClass: true });
    }
  }
  const path = frames.map((f) => f.name);
  const lastClass = frames.map((f) => f.isClass).lastIndexOf(true);
  const cls = lastClass >= 0 ? path.slice(0, lastClass + 1).join("::") : undefined;
  return { path, anon, ...(cls !== undefined ? { cls } : {}) };
}

/** The function_declarator inside a function definition, past pointer and reference wrappers. */
export function functionDeclarator(fn: SyntaxNode): SyntaxNode | null {
  let d: SyntaxNode | null = fn.childForFieldName("declarator");
  // A reference or pointer wrapper has no named field in tree-sitter-cpp, so its inner declarator is found as a child.
  while (d && d.type !== "function_declarator") {
    d = d.childForFieldName("declarator") ?? d.namedChildren.find((c) => c.type === "function_declarator" || c.type.endsWith("_declarator")) ?? null;
  }
  return d;
}

/** Where a lambda bound to a variable can be named. */
export interface LambdaBinding {
  /** Namespace and class names around the lambda, outermost first. */
  scope: string[];
  /** The block that holds the variable, as start and end offsets. Undefined at namespace, class or file scope. */
  block?: [number, number];
  /** Offset where the declaration or assignment ends. A use before it does not see the variable. */
  declEnd: number;
  /** True when the lambda is assigned to an existing variable rather than declared with it. */
  assigned: boolean;
}

export interface FnDecl {
  id: NodeId;
  rel: string;
  qname: string;
  simple: string;
  /** The class the function belongs to, qualified. Undefined for free functions. */
  cls?: string;
  exported: boolean;
  key: string;
  /** True for a lambda. It has no declaration of its own, so its name comes from the variable it is bound to, or its position. */
  anonymous?: boolean;
  /** For a lambda bound to a variable, where that variable can be named. */
  binding?: LambdaBinding;
}

export interface Unit {
  rel: string;
  root: SyntaxNode;
  tree: Tree;
  /** ERROR nodes. A file with any has inferred facts. */
  errors: SyntaxNode[];
}

export interface Project {
  units: Map<string, Unit>;
  /** Every function definition, keyed by `${rel}|${nodeKey}`. */
  fns: Map<string, FnDecl>;
  fnsByFile: Map<string, FnDecl[]>;
  byQName: Map<string, FnDecl[]>;
  bySimple: Map<string, FnDecl[]>;
  /** Field names declared in each class, keyed by qualified class name. */
  members: Map<string, Set<string>>;
  /** Declared base type of each data member, by class then member name. Template arguments are removed. */
  fieldTypes: Map<string, Map<string, string>>;
  /** Declared base type of each namespace-scope variable, by qualified name. */
  globals: Map<string, string>;
  /** Functions whose body suspends. A call to one creates a coroutine rather than running it. */
  coroutines: Set<NodeId>;
  /** Lambdas bound to a variable, by the variable's name. Lambdas are kept out of byQName and bySimple, so a call never reaches one. */
  lambdaBindings: Map<string, FnDecl[]>;
  /** For each file, the other files that define the attribute macros it uses. A change to one re-extracts the file. */
  macroDeps: Map<string, string[]>;
}

const walk = (node: SyntaxNode, visit: (n: SyntaxNode) => void): void => {
  visit(node);
  for (const child of node.namedChildren) walk(child, visit);
};

/** `Foo::` or `Foo<T>::` from text before a name, as the qualifier names. Anything before the last top-level space is a return type. */
function scopeParts(prefix: string): string[] {
  const tokens = scanTopLevel(prefix);
  let from = 0;
  tokens.forEach((t, k) => {
    if (t.top && /\s/.test(t.text)) from = k + 1;
  });
  const scope = norm(
    tokens
      .slice(from)
      .filter((t) => t.top)
      .map((t) => t.text)
      .join(""),
  )
    .replace(/^::/, "")
    .replace(/::$/, "");
  return scope === "" ? [] : scope.split("::");
}

function declaredName(fn: SyntaxNode): { qname: string; simple: string } | undefined {
  const fd = functionDeclarator(fn);
  const head = fd?.childForFieldName("declarator");
  if (!head) return undefined;
  // The name is the last node of the declarator's qualified chain. A macro before the return type makes tree-sitter
  // read the macro as the type, so the real return type can sit at the start of that chain. The scope therefore comes
  // from the text before the name, after its last top-level space.
  let name: SyntaxNode = head;
  while (name.type === "qualified_identifier" && name.namedChildCount > 0) name = name.namedChildren[name.namedChildCount - 1] ?? name;
  if (name.type === "ERROR") return declaredNameFromText(head);
  const raw = name.text;
  let offset = name.startIndex - head.startIndex;
  if (head.text.substring(offset, offset + raw.length) !== raw) offset = head.text.lastIndexOf(raw);
  if (offset < 0) return declaredNameFromText(head);
  const simple =
    name.type === "operator_name" ? normName(raw) : stripTemplates(norm(raw));
  const parts = [...scopeParts(head.text.slice(0, offset)), simple];
  return { qname: parts.join("::"), simple };
}

/** Fallback when no name node can be found: the declarator's text, template arguments stripped. */
function declaredNameFromText(head: SyntaxNode): { qname: string; simple: string } {
  const bare = stripTemplates(norm(head.text));
  const parts = bare.replace(/^::/, "").split("::");
  return { qname: parts.join("::"), simple: parts[parts.length - 1] ?? bare };
}

/**
 * A definition with no body to run: `= delete`, or `= default` on a reference-returning function. A reference return
 * is only reached by the declarator walk since it was extended to wrappers, so those defaults are skipped as before.
 * Other `= default` definitions, such as constructors, keep their nodes.
 */
function hasNoBody(fn: SyntaxNode): boolean {
  if (fn.namedChildren.some((c) => c.type === "delete_method_clause")) return true;
  return fn.childForFieldName("declarator")?.type === "reference_declarator" && fn.namedChildren.some((c) => c.type === "default_method_clause");
}

/** The name a declarator declares: the identifier at the bottom of its declarator chain. */
export function declaredVariable(decl: SyntaxNode): string | undefined {
  let n: SyntaxNode | null = decl.childForFieldName("declarator");
  while (n && n.type !== "identifier" && n.type !== "field_identifier") n = n.childForFieldName("declarator");
  return n?.text;
}

/** The base type of a declaration: its type with template arguments removed, whitespace dropped. */
export const baseTypeOf = (decl: SyntaxNode): string => stripTemplates(norm(decl.childForFieldName("type")?.text ?? ""));

function collectMembers(
  root: SyntaxNode,
  members: Map<string, Set<string>>,
  fieldTypes: Map<string, Map<string, string>>,
): void {
  walk(root, (node) => {
    if (node.type !== "class_specifier" && node.type !== "struct_specifier") return;
    const body = node.childForFieldName("body");
    const name = stripTemplates(norm(node.childForFieldName("name")?.text ?? ""));
    if (!body || !name) return;
    const cls = [...scopeOf(node).path, name].join("::");
    const set = members.get(cls) ?? new Set<string>();
    const types = fieldTypes.get(cls) ?? new Map<string, string>();
    for (const field of body.namedChildren) {
      if (field.type !== "field_declaration") continue;
      let d: SyntaxNode | null = field.childForFieldName("declarator");
      let isFunction = false;
      while (d && d.type !== "field_identifier") {
        if (d.type === "function_declarator") isFunction = true;
        d = d.childForFieldName("declarator");
      }
      if (d && !isFunction) {
        set.add(d.text);
        types.set(d.text, baseTypeOf(field));
      }
    }
    members.set(cls, set);
    fieldTypes.set(cls, types);
  });
}

/** A declaration at namespace or file scope, not inside a class or function. */
const isNamespaceScope = (decl: SyntaxNode): boolean => {
  const p = decl.parent;
  if (p?.type === "translation_unit") return true;
  return p?.type === "declaration_list" && (p.parent?.type === "namespace_definition" || p.parent?.type === "linkage_specification");
};

/** Nodes that make the function around them a coroutine. */
const SUSPENDING = ["co_await_expression", "co_yield_statement", "co_return_statement"];

/**
 * The function a node belongs to: its nearest enclosing definition or lambda that the project records.
 * This is the same rule the emitter uses to find the caller, so both agree on which functions suspend.
 */
export function ownerOf(node: SyntaxNode, fns: Map<string, FnDecl>, rel: string): FnDecl | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type !== "function_definition" && p.type !== "lambda_expression") continue;
    const decl = fns.get(`${rel}|${nodeKey(p)}`);
    if (decl) return decl;
  }
  return undefined;
}

/** The compound statement a node sits in, if any. */
export function blockOf(node: SyntaxNode): SyntaxNode | null {
  for (let p = node.parent; p; p = p.parent) if (p.type === "compound_statement") return p;
  return null;
}

const sameNode = (a: SyntaxNode | null, b: SyntaxNode): boolean => a !== null && nodeKey(a) === nodeKey(b);
const blockRange = (node: SyntaxNode): { block?: [number, number] } => {
  const block = blockOf(node);
  return block ? { block: [block.startIndex, block.endIndex] } : {};
};

/**
 * The variable a lambda is bound to: the whole initializer of a declared name, or the whole right side
 * of an assignment to a name. Anything else, such as an argument or a member, binds none.
 */
function boundTo(lambda: SyntaxNode): ({ name: string; declEnd: number; assigned: boolean } & { block?: [number, number] }) | undefined {
  let value: SyntaxNode = lambda;
  while (value.parent?.type === "parenthesized_expression") value = value.parent;
  const parent = value.parent;
  if (parent?.type === "init_declarator" && sameNode(parent.childForFieldName("value"), value)) {
    const name = parent.childForFieldName("declarator");
    return name?.type === "identifier" ? { name: name.text, ...blockRange(parent), declEnd: parent.endIndex, assigned: false } : undefined;
  }
  if (parent?.type === "assignment_expression" && sameNode(parent.childForFieldName("right"), value)) {
    const name = parent.childForFieldName("left");
    return name?.type === "identifier" ? { name: name.text, ...blockRange(parent), declEnd: parent.endIndex, assigned: true } : undefined;
  }
  return undefined;
}

/** `base` when no function or lambda has it yet, else the same name with the line, then a counter. */
function uniqueId(base: string, line: number, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let id = `${base}@${line}`;
  for (let n = 2; taken.has(id); n++) id = `${base}@${line}~${n}`;
  return id;
}

/**
 * Registers the lambdas of one file, in source order, so an enclosing function or lambda is always
 * registered before the lambdas inside it. A lambda bound to a variable takes that variable's name.
 * Any other is named `λ<line>:<col>`, 1-based as an editor shows positions.
 */
function addLambdas(rel: string, lambdas: SyntaxNode[], fns: Map<string, FnDecl>, list: FnDecl[], bindings: Map<string, FnDecl[]>): void {
  const taken = new Set(list.map((d) => d.id));
  for (const node of lambdas) {
    const enclosing = ownerOf(node, fns, rel);
    const scope = scopeOf(node);
    const bound = boundTo(node);
    const simple = bound?.name ?? `λ${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
    const qname = enclosing ? `${enclosing.qname}.${simple}` : [...scope.path, simple].join("::");
    const cls = scope.cls ?? enclosing?.cls;
    const id = uniqueId(`${rel}#${qname}`, node.startPosition.row + 1, taken);
    taken.add(id);
    const decl: FnDecl = {
      id,
      rel,
      qname,
      simple,
      ...(cls !== undefined ? { cls } : {}),
      exported: false,
      key: `${rel}|${nodeKey(node)}`,
      anonymous: true,
      ...(bound
        ? { binding: { scope: scope.path, ...(bound.block ? { block: bound.block } : {}), declEnd: bound.declEnd, assigned: bound.assigned } }
        : {}),
    };
    fns.set(decl.key, decl);
    list.push(decl);
    if (bound) {
      const same = bindings.get(simple) ?? [];
      same.push(decl);
      bindings.set(simple, same);
    }
  }
}

/** Parses every C or C++ file and collects the function definitions that calls can target. */
export async function buildProject(texts: Map<string, string>): Promise<Project> {
  const parser = await getParser();
  const units = new Map<string, Unit>();
  const macros = discoverAttrMacros(texts);
  const macroDeps = new Map<string, string[]>();
  for (const [rel, text] of texts) {
    const blanked = blankAttrMacros(text, macros);
    const defining = new Set<string>();
    for (const name of blanked.used) for (const f of macros.get(name)?.files ?? []) if (f !== rel) defining.add(f);
    macroDeps.set(rel, [...defining].sort());
    const tree = parser.parse(blankClassHeadMacros(blanked.text));
    if (!tree) throw new Error(`could not parse ${rel}`);
    const root = tree.rootNode;
    // A file can be wrong without an ERROR node (a MISSING token), so the root stands in for it.
    const found = root.hasError ? root.descendantsOfType("ERROR") : [];
    const errors: SyntaxNode[] = root.hasError ? (found.length > 0 ? found : [root]) : [];
    units.set(rel, { rel, root, tree, errors });
  }

  const fns = new Map<string, FnDecl>();
  const fnsByFile = new Map<string, FnDecl[]>();
  const byQName = new Map<string, FnDecl[]>();
  const bySimple = new Map<string, FnDecl[]>();
  const members = new Map<string, Set<string>>();
  const fieldTypes = new Map<string, Map<string, string>>();
  const globals = new Map<string, string>();
  const lambdaBindings = new Map<string, FnDecl[]>();

  for (const unit of units.values()) {
    const pending: { node: SyntaxNode; qname: string; simple: string; scope: Scope }[] = [];
    const lambdas: SyntaxNode[] = [];
    walk(unit.root, (node) => {
      if (node.type === "lambda_expression") lambdas.push(node);
      if (node.type !== "function_definition" || hasNoBody(node)) return;
      const names = declaredName(node);
      if (!names) return;
      const scope = scopeOf(node);
      pending.push({ node, ...names, scope });
    });

    const fullNames = pending.map((p) => [...p.scope.path, p.qname].join("::"));
    const counts = new Map<string, number>();
    for (const name of fullNames) counts.set(name, (counts.get(name) ?? 0) + 1);

    const list: FnDecl[] = [];
    pending.forEach((p, i) => {
      const qname = fullNames[i] as string;
      const base = `${unit.rel}#${qname}`;
      const id = (counts.get(qname) ?? 0) > 1 ? `${base}@${p.node.startPosition.row + 1}` : base;
      const cls = p.scope.cls ?? (p.qname.includes("::") ? [...p.scope.path, ...p.qname.split("::").slice(0, -1)].join("::") : undefined);
      const isStatic = p.node.namedChildren.some((c) => c.type === "storage_class_specifier" && c.text === "static");
      const decl: FnDecl = {
        id,
        rel: unit.rel,
        qname,
        simple: p.simple,
        ...(cls !== undefined ? { cls } : {}),
        exported: !p.scope.anon && !isStatic,
        key: `${unit.rel}|${nodeKey(p.node)}`,
      };
      fns.set(decl.key, decl);
      list.push(decl);
      const exact = byQName.get(qname) ?? [];
      exact.push(decl);
      byQName.set(qname, exact);
      const simple = bySimple.get(p.simple) ?? [];
      simple.push(decl);
      bySimple.set(p.simple, simple);
    });
    addLambdas(unit.rel, lambdas, fns, list, lambdaBindings);
    fnsByFile.set(unit.rel, list);
    collectMembers(unit.root, members, fieldTypes);
    walk(unit.root, (node) => {
      if (node.type !== "declaration" || !isNamespaceScope(node)) return;
      const name = declaredVariable(node);
      if (name) globals.set([...scopeOf(node).path, name].join("::"), baseTypeOf(node));
    });
  }

  // A call to a coroutine only creates one, and the callee may sit in a file the emitter has not
  // reached, so coroutines are found here, before any file is emitted.
  const coroutines = new Set<NodeId>();
  for (const unit of units.values()) {
    for (const node of unit.root.descendantsOfType(SUSPENDING)) {
      const owner = ownerOf(node, fns, unit.rel);
      if (owner) coroutines.add(owner.id);
    }
  }

  return { units, fns, fnsByFile, byQName, bySimple, members, fieldTypes, globals, coroutines, lambdaBindings, macroDeps };
}

/** A lock name for a mutex expression. Members of the enclosing class are qualified by that class. */
export function lockIdentity(expr: string, cls: string | undefined, members: Map<string, Set<string>>): string {
  const e = norm(expr).replace(/^[&*]+/, "").replace(/^this->/, "").replace(/->/g, ".");
  if (cls !== undefined && /^[A-Za-z_]\w*$/.test(e) && members.get(cls)?.has(e)) return `${cls}::${e}`;
  return e;
}

/**
 * One catalog row. `api` defaults to the callee. `op` is required for effects.os.call. `attr` names the
 * attribute to fill from argument `arg` (`path` and `target` on an fd are string literals; other targets
 * are macro or signal names). With `attr` and no `arg`, the attribute is "<dynamic>".
 */
export interface EffectEntry {
  callee: string;
  kind: string;
  api?: string;
  syscall?: string;
  op?: string;
  attr?: string;
  arg?: number;
}

const CATALOG_FILE = fileURLToPath(new URL("../data/effects.json", import.meta.url));

/** Known system calls, by callee name. One name can have several rows (fork is a spawn and an OS call). The list is data. */
export const effectCatalog: Map<string, EffectEntry[]> = (() => {
  const map = new Map<string, EffectEntry[]>();
  for (const row of JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as EffectEntry[]) {
    map.set(row.callee, [...(map.get(row.callee) ?? []), row]);
  }
  return map;
})();

/** Frees the parse trees. The WASM heap is not garbage collected with the JavaScript objects. */
export function disposeProject(project: Project): void {
  for (const unit of project.units.values()) unit.tree.delete();
}
