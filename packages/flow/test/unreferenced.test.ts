import { describe, expect, it } from "vitest";
import type { IREdge, IRNode } from "@insight/ir";
import { SCOPE_FUNCTION_LIMIT, isNoisePath, summarizeScope, type ScopeFlow, type UnreferencedFunction } from "../src/index.js";
import { PROVENANCE, callEdge, flowOfScope, fnNode } from "./synthetic.js";

/**
 * A small project. `main` is called by a test, `parse` by `main`, and `lex` by `parse` in another file. `format` is
 * called from another folder, `pad` from `format` in its own file. `trim` and `upper` are called by nothing, `helper`
 * too, and `ping` only by itself. `start` is called by module-level code, `stop` by nothing.
 */
const NODES: IRNode[] = [
  fnNode("app/src/index.ts", "main", 0),
  fnNode("app/src/index.ts", "parse", 4),
  fnNode("app/src/index.ts", "helper", 8),
  fnNode("app/src/index.ts", "ping", 12),
  fnNode("app/src/lex.ts", "lex", 0),
  fnNode("app/test/index.test.ts", "it", 0),
  fnNode("lib/format.ts", "format", 0),
  fnNode("lib/format.ts", "pad", 4),
  fnNode("lib/strings.ts", "trim", 0),
  fnNode("lib/strings.ts", "upper", 4),
  fnNode("src/boot.ts", "start", 0),
  fnNode("src/boot.ts", "stop", 4),
];

const EDGES: IREdge[] = [
  callEdge("app/src/index.ts#main", "app/src/index.ts#parse", "app/src/index.ts", 1),
  callEdge("app/src/index.ts#main", "lib/format.ts#format", "app/src/index.ts", 2),
  callEdge("app/src/index.ts#parse", "app/src/lex.ts#lex", "app/src/index.ts", 5),
  callEdge("app/src/index.ts#ping", "app/src/index.ts#ping", "app/src/index.ts", 13),
  callEdge("app/test/index.test.ts#it", "app/src/index.ts#main", "app/test/index.test.ts", 1),
  callEdge("lib/format.ts#format", "lib/format.ts#pad", "lib/format.ts", 1),
  // Module-level code: its caller is the file, not a function.
  callEdge("src/boot.ts", "src/boot.ts#start", "src/boot.ts", 10),
];

const FILES = ["app/src/index.ts", "app/src/lex.ts", "app/test/index.test.ts", "lib/format.ts", "lib/strings.ts", "src/boot.ts"];
/** The scopes of the project from the root down, with a nested chain file -> folder -> parent -> root. */
const CHAIN = ["app/src/lex.ts", "app/src/index.ts", "app/src", "app", ""];
const SCOPES = [...new Set([...CHAIN, "app/test", "app/test/index.test.ts", "lib", "lib/format.ts", "lib/strings.ts", "src", "src/boot.ts"])];

const flowAt = (scope: string): ScopeFlow => flowOfScope(NODES, EDGES, FILES, scope);
const namesOf = (flow: ScopeFlow) => flow.unreferenced.map((f) => f.name).sort();

describe("isNoisePath", () => {
  it("marks files under a test, fixture or sample directory, and test or spec files", () => {
    expect(isNoisePath("app/test/index.test.ts")).toBe(true);
    expect(isNoisePath("a/tests/x.ts")).toBe(true);
    expect(isNoisePath("a/__tests__/x.ts")).toBe(true);
    expect(isNoisePath("a/fixtures/x.ts")).toBe(true);
    expect(isNoisePath("examples/sample/x.ts")).toBe(true);
    expect(isNoisePath("examples/samples/x.ts")).toBe(true);
    expect(isNoisePath("src/x.spec.tsx")).toBe(true);
    expect(isNoisePath("src/x.test.js")).toBe(true);
  });

  it("leaves source files alone, even with test or sample in their name", () => {
    expect(isNoisePath("src/index.ts")).toBe(false);
    expect(isNoisePath("src/test-utils.ts")).toBe(false);
    expect(isNoisePath("src/testing/index.ts")).toBe(false);
    expect(isNoisePath("src/tests.ts")).toBe(false);
    expect(isNoisePath("src/sample.ts")).toBe(false);
    expect(isNoisePath("src/samples-loader/index.ts")).toBe(false);
  });
});

