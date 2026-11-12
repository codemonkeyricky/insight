import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCoreRegistry, validateIR, type IREdge, type IRNode } from "@insight/ir";
import frontend from "../src/index.js";

// A handler the top-level code installs (`ctx.onmessage = fn`, `addEventListener("message", fn)`) is a flow step
// that opens the handler. The module reaches the handler through a handler reference, and a postMessage is a step.
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "worker");
const files = ["src/worker.ts", "src/verify.ts", "src/listen.ts"];
const root = { path: fixtureRoot, name: "worker", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

async function extract(): Promise<{ nodes: IRNode[]; edges: IREdge[] }> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out = { nodes: [] as IRNode[], edges: [] as IREdge[] };
  for await (const batch of frontend.extract(ctx)) {
    for (const record of batch.records) {
      if ("node" in record) out.nodes.push(record.node);
      if ("edge" in record) out.edges.push(record.edge);
    }
  }
  return out;
}

describe("handler steps", () => {
  it("records an onmessage assignment as a handler step that targets the lambda", async () => {
    const { nodes, edges } = await extract();
    const step = nodes.find((n) => n.kind === "flow.handler" && n.span?.file === "src/worker.ts");
    expect(step).toBeDefined();
    expect(step?.attrs.label).toBe("on message ▸");
    expect(step?.attrs.event).toBe("message");
    const target = String(step?.attrs.target);
    expect(target.startsWith("src/worker.ts#λ")).toBe(true);
    const ref = edges.find((e) => e.kind === "calls.reference" && e.from === "src/worker.ts#(module)" && e.to === target);
    expect((ref?.attrs as { how?: unknown } | undefined)?.how).toBe("handler");
  });

  it("records addEventListener with a named function as a handler step", async () => {
    const { nodes, edges } = await extract();
    const step = nodes.find((n) => n.kind === "flow.handler" && n.span?.file === "src/listen.ts");
    expect(step?.attrs.label).toBe("on message ▸");
    expect(step?.attrs.target).toBe("src/listen.ts#onMessage");
    expect(edges.some((e) => e.kind === "calls.reference" && e.to === "src/listen.ts#onMessage" && (e.attrs as { how?: unknown }).how === "handler")).toBe(true);
  });

  it("records postMessage inside the handler as a message effect", async () => {
    const { nodes } = await extract();
    const post = nodes.find((n) => n.kind === "effects.message.post");
    expect(post?.parent).toMatch(/^src\/worker\.ts#λ/);
  });
});

describe("emitted records validate against the IR schema", () => {
  it("validates every node and edge the worker fixture produces, including handler references", async () => {
    const { nodes, edges } = await extract();
    // The host indexes each file as a structure.file node, and the frontend's records hang off them.
    const fileNodes = files.map((path) => ({
      id: path,
      facet: "structure",
      kind: "structure.file",
      attrs: { path, language: "typescript", parseStatus: "ok" },
      provenance: { frontend: "test", confidence: "exact" },
    }));
    const text = [...fileNodes.map((node) => ({ node })), ...nodes.map((node) => ({ node })), ...edges.map((edge) => ({ edge }))]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const report = validateIR(text, createCoreRegistry());
    expect(report.errors.map((e) => e.message)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(edges.some((e) => e.kind === "calls.reference" && (e.attrs as { how?: unknown }).how === "handler")).toBe(true);
  });
});
