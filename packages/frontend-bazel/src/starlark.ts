/**
 * A small tokenizer and call splitter for the subset of Starlark that BUILD files use. It does not
 * evaluate anything: it finds top-level rule calls and the strings inside their arguments.
 */

export interface Tok {
  kind: "str" | "id" | "op";
  value: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface Arg {
  key?: string;
  tokens: Tok[];
}

export interface Call {
  name: string;
  nameTok: Tok;
  endTok: Tok;
  args: Arg[];
}

const TWO_CHAR_OPS = new Set(["==", "!=", "<=", ">="]);
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 0;
  let col = 0;
  const advance = (n: number): void => {
    for (let k = 0; k < n && i < text.length; k++) {
      if (text[i] === "\n") {
        line++;
        col = 0;
      } else col++;
      i++;
    }
  };
  const push = (kind: Tok["kind"], value: string, sl: number, sc: number): void => {
    out.push({ kind, value, line: sl, col: sc, endLine: line, endCol: col });
  };

  while (i < text.length) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      advance(1);
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") advance(1);
      continue;
    }
    const sl = line;
    const sc = col;
    if (c === '"' || c === "'") {
      const quote = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      advance(quote.length);
      let value = "";
      while (i < text.length && !text.startsWith(quote, i)) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const next = text[i + 1] as string;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          advance(2);
        } else {
          value += text[i];
          advance(1);
        }
      }
      advance(quote.length);
      push("str", value, sl, sc);
      continue;
    }
    if (/[A-Za-z_0-9]/.test(c)) {
      let j = i;
      while (j < text.length && /\w/.test(text[j] as string)) j++;
      const value = text.slice(i, j);
      advance(j - i);
      push("id", value, sl, sc);
      continue;
    }
    const two = text.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      advance(2);
      push("op", two, sl, sc);
      continue;
    }
    advance(1);
    push("op", c, sl, sc);
  }
  return out;
}

/** Index of the bracket that closes the one at `open`, or -1 when it never closes. */
export function matchClose(toks: Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.kind !== "op") continue;
    if (OPEN.has(t.value)) depth++;
    else if (CLOSE.has(t.value)) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Splits a call's argument tokens at top-level commas and reads `key =` prefixes. */
export function splitArgs(toks: Tok[]): Arg[] {
  const args: Arg[] = [];
  let start = 0;
  let depth = 0;
  const flush = (end: number): void => {
    const part = toks.slice(start, end);
    if (part.length === 0) return;
    const first = part[0] as Tok;
    const second = part[1];
    if (first.kind === "id" && second?.kind === "op" && second.value === "=") {
      args.push({ key: first.value, tokens: part.slice(2) });
    } else args.push({ tokens: part });
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.kind !== "op") continue;
    if (OPEN.has(t.value)) depth++;
    else if (CLOSE.has(t.value)) depth--;
    else if (t.value === "," && depth === 0) {
      flush(k);
      start = k + 1;
    }
  }
  flush(toks.length);
  return args;
}

/** Rule calls at the top level of a BUILD file: `name(args)` outside any bracket. */
export function topLevelCalls(toks: Tok[]): Call[] {
  const calls: Call[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    const next = toks[i + 1];
    if (t.kind === "id" && next?.kind === "op" && next.value === "(") {
      const close = matchClose(toks, i + 1);
      if (close < 0) break;
      calls.push({
        name: t.value,
        nameTok: t,
        endTok: toks[close] as Tok,
        args: splitArgs(toks.slice(i + 2, close)),
      });
      i = close;
    } else if (t.kind === "op" && OPEN.has(t.value)) {
      const close = matchClose(toks, i);
      if (close < 0) break;
      i = close;
    }
  }
  return calls;
}

/**
 * The string literals in an argument, at any depth. Dict keys (the labels in select()) are left
 * out, and so are the contents of glob(), which globsIn reads instead.
 */
export function stringsIn(toks: Tok[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    const next = toks[k + 1];
    if (t.kind === "id" && t.value === "glob" && next?.kind === "op" && next.value === "(") {
      const close = matchClose(toks, k + 1);
      if (close < 0) break;
      k = close;
      continue;
    }
    if (t.kind === "str" && !(next?.kind === "op" && next.value === ":")) out.push(t.value);
  }
  return out;
}

export interface GlobCall {
  include: string[];
  exclude: string[];
}

export function globsIn(toks: Tok[]): GlobCall[] {
  const out: GlobCall[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    const next = toks[k + 1];
    if (!(t.kind === "id" && t.value === "glob" && next?.kind === "op" && next.value === "(")) continue;
    const close = matchClose(toks, k + 1);
    if (close < 0) break;
    const args = splitArgs(toks.slice(k + 2, close));
    const include = stringsIn(args.find((a) => a.key === undefined)?.tokens ?? []);
    const exclude = stringsIn(args.find((a) => a.key === "exclude")?.tokens ?? []);
    out.push({ include, exclude });
    k = close;
  }
  return out;
}
