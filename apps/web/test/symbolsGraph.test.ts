import { describe, expect, it } from "vitest";
import { buildProjectModel, type ProjectModel } from "@insight/model";
import { SYMBOLS_MAX_DEPTH, exportedCallees, exportedCallers, exportedFunctions, isExportedFunction } from "../src/symbols/graph";

// A small hand-built project: each function is a node in its file, each call an edge. The model is built the way the page
// builds it, so the walks under test read the same relations the Symbols tab does.

const P = { frontend: "test", confidence: "exact" as const };
type Doc = Parameters<typeof buildProjectModel>[0];

const A = "src/a.ts";
const B = "src/b.ts";
const C = "src/c.ts";
const X = "src/x.ts";
const Y = "src/y.ts";
const EXT = "ext/lib.ts";

const fileNode = (path: string) => ({ id: path, facet: "structure", kind: "structure.file", attrs: { path }, provenance: P });

interface FnOpts {
  file: string;
  name: string;
  line?: number;
  exported?: boolean;
  external?: boolean;
  anonymous?: boolean;
  parent?: string;
}
/** A function node. A lambda is anonymous: its id is `<parent>#<lambda:name>` and it has no exported flag. */
function fnNode(o: FnOpts) {
  const id = o.anonymous ? `${o.parent}#<lambda:${o.name}>` : `${o.file}#${o.name}`;
  const line = o.line ?? 1;
  const attrs: Record<string, unknown> = o.anonymous ? { name: "<lambda>", anonymous: true } : { name: o.name };
  if (o.exported) attrs.exported = true;
  if (o.external) attrs.external = true;
  return {
    id,
    facet: "structure",
    kind: "structure.function",
    parent: o.anonymous ? o.parent : o.file,
    span: { file: o.file, start: [line, 0] as [number, number], end: [line + 2, 1] as [number, number] },
    attrs,
    provenance: P,
  };
}

const callEdge = (from: string, to: string | string[]) => ({
  from,
  to: Array.isArray(to) ? { candidates: to } : to,
  facet: "calls",
  kind: "calls.call",
  span: { file: A, start: [5, 2] as [number, number], end: [5, 8] as [number, number] },
  provenance: P,
});

const id = (file: string, name: string) => `${file}#${name}`;

/** Builds a model from the functions and the call edges given. Files A, B, C, X, Y and EXT are always present. */
function modelOf(fns: FnOpts[], calls: Array<[string, string | string[]]>): ProjectModel {
  const nodes = [A, B, C, X, Y, EXT].map(fileNode);
  return modelRaw(fns, [], calls.map(([from, to]) => callEdge(from, to)));
}

/** A model from the functions, any extra nodes (a spawn), and raw edges (a reference, a spawn). Files A, B, C, X, Y, EXT are always present. */
function modelRaw(fns: FnOpts[], extraNodes: unknown[], edges: unknown[]): ProjectModel {
  const nodes = [A, B, C, X, Y, EXT].map(fileNode);
  const doc = {
    nodes: [...nodes, ...fns.map(fnNode), ...extraNodes],
    edges,
    findings: [],
  } as unknown as Doc;
  return buildProjectModel(doc);
}

const names = (links: Array<{ name: string }>) => links.map((l) => l.name);

describe("exported functions", () => {
  const m = modelOf(
    [
      { file: A, name: "A", exported: true },
      { file: A, name: "H", line: 9 },
      { file: B, name: "B", exported: true },
      { file: C, name: "C", exported: true },
      { file: X, name: "X", exported: true },
      { file: EXT, name: "Ext", exported: true, external: true },
    ],
    [],
  );

  it("lists the exported, non-external functions of the whole project for the root scope", () => {
    expect(exportedFunctions(m, "").map((s) => s.name)).toEqual(["A", "B", "C", "X"]);
  });

  it("lists only the functions of the scope, a folder or a file", () => {
    expect(exportedFunctions(m, "src").map((s) => s.file)).toEqual([A, B, C, X]);
    expect(exportedFunctions(m, "src/a.ts").map((s) => s.name)).toEqual(["A"]);
    expect(exportedFunctions(m, "ext")).toEqual([]);
  });

  it("does not list an internal helper, and tests the export flag on the node", () => {
    expect(isExportedFunction(m, id(A, "H"))).toBe(false);
    expect(isExportedFunction(m, id(EXT, "Ext"))).toBe(false);
    expect(isExportedFunction(m, id(A, "A"))).toBe(true);
  });
});