describe("unreferenced functions of a scope", () => {
  it("lists every function at file scope when nothing in the file calls it", () => {
    const strings = flowAt("lib/strings.ts");
    expect(namesOf(strings)).toEqual(["trim", "upper"]);
    expect(strings.unreferenced.every((f) => !f.calledFromOutside)).toBe(true);
  });

  it("removes a function that another function in the same file calls", () => {
    const format = flowAt("lib/format.ts");
    // pad is called by format in this file, so only format is left.
    expect(namesOf(format)).toEqual(["format"]);
  });

  it("does not count a self-call as a reference", () => {
    const index = flowAt("app/src/index.ts");
    // ping calls only itself. helper is called by nothing.
    // main is called only by a test outside this file, so it stays (and is flagged). parse is called by main here.
    expect(namesOf(index)).toEqual(["helper", "main", "ping"]);
    expect(index.unreferenced.find((f) => f.name === "ping")).toBeDefined();
  });

  it("counts a call made by module-level code as a reference", () => {
    expect(namesOf(flowAt("src/boot.ts"))).toEqual(["stop"]);
  });

  it("keeps a function that only an outside caller reaches, and flags it", () => {
    const format = flowAt("lib/format.ts").unreferenced.find((f) => f.name === "format");
    expect(format).toMatchObject({ calledFromOutside: true });
    expect(format?.noise).toBeUndefined();
    const flow = flowAt("lib/format.ts");
    expect(flow.stats).toMatchObject({ unreferenced: 1, unreferencedOutside: 1 });
    // The entries are unchanged: an outside caller still keeps the function out of them.
    expect(flow.entries).not.toContain("lib/format.ts#format");
  });

  it("marks test rows, and counts them apart from the rest", () => {
    const root = flowAt("");
    const it = root.unreferenced.find((f) => f.name === "it");
    expect(it).toMatchObject({ noise: true });
    expect(root.stats).toMatchObject({ unreferenced: 5, unreferencedNoise: 1, functionsNoise: 1 });
    expect(root.unreferenced.filter((f) => !f.noise).map((f) => f.name).sort()).toEqual(["helper", "ping", "stop", "trim", "upper"]);
  });

  it("counts each candidate of a call with several possible targets as referenced", () => {
    const nodes = [fnNode("src/a.ts", "f", 0), fnNode("src/a.ts", "g", 4), fnNode("src/b.ts", "h", 0)];
    const edges = [callEdge("src/a.ts#f", { candidates: ["src/a.ts#g", "src/b.ts#h"] }, "src/a.ts", 1)];
    const flow = summarizeScope(nodes, edges, ["src/a.ts", "src/b.ts"]);
    expect(flow.unreferenced.map((f) => f.name)).toEqual(["f"]);
    expect(flow.unreferenced[0]?.reach).toBe(2);
  });

  it("gives a reach that counts each function once, not itself, and stays finite on a cycle", () => {
    // d calls a; a and b call each other; b calls c; c calls itself. d is the only function nothing calls.
    const file = "src/cyc.ts";
    const nodes = ["a", "b", "c", "d"].map((n, i) => fnNode(file, n, i * 4));
    const at = (name: string) => `${file}#${name}`;
    const edges = [
      callEdge(at("d"), at("a"), file, 1),
      callEdge(at("a"), at("b"), file, 5),
      callEdge(at("b"), at("a"), file, 9),
      callEdge(at("b"), at("c"), file, 10),
      callEdge(at("c"), at("c"), file, 14),
    ];
    const flow = summarizeScope(nodes, edges, [file]);
    expect(flow.unreferenced).toHaveLength(1);
    expect(flow.unreferenced[0]).toMatchObject({ name: "d", reach: 3 });
  });

  it("holds at file-level granularity too, so a large scope keeps its entry points", () => {
    const count = SCOPE_FUNCTION_LIMIT + 1;
    const big = Array.from({ length: count }, (_, i) => fnNode("src/big.ts", `f${i}`, i * 4));
    // f_i is called by f_(i-1), so only f0 is unreferenced.
    const calls = Array.from({ length: count - 1 }, (_, i) => callEdge(`src/big.ts#f${i}`, `src/big.ts#f${i + 1}`, "src/big.ts", i * 4 + 1));
    const flow = summarizeScope(big, calls, ["src/big.ts"]);
    expect(flow.granularity).toBe("files");
    expect(flow.functions).toEqual([]);
    expect(flow.unreferenced.map((f) => f.name)).toEqual(["f0"]);
    expect(flow.unreferenced[0]).toMatchObject({ reach: count - 1 });
    expect(flow.stats).toMatchObject({ functionsTotal: count, unreferenced: 1, unreferencedNoise: 0 });
  });
});

