import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge } from "@insight/ir";
import frontend from "../src/index.js";

// Reference and call cases the first fixture does not cover: object-literal methods, this-method calls, a factory that
// constructs a class, and a decorator. Each case already resolves through an existing edge kind, and this test pins that.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "refs-extra");
const files = ["src/obj.ts", "src/factory.ts", "src/store.ts", "src/dec.ts"];
const root = { path: fixtureRoot, name: "refs-extra", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function edges(): Promise<IREdge[]> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: IREdge[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) if ("edge" in record) out.push(record.edge);
  }
  return out;
}

const pairs = (all: IREdge[], kind: string) =>
  all
    .filter((e) => e.kind === kind)
    .map((e) => {
      const how = (e.attrs as { how?: unknown }).how;
      return `${e.from} -> ${e.to}${how === undefined ? "" : ` (${String(how)})`}`;
    })
    .sort();

describe("object-literal methods, this-method calls, factories and decorators", () => {
  it("resolves calls to methods through this and through object literals", async () => {
    expect(pairs(await edges(), "calls.call")).toEqual([
      "src/factory.ts#useFactory -> src/factory.ts#makeStore",
      "src/obj.ts#Local.go -> src/obj.ts#Local.step",
      "src/obj.ts#callRun -> src/obj.ts#run",
      "src/obj.ts#useApi -> src/obj.ts#onClick",
      "src/obj.ts#viaProp -> src/obj.ts#pass",
    ]);
  });

  it("records an object-literal method passed as a value, a factory's new, and a decorator", async () => {
    expect(pairs(await edges(), "calls.reference")).toEqual([
      "src/factory.ts -> src/store.ts#Store.constructor (new)",
      "src/factory.ts#Decorated.m -> src/dec.ts#log (value)",
      "src/factory.ts#makeStore -> src/store.ts#Store.constructor (new)",
      "src/obj.ts#viaProp -> src/obj.ts#onClick (value)",
    ]);
  });
});
