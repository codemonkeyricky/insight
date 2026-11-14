import ts from "typescript";

/**
 * Explicit message channels: a BroadcastChannel by its literal name, and the two ports of a MessageChannel by the place
 * it is made. Receivers are matched by their checker type (MessagePort, BroadcastChannel) declared in a library or a
 * package, so a project class with a postMessage method is not a channel.
 */

const DYNAMIC = "<dynamic>";

export interface ChannelFact {
  channel: string;
  api: string;
}

/** Channel identity per symbol of the file: a BroadcastChannel variable or field, or a MessageChannel variable or port. */
export type ChannelIndex = Map<ts.Symbol, string>;

const unwrap = (e: ts.Expression): ts.Expression => {
  let inner = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
};

/** The constructor a `new X(...)` names, when it is a plain identifier. */
const newOf = (e: ts.Expression | undefined, name: string): ts.NewExpression | undefined => {
  if (e === undefined) return undefined;
  const inner = unwrap(e);
  return ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === name ? inner : undefined;
};

/** The channel identity a `new` expression gives: a BroadcastChannel's literal name, or the place a MessageChannel is made. */
function identityOf(sf: ts.SourceFile, rel: string, e: ts.NewExpression): string | undefined {
  if (ts.isIdentifier(e.expression) && e.expression.text === "BroadcastChannel") {
    const arg = e.arguments?.[0];
    return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
  }
  if (ts.isIdentifier(e.expression) && e.expression.text === "MessageChannel") {
    const line = sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1;
    return `MessageChannel@${rel}:${line}`;
  }
  return undefined;
}

/** Whether the file mentions a channel at all, so the index is only built for files that can hold one. */
export function mayHoldChannels(sf: ts.SourceFile): boolean {
  return sf.text.includes("BroadcastChannel") || sf.text.includes("MessageChannel");
}

/** The channel objects a file creates and keeps, keyed by the symbol that holds them. */
export function channelIndex(checker: ts.TypeChecker, sf: ts.SourceFile, rel: string): ChannelIndex {
  const index: ChannelIndex = new Map();
  if (!mayHoldChannels(sf)) return index;
  const put = (name: ts.Node | undefined, init: ts.Expression | undefined) => {
    if (name === undefined || init === undefined) return;
    const created = unwrap(init);
    if (!ts.isNewExpression(created)) return;
    const id = identityOf(sf, rel, created);
    if (id === undefined) return;
    const sym = ts.isIdentifier(name) || ts.isPropertyAccessExpression(name) ? checker.getSymbolAtLocation(ts.isPropertyAccessExpression(name) ? name.name : name) : undefined;
    if (sym !== undefined) index.set(sym, id);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        put(n.name, n.initializer);
      } else if (ts.isObjectBindingPattern(n.name) && n.initializer !== undefined) {
        // const { port1, port2 } = new MessageChannel()
        const created = newOf(n.initializer, "MessageChannel");
        if (created !== undefined) {
          const id = identityOf(sf, rel, created);
          for (const el of n.name.elements) {
            const key = el.propertyName ?? el.name;
            const sym = ts.isIdentifier(el.name) && ts.isIdentifier(key) && (key.text === "port1" || key.text === "port2") ? checker.getSymbolAtLocation(el.name) : undefined;
            if (sym !== undefined && id !== undefined) index.set(sym, id);
          }
        }
      }
    } else if (ts.isPropertyDeclaration(n)) {
      put(n.name, n.initializer);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isIdentifier(n.left) || ts.isPropertyAccessExpression(n.left))) {
      put(n.left, n.right);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return index;
}

/** The library or package type a receiver has, when it is one of the channel types. */
function channelType(checker: ts.TypeChecker, e: ts.Expression): "BroadcastChannel" | "MessagePort" | undefined {
  const sym = checker.getTypeAtLocation(e).getSymbol();
  if (sym === undefined) return undefined;
  const name = sym.getName();
  if (name !== "BroadcastChannel" && name !== "MessagePort") return undefined;
  const fromLibrary = (sym.getDeclarations() ?? []).some((d) => {
    const file = d.getSourceFile().fileName;
    return file.includes("node_modules") || file.includes("/typescript/lib/");
  });
  return fromLibrary ? name : undefined;
}

/** The channel a receiver names: a variable or field the file initialised from a channel constructor, or a port of one. */
function channelOf(checker: ts.TypeChecker, index: ChannelIndex, recv: ts.Expression): string | undefined {
  const r = unwrap(recv);
  if (ts.isIdentifier(r)) {
    const sym = checker.getSymbolAtLocation(r);
    return sym === undefined ? undefined : index.get(sym);
  }
  if (ts.isPropertyAccessExpression(r)) {
    if ((r.name.text === "port1" || r.name.text === "port2") && ts.isIdentifier(r.expression)) {
      const owner = checker.getSymbolAtLocation(r.expression);
      const id = owner === undefined ? undefined : index.get(owner);
      if (id !== undefined) return id;
    }
    const sym = checker.getSymbolAtLocation(r.name);
    return sym === undefined ? undefined : index.get(sym);
  }
  return undefined;
}

/** A postMessage call on a BroadcastChannel or MessagePort: a send on that channel. */
export function matchChannelSend(call: ts.CallExpression, checker: ts.TypeChecker, index: ChannelIndex): ChannelFact | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "postMessage") return undefined;
  const type = channelType(checker, callee.expression);
  if (type === undefined) return undefined;
  return { channel: channelOf(checker, index, callee.expression) ?? DYNAMIC, api: `${type}.postMessage` };
}

/** `ch.onmessage = fn`, or `ch.addEventListener("message", fn)`, on a BroadcastChannel or MessagePort: a receive on that channel. */
export function matchChannelRecv(node: ts.Node, checker: ts.TypeChecker, index: ChannelIndex): ChannelFact | undefined {
  let recv: ts.Expression | undefined;
  let member: string | undefined;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && node.left.name.text === "onmessage") {
    recv = node.left.expression;
    member = "onmessage";
  } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "addEventListener") {
    const first = node.arguments[0];
    if (first && ts.isStringLiteralLike(first) && first.text === "message") {
      recv = node.expression.expression;
      member = "addEventListener";
    }
  }
  if (recv === undefined || member === undefined) return undefined;
  const type = channelType(checker, recv);
  if (type === undefined) return undefined;
  return { channel: channelOf(checker, index, recv) ?? DYNAMIC, api: `${type}.${member}` };
}
