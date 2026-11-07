import { describe, expect, it } from "vitest";
import type { IRRecord } from "@insight/ir";
import { diffSnapshots, keyFindings, type SnapshotInput } from "../src/diff.js";
import type { AnalysisFile } from "../src/analyze.js";

const prov = { frontend: "test", confidence: "exact" as const };
const fn = (id: string, name: string, parent = "src/a.cc", line = 1): IRRecord => ({
  node: { id, facet: "structure", kind: "structure.function", parent, attrs: { name }, span: { file: "src/a.cc", start: [line, 0], end: [line + 2, 0] }, provenance: prov },
});
const file = (id: string): IRRecord => ({ node: { id, facet: "structure", kind: "structure.file", attrs: {}, provenance: prov } });
const effect = (id: string, parent: string): IRRecord => ({
  node: { id, facet: "effects", kind: "effects.fs.write", parent, attrs: {}, span: { file: "src/a.cc", start: [4, 2], end: [4, 9] }, provenance: prov },
});
const edge = (from: string, to: unknown, kind = "calls.call"): IRRecord => ({
  edge: { from, to, facet: "calls", kind, provenance: prov } as IRRecord & { edge: object },
} as IRRecord);
const finding = (lens: string, id: string, message: string, severity = "warning"): LensFindingRow => ({ lens, id, severity, message });
type LensFindingRow = { lens: string; id: string; severity: string; message: string };

function analysis(lenses: Record<string, LensFindingRow[] | "unavailable">): AnalysisFile {
  return {
    schema: 1,
    snapshot: "s",
    lenses: Object.entries(lenses).map(([id, findings]) =>
      findings === "unavailable"
        ? { id, title: id, status: "unavailable", reason: "missing facet", reused: false, inputsHash: "h" }
        : {
            id,
            title: id,
            status: "ok",
            reused: false,
            inputsHash: "h",
            result: { findings: findings as never, views: [], metrics: {} },
          },
    ),
  };
}

const base: SnapshotInput = {
  records: [file("src/a.cc"), fn("src/a.cc#f", "f"), fn("src/a.cc#g", "g", "src/a.cc", 9), edge("src/a.cc#f", "src/a.cc#g"), edge("src/a.cc#f", "src/a.cc#g")],
  analysis: analysis({ "lens-complexity": [finding("lens-complexity", "complexity:f", "f is too branchy")] }),
};

describe("semantic snapshot diff", () => {
  it("reports added, removed and changed nodes by stable id, ignoring line moves", () => {
    const head: SnapshotInput = {
      records: [
        file("src/a.cc"),
        // f moved down two lines: same id and attrs, so it is not a change.
        { node: { ...(fn("src/a.cc#f", "f").node as object), span: { file: "src/a.cc", start: [3, 0], end: [5, 0] } } as never },
        // h is new; g is gone; k changed its parent.
        fn("src/a.cc#h", "h", "src/a.cc", 20),
        effect("src/a.cc#f@write", "src/a.cc#f"),
      ],
      analysis: analysis({ "lens-complexity": [finding("lens-complexity", "complexity:f", "f is too branchy")] }),
    };
    const d = diffSnapshots(base, head);
    expect(d.ir.nodes.added.map((n) => n.id).sort()).toEqual(["src/a.cc#f@write", "src/a.cc#h"]);
    expect(d.ir.nodes.removed.map((n) => n.id)).toEqual(["src/a.cc#g"]);
    expect(d.ir.nodes.changed).toEqual([]);
  });

  it("counts repeated edges and reports only the copies that were added or removed", () => {
    const head: SnapshotInput = {
      records: [file("src/a.cc"), fn("src/a.cc#f", "f"), fn("src/a.cc#g", "g", "src/a.cc", 9), edge("src/a.cc#f", "src/a.cc#g"), edge("src/a.cc#g", "src/a.cc#f")],
    };
    const d = diffSnapshots(base, head);
    expect(d.ir.edges.removed).toEqual([expect.objectContaining({ from: "src/a.cc#f", count: 1 })]);
    expect(d.ir.edges.added).toEqual([expect.objectContaining({ from: "src/a.cc#g", to: "src/a.cc#f", count: 1 })]);
  });

  it("names effects and lock facts in the summary, and counts the rest", () => {
    const head: SnapshotInput = {
      records: [...base.records, effect("src/a.cc#f@write", "src/a.cc#f")],
      analysis: base.analysis,
    };
    const d = diffSnapshots(base, head);
    expect(d.summary).toContain("Adds effects.fs.write in f");
  });

  it("compares lens findings by stable key and says which ones are new or resolved", () => {
    const head: SnapshotInput = {
      records: base.records,
      analysis: analysis({
        "lens-complexity": [finding("lens-complexity", "complexity:h", "h is too branchy", "error")],
        "lens-lock-order": [finding("lens-lock-order", "cycle:a|b", "Lock order cycle: a -> b -> a", "error")],
      }),
    };
    const d = diffSnapshots(base, head);
    const complexity = d.lenses.find((l) => l.id === "lens-complexity")!;
    expect(complexity.comparable).toBe(true);
    expect(complexity.added.map((f) => f.key)).toEqual(["lens-complexity#complexity:h"]);
    expect(complexity.removed.map((f) => f.key)).toEqual(["lens-complexity#complexity:f"]);
    expect(d.summary).toContain("New lens-complexity finding (error): h is too branchy");
    expect(d.summary).toContain("Resolved lens-complexity finding: f is too branchy");
    const lockOrder = d.lenses.find((l) => l.id === "lens-lock-order")!;
    expect(lockOrder.comparable).toBe(false);
    expect(d.summary.some((s) => s.startsWith("lens-lock-order did not run ok on both sides"))).toBe(true);
  });

  it("does not compare a lens that was unavailable on one side", () => {
    const head: SnapshotInput = { records: base.records, analysis: analysis({ "lens-complexity": "unavailable" }) };
    const d = diffSnapshots(base, head);
    expect(d.lenses[0]).toMatchObject({ id: "lens-complexity", comparable: false, added: [], removed: [] });
  });
});

describe("finding keys", () => {
  it("suffixes repeated ids so that no finding is dropped", () => {
    const keys = keyFindings([
      { lens: "lens-calls", id: "unreachable:f" },
      { lens: "lens-calls", id: "unreachable:f" },
      { lens: "lens-calls", id: "unreachable:g" },
    ]);
    expect([...keys.keys()]).toEqual(["lens-calls#unreachable:f", "lens-calls#unreachable:f~2", "lens-calls#unreachable:g"]);
  });
});
