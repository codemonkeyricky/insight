// Feasibility spike: parse every Verilog/SystemVerilog file under the given directories with the
// tree-sitter-systemverilog WASM grammar and print one JSON summary to stdout.
// Usage: node scripts/spike.mjs <dir>...
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const TreeSitter = require("web-tree-sitter");
const RTL_RE = /\.(v|sv|svh|vh)$/;

const roots = process.argv.slice(2).map((d) => resolve(d));
if (roots.length === 0) {
  console.error("usage: node scripts/spike.mjs <dir>...");
  process.exit(2);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && RTL_RE.test(entry.name)) yield p;
  }
}

const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

const wasmStart = performance.now();
await TreeSitter.Parser.init();
const language = await TreeSitter.Language.load(
  require.resolve("tree-sitter-systemverilog/tree-sitter-systemverilog.wasm"),
);
const parser = new TreeSitter.Parser();
parser.setLanguage(language);
const wasmLoadMs = Math.round(performance.now() - wasmStart);

let peakRss = process.memoryUsage().rss;
let files = 0;
let totalLines = 0;
let totalBytes = 0;
let parseMsTotal = 0;
let filesWithErrors = 0;
let errorNodeCount = 0;
let missingNodeCount = 0;
let errorLinesTotal = 0;
let unreadable = 0;
let timeouts = 0;
const perFile = [];
const errorParents = new Map();

for (const root of roots) {
  const base = statSync(root).isDirectory() ? root : resolve(root, "..");
  const paths = statSync(root).isDirectory() ? walk(root) : [root];
  for (const abs of paths) {
    const rel = relative(base, abs);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    const lines = text.length === 0 ? 0 : text.split("\n").length;
    const t0 = performance.now();
    const tree = parser.parse(text);
    const ms = performance.now() - t0;
    if (!tree) {
      timeouts++;
      continue;
    }
    files++;
    totalLines += lines;
    totalBytes += Buffer.byteLength(text, "utf8");
    parseMsTotal += ms;
    perFile.push({ file: rel, ms: Math.round(ms * 10) / 10, lines });

    const errorRows = new Set();
    let fileErrors = 0;
    const cursor = tree.walk();
    let descend = true;
    // Iterative pre-order walk over every node, tracking ERROR nodes and MISSING nodes.
    for (;;) {
      const node = cursor.currentNode;
      if (descend && node.type === "ERROR") {
        fileErrors++;
        const parentType = node.parent ? node.parent.type : "(root)";
        errorParents.set(parentType, (errorParents.get(parentType) ?? 0) + 1);
        for (let r = node.startPosition.row; r <= node.endPosition.row; r++) errorRows.add(r);
      }
      if (node.isMissing) missingNodeCount++;
      if (descend && cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) {
        descend = true;
        continue;
      }
      let up = false;
      while (cursor.gotoParent()) {
        if (cursor.gotoNextSibling()) {
          up = true;
          break;
        }
      }
      if (!up) break;
      descend = true;
    }
    cursor.delete();
    errorNodeCount += fileErrors;
    if (fileErrors > 0 || tree.rootNode.hasError) filesWithErrors++;
    errorLinesTotal += errorRows.size;
    if (fileErrors > 0) perFile[perFile.length - 1].errors = fileErrors;
    tree.delete();

    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
}

const r1 = (n) => Math.round(n * 10) / 10;
const result = {
  roots: roots.map((r) => relative(process.cwd(), r) || "."),
  files,
  totalLines,
  totalBytes,
  parseMsTotal: r1(parseMsTotal),
  slowestFiles: [...perFile]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map(({ file, ms, lines }) => ({ file, ms, lines })),
  filesWithErrors,
  errorNodeCount,
  missingNodeCount,
  errorLineFraction: totalLines === 0 ? 0 : Math.round((errorLinesTotal / totalLines) * 10000) / 10000,
  topErrorParents: [...errorParents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([type, count]) => ({ type, count })),
  topErrorFiles: perFile
    .filter((f) => f.errors)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 10)
    .map(({ file, errors }) => ({ file, errors })),
  peakRssMB: mb(peakRss),
  wasmLoadMs,
  unreadable,
  parseTimeouts: timeouts,
};
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
