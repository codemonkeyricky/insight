import ts from "typescript";
import { createHash } from "node:crypto";
import { globalWritesIn } from "./data.js";

/**
 * Digest of a file's API: its text with every function body removed, plus its global writes. A body-only change leaves
 * the digest alone, so dependents keep their shards, unless it moves or changes a global write. Top-level statements still count.
 */
export function apiDigest(relPath: string, text: string): string {
  // Parents are set: the global writes are found through them.
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, scriptKind(relPath));
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
  // Global writes are part of the API, since a reader of a global depends on them. A body-only change that moves or drops one
  // is seen. A file with none adds nothing, so its digest is unchanged.
  const writes = globalWritesIn(sf);
  if (writes.length > 0) out += `\n//global-writes:${writes.map((w) => `${w.name}@${w.start}-${w.end}`).join(",")}`;
  return createHash("sha256").update(out).digest("hex");
}

export function scriptKind(rel: string): ts.ScriptKind {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