describe("exported callees", () => {
  it("lists a direct callee with no via and no maybe flag", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [[id(A, "A"), id(B, "B")]],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, candidate: false }]);
  });

  it("follows a call through an internal helper, naming the first helper as the via", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "H" },
        { file: C, name: "C", exported: true },
      ],
      [
        [id(A, "A"), id(A, "H")],
        [id(A, "H"), id(C, "C")],
      ],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(C, "C"), name: "C", file: C, via: "H", candidate: false }]);
  });

  it("ends at the first exported function on a path: what an exported callee calls is not its caller's callee", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
        { file: C, name: "C", exported: true },
      ],
      [
        [id(A, "A"), id(B, "B")],
        [id(B, "B"), id(C, "C")],
      ],
    );
    expect(names(exportedCallees(m, id(A, "A")))).toEqual(["B"]);
  });

  it("is cycle-safe over a helper cycle, and still reaches the exported function past it", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "H1" },
        { file: A, name: "H2" },
        { file: B, name: "B", exported: true },
      ],
      [
        [id(A, "A"), id(A, "H1")],
        [id(A, "H1"), id(A, "H2")],
        [id(A, "H2"), id(A, "H1")],
        [id(A, "H2"), id(B, "B")],
      ],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, via: "H1", candidate: false }]);
  });

  it("marks a callee as a maybe when its only link is an interface-dispatch candidate", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: X, name: "X", exported: true },
        { file: Y, name: "Y", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [
        [id(A, "A"), [id(X, "X")]],
        [id(A, "A"), id(B, "B")],
        [id(A, "A"), [id(B, "B"), id(Y, "Y")]],
      ],
    );
    // X is only a candidate; B is a sure call (a candidate set naming it does not make it a maybe); Y is a candidate.
    expect(exportedCallees(m, id(A, "A")).map((l) => [l.name, l.candidate])).toEqual([
      ["B", false],
      ["X", true],
      ["Y", true],
    ]);
  });

  it("skips external functions, exported or not", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: EXT, name: "Ext", exported: true, external: true },
        { file: EXT, name: "extHelper", external: true },
        { file: B, name: "B", exported: true },
      ],
      [
        [id(A, "A"), id(EXT, "Ext")],
        [id(A, "A"), id(EXT, "extHelper")],
        [id(A, "A"), id(B, "B")],
      ],
    );
    expect(names(exportedCallees(m, id(A, "A")))).toEqual(["B"]);
  });

  it("folds a lambda's call into its owner", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "cb", anonymous: true, parent: id(A, "A") },
        { file: B, name: "B", exported: true },
      ],
      [[`${id(A, "A")}#<lambda:cb>`, id(B, "B")]],
    );
    // The lambda is inside A (its parent); its call to B is a call of A.
    expect(names(exportedCallees(m, id(A, "A")))).toEqual(["B"]);
  });

  it("keeps a helper's callee when the helper is reached through a lambda", () => {
    const lam = `${id(A, "A")}#<lambda:cb>`;
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "cb", anonymous: true, parent: id(A, "A") },
        { file: A, name: "H" },
        { file: C, name: "C", exported: true },
      ],
      [
        [lam, id(A, "H")],
        [id(A, "H"), id(C, "C")],
      ],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(C, "C"), name: "C", file: C, via: "H", candidate: false }]);
  });

  it("sorts the direct callees first, then the rest, each group by name", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "H" },
        { file: B, name: "Zeta", exported: true },
        { file: B, name: "Beta", exported: true },
        { file: C, name: "Alpha", exported: true },
      ],
      [
        [id(A, "A"), id(B, "Zeta")],
        [id(A, "A"), id(B, "Beta")],
        [id(A, "A"), id(A, "H")],
        [id(A, "H"), id(C, "Alpha")],
      ],
    );
    expect(names(exportedCallees(m, id(A, "A")))).toEqual(["Beta", "Zeta", "Alpha"]);
  });

  it("answers an empty list for a function that calls no exported function", () => {
    const m = modelOf([{ file: A, name: "A", exported: true }], []);
    expect(exportedCallees(m, id(A, "A"))).toEqual([]);
  });

  it("stops at the depth cap: an exported function past SYMBOLS_MAX_DEPTH helpers is not reached", () => {
    const chainOf = (helpers: number) => {
      const fns: FnOpts[] = [{ file: A, name: "A", exported: true }, { file: B, name: "Far", exported: true }];
      const calls: Array<[string, string]> = [];
      let prev = id(A, "A");
      for (let i = 1; i <= helpers; i++) {
        fns.push({ file: A, name: `H${i}` });
        calls.push([prev, id(A, `H${i}`)]);
        prev = id(A, `H${i}`);
      }
      calls.push([prev, id(B, "Far")]);
      return modelOf(fns, calls);
    };
    // The exported function is reached on hop helpers + 1; the cap is the largest hop count followed.
    expect(SYMBOLS_MAX_DEPTH).toBe(8);
    expect(names(exportedCallees(chainOf(SYMBOLS_MAX_DEPTH - 1), id(A, "A")))).toEqual(["Far"]);
    expect(exportedCallees(chainOf(SYMBOLS_MAX_DEPTH), id(A, "A"))).toEqual([]);
  });
});

