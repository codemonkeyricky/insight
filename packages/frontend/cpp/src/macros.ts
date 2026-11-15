/**
 * Attribute-like macros. Export, visibility and thread-safety annotation macros (`GTEST_API_`, `ABSL_GUARDED_BY(x)`)
 * confuse tree-sitter, which cannot expand the preprocessor. The project defines most of them, so the definitions are
 * read once per run. A macro whose every definition expands to nothing or to attributes only is attribute-like, and
 * its uses are blanked before parsing. Blanking keeps the byte length and every newline.
 */

const isIdentStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdentPart = (c: number): boolean => isIdentStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

/** End of a string or character literal that starts at i (the quote). An unterminated one ends at its line. */
function skipQuoted(text: string, i: number): number {
  const quote = text.charCodeAt(i);
  let j = i + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 92) j += 2;
    else if (c === quote) return j + 1;
    else if (c === 10) return j;
    else j++;
  }
  return text.length;
}

/** End of a raw string whose opening quote is at q. */
function skipRaw(text: string, q: number): number {
  const open = text.indexOf("(", q + 1);
  if (open < 0 || open - q > 17) return q + 1;
  const delim = text.slice(q + 1, open);
  const end = text.indexOf(`)${delim}"`, open);
  return end < 0 ? text.length : end + delim.length + 2;
}

/** End of the logical line of a preprocessor directive that starts at i (the `#`). The newline is not consumed. */
function directiveEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 10) return j;
    if (c === 92 && (text.charCodeAt(j + 1) === 10 || (text.charCodeAt(j + 1) === 13 && text.charCodeAt(j + 2) === 10))) {
      j += text.charCodeAt(j + 1) === 10 ? 2 : 3;
    } else if (c === 47 && text.charCodeAt(j + 1) === 42) {
      const end = text.indexOf("*/", j + 2);
      j = end < 0 ? text.length : end + 2;
    } else if (c === 47 && text.charCodeAt(j + 1) === 47) {
      const nl = text.indexOf("\n", j);
      return nl < 0 ? text.length : nl;
    } else if (c === 34 || c === 39) j = skipQuoted(text, j);
    else j++;
  }
  return text.length;
}

/**
 * Walks C or C++ text. Comments, string and character literals and raw strings are skipped, and a preprocessor line is
 * reported whole instead of word by word. `onIdent` may return an index to continue from.
 */
function lex(
  text: string,
  onIdent: ((start: number, end: number) => number | void) | undefined,
  onDirective: ((start: number, end: number) => void) | undefined,
): void {
  const n = text.length;
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      lineStart = true;
      i++;
    } else if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) i++;
    else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (lineStart && c === 35) {
      const end = directiveEnd(text, i);
      onDirective?.(i, end);
      i = end;
    } else {
      lineStart = false;
      if (c === 34 || c === 39) i = skipQuoted(text, i);
      else if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && isIdentPart(text.charCodeAt(j))) j++;
        if (text.charCodeAt(j) === 34 && /^(?:u8|u|U|L)?R$/.test(text.slice(i, j))) {
          i = skipRaw(text, j);
        } else if ((text.charCodeAt(j) === 34 || text.charCodeAt(j) === 39) && /^(?:u8|u|U|L)$/.test(text.slice(i, j))) {
          i = j;
        } else {
          const next = onIdent?.(i, j);
          i = typeof next === "number" ? next : j;
        }
      } else if (isDigit(c)) {
        let j = i + 1;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (isIdentPart(d) || d === 46) j++;
          else if (d === 39 && isIdentPart(text.charCodeAt(j + 1))) j += 2;
          else if ((d === 43 || d === 45) && /[eEpP]/.test(text[j - 1] ?? "")) j++;
          else break;
        }
        i = j;
      } else i++;
    }
  }
}

/** Tokens of a macro body: words, numbers, literals, `##`, and single punctuation characters. Comments are dropped. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10 || c === 12 || c === 11) i++;
    else if (c === 92 && (s.charCodeAt(i + 1) === 10 || s.charCodeAt(i + 1) === 13)) i++;
    else if (c === 47 && s.charCodeAt(i + 1) === 42) {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
    } else if (c === 47 && s.charCodeAt(i + 1) === 47) break;
    else if (c === 34 || c === 39) {
      const end = skipQuoted(s, i);
      out.push(s.slice(i, end));
      i = end;
    } else if (isIdentStart(c) || isDigit(c)) {
      let j = i + 1;
      while (j < s.length && (isIdentPart(s.charCodeAt(j)) || s.charCodeAt(j) === 46)) j++;
      out.push(s.slice(i, j));
      i = j;
    } else if (c === 35 && s.charCodeAt(i + 1) === 35) {
      out.push("##");
      i += 2;
    } else {
      out.push(s[i] as string);
      i++;
    }
  }
  return out;
}

/** The index after the bracket group that opens at i, or -1 when it does not close. */
function balanced(tokens: string[], i: number, open: string, close: string): number {
  let depth = 0;
  for (let j = i; j < tokens.length; j++) {
    if (tokens[j] === open) depth++;
    else if (tokens[j] === close && --depth === 0) return j + 1;
  }
  return -1;
}

