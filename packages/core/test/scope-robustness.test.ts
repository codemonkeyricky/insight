import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRDocument } from "@insight/ir";
import type { ProjectRoot } from "@insight/sdk";
import { loadPlugins, projectPaths, readSnapshot, runIndex, runLensOnScope, type LoadedPlugins } from "../src/index.js";

// Every lens over the root, every folder and every file of two small fixtures. A scope cut creates external stubs
// at each cross-file edge, which is where a lens that trusts the whole project would fail. A lens may report nothing
// for a scope, but it must not return status "error". The fixtures are small so the test stays quick:
// samples/lock-order-fixture (C++ locks and threads, one file) and a generated TypeScript project whose folders call
// each other, with a module cycle between two files. The google/benchmark sample is covered by the golden test.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const SCRATCH = join(here, "..", ".insight-test", `scope-robustness-${process.pid}`);
const userPluginDir = join(SCRATCH, "no-user-plugins");
const TIMEOUT = 120_000;

const LENS_IDS = [
  "lens-calls",
  "lens-concurrency-map",
  "lens-dependencies",
  "lens-effects",
  "lens-execution",
  "lens-flow-complexity",
  "lens-lock-order",
];

const TS_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "robust", version: "0.0.0", private: true }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src"],
  }),
  "src/main.ts": `import { handle } from "./api/handler.js";
import { report } from "./tools/report.js";

export async function main(): Promise<string> {
  if (process.env.MODE === "quiet") return "";
  if (await handle("boot")) return report();
  return "failed";
}
`,
  "src/api/handler.ts": `import { save } from "../core/store.js";

export async function handle(input: string): Promise<boolean> {
  const dir = process.env.STORE_DIR ?? "/tmp";
  if (input.length === 0) return false;
  for (const ch of input) {
    if (ch === "!") break;
  }
  return save(dir + "/" + input);
}
`,
  "src/core/store.ts": `import { writeFileSync } from "node:fs";
import { checksum, normalize } from "./util.js";

export async function save(path: string): Promise<boolean> {
  try {
    writeFileSync(path, checksum(path));
    return true;
  } catch {
    return false;
  }
}

export function label(path: string): string {
  return normalize(path);
}
`,
  "src/core/util.ts": `import { label } from "./store.js";

export function checksum(text: string): string {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum = (sum + text.charCodeAt(i)) % 65521;
  return String(sum) + label(text);
}

export function normalize(text: string): string {
  return text.trim();
}
`,
  "src/tools/report.ts": `import { handle } from "../api/handler.js";

export async function report(): Promise<string> {
  const ok = await handle("daily");
  return ok ? "ok" : "failed";
}
`,
  "src/tools/format.ts": `export function classify(n: number): string {
  switch (n) {
    case 0:
      return "zero";
    case 1:
      return "one";
    default:
      break;
  }
  let out = "";
  while (n > 0) {
    out += "x";
    n--;
  }
  try {
    JSON.parse(out);
  } catch {
    return "bad";
  }
  return out;
}
`,
};

interface Indexed {
  root: ProjectRoot;
  plugins: LoadedPlugins;
  doc: IRDocument;
  snapshot: string;
  /** Every folder and file that holds source, sorted. The root "" is not in the list. */
  scopes: string[];
}

/** Every file, and every folder above a file, from the structure.file nodes of the document. */
function scopesOf(doc: IRDocument): string[] {
  const files = doc.nodes.filter((n) => n.kind === "structure.file").map((n) => n.id);
  const all = new Set<string>(files);
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  return [...all].sort();
}

