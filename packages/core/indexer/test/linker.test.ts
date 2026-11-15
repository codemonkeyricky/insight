import { describe, expect, it } from "vitest";
import type { IRRecord, UnresolvedRef } from "@insight/ir";
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

describe("fallback resolvers", () => {
  const fallbackTable = (id: string, priority: number, answers: Record<string, ResolveAnswer>): LinkResolver => ({
    ...table(id, priority, answers),
    fallback: true,
  });

  it("lets a non-fallback heuristic answer beat a fallback inferred answer", async () => {
    const result = await run(
      [
        fallbackTable("syntactic", 10, { "b.h": { targets: ["b.h"], confidence: "inferred" } }),
        table("build", 90, { "b.h": { targets: ["c.h"], confidence: "heuristic" } }),
      ],
      [refEdge("a.cc", "b.h")],
    );
    expect(result.doc.edges).toHaveLength(1);
    expect(result.doc.edges[0]?.to).toBe("c.h");
    expect(result.doc.edges[0]?.provenance.resolvedBy).toBe("build");
    expect(result.doc.findings).toHaveLength(0);
  });

  it("uses a fallback answer when it is the only answer", async () => {
    const result = await run(
      [fallbackTable("syntactic", 10, { "b.h": { targets: ["b.h"], confidence: "inferred" } })],
      [refEdge("a.cc", "b.h")],
    );
    expect(result.doc.edges[0]?.to).toBe("b.h");
    expect(result.doc.edges[0]?.provenance.resolvedBy).toBe("syntactic");
    expect(result.resolved).toBe(1);
  });

  it("keeps both targets when two non-fallback answers disagree, and drops the fallback's own answer", async () => {
    const result = await run(
      [
        table("bazel", 90, { "b.h": { targets: ["b.h"], confidence: "exact" } }),
        table("cmake", 80, { "b.h": { targets: ["c.h"], confidence: "exact" } }),
        fallbackTable("syntactic", 10, { "b.h": { targets: ["a.cc"], confidence: "inferred" } }),
      ],
      [refEdge("a.cc", "b.h")],
    );
    expect(result.doc.edges.map((e) => e.to)).toEqual(["b.h", "c.h"]);
    expect(result.doc.edges.map((e) => e.provenance.resolvedBy)).toEqual(["bazel", "cmake"]);
    expect(result.doc.findings).toHaveLength(1);
    });
  });