/** Words that stand alone as attributes. */
const BARE_ATTRIBUTES = new Set(["__forceinline", "inline", "__inline", "__inline__", "__restrict", "__restrict__", "__unaligned"]);
/** Words that are attributes when followed by a parenthesised group. */
const CALL_ATTRIBUTES = new Set(["__attribute__", "__declspec", "_Pragma", "alignas"]);

/** True when the tokens are nothing but attributes, with `known` as the macros that count as attributes. */
function attributeOnly(tokens: string[], known: ReadonlySet<string>): boolean {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === "[" && tokens[i + 1] === "[") {
      i = balanced(tokens, i, "[", "]");
      if (i < 0) return false;
    } else if (CALL_ATTRIBUTES.has(t)) {
      if (tokens[i + 1] !== "(") return false;
      i = balanced(tokens, i + 1, "(", ")");
      if (i < 0) return false;
    } else if (BARE_ATTRIBUTES.has(t)) i++;
    else if (known.has(t)) {
      i++;
      if (tokens[i] === "(") {
        i = balanced(tokens, i, "(", ")");
        if (i < 0) return false;
      }
    } else return false;
  }
  return !tokens.includes("##");
}

export interface AttrMacro {
  /** True when every definition takes parameters. Only then does a use swallow its argument list. */
  fnLike: boolean;
  /** The files that define it. */
  files: string[];
}
export type AttrMacros = Map<string, AttrMacro>;

const CANDIDATE = /^[A-Z][A-Z0-9_]*$/;
const isCandidate = (name: string): boolean => CANDIDATE.test(name) && (name.includes("_") || name.length >= 3);

interface Definition {
  fnLike: boolean;
  body: string[];
  file: string;
}

const DEFINE = /^#[ \t]*define[ \t]+([A-Za-z_]\w*)(\()?/;

/** Reads the `#define` lines of every file and returns the macros whose every definition is attributes or nothing. */
export function discoverAttrMacros(texts: ReadonlyMap<string, string>): AttrMacros {
  const defs = new Map<string, Definition[]>();
  for (const [file, text] of texts) {
    if (!/^[ \t]*#[ \t]*define\b/m.test(text)) continue;
    lex(text, undefined, (start, end) => {
      const raw = text.slice(start, end);
      const m = DEFINE.exec(raw);
      if (!m) return;
      const name = m[1] as string;
      if (!isCandidate(name)) return;
      let bodyStart = m[0].length;
      if (m[2]) {
        const close = raw.indexOf(")", bodyStart);
        bodyStart = close < 0 ? raw.length : close + 1;
      }
      const list = defs.get(name) ?? [];
      list.push({ fnLike: m[2] !== undefined, body: tokenize(raw.slice(bodyStart)), file });
      defs.set(name, list);
    });
  }
  const known = new Set(defs.keys());
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of [...known]) {
      if (!(defs.get(name) ?? []).every((d) => attributeOnly(d.body, known))) {
        known.delete(name);
        changed = true;
      }
    }
  }
  const out: AttrMacros = new Map();
  for (const name of known) {
    const list = defs.get(name) ?? [];
    out.set(name, { fnLike: list.every((d) => d.fnLike), files: [...new Set(list.map((d) => d.file))].sort() });
  }
  return out;
}

/**
 * The text with every use of an attribute-like macro blanked, and the names of the macros it blanked. A function-like
 * macro takes its parenthesised argument list with it. Comments, literals and preprocessor lines are left alone.
 */
export function blankAttrMacros(text: string, macros: AttrMacros): { text: string; used: Set<string> } {
  const used = new Set<string>();
  if (macros.size === 0) return { text, used };
  const ranges: [number, number][] = [];
  lex(
    text,
    (start, end) => {
      const macro = macros.get(text.slice(start, end));
      if (!macro) return;
      let stop = end;
      if (macro.fnLike) {
        let k = end;
        while (k < text.length && /\s/.test(text[k] as string)) k++;
        if (text[k] !== "(") return;
        const close = closeParen(text, k);
        if (close < 0) return;
        stop = close;
      }
      used.add(text.slice(start, end));
      ranges.push([start, stop]);
      return stop;
    },
    undefined,
  );
  if (ranges.length === 0) return { text, used };
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    out += text.slice(at, a) + text.slice(a, b).replace(/[^\n]/g, " ");
    at = b;
  }
  return { text: out + text.slice(at), used };
}

/** The index after the `)` that closes the `(` at i, skipping literals and comments, or -1. */
export function closeParen(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return j + 1;
    else if (c === 34 || c === 39) {
      j = skipQuoted(text, j);
      continue;
    } else if (c === 47 && text.charCodeAt(j + 1) === 42) {
      const end = text.indexOf("*/", j + 2);
      j = end < 0 ? text.length : end + 2;
      continue;
    } else if (c === 47 && text.charCodeAt(j + 1) === 47) {
      const nl = text.indexOf("\n", j);
      j = nl < 0 ? text.length : nl;
      continue;
    }
    j++;
  }
  return -1;
}
