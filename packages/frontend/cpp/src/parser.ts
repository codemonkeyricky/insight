import { createRequire } from "node:module";
import type * as WebTreeSitter from "web-tree-sitter";

export type { Node as SyntaxNode, Tree } from "web-tree-sitter";

// web-tree-sitter is CommonJS with named exports. Loading it through createRequire avoids depending
// on how the bundler or Node interoperates with its module shape.
const require = createRequire(import.meta.url);
const TreeSitter = require("web-tree-sitter") as typeof WebTreeSitter;

let parserReady: Promise<WebTreeSitter.Parser> | undefined;

/** One parser for the process. The grammar is the WASM build shipped by tree-sitter-cpp. */
export function getParser(): Promise<WebTreeSitter.Parser> {
  parserReady ??= (async () => {
    await TreeSitter.Parser.init();
    const language = await TreeSitter.Language.load(require.resolve("tree-sitter-cpp/tree-sitter-cpp.wasm"));
    const parser = new TreeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserReady;
}
