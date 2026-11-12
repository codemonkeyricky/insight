import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "refs");
const files = ["src/app.tsx", "src/widgets.tsx"];
const root = { path: fixtureRoot, name: "refs", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

/** Every edge the frontend emits for the reference fixture. */
async function edges(): Promise<IREdge[]> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: IREdge[] = [];
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) if ("edge" in record) out.push(record.edge);
  }
  return out;
}

/** `from -> to (how)` for each calls.reference edge, sorted. */
function references(all: IREdge[]): string[] {
  return all
    .filter((e) => e.kind === "calls.reference")
    .map((e) => `${e.from} -> ${e.to} (${String((e.attrs as { how?: unknown }).how)})`)
    .sort();
}

describe("calls.reference", () => {
  it("records new, JSX, value and export-reuse references, and nothing else", async () => {
    expect(references(await edges())).toEqual([
      "src/app.tsx -> src/widgets.tsx#handler (value)",
      "src/app.tsx#attach -> src/widgets.tsx#handler (value)",
      "src/app.tsx#make -> src/widgets.tsx#Store.constructor (new)",
      "src/app.tsx#pass -> src/widgets.tsx#helper (value)",
      "src/app.tsx#render -> src/widgets.tsx#Button (jsx)",
      "src/app.tsx#selfRef -> src/app.tsx#selfRef (value)",
      "src/app.tsx#viaNamespace -> src/widgets.tsx#Button (jsx)",
      "src/widgets.tsx#Widget.draw -> src/widgets.tsx#dec (value)",
      "src/widgets.tsx#Widget.pick -> src/widgets.tsx#Widget.scale (value)",
    ]);
  });

  it("leaves calls.call exactly as before: calls are never also references", async () => {
    const calls = (await edges())
      .filter((e) => e.kind === "calls.call")
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();
    expect(calls).toEqual([
      "src/app.tsx#reexported -> src/widgets.tsx#helper",
      "src/widgets.tsx#Widget.run -> src/widgets.tsx#Widget.draw",
    ]);
  });

  it("gives every reference edge the calls facet, the call-edge span shape and frontend provenance", async () => {
    const refEdges = (await edges()).filter((e) => e.kind === "calls.reference");
    for (const e of refEdges) {
      expect(e.facet).toBe("calls");
      expect(e.provenance.frontend).toBe("frontend-typescript");
      expect(e.span?.file).toBe(e.from.includes("#") ? e.from.slice(0, e.from.indexOf("#")) : e.from);
    }
  });

  it("does not treat a class without a constructor, a host JSX element, or a declaration site as a reference", async () => {
    const all = references(await edges());
    expect(all.some((r) => r.includes("Plain"))).toBe(false);
    expect(all.some((r) => r.includes("span"))).toBe(false);
    expect(all.some((r) => r.includes("#declaredOnly") || r.includes("#Button (value)"))).toBe(false);
  });
});
