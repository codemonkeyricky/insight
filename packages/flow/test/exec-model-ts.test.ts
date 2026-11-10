import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, type ExecModel, type ExecThread } from "../src/index.js";

// A browser app: index.html loads main.tsx, which imports client.ts (two Workers) and awaits loader.ts.
const FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html>
  <body>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "src/main.tsx": `import "./client.js";
import { loadMeshes } from "./loader.js";
import { meshThickness } from "./verify/mesh.js";

export async function boot() {
  const meshes = await loadMeshes();
  return meshes.map(meshThickness);
}

boot();
`,
  "src/loader.ts": `export async function loadMeshes(): Promise<number[]> {
  return [1, 2, 3];
}
`,
  "src/client.ts": `const url = new URL("./verify/verify.worker.ts", import.meta.url);

export const checker = new Worker(url, { type: "module" });
export const printer = new Worker(new URL("./verify/print.worker.ts", import.meta.url), { type: "module" });
`,
  "src/verify/mesh.ts": `export function meshThickness(v: number): number {
  return v * 2;
}
`,
  "src/verify/verify.ts": `import { meshThickness } from "./mesh.js";

export function verify(v: number): boolean {
  return meshThickness(v) > 1;
}
`,
  "src/verify/verify.worker.ts": `import { verify } from "./verify.js";

const ctx = self as unknown as { onmessage: ((e: { data: number }) => void) | null };
ctx.onmessage = (e) => {
  verify(e.data);
};
`,
  "src/verify/print.worker.ts": `import { meshThickness } from "./mesh.js";

const ctx = self as unknown as { onmessage: ((e: { data: number }) => void) | null };
ctx.onmessage = (e) => {
  meshThickness(e.data);
};
`,
};
const FILE_LIST = Object.keys(FILES).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
const VERIFY_WORKER = "src/verify/verify.worker.ts#(module)";
const PRINT_WORKER = "src/verify/print.worker.ts#(module)";
const MAIN = "src/main.tsx#(module)";
const LOAD_MESHES = "src/loader.ts#loadMeshes";
const VERIFY = "src/verify/verify.ts#verify";
const MESH = "src/verify/mesh.ts#meshThickness";

let model: ExecModel;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-exec-ts-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "exec-ts-sample", type: "module" }));
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const ctx = {
      root: { path: dir, name: "exec-ts-sample", allowBuildTools: false },
      files: FILE_LIST,
      listFiles: () => FILE_LIST,
      readFile: async (rel: string) => FILES[rel] ?? "",
      log: () => undefined,
    };
    const nodes: IRNode[] = [];
    const edges: IREdge[] = [];
    for await (const batch of frontend.extract(ctx)) {
      for (const r of batch.records) {
        if ("node" in r) nodes.push(r.node);
        else if ("edge" in r) edges.push(r.edge);
      }
    }
    model = execModel(nodes, edges, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The thread that a spawn started on the given module, if any. */
const workerThread = (rootId: string): ExecThread | undefined =>
  model.threads.find((t) => t.spawn !== undefined && t.roots.includes(rootId));

describe("exec model for a browser project", () => {
  it("grounds the main thread in the html entry module", () => {
    const main = model.threads.find((t) => t.kind === "main");
    expect(main?.grounded).toBe(true);
    expect(main?.roots).toContain(MAIN);
  });

  it("starts one grounded thread per Worker, rooted at its worker module", () => {
    expect(workerThread(VERIFY_WORKER)?.grounded).toBe(true);
    expect(workerThread(PRINT_WORKER)?.grounded).toBe(true);
    expect(model.threads.filter((t) => t.spawn !== undefined)).toHaveLength(2);
  });

  it("reaches the shared code from each worker through the module's top-level handler", () => {
    expect(workerThread(VERIFY_WORKER)?.reached).toEqual(expect.arrayContaining([VERIFY, MESH]));
    expect(workerThread(PRINT_WORKER)?.reached).toEqual(expect.arrayContaining([MESH]));
  });

  it("records the awaited loader as a coroutine of the main thread", () => {
    const main = model.threads.find((t) => t.kind === "main");
    expect(main?.coroutines.map((c) => c.target)).toContain(LOAD_MESHES);
    expect(model.stats.coroutines).toBeGreaterThan(0);
  });
});