describe("exported callers", () => {
  it("lists a direct caller", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [[id(B, "B"), id(A, "A")]],
    );
    expect(exportedCallers(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, candidate: false }]);
  });

  it("walks callers through an internal helper, naming the helper as the via", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "H" },
        { file: B, name: "B", exported: true },
      ],
      [
        [id(B, "B"), id(A, "H")],
        [id(A, "H"), id(A, "A")],
      ],
    );
    expect(exportedCallers(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, via: "H", candidate: false }]);
  });

  it("folds a caller's lambda into the function that owns it", () => {
    const lam = `${id(B, "B")}#<lambda:cb>`;
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
        { file: B, name: "cb", anonymous: true, parent: id(B, "B"), line: 3 },
      ],
      [[lam, id(A, "A")]],
    );
    expect(names(exportedCallers(m, id(A, "A")))).toEqual(["B"]);
  });

  it("does not list the function itself, and a callee is not its caller", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [
        [id(A, "A"), id(B, "B")],
        [id(A, "A"), id(A, "A")],
      ],
    );
    expect(exportedCallers(m, id(A, "A"))).toEqual([]);
    expect(names(exportedCallers(m, id(B, "B")))).toEqual(["A"]);
  });

  it("marks a caller as a maybe when its only link is a candidate", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [[id(B, "B"), [id(A, "A")]]],
    );
    expect(exportedCallers(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, candidate: true }]);
  });
});

const spanAt = { file: A, start: [5, 2] as [number, number], end: [5, 8] as [number, number] };
const refEdge = (from: string, to: string, how: string) => ({ from, to, facet: "calls", kind: "calls.reference", attrs: { how }, span: spanAt, provenance: P });
const spawnNode = (sid: string, parent: string) => ({
  id: sid,
  facet: "concurrency",
  kind: "concurrency.spawn-thread",
  parent,
  attrs: { api: "thread" },
  span: spanAt,
  provenance: P,
});
const spawnEdge = (from: string, to: string) => ({ from, to, facet: "concurrency", kind: "concurrency.spawns", span: spanAt, provenance: P });

describe("maybe links from references", () => {
  it("a reference that does not invoke its target is a maybe; an invoking reference (handler) is a sure call", () => {
    const m = modelRaw(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
        { file: C, name: "C", exported: true },
      ],
      [],
      [refEdge(id(A, "A"), id(B, "B"), "value"), refEdge(id(A, "A"), id(C, "C"), "handler")],
    );
    expect(exportedCallees(m, id(A, "A")).map((l) => [l.name, l.candidate])).toEqual([
      ["B", true],
      ["C", false],
    ]);
    expect(exportedCallers(m, id(B, "B"))).toEqual([{ id: id(A, "A"), name: "A", file: A, candidate: true }]);
  });
});

describe("spawned targets", () => {
  it("a spawned target is a callee of the function that starts the thread, and that function is its caller", () => {
    const sid = `${id(A, "A")}#spawn:0`;
    const m = modelRaw(
      [
        { file: A, name: "A", exported: true },
        { file: B, name: "B", exported: true },
      ],
      [spawnNode(sid, id(A, "A"))],
      [spawnEdge(sid, id(B, "B"))],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(B, "B"), name: "B", file: B, candidate: false }]);
    expect(exportedCallers(m, id(B, "B"))).toEqual([{ id: id(A, "A"), name: "A", file: A, candidate: false }]);
  });

  it("a thread started from a lambda is folded into the function that owns the lambda, both ways", () => {
    const lam = `${id(A, "A")}#<lambda:cb>`;
    const sid = `${lam}#spawn:0`;
    const m = modelRaw(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "cb", anonymous: true, parent: id(A, "A") },
        { file: B, name: "B", exported: true },
      ],
      [spawnNode(sid, lam)],
      [spawnEdge(sid, id(B, "B"))],
    );
    expect(exportedCallees(m, id(A, "A")).map((l) => l.name)).toEqual(["B"]);
    expect(exportedCallers(m, id(B, "B")).map((l) => l.name)).toEqual(["A"]);
  });
});

describe("the via of a link", () => {
  it("a sure path found after a maybe one takes the sure path's helper as its via", () => {
    const m = modelOf(
      [
        { file: A, name: "A", exported: true },
        { file: A, name: "H1" },
        { file: A, name: "H2" },
        { file: X, name: "X", exported: true },
      ],
      [
        [id(A, "A"), [id(A, "H1")]],
        [id(A, "A"), id(A, "H2")],
        [id(A, "H1"), id(X, "X")],
        [id(A, "H2"), id(X, "X")],
      ],
    );
    expect(exportedCallees(m, id(A, "A"))).toEqual([{ id: id(X, "X"), name: "X", file: X, via: "H2", candidate: false }]);
  });
});
