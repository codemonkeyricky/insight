import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import frontend from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "paths");
const files = [
  "packages/tool/src/run.ts",
  "packages/tool/src/w.ts",
  "packages/tool/w.ts",
  "src/child.ts",
  "src/helpers/run.ts",
  "src/main.ts",
  "src/worker.ts",
];
const root = { path: fixtureRoot, name: "paths", allowBuildTools: false };
const readFile = async (rel: string) => readFileSync(join(fixtureRoot, rel), "utf8");

interface Extracted {
  edges: IREdge[];
  nodes: IRNode[];
  dependsOn: Map<string, string[]>;
}

/** Every edge and node the frontend emits for the paths fixture, and the dependsOn of each file. */
async function extract(): Promise<Extracted> {
  const ctx = { root, files, listFiles: () => [...files], readFile, log: () => undefined };
  const out: Extracted = { edges: [], nodes: [], dependsOn: new Map() };
  for await (const batch of frontend.extract(ctx)) {
    out.dependsOn.set(batch.file, batch.dependsOn ?? []);
    for (const record of batch.records) {
      if ("edge" in record) out.edges.push(record.edge);
      if ("node" in record) out.nodes.push(record.node);
    }
  }
  return out;
}

/** `from -> to (how)` for each edge of one kind, sorted. */
function labelled(all: IREdge[], kind: string): string[] {
  return all
    .filter((e) => e.kind === kind)
    .map((e) => `${e.from} -> ${e.to} (${String((e.attrs as { how?: unknown }).how)})`)
    .sort();
}

