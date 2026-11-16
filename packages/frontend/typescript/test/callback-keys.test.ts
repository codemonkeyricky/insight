import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// A callback's parameter shares its name with a local of the function it sits in. The two are different locals: the frontend keys
// each by its own declaration line, so a read inside the callback never names the driver's local.

const FILE = "src/cb.ts";

const SOURCE = `function pick(): string {
  return "a";
}
function use(v: unknown): void {
  void v;
}
function sinkC(v: string): void {
  void v;
}
export function outer(paths: string[]): void {
  const file = pick();
  use(file);
  paths.forEach((file) => sinkC(file));
}
`;

let dir = "";
let edges: IREdge[] = [];
let nodes: IRNode[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-callback-keys-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "callback-keys", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, FILE), SOURCE);
  const ctx = {
    root: { path: dir, name: "callback-keys", allowBuildTools: false },
    files: [FILE],
    listFiles: () => [FILE],
    readFile: async () => SOURCE,
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) {
      if ("node" in r) nodes.push(r.node);
      else edges.push(r.edge);
    }
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The 1-based line of the source line holding the text. */
const lineOf = (text: string): number => SOURCE.split("\n").findIndex((l) => l.includes(text)) + 1;
/** The calls.call edge with a given callee text. */
const callTo = (callee: string): IREdge | undefined => edges.find((e) => e.kind === "calls.call" && e.attrs?.callee === callee);

describe("frontend-typescript callback locals", () => {
  it("keys a driver local and a same-named callback parameter by their own declaration lines", () => {
    const driverLine = lineOf("const file = pick()");
    const cbLine = lineOf("paths.forEach((file)");
    expect(driverLine).toBeGreaterThan(0);
    expect(cbLine).toBeGreaterThan(driverLine);
    expect(callTo("pick")?.attrs?.binds).toBe(`file@${driverLine}`);
    expect(callTo("use")?.attrs?.reads).toEqual([`file@${driverLine}`]);
    expect(callTo("sinkC")?.attrs?.reads).toEqual([`file@${cbLine}`]);
  });

  it("gives the callback its parameter under the same key its reads use", () => {
    const cbLine = lineOf("paths.forEach((file)");
    const cb = nodes.find((n) => n.kind === "structure.function" && n.attrs.anonymous === true && n.span?.start[0] === cbLine - 1);
    expect(cb?.attrs.params).toEqual([`file@${cbLine}`]);
  });
});
