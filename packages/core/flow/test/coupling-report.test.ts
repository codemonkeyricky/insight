import { beforeAll, describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { COUPLING_REPORT_FUNCTION_LIMIT, couplingIndex, couplingReport, type CouplingIndex } from "../src/index.js";
import { indexFixture } from "./coupling-fixture.js";

// Two packages: a calls into b. The report is the CLI/API view of the same footprints the coupling chart draws.
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "pkgs/a/package.json": JSON.stringify({ name: "a" }),
  "pkgs/b/package.json": JSON.stringify({ name: "b" }),
  "pkgs/b/src/lib.ts": `export function fetchLabel(k: string): string {
  return k + "!";
}
export function risky(): number {
  throw new Error("risky");
}
`,
  "pkgs/a/src/use.ts": `import { fetchLabel, risky } from "../../b/src/lib.js";
export function useB(): string {
  return fetchLabel("k");
}
export function callsRisky(): number {
  return risky();
}
`,
  "pkgs/a/src/pure.ts": `export function leaf(n: number): number {
  return n + 1;
}
export function chain(n: number): number {
  return leaf(n) * 2;
}
`,
};

let nodes: Parameters<typeof couplingIndex>[0];
let edges: Parameters<typeof couplingIndex>[1];
let index: CouplingIndex;

beforeAll(async () => {
  ({ nodes, edges } = await indexFixture(FILES));
  index = couplingIndex(nodes, edges);
});

const fn = (report: ReturnType<typeof couplingReport>, name: string) => {
  const found = report.functions.find((f) => f.name === name);
  if (found === undefined) throw new Error(`no ${name} in the report`);
  return found;
};

describe("couplingReport", () => {
  it("reports a cross call with the callee's file and 1-based line", () => {
    const useB = fn(couplingReport(index, { scope: "pkgs/a/src/use.ts" }), "useB");
    expect(useB.id).toBe("pkgs/a/src/use.ts#useB");
    expect(useB.file).toBe("pkgs/a/src/use.ts");
    expect(useB.module).toBe("pkgs/a");
    expect(useB.cross).toEqual([
      { label: "fetchLabel()", target: "pkgs/b/src/lib.ts#fetchLabel", file: "pkgs/b/src/lib.ts", line: 1 },
    ]);
    expect(useB.summary).toContain("⇄ 1 module");
    // The empty classes are present and empty, so a consumer reads every function the same way.
    expect(useB.io).toEqual([]);
    expect(useB.state).toEqual([]);
    expect(useB.conc).toEqual([]);
    expect(useB.escape).toEqual([]);
  });

  it("reports an escaping call as both cross and escape, and a function with no coupling as such", () => {
    const report = couplingReport(index, { scope: "pkgs/a/src" });
    const risky = fn(report, "callsRisky");
    expect(risky.cross.map((e) => e.target)).toEqual(["pkgs/b/src/lib.ts#risky"]);
    expect(risky.escape.map((e) => e.label)).toContain("risky() may throw");
    const leaf = fn(report, "leaf");
    expect(leaf.summary).toBe("no coupling");
  });

  it("sorts functions by id and every class by target, label, file, line", () => {
    const report = couplingReport(index);
    const ids = report.functions.map((f) => f.id);
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    for (const f of report.functions) {
      for (const bucket of [f.cross, f.io, f.state, f.conc, f.escape]) {
        const keys = bucket.map((e) => [e.target ?? "", e.label, e.file ?? "", String(e.line ?? 0).padStart(6, "0")]);
        expect(keys).toEqual([...keys].sort((a, b) => {
          for (let i = 0; i < a.length; i++) {
            const x = a[i] as string;
            const y = b[i] as string;
            if (x !== y) return x < y ? -1 : 1;
          }
          return 0;
        }));
      }
    }
  });

  it("selects by a file, by a folder prefix, and by exact ids", () => {
    expect(couplingReport(index, { scope: "pkgs/a/src/use.ts" }).functions.map((f) => f.name)).toEqual(["useB", "callsRisky"].sort());
    const folder = couplingReport(index, { scope: "pkgs/a" }).functions;
    expect(folder.length).toBeGreaterThan(0);
    expect(folder.every((f) => f.file?.startsWith("pkgs/a/") === true)).toBe(true);
    expect(couplingReport(index, { ids: ["pkgs/a/src/use.ts#useB"] }).functions.map((f) => f.id)).toEqual(["pkgs/a/src/use.ts#useB"]);
    expect(couplingReport(index, { ids: ["pkgs/b/src/lib.ts#fetchLabel"] }).functions.map((f) => f.name)).toEqual(["fetchLabel"]);
  });

  it("is deterministic when the IR records arrive in another order", () => {
    const reversed = couplingIndex([...nodes].reverse(), [...edges].reverse());
    expect(JSON.stringify(couplingReport(reversed))).toBe(JSON.stringify(couplingReport(index)));
  });

  it("caps a report by function count and marks it truncated", () => {
    const count = COUPLING_REPORT_FUNCTION_LIMIT + 1;
    const many = Array.from({ length: count }, (_, i) =>
      fx.node(`big.ts#f${String(i).padStart(4, "0")}`, "structure", "structure.function", {
        attrs: { name: `f${i}` },
        span: fx.span("big.ts", i, 0, i, 1),
      }),
    );
    many.push(fx.node("big.ts", "structure", "structure.file", { attrs: { path: "big.ts" } }));
    const report = couplingReport(couplingIndex(many, []));
    expect(report.functions).toHaveLength(COUPLING_REPORT_FUNCTION_LIMIT);
    expect(report.truncated).toBe(true);
    // The cap keeps the first ids in the report's stable id order.
    expect(report.functions[0]?.id).toBe("big.ts#f0000");
    expect(report.functions.at(-1)?.id).toBe("big.ts#f0199");
    // A report the cap does not cut carries no marker.
    expect(couplingReport(index).truncated).toBeUndefined();
  });
});