/** The file part of a node or edge id: `<rel>#...`, `<rel>@...`, or the bare rel path. */
const fileOf = (id: string): string => id.split(/[#@]/)[0] ?? id;

/** Every spawn the frontend recorded, as a node id. */
const spawnIds = (nodes: IRNode[]): string[] =>
  nodes
    .filter((n) => n.kind === "concurrency.spawn-thread" || n.kind === "concurrency.spawn-process")
    .map((n) => n.id);

describe("concurrency.spawns: Node path semantics", () => {
  it("links each spawn whose script resolves to a project file, and no other", async () => {
    // Listed in source order; the test compares sorted, as labelled() sorts.
    const expected = [
      // file-relative: new URL, join of import.meta.dirname, a template over __dirname, fileURLToPath of a URL
      "src/main.ts@spawn:7:9 -> src/worker.ts (thread)",
      "src/main.ts@spawn:12:9 -> src/worker.ts (thread)",
      "src/main.ts@spawn:17:9 -> src/worker.ts (thread)",
      "src/main.ts@spawn:22:2 -> src/child.ts (process)",
      // file-relative from a subdirectory, with .. segments
      "src/helpers/run.ts@spawn:5:9 -> src/worker.ts (thread)",
      "src/helpers/run.ts@spawn:10:9 -> src/worker.ts (thread)",
      // file-relative beside the file, in a nested package
      "packages/tool/src/run.ts@spawn:9:9 -> packages/tool/src/w.ts (thread)",
      // cwd-relative literals, resolved from the nearest package or the root
      "packages/tool/src/run.ts@spawn:4:9 -> packages/tool/w.ts (thread)",
      "packages/tool/src/run.ts@spawn:14:9 -> packages/tool/src/w.ts (thread)",
      "packages/tool/src/run.ts@spawn:19:9 -> src/worker.ts (thread)",
      "src/main.ts@spawn:27:9 -> src/worker.ts (thread)",
      "src/main.ts@spawn:47:2 -> src/child.ts (process)",
      // a path under outDir, mapped back to rootDir
      "src/main.ts@spawn:32:9 -> src/worker.ts (thread)",
    ];
    expect(labelled((await extract()).edges, "concurrency.spawns")).toEqual([...expected].sort());
  });

  it("gives file-relative forms exact confidence, cwd-relative literals heuristic, and an outDir path inferred", async () => {
    const edges = (await extract()).edges.filter((e) => e.kind === "concurrency.spawns");
    expect(Object.fromEntries(edges.map((e) => [e.from, e.provenance.confidence]))).toEqual({
      "packages/tool/src/run.ts@spawn:4:9": "heuristic",
      "packages/tool/src/run.ts@spawn:9:9": "exact",
      "packages/tool/src/run.ts@spawn:14:9": "heuristic",
      "packages/tool/src/run.ts@spawn:19:9": "heuristic",
      "src/helpers/run.ts@spawn:5:9": "exact",
      "src/helpers/run.ts@spawn:10:9": "exact",
      "src/main.ts@spawn:7:9": "exact",
      "src/main.ts@spawn:12:9": "exact",
      "src/main.ts@spawn:17:9": "exact",
      "src/main.ts@spawn:22:2": "exact",
      "src/main.ts@spawn:27:9": "heuristic",
      "src/main.ts@spawn:32:9": "inferred",
      "src/main.ts@spawn:47:2": "heuristic",
    });
  });

  it("starts each edge at its spawn node, with the node's position as the span in that file", async () => {
    const edges = (await extract()).edges.filter((e) => e.kind === "concurrency.spawns");
    for (const e of edges) {
      const [, line, col] = /@spawn:(\d+):(\d+)$/.exec(e.from) ?? [];
      expect(e.span?.start).toEqual([Number(line), Number(col)]);
      expect(e.span?.file).toBe(fileOf(e.from));
    }
  });

  it("gives no edge to an absolute path or a computed path, and still records each spawn", async () => {
    const { nodes, edges } = await extract();
    expect(spawnIds(nodes)).toEqual(expect.arrayContaining(["src/main.ts@spawn:37:9", "src/main.ts@spawn:42:9"]));
    const unresolved = edges.filter(
      (e) => e.kind === "concurrency.spawns" && (e.from === "src/main.ts@spawn:37:9" || e.from === "src/main.ts@spawn:42:9"),
    );
    expect(unresolved).toEqual([]);
  });

  it("resolves a plain literal from the nearest package directory, not from the file's own directory", async () => {
    // packages/tool/src/run.ts is inside packages/tool, whose package.json is the nearest. "./w.js" names
    // packages/tool/w.ts. Read from the file's directory it would name packages/tool/src/w.ts, which is a different file.
    const edges = labelled((await extract()).edges, "concurrency.spawns").filter((l) => l.startsWith("packages/tool/"));
    expect(edges).toEqual(
      [
        "packages/tool/src/run.ts@spawn:4:9 -> packages/tool/w.ts (thread)",
        "packages/tool/src/run.ts@spawn:9:9 -> packages/tool/src/w.ts (thread)",
        "packages/tool/src/run.ts@spawn:14:9 -> packages/tool/src/w.ts (thread)",
        "packages/tool/src/run.ts@spawn:19:9 -> src/worker.ts (thread)",
      ].sort(),
    );
  });

  it("falls back to the project root for a cwd-relative literal the package does not hold", async () => {
    // "./src/worker.js" from packages/tool has no match there, so the project root's src/worker.ts is the hit.
    const { edges } = await extract();
    const fallback = edges.find((e) => e.from === "packages/tool/src/run.ts@spawn:19:9");
    expect(fallback?.to).toBe("src/worker.ts");
    expect(fallback?.provenance.confidence).toBe("heuristic");
  });

  it("maps a path under the output directory back to the source directory, as inferred", async () => {
    // tsconfig has outDir "dist" and rootDir "src". "./dist/worker.js" is the compiled form of src/worker.ts.
    const { edges } = await extract();
    const compiled = edges.find((e) => e.from === "src/main.ts@spawn:32:9");
    expect(compiled?.to).toBe("src/worker.ts");
    expect(compiled?.provenance.confidence).toBe("inferred");
  });
});

describe("dependsOn for Node path semantics", () => {
  const manifests = (deps: string[] | undefined) => (deps ?? []).filter((d) => d.endsWith("package.json"));

  it("depends on each package.json a cwd-relative literal checked, nearest first, and stops at the nearest", async () => {
    const { dependsOn } = await extract();
    // src/main.ts is in the project root: it checks src/package.json, then the root package.json.
    // dependsOn is sorted on output, so the expectations are sorted too.
    expect(manifests(dependsOn.get("src/main.ts"))).toEqual(["package.json", "src/package.json"]);
    // packages/tool/src/run.ts checks its own directory, then packages/tool, which holds a package.json, and stops there.
    expect(manifests(dependsOn.get("packages/tool/src/run.ts"))).toEqual([
      "packages/tool/package.json",
      "packages/tool/src/package.json",
    ]);
  });

  it("depends on no package.json for a file whose every path is file-relative", async () => {
    const { dependsOn } = await extract();
    expect(manifests(dependsOn.get("src/helpers/run.ts"))).toEqual([]);
  });

  it("lists every candidate the resolver tried, including the outDir name and the package and root names", async () => {
    const { dependsOn } = await extract();
    expect(dependsOn.get("src/main.ts")).toEqual(
      expect.arrayContaining(["src/worker.ts", "src/child.ts", "dist/worker.ts", "src/package.json", "package.json"]),
    );
    expect(dependsOn.get("packages/tool/src/run.ts")).toEqual(
      expect.arrayContaining(["packages/tool/w.ts", "packages/tool/src/w.ts", "packages/tool/src/worker.ts", "src/worker.ts"]),
    );
  });
});
