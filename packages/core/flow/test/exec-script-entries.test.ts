import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { execModel, type ExecModel } from "../src/index.js";

// Files that test which scripts become Node programs. The package.json names scripts/run.ts; scripts/use.ts imports it.
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "script-entries-sample", type: "module", scripts: { start: "tsx scripts/run.ts" } }),
  // A script with top-level calls and no shebang or process.argv: a program.
  "scripts/check.ts": `import { readFileSync } from "node:fs";

function check(): number {
  return readFileSync("x", "utf8").length;
}
check();
process.exit(0);
`,
  // A library: exports and constants only, nothing runs on load: not a program.
  "scripts/lib.ts": `export function build(): number {
  return 1;
}
export const made = build();
`,
  // A script under a nested tools/scripts/ folder, with a top-level call: a program.
  "tools/scripts/deep.ts": `function go(): void {
  console.log("deep");
}
go();
`,
  // Named by package.json and imported by scripts/use.ts: a program anyway.
  "scripts/run.ts": `export function run(): number {
  return 1;
}
run();
`,
  "scripts/use.ts": `import { run } from "./run.js";

export function useIt(): number {
  return run() + 1;
}
`,
  // Outside a scripts/ or bin/ folder, so never a Node entry even with a top-level call.
  "src/side.ts": `export function side(): number {
  return 2;
}
side();
`,
  // A test file under scripts/: never an entry.
  "scripts/x.test.ts": `import { run } from "./run.js";

run();
`,
  // Its only top-level work is an awaited declaration: a program.
  "scripts/vawait.ts": `async function main(): Promise<number> {
  return 1;
}
const n = await main();
export { n };
`,
  // Page code under a nested scripts/ folder, loaded by a bundler: not a Node program.
  "web/src/scripts/theme.ts": `const dark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = dark ? "dark" : "light";
`,
};
const CHECK = "entry:node:scripts/check.ts";
const DEEP = "entry:node:tools/scripts/deep.ts";
const RUN = "entry:node:scripts/run.ts";
const VAWAIT = "entry:node:scripts/vawait.ts";

let model: ExecModel;
/** The same files under a private monorepo root: a package.json with scripts and no name. */
let unnamed: ExecModel;

async function modelOf(files: Record<string, string>): Promise<ExecModel> {
  const dir = mkdtempSync(join(tmpdir(), "insight-script-entries-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const ctx = {
      root: { path: dir, name: "script-entries-sample", allowBuildTools: false },
      files: Object.keys(files),
      listFiles: () => Object.keys(files),
      readFile: async (rel: string) => files[rel] ?? "",
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
    return execModel(nodes, edges, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  model = await modelOf(FILES);
  unnamed = await modelOf({ ...FILES, "package.json": JSON.stringify({ private: true, type: "module", scripts: { start: "tsx scripts/run.ts" } }) });
});

describe("Node script programs", () => {
  it("makes a program for each script that runs on load, and for the one package.json names", () => {
    const node = model.programs.filter((p) => p.kind === "node").map((p) => p.id);
    expect(node.sort()).toEqual([CHECK, DEEP, RUN, VAWAIT].sort());
  });

  it("makes a program for a script under a nested scripts/ folder", () => {
    expect(model.programs.find((p) => p.id === DEEP)?.name).toBe("tools/scripts/deep.ts");
  });

  it("keeps a script named by package.json even when another file imports it", () => {
    expect(model.programs.some((p) => p.id === RUN)).toBe(true);
  });

  it("does not make a library, a test, or a file outside scripts/ a program", () => {
    const ids = model.programs.map((p) => p.id);
    expect(ids.some((id) => id.includes("scripts/lib.ts"))).toBe(false);
    expect(ids.some((id) => id.includes("scripts/use.ts"))).toBe(false);
    expect(ids.some((id) => id.includes("x.test.ts"))).toBe(false);
    expect(ids.some((id) => id.includes("src/side.ts"))).toBe(false);
  });

  it("does not make page code under a nested scripts/ folder a program", () => {
    expect(model.programs.some((p) => p.id.includes("theme.ts"))).toBe(false);
  });

  it("keeps an imported script that an unnamed root package.json names", () => {
    const node = unnamed.programs.filter((p) => p.kind === "node").map((p) => p.id);
    expect(node.sort()).toEqual([CHECK, DEEP, RUN, VAWAIT].sort());
  });
});
