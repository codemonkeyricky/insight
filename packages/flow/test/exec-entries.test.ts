import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, type ExecModel, type ExecThread } from "../src/index.js";

// A browser page (index.html -> main.tsx, which starts a worker), two Node scripts under scripts/, a test file and a
// helper nothing references. Only the page and the two scripts are entries.
const FILES: Record<string, string> = {
  "index.html": `<!doctype html>
<html>
  <body>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
  "src/main.tsx": `import { build } from "./lib.js";

const worker = new Worker(new URL("./verify.worker.ts", import.meta.url), { type: "module" });
export const size = worker ? build() : 0;
`,
  "src/verify.worker.ts": `import { check } from "./lib.js";

const ctx = self as unknown as { onmessage: ((e: { data: number }) => void) | null };
ctx.onmessage = (e) => {
  check(e.data);
};
`,
  "src/lib.ts": `export function build(): number {
  return 1;
}

export function check(v: number): boolean {
  return build() + v > 1;
}
`,
  "src/helper.ts": `export function movePart(): number {
  return 0;
}
`,
  "src/app.test.ts": `import { build } from "./lib.js";

build();
`,
  "scripts/gen.ts": `#!/usr/bin/env node
import { build } from "../src/lib.js";

const name = process.argv[2] ?? "cat";
console.log(name, build());
`,
  "scripts/clean.ts": `const dir = process.argv[2] ?? ".";
console.log(dir);
`,
};
const FILE_LIST = Object.keys(FILES).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
const BROWSER = "entry:browser";
const GEN = "entry:node:scripts/gen.ts";
const CLEAN = "entry:node:scripts/clean.ts";
const MAIN = "src/main.tsx#(module)";
const WORKER = "src/verify.worker.ts#(module)";
const MOVE = "src/helper.ts#movePart";

let model: ExecModel;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-exec-entries-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "entries-sample", type: "module" }));
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const ctx = {
      root: { path: dir, name: "entries-sample", allowBuildTools: false },
      files: Object.keys(FILES),
      listFiles: () => Object.keys(FILES),
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

const thread = (id: string): ExecThread | undefined => model.threads.find((t) => t.id === id);

describe("programs from entries", () => {
  it("makes three programs: one browser page and one per Node script", () => {
    expect(model.programs.map((p) => p.id)).toEqual([BROWSER, CLEAN, GEN]);
    expect(model.programs.map((p) => p.kind)).toEqual(["browser", "node", "node"]);
  });

  it("gives the browser program its main thread and its worker inside it", () => {
    const browser = model.programs.find((p) => p.id === BROWSER);
    expect(browser?.name).toBe("index.html");
    expect(browser?.entries).toEqual([MAIN]);
    const main = thread(`main:${BROWSER}`);
    expect(main?.kind).toBe("main");
    expect(main?.roots).toEqual([MAIN]);
    const worker = model.threads.find((t) => t.spawn !== undefined && t.roots.includes(WORKER));
    expect(worker).toBeDefined();
    expect(browser?.threads).toEqual(expect.arrayContaining([`main:${BROWSER}`, worker?.id]));
  });

  it("gives each Node script its own main thread, rooted at its module", () => {
    for (const [id, file] of [
      [GEN, "scripts/gen.ts"],
      [CLEAN, "scripts/clean.ts"],
    ] as const) {
      const p = model.programs.find((x) => x.id === id);
      expect(p?.name).toBe(file);
      expect(p?.threads).toEqual([`main:${id}`]);
      expect(thread(`main:${id}`)?.roots).toEqual([`${file}#(module)`]);
    }
  });

  it("does not make a test file an entry", () => {
    expect(model.programs.some((p) => p.name.includes("app.test"))).toBe(false);
    expect(model.threads.some((t) => t.roots.some((r) => r.startsWith("src/app.test.ts")))).toBe(false);
  });

  it("does not make an unreferenced helper a root: it runs on no thread", () => {
    expect(model.threads.some((t) => t.roots.includes(MOVE))).toBe(false);
    expect(model.unthreaded).toContain(MOVE);
  });

  it("lists the main thread of each program with a grounded flag", () => {
    expect(model.threads.every((t) => t.grounded)).toBe(true);
  });
});
