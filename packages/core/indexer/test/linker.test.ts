import { describe, expect, it } from "vitest";
import type { UnresolvedRef } from "@insight/ir";
import type { ResolveAnswer, Resolver } from "@insight/sdk";
import { link, type LinkResolver, type LinkShard } from "../src/linker.js";

const root = { path: "/tmp-not-used", name: "fixture", allowBuildTools: false };
const PROV = { frontend: "fixture", confidence: "exact" as const };

/** A resolver that answers from a table, keyed by the reference text. */
function table(id: string, priority: number, answers: Record<string, ResolveAnswer>, scheme = "test.ref"): LinkResolver {
  const resolver: Resolver = {
    scheme,
    priority,
    async resolve(ref: UnresolvedRef["unresolved"]) {
      return answers[ref.text] ?? null;
    },
  };
  return { id, resolver };
}

function refEdge(from: string, text: string, scheme = "test.ref") {
  return { edge: { from, to: { unresolved: { scheme, text } }, facet: "packaging", kind: "packaging.include", provenance: PROV }, file: from } as const;
}

function shard(file: string, edges: ReturnType<typeof refEdge>[]): LinkShard {
  return { frontend: "fixture", file, records: edges.map((e) => ({ edge: e.edge })) };
}

const files = ["a.cc", "b.h", "c.h"];

async function run(resolvers: LinkResolver[], edges: ReturnType<typeof refEdge>[]) {
  return link({ root, files, shards: [shard("a.cc", edges)], resolvers });
}

describe("linker agreement", () => {
  it("adopts a single answer and records who resolved it", async () => {
    const result = await run([table("fixture-a", 5, { "b.h": { targets: ["b.h"], confidence: "exact" } })], [refEdge("a.cc", "b.h")]);
    const edge = result.doc.edges[0];
    expect(edge?.to).toBe("b.h");
    expect(edge?.provenance.resolvedBy).toBe("fixture-a");
    expect(result.resolved).toBe(1);
    expect(result.doc.findings).toHaveLength(0);
  });

  it("ignores a heuristic answer when a strong answer exists", async () => {
    const result = await run(
      [
        table("heuristic", 10, { "b.h": { targets: ["c.h"], confidence: "heuristic" } }),
        table("strong", 80, { "b.h": { targets: ["b.h"], confidence: "exact" } }),
      ],
      [refEdge("a.cc", "b.h")],
    );
    expect(result.doc.edges).toHaveLength(1);
    expect(result.doc.edges[0]?.to).toBe("b.h");
    expect(result.doc.edges[0]?.provenance.resolvedBy).toBe("strong");
  });

  it("joins the names of agreeing resolvers and keeps the weaker confidence", async () => {
    const result = await run(
      [
        table("bazel", 90, { "b.h": { targets: ["b.h"], confidence: "exact" } }),
        table("cmake", 80, { "b.h": { targets: ["b.h"], confidence: "inferred" } }),
      ],
      [refEdge("a.cc", "b.h")],
    );
    const edge = result.doc.edges[0];
    expect(edge?.to).toBe("b.h");
    expect(edge?.provenance.resolvedBy).toBe("bazel+cmake");
    expect(edge?.provenance.confidence).toBe("inferred");
    expect(result.doc.findings).toHaveLength(0);
  });

  it("keeps both targets and reports a finding when strong answers disagree", async () => {
    const result = await run(
      [
        table("bazel", 90, { "b.h": { targets: ["b.h"], confidence: "exact" } }),
        table("cmake", 80, { "b.h": { targets: ["c.h"], confidence: "exact" } }),
      ],
      [refEdge("a.cc", "b.h")],
    );
    const targets = result.doc.edges.map((e) => e.to);
    expect(targets).toEqual(["b.h", "c.h"]);
    expect(result.doc.edges.map((e) => e.provenance.resolvedBy)).toEqual(["bazel", "cmake"]);
    expect(result.doc.findings).toHaveLength(1);
    expect(result.doc.findings[0]?.message).toContain("2 different targets");
    expect(result.resolved).toBe(1);
  });

  it("leaves a reference unresolved when no resolver answers", async () => {
    const result = await run([table("fixture-a", 5, {})], [refEdge("a.cc", "missing.h")]);
    expect(result.doc.edges[0]?.to).toEqual({ unresolved: { scheme: "test.ref", text: "missing.h" } });
    expect(result.unresolved).toBe(1);
  });

  it("drops an answer whose target does not exist in the graph", async () => {
    const result = await run([table("fixture-a", 5, { "b.h": { targets: ["nope.h"], confidence: "exact" } })], [refEdge("a.cc", "b.h")]);
    expect(result.unresolved).toBe(1);
  });
});
