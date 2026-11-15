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
};
const CHECK = "entry:node:scripts/check.ts";
const DEEP = "entry:node:tools/scripts/deep.ts";
const RUN = "entry:node:scripts/run.ts";

let model: ExecModel;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-script-entries-"));
  try {
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const ctx = {
      root: { path: dir, name: "script-entries-sample", allowBuildTools: false },
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

describe("Node script programs", () => {
  it("makes a program for each script that runs on load, and for the one package.json names", () => {
    const node = model.programs.filter((p) => p.kind === "node").map((p) => p.id);
    expect(node.sort()).toEqual([CHECK, DEEP, RUN].sort());
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
});