describe("unreferenced functions across nested scopes", () => {
  it("never lets a function come back when the scope widens: unreferenced above implies unreferenced below", () => {
    for (const narrow of SCOPES) {
      for (const wide of SCOPES) {
        if (narrow === wide || !insideOf(narrow, wide)) continue;
        const inner = flowAt(narrow);
        const outer = flowAt(wide);
        const innerIds = new Set(inner.functions.map((f) => f.id));
        const innerUnreferenced = new Set(inner.unreferenced.map((f) => f.id));
        const stillUnreferenced = outer.unreferenced.filter((f) => innerIds.has(f.id)).map((f) => f.id);
        for (const id of stillUnreferenced) {
          expect(innerUnreferenced.has(id), `${id} is unreferenced in ${wide || "the project"} but not in ${narrow}`).toBe(true);
        }
      }
    }
  });

  it("can count more unreferenced functions at the wider scope, because it holds more functions", () => {
    // lex is called from another file, so it is unreferenced in its own file. app/src also holds main and helper and ping.
    const file = flowAt("app/src/lex.ts");
    const folder = flowAt("app/src");
    expect(namesOf(file)).toEqual(["lex"]);
    expect(namesOf(folder)).toEqual(["helper", "main", "ping"]);
    expect(folder.stats.unreferenced).toBeGreaterThan(file.stats.unreferenced);
  });

  it("drops a function from the set once a caller in the wider scope reaches it", () => {
    expect(namesOf(flowAt("app/src/index.ts"))).toContain("main");
    expect(namesOf(flowAt("app"))).not.toContain("main");
    expect(namesOf(flowAt("app/src"))).toContain("main");
    expect(namesOf(flowAt("app/src/lex.ts"))).toContain("lex");
    expect(namesOf(flowAt(""))).not.toContain("lex");
  });

});

/** An anonymous function on `line` of `file`, written in `parent`: a function id, or the file for module-level code. */
function anonNode(file: string, line: number, parent: string): IRNode {
  const name = `λ${line + 1}:3`;
  return { ...fnNode(file, name, line), parent, attrs: { name, anonymous: true } };
}

/** A closure edge: `from` creates the anonymous function `to`, on `line` of `file`. */
function closureEdge(from: string, to: string, file: string, line: number): IREdge {
  return {
    from,
    to,
    facet: "calls",
    kind: "calls.reference",
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: { how: "closure" },
    provenance: PROVENANCE,
  };
}

describe("anonymous functions in the unreferenced rows", () => {
  it("gives a named function the same row whether it calls through a lambda or directly", () => {
    const file = "src/a.ts";
    const named = [fnNode(file, "outer", 0), fnNode(file, "inner", 8)];
    const direct = summarizeScope(named, [callEdge(`${file}#outer`, `${file}#inner`, file, 1)], [file]);
    // The same call, made inside a lambda that outer creates. The lambda is not a row, and its call is outer's.
    const lam = anonNode(file, 4, `${file}#outer`);
    const viaLambda = summarizeScope(
      [...named, lam],
      [closureEdge(`${file}#outer`, lam.id, file, 4), callEdge(lam.id, `${file}#inner`, file, 5)],
      [file],
    );
    for (const flow of [direct, viaLambda]) {
      expect(flow.unreferenced.map((f) => [f.name, f.reach])).toEqual([["outer", 1]]);
      expect(flow.stats).toMatchObject({ unreferenced: 1, unreferencedOutside: 0 });
    }
    // The row's identity and reach are the same. Its body measures (steps and the rest) are not: the call sits in the
    // lambda's body, which is the lambda's own function, so outer's steps no longer count it.
    const identity = (f: UnreferencedFunction) => ({ id: f.id, name: f.name, file: f.file, line: f.line, reach: f.reach, calledFromOutside: f.calledFromOutside });
    expect(viaLambda.unreferenced.map(identity)).toEqual(direct.unreferenced.map(identity));
    expect(viaLambda.functions.find((f) => f.id === lam.id)).toMatchObject({ anonymous: true });
  });

  it("never lists an anonymous function as unreferenced or as an entry, even one nothing creates", () => {
    const file = "src/c.ts";
    // A lambda in f, and one at module level. Neither has a creator edge, so nothing in the scope names either.
    const nodes = [fnNode(file, "f", 0), anonNode(file, 4, `${file}#f`), anonNode(file, 8, file)];
    const flow = summarizeScope(nodes, [], [file]);
    expect(flow.unreferenced.map((f) => f.name)).toEqual(["f"]);
    expect(flow.entries).toEqual([`${file}#f`]);
    expect(flow.functions.filter((f) => f.anonymous)).toHaveLength(2);
    expect(flow.stats.functions).toBe(3);
  });
});

/** True when a scope lies inside another. The project's scope "" holds every scope. */
function insideOf(narrow: string, wide: string): boolean {
  return wide === "" || narrow === wide || narrow.startsWith(`${wide}/`);
}