async function indexFixture(name: string, copy: (dir: string) => void): Promise<Indexed> {
  const project = join(SCRATCH, name);
  mkdirSync(project, { recursive: true });
  copy(project);
  const report = await runIndex({ projectPath: project, builtinRoot: repoRoot, userPluginDir, full: true });
  const doc: IRDocument = { nodes: [], edges: [], findings: [] };
  for (const r of readSnapshot(projectPaths(project), report.snapshot)) {
    if ("node" in r) doc.nodes.push(r.node);
    else if ("edge" in r) doc.edges.push(r.edge);
    else doc.findings.push(r.finding);
  }
  const plugins = await loadPlugins({ projectPath: project, builtinRoot: repoRoot, userPluginDir });
  return {
    root: { path: project, name, allowBuildTools: false },
    plugins,
    doc,
    snapshot: report.snapshot,
    scopes: scopesOf(doc),
  };
}

function writeTsProject(dir: string): void {
  for (const [path, text] of Object.entries(TS_FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

let lockOrder: Indexed;
let typeScript: Indexed;

beforeAll(async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  lockOrder = await indexFixture("lock-order", (dir) =>
    cpSync(join(repoRoot, "samples", "lock-order-fixture"), dir, { recursive: true }),
  );
  typeScript = await indexFixture("typescript", writeTsProject);
}, TIMEOUT);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** Runs every loaded lens on the root scope and on every scope of the fixture. Collects the errors and the statuses. */
async function runEveryScope(fx: Indexed): Promise<{ statuses: Set<string>; failures: string[] }> {
  const statuses = new Set<string>();
  const failures: string[] = [];
  for (const scope of ["", ...fx.scopes]) {
    for (const lens of fx.plugins.lenses) {
      const record = await runLensOnScope({
        doc: fx.doc,
        registry: fx.plugins.registry,
        root: fx.root,
        snapshot: fx.snapshot,
        scope,
        lens,
        lenses: fx.plugins.lenses,
        configs: {},
      });
      statuses.add(record.status);
      if (record.status === "error") failures.push(`${lens.lens.id} on "${scope}": ${record.reason ?? "no reason"}`);
    }
  }
  return { statuses, failures };
}

describe("scoped lens robustness", () => {
  it("loads every lens package the fixtures run", () => {
    const ids = typeScript.plugins.lenses.map((l) => l.lens.id);
    expect(ids).toEqual(expect.arrayContaining(LENS_IDS));
  });

  it("finds the folder and file scopes of each fixture", () => {
    expect(lockOrder.scopes).toEqual(["src", "src/ledger.cc"]);
    expect(typeScript.scopes).toEqual([
      "package.json",
      "src",
      "src/api",
      "src/api/handler.ts",
      "src/core",
      "src/core/store.ts",
      "src/core/util.ts",
      "src/main.ts",
      "src/tools",
      "src/tools/format.ts",
      "src/tools/report.ts",
      "tsconfig.json",
    ]);
  });

  it("runs every lens on every scope of the C++ fixture without an error", async () => {
    const { statuses, failures } = await runEveryScope(lockOrder);
    expect(failures).toEqual([]);
    expect(statuses.has("ok")).toBe(true);
  }, TIMEOUT);

  it("runs every lens on every scope of the TypeScript fixture without an error", async () => {
    const { statuses, failures } = await runEveryScope(typeScript);
    expect(failures).toEqual([]);
    expect(statuses.has("ok")).toBe(true);
  }, TIMEOUT);

  it("returns the stored result when the same scope is run again", async () => {
    const lens = typeScript.plugins.lenses.find((l) => l.lens.id === "lens-calls");
    if (!lens) throw new Error("lens-calls is not loaded");
    const args = {
      doc: typeScript.doc,
      registry: typeScript.plugins.registry,
      root: typeScript.root,
      snapshot: typeScript.snapshot,
      scope: "src/core",
      lens,
      lenses: typeScript.plugins.lenses,
      configs: {},
    };
    const first = await runLensOnScope(args);
    const second = await runLensOnScope(args);
    expect(first.status).toBe("ok");
    expect(second.reused).toBe(true);
    expect(second.inputsHash).toBe(first.inputsHash);
    expect(second.result).toEqual(first.result);
  }, TIMEOUT);
});