describe("build-graph narrowing", () => {
  const CALL_PROV = { frontend: "fixture", confidence: "heuristic" as const };

  const target = (id: string) =>
    ({ node: { id, facet: "packaging", kind: "packaging.build-target", attrs: {}, provenance: PROV } }) as const;
  const owns = (t: string, file: string) =>
    ({ edge: { from: t, to: file, facet: "packaging", kind: "packaging.target-contains", provenance: PROV } }) as const;
  const dep = (from: string, to: string) =>
    ({ edge: { from, to, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } }) as const;
  const fn = (id: string, file: string) =>
    ({ node: { id, facet: "calls", kind: "structure.function", parent: file, attrs: {}, provenance: PROV } }) as const;
  const call = (from: string, candidates: string[], kind = "calls.call") =>
    ({ edge: { from, to: { candidates } as never, facet: "calls", kind, provenance: CALL_PROV } }) as const;

  /** Runs link over one shard whose records are all in `shardFile`. */
  async function linkRecords(records: IRRecord[], shardFile: string, files: string[], narrow?: boolean) {
    return link({
      root,
      files,
      shards: [{ frontend: "fixture", file: shardFile, records }],
      resolvers: [],
      ...(narrow === undefined ? {} : { narrowByBuildGraph: narrow }),
    });
  }

  const FILES = ["app/main.cc", "lib/x.cc", "other/o.cc", "mid/b.cc", "deep/c.cc", "unrelated/d.cc", "loose/main.cc", "gen/loose.cc"];

  it("(1) keeps only the candidate the caller's dependency closure can link", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//app:a", "//lib:x"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("lib/x.cc#f");
    expect(edge?.provenance.confidence).toBe("inferred");
    expect(edge?.provenance.resolvedBy).toContain("build-graph");
    expect(result.narrowed).toBe(1);
  });

  it("(2) follows dependencies transitively and drops the unrelated candidate", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//mid:b"), target("//deep:c"), target("//unrelated:d"),
      owns("//app:a", "app/main.cc"), owns("//mid:b", "mid/b.cc"), owns("//deep:c", "deep/c.cc"), owns("//unrelated:d", "unrelated/d.cc"),
      dep("//app:a", "//mid:b"), dep("//mid:b", "//deep:c"),
      fn("app/main.cc#main", "app/main.cc"), fn("deep/c.cc#g", "deep/c.cc"), fn("unrelated/d.cc#g", "unrelated/d.cc"),
      call("app/main.cc#main", ["deep/c.cc#g", "unrelated/d.cc#g"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("deep/c.cc#g");
    expect(result.narrowed).toBe(1);
  });

  it("(3) leaves the edge unchanged when the caller's file is in no target", async () => {
    const records: IRRecord[] = [
      target("//lib:x"), target("//other:o"),
      owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      fn("loose/main.cc#main", "loose/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("loose/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "loose/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#f", "other/o.cc#f"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  it("(4) leaves the edge unchanged when every candidate is outside the closure", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#f", "other/o.cc#f"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  it("(5) keeps a candidate whose file no target owns", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//other:o", "other/o.cc"),
      fn("app/main.cc#main", "app/main.cc"), fn("gen/loose.cc#f", "gen/loose.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["gen/loose.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("gen/loose.cc#f");
    expect(result.narrowed).toBe(1);
  });

  it("(6) does nothing when narrowByBuildGraph is false", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//app:a", "//lib:x"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES, false);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#f", "other/o.cc#f"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  it("(7) never touches calls.reference edges", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//app:a", "//lib:x"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"], "calls.reference"),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.reference");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#f", "other/o.cc#f"] });
    expect(edge?.provenance).toEqual(CALL_PROV);
    expect(result.narrowed).toBe(0);
  });

  const targetIn = (id: string, frontend: string) =>
    ({ node: { id, facet: "packaging", kind: "packaging.build-target", attrs: {}, provenance: { frontend, confidence: "exact" as const } } }) as const;
  const unresolvedDep = (from: string) =>
    ({ edge: { from, to: { unresolved: { scheme: "fixture.dep", text: "@external" } }, facet: "packaging", kind: "packaging.dep-edge", provenance: PROV } }) as const;

  it("(a) keeps a candidate whose only owner belongs to a frontend the caller does not share", async () => {
    const records: IRRecord[] = [
      targetIn("//app:a", "frontend-x"), targetIn("//other:o", "frontend-x"), targetIn("//hdr:h", "frontend-y"),
      owns("//app:a", "app/main.cc"), owns("//other:o", "other/o.cc"), owns("//hdr:h", "inc/h.h"),
      fn("app/main.cc#main", "app/main.cc"), fn("inc/h.h#f", "inc/h.h"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["inc/h.h#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", [...FILES, "inc/h.h"]);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("inc/h.h#f");
    expect(result.narrowed).toBe(1);
  });

  it("(b) leaves the edge unchanged when a dependency of the caller's closure is unresolved", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//app:a", "//lib:x"), unresolvedDep("//app:a"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#f", "other/o.cc#f"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  it("(c) keeps a candidate when one shared frontend says linked and the other says not linked", async () => {
    const records: IRRecord[] = [
      targetIn("//app:a", "frontend-x"), targetIn("//app:b", "frontend-y"),
      targetIn("//lib:x", "frontend-x"), targetIn("//lib:y", "frontend-y"), targetIn("//other:o", "frontend-x"),
      owns("//app:a", "app/main.cc"), owns("//app:b", "app/main.cc"),
      owns("//lib:x", "lib/x.cc"), owns("//lib:y", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//app:a", "//lib:x"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#f", "lib/x.cc"), fn("other/o.cc#f", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#f", "other/o.cc#f"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("lib/x.cc#f");
    expect(result.narrowed).toBe(1);
  });

  /** A structure.type node in a file, and a method whose parent is that type. */
  const typeIn = (id: string, file: string) =>
    ({ node: { id, facet: "calls", kind: "structure.type", parent: file, attrs: { name: id.split("#")[1] }, provenance: PROV } }) as const;
  const method = (id: string, parent: string) =>
    ({ node: { id, facet: "calls", kind: "structure.function", parent, attrs: {}, provenance: PROV } }) as const;

  it("(d) never drops a method candidate, even one in a target the caller does not link", async () => {
    // Both Run methods are in targets the caller's binary does not link. Methods are always kept, since virtual
    // dispatch can reach any override. Nothing is narrowed.
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//lib:x", "//app:a"),
      fn("app/main.cc#main", "app/main.cc"),
      typeIn("lib/x.cc#Fixture", "lib/x.cc"), method("lib/x.cc#Fixture::Run", "lib/x.cc#Fixture"),
      typeIn("other/o.cc#Other", "other/o.cc"), method("other/o.cc#Other::Run", "other/o.cc#Other"),
      call("app/main.cc#main", ["lib/x.cc#Fixture::Run", "other/o.cc#Other::Run"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["lib/x.cc#Fixture::Run", "other/o.cc#Other::Run"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  /** An out-of-line method: the C++ frontend parents it to the file, and its qualified name names the type. */
  const outOfLine = (id: string, file: string, qualifiedName: string) =>
    ({ node: { id, facet: "calls", kind: "structure.function", parent: file, attrs: { qualifiedName }, provenance: PROV } }) as const;

  it("(f) keeps an out-of-line method parented to its file when its qualified name names a type", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      dep("//lib:x", "//app:a"),
      fn("app/main.cc#main", "app/main.cc"),
      typeIn("lib/x.cc#Circle", "lib/x.cc"), outOfLine("lib/x.cc#Circle::area", "lib/x.cc", "Circle::area"),
      fn("other/o.cc#free", "other/o.cc"),
      call("app/main.cc#main", ["lib/x.cc#Circle::area", "other/o.cc#free"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("lib/x.cc#Circle::area");
    expect(result.narrowed).toBe(1);
  });

  it("(g) keeps the sibling implementation of a virtual call, not linked into the caller's closure", async () => {
    // render -> shape, circle -> shape, app -> {render, circle}. render.cc calls s->area() with candidates
    // Shape::area and Circle::area. Circle is not in render's closure nor downstream of it, but app links both.
    const records: IRRecord[] = [
      target("//render:r"), target("//shape:s"), target("//circle:c"),
      owns("//render:r", "render/render.cc"), owns("//shape:s", "shape/shape.cc"), owns("//circle:c", "circle/circle.cc"),
      dep("//render:r", "//shape:s"), dep("//circle:c", "//shape:s"),
      typeIn("shape/shape.h#Shape", "shape/shape.cc"), outOfLine("shape/shape.cc#Shape::area", "shape/shape.cc", "Shape::area"),
      typeIn("circle/circle.h#Circle", "circle/circle.cc"), outOfLine("circle/circle.cc#Circle::area", "circle/circle.cc", "Circle::area"),
      fn("render/render.cc#draw", "render/render.cc"),
      call("render/render.cc#draw", ["shape/shape.cc#Shape::area", "circle/circle.cc#Circle::area"]),
    ];
    const result = await linkRecords(records, "render/render.cc", [...FILES, "render/render.cc", "shape/shape.cc", "circle/circle.cc"]);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toEqual({ candidates: ["shape/shape.cc#Shape::area", "circle/circle.cc#Circle::area"] });
    expect(edge?.provenance.resolvedBy).toBeUndefined();
    expect(result.narrowed).toBe(0);
  });

  it("(h) drops an unrelated free function in a non-linked target, and keeps a method beside it", async () => {
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"), target("//other:o"),
      owns("//app:a", "app/main.cc"), owns("//lib:x", "lib/x.cc"), owns("//other:o", "other/o.cc"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#free", "lib/x.cc"),
      typeIn("other/o.cc#Other", "other/o.cc"), outOfLine("other/o.cc#Other::Run", "other/o.cc", "Other::Run"),
      call("app/main.cc#main", ["lib/x.cc#free", "other/o.cc#Other::Run"]),
    ];
    const result = await linkRecords(records, "app/main.cc", FILES);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("other/o.cc#Other::Run");
    expect(edge?.provenance.resolvedBy).toContain("build-graph");
    expect(result.narrowed).toBe(1);
  });

  it("(e) drops a free function defined downstream of the caller", async () => {
    // app/peer.cc is in the caller's own target, so it is linked and survives; the downstream free function is not.
    const records: IRRecord[] = [
      target("//app:a"), target("//lib:x"),
      owns("//app:a", "app/main.cc"), owns("//app:a", "app/peer.cc"), owns("//lib:x", "lib/x.cc"),
      dep("//lib:x", "//app:a"),
      fn("app/main.cc#main", "app/main.cc"), fn("lib/x.cc#helper", "lib/x.cc"), fn("app/peer.cc#g", "app/peer.cc"),
      call("app/main.cc#main", ["lib/x.cc#helper", "app/peer.cc#g"]),
    ];
    const result = await linkRecords(records, "app/main.cc", [...FILES, "app/peer.cc"]);
    const edge = result.doc.edges.find((e) => e.kind === "calls.call");
    expect(edge?.to).toBe("app/peer.cc#g");
    expect(result.narrowed).toBe(1);
  });
});

describe("linker passes the edge attributes to resolvers", () => {
  it("gives a resolver the attrs of the edge that holds the reference", async () => {
    const seen: unknown[] = [];
    const spy: Resolver = {
      scheme: "test.ref",
      priority: 5,
      async resolve(_ref, ctx) {
        seen.push(ctx.attrs);
        return null;
      },
    };
    const edge = { edge: { from: "a.cc", to: { unresolved: { scheme: "test.ref", text: "time.h" } }, facet: "packaging", kind: "packaging.include", attrs: { system: true, text: "time.h" }, provenance: PROV }, file: "a.cc" } as const;
    await run([{ id: "spy", resolver: spy }], [edge]);
    expect(seen).toEqual([{ system: true, text: "time.h" }]);
  });
});
