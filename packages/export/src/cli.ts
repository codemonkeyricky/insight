#!/usr/bin/env node
// Exports one project to a folder of static JSON files and prints each file's size, raw and gzipped.
//
//   node packages/export/dist/cli.js <root> --out <dir> [--name n] [--commit sha]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { exportProject } from "./index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    name: { type: "string" },
    commit: { type: "string" },
  },
});
const [root] = positionals;
if (!root || !values.out) {
  console.error("usage: node packages/export/dist/cli.js <root> --out <dir> [--name n] [--commit sha]");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "insight-export-"));
try {
  const started = performance.now();
  let lastPhase = "";
  const { files } = await exportProject({
    root: resolve(root),
    name: values.name,
    commit: values.commit,
    home,
    onPhase: (p) => {
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        console.error(`phase ${p.phase}`);
      }
    },
  });
  const out = resolve(values.out);
  const rows: { file: string; raw: number; gz: number }[] = [];
  for (const [rel, text] of files) {
    const target = join(out, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    rows.push({ file: rel, raw: Buffer.byteLength(text), gz: gzipSync(text).length });
  }
  const elapsed = (performance.now() - started) / 1000;
  const width = Math.max(4, ...rows.map((r) => r.file.length));
  console.log(`${"file".padEnd(width)}  ${"raw".padStart(12)}  ${"gzip".padStart(12)}`);
  for (const r of rows) console.log(`${r.file.padEnd(width)}  ${String(r.raw).padStart(12)}  ${String(r.gz).padStart(12)}`);
  const raw = rows.reduce((s, r) => s + r.raw, 0);
  const gz = rows.reduce((s, r) => s + r.gz, 0);
  console.log(`${"total".padEnd(width)}  ${String(raw).padStart(12)}  ${String(gz).padStart(12)}  (${rows.length} files)`);
  console.log(`wrote ${out} in ${elapsed.toFixed(1)} s`);
} catch (err) {
  const e = err as { code?: string; message: string };
  console.error(`export failed${e.code ? ` (${e.code})` : ""}: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
