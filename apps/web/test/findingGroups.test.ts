import { describe, expect, it } from "vitest";
import type { FindingRow } from "../src/api.js";
import { EXAMPLES, fillTemplate, fileOf, fnOf, groupFindings, kindOf, numbersOf, subjectOf, templateOf, TOP_FILES } from "../src/findingGroups.js";

const unreachable = (file: string, name: string): FindingRow => ({
  id: `unreachable:${file}#${name}`,
  lens: "lens-calls",
  severity: "info",
  message: `${name} is not reachable from any entry point`,
  nodes: [`${file}#${name}`],
  span: { file, start: [9, 2], end: [9, 20] },
});

const complexity = (file: string, name: string, n: number): FindingRow => ({
  id: `complexity:${file}#${name}`,
  lens: "lens-flow-complexity",
  severity: "warning",
  message: `${name} has complexity ${n}, above 10`,
  nodes: [`${file}#${name}`],
  span: { file, start: [92, 0], end: [308, 1] },
});

describe("kindOf, fileOf, fnOf, subjectOf", () => {
  it("reads the kind from the id before its colon", () => {
    expect(kindOf({ id: "unreachable:a.ts#b" })).toBe("unreachable");
    expect(kindOf({ id: "plain" })).toBe("plain");
  });

  it("takes the file from the span, else from the first node", () => {
    expect(fileOf(unreachable("src/a.ts", "run"))).toBe("src/a.ts");
    expect(fileOf({ id: "cycle:x", lens: "l", severity: "warning", message: "m", nodes: ["src/p.ts", "src/q.ts"] })).toBe("src/p.ts");
    expect(fileOf({ id: "x", lens: "l", severity: "info", message: "m" })).toBeUndefined();
  });

  it("names the function only for a node with a hash", () => {
    expect(fnOf(unreachable("src/a.ts", "run"))).toBe("src/a.ts#run");
    expect(fnOf({ id: "cycle:x", lens: "l", severity: "warning", message: "m", nodes: ["src/p.ts"] })).toBeUndefined();
  });

  it("uses the short function name as the subject, else the node chain", () => {
    expect(subjectOf(unreachable("src/a.ts", "run"))).toBe("run");
    expect(subjectOf({ id: "cycle:x", lens: "l", severity: "warning", message: "m", nodes: ["a.ts", "b.ts"] })).toBe("a.ts -> b.ts");
  });
});

describe("templates", () => {
  it("reads the numbers of a message in order", () => {
    expect(numbersOf("motionModel has complexity 65, above 10")).toEqual([65, 10]);
    expect(numbersOf("bag is not reachable")).toEqual([]);
  });

  it("turns a message into a template that fills back to the same message", () => {
    const message = "motionModel has complexity 65, above 10";
    const template = templateOf(message, "motionModel");
    expect(template).toBe("{subject} has complexity {n}, above {n}");
    expect(fillTemplate(template, { subject: "motionModel", numbers: [65, 10] })).toBe(message);
  });

  it("fills a template from new values and returns undefined when a value is missing", () => {
    expect(fillTemplate("{subject} has complexity {n}, above {n}", { subject: "run", numbers: [12, 10] })).toBe("run has complexity 12, above 10");
    expect(fillTemplate("{subject} has complexity {n}, above {n}", { subject: "run", numbers: [12] })).toBeUndefined();
    expect(fillTemplate("no placeholders", { subject: "x", numbers: [] })).toBe("no placeholders");
  });

  it("never leaves a raw placeholder in a filled message", () => {
    const rows = [unreachable("a.ts", "run"), complexity("b.ts", "motionModel", 65)];
    for (const g of groupFindings(rows)) expect(g.message).not.toMatch(/\{(subject|n)\}/);
  });
});

describe("groupFindings", () => {
  const rows: FindingRow[] = [
    unreachable("src/a.ts", "run"),
    unreachable("src/a.ts", "stop"),
    unreachable("src/b.ts", "tick"),
    unreachable("src/a.ts", "go"),
    unreachable("src/c.ts", "zap"),
    unreachable("src/c.ts", "zip"),
    complexity("src/parts/motion.ts", "motionModel", 65),
  ];

  it("makes one row per kind, ordered by count", () => {
    const groups = groupFindings(rows);
    expect(groups.map((g) => [g.kind, g.count])).toEqual([
      ["unreachable", 6],
      ["complexity", 1],
    ]);
    expect(groups[0]?.lens).toBe("lens-calls");
    expect(groups[1]?.severity).toBe("warning");
  });

  it("counts files by finding and lists the top ones with the most first", () => {
    const [unr] = groupFindings(rows);
    expect(unr?.topFiles).toEqual([
      { file: "src/a.ts", count: 3 },
      { file: "src/c.ts", count: 2 },
      { file: "src/b.ts", count: 1 },
    ]);
  });

  it("caps the top files and gives three examples with their function and line", () => {
    const many: FindingRow[] = Array.from({ length: 9 }, (_, i) => unreachable(`src/f${i}.ts`, `fn${i}`));
    const [g] = groupFindings(many);
    expect(g?.topFiles).toHaveLength(TOP_FILES);
    expect(g?.examples).toHaveLength(EXAMPLES);
    expect(g?.examples[0]).toEqual({ file: "src/f0.ts", line: 10, fn: "src/f0.ts#fn0", message: "fn0 is not reachable from any entry point" });
  });

  it("fills the message from the first finding and points Show in Flow at the top file's function", () => {
    const groups = groupFindings(rows);
    expect(groups[0]?.template).toBe("{subject} is not reachable from any entry point");
    expect(groups[0]?.message).toBe("run is not reachable from any entry point");
    expect(groups[0]?.flowFile).toBe("src/a.ts");
    expect(groups[0]?.flowFn).toBe("src/a.ts#run");
    expect(groups[1]?.message).toBe("motionModel has complexity 65, above 10");
  });

  it("leaves Show in Flow without a function when the top file has no example function", () => {
    const cycle: FindingRow = {
      id: "cycle:src/p.ts|src/q.ts",
      lens: "lens-dependencies",
      severity: "warning",
      message: "Import cycle between 2 modules: src/p.ts -> src/q.ts",
      nodes: ["src/p.ts", "src/q.ts"],
    };
    const [g] = groupFindings([cycle]);
    expect(g?.flowFile).toBe("src/p.ts");
    expect(g?.flowFn).toBeUndefined();
    expect(g?.message).toBe("Import cycle between 2 modules: src/p.ts -> src/q.ts");
  });

  it("returns no rows for no findings", () => {
    expect(groupFindings([])).toEqual([]);
  });
});
