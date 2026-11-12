import ts from "typescript";
import { createHash } from "node:crypto";

/**
 * Digest of a file's API: its text with every function body removed. A body-only change leaves
 * the digest alone, so dependents keep their shards. Top-level statements still count.
 */
export function apiDigest(relPath: string, text: string): string {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, false, scriptKind(relPath));
  const cuts: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)) &&
      node.body &&
      ts.isBlock(node.body)
    ) {
      cuts.push([node.body.getStart(sf) + 1, node.body.end - 1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [start, end] of cuts) {
    if (start < pos) continue;
    out += text.slice(pos, start);
    pos = end;
  }
  out += text.slice(pos);
  return createHash("sha256").update(out).digest("hex");
}

export function scriptKind(rel: string): ts.ScriptKind {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
