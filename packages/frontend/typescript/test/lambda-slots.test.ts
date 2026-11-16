import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// The `anonymous` attribute of a lambda says whether it is a callback slot. A property arrow of a returned or stored literal is a named
// member; a property arrow of an options bag passed to a call is a callback slot; a lambda passed directly is one too. A property of a
// bound literal is named by the property, and its declared parameters and derived locals are emitted like a declared function's.

const FILE = "src/slots.ts";

const SOURCE = `export interface Parser { parse(t: string): string }
export function makeParser(): Parser {
  return { parse: (t) => t };
}
export function runWith(opts: { onProgress?: (l: string) => void }): void {
  opts.onProgress?.("x");
}
export function main(): void {
  runWith({ onProgress: (l) => { void l; } });
  [1].forEach((n) => { void n; });
  const ops = { load: (p: string) => { const q = p; void q; } };
  ops.load("a");
}
`;

let dir = "";
let nodes: IRNode[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "insight-lambda-slots-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lambda-slots", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true }, include: ["src"] }));
  writeFileSync(join(dir, FILE), SOURCE);
  const ctx = {
    root: { path: dir, name: "lambda-slots", allowBuildTools: false },
    files: [FILE],
    listFiles: () => [FILE],
    readFile: async () => SOURCE,
    log: () => undefined,
  };
  for await (const batch of frontend.extract(ctx)) {
    for (const r of batch.records) if ("node" in r && r.node.kind === "structure.function") nodes.push(r.node);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The function node whose span starts on the 1-based source line holding the text. */
const fnAt = (text: string): IRNode | undefined => {
  const line = SOURCE.split("\n").findIndex((l) => l.includes(text));
  return nodes.find((n) => n.span?.start[0] === line);
};

describe("frontend-typescript callback slots", () => {
  it("marks a property arrow of a returned literal as a named member, not a callback", () => {
    expect(fnAt("return { parse:")?.attrs.anonymous).toBe(false);
  });

  it("marks a property arrow of an options bag passed to a call as a callback slot", () => {
    expect(fnAt("runWith({ onProgress:")?.attrs.anonymous).toBe(true);
  });

  it("marks a lambda passed directly to a call as a callback", () => {
    expect(fnAt("forEach((n)")?.attrs.anonymous).toBe(true);
  });

  it("names a property of a bound literal by the property, with its parameters and derives", () => {
    const load = nodes.find((n) => n.attrs.name === "load");
    expect(load?.attrs.anonymous).toBeUndefined();
    expect(load?.attrs.params).toEqual(["p"]);
    expect(load?.attrs.derives).toEqual({ q: ["p"] });
  });
});
