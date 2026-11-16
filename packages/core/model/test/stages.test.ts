import { describe, expect, it } from "vitest";
import type { IRDocument, IREdge, IRNode } from "@insight/ir";
import * as fx from "@insight/sdk/testing";
import { buildProjectModel, stageDrivers, stageGraph, type StageGraph, type StageNode } from "../src/index.js";
import { armShare } from "../src/stages.js";

const F = "app/src/run.ts";
const DRV = `${F}#run`;
const comp = (file: string | undefined): string | undefined => file?.split("/")[0];

const file = (path: string): IRNode => fx.node(path, "structure", "structure.file", { attrs: { path }, span: fx.span(path, 0, 0, 0, 0) });

function fn(id: string, name: string, path: string, parent: string, attrs: Record<string, unknown> = {}): IRNode {
  return fx.node(id, "structure", "structure.function", { attrs: { name, ...attrs }, parent, span: fx.span(path, 2, 0, 9, 1) });
}

type Span4 = [number, number, number, number];
/** A flow fact in F. Its parent is the driver unless given. */
function flow(id: string, kind: string, s: Span4, attrs: Record<string, unknown> = {}, parent = DRV): IRNode {
  return fx.node(`${F}@${id}`, "flow", kind, { attrs, parent, span: fx.span(F, ...s) });
}

/**
 * A call in F on `line` from `from`. The callEnd defaults to the span end; pass `callEnd: undefined` in `extra` to drop it.
 * `to` is one target or a candidate list.
 */
function call(from: string, to: string | string[], line: number, c0 = 2, c1 = 6, extra: Record<string, unknown> = {}): IREdge {
  return fx.edge(from, to, "calls", "calls.call", { span: fx.span(F, line, c0, line, c1), attrs: { callEnd: [line, c1], ...extra } });
}

const STAGES: Record<string, string> = { s1: "b/src/b1.ts", s2: "b/src/b2.ts", s3: "c/src/c1.ts", s4: "c/src/c2.ts", s5: "c/src/c3.ts", s6: "c/src/c4.ts" };
const stageId = (name: string): string => `${STAGES[name] as string}#${name}`;

/** Each stage lives in its own file and calls two leaves, so it is a stage (two distinct targets) and not a minor helper. */
function stageParts(): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  for (const [name, path] of Object.entries(STAGES)) {
    nodes.push(fn(`${path}#${name}`, name, path, path), fn(`${path}#${name}A`, `${name}A`, path, path), fn(`${path}#${name}B`, `${name}B`, path, path));
    edges.push(
      fx.edge(`${path}#${name}`, `${path}#${name}A`, "calls", "calls.call", { span: fx.span(path, 3, 2, 3, 4) }),
      fx.edge(`${path}#${name}`, `${path}#${name}B`, "calls", "calls.call", { span: fx.span(path, 4, 2, 4, 4) }),
    );
  }
  return { nodes, edges };
}

/** The fixture document: the driver (no nodes of its own beyond its function), the stages, and the extra nodes and edges. */
function doc(parts: { nodes?: IRNode[]; edges?: IREdge[] } = {}): IRDocument {
  const st = stageParts();
  const paths = [F, ...Object.values(STAGES)];
  return {
    nodes: [...paths.map(file), fn(DRV, "run", F, F), ...st.nodes, ...(parts.nodes ?? [])],
    edges: [...st.edges, ...(parts.edges ?? [])],
    findings: [],
  };
}

const graphOf = (d: IRDocument, driver = DRV) => stageGraph(buildProjectModel(d), driver, comp, false);

/** A compact rendering of a stage graph: calls by name (`~` minor, `[n]` fan-out size, `?` ambiguous), blocks in brackets. */
function show(nodes: StageNode[]): string {
  return nodes
    .map((n): string => {
      switch (n.kind) {
        case "call": {
          const name = n.name + (n.minor ? "~" : "") + (n.fanout ? `[${n.fanout.targets.length}]` : "") + (n.ambiguous ? "?" : "") + (n.repeatOf !== undefined ? "↺" : "");
          return n.body ? `${name}{${show(n.body)}}` : name;
        }
        case "loop":
          return `for[${show(n.body)}]`;
        case "branch":
          return `if{${n.arms.map((a) => `${a.label}=[${show(a.body)}]`).join(" ")}}`;
        case "try":
          return `try[${show(n.body)}]catch[${show(n.handler)}]`;
        case "exit":
          return `exit:${n.how}`;
      }
    })
    .join(" ");
}

/** loop > body block > branch with arms then (s1) and else (s2), then a call s3 after the branch. */
function nestingParts(order: "forward" | "reverse" = "forward"): { nodes: IRNode[]; edges: IREdge[] } {
  const nodes = [
    flow("loop:3:2", "flow.loop", [3, 2, 10, 3], { variant: "for-of", condition: "const x of items" }),
    flow("block:3:30", "flow.block", [3, 30, 10, 3], { label: "body" }),
    flow("if:4:4", "flow.branch", [4, 4, 8, 5], { condition: "x.ok" }),
    flow("arm:4:18", "flow.branch-arm", [4, 18, 6, 5], { label: "then" }),
    flow("arm:6:11", "flow.branch-arm", [6, 11, 8, 5], { label: "else" }),
  ];
  const calls = [call(DRV, stageId("s1"), 5, 6, 8), call(DRV, stageId("s2"), 7, 6, 8), call(DRV, stageId("s3"), 9, 4, 6)];
  return { nodes, edges: order === "forward" ? calls : [...calls].reverse() };
}

describe("stage graph: nesting", () => {
  it("nests loop > body > branch > arms by span containment, with the call after the branch in the loop body", () => {
    const p = nestingParts();
    const g = graphOf(doc(p));
    expect(show(g.body)).toBe("for[if{then=[s1] else=[s2]} s3]");
    expect(g.driver.id).toBe(DRV);
    expect(g.driver.name).toBe("run");
  });

  it("gives the same graph whatever order the call edges come in", () => {
    const forward = graphOf(doc(nestingParts("forward")));
    const reverse = graphOf(doc(nestingParts("reverse")));
    expect(show(reverse.body)).toBe(show(forward.body));
    expect(show(forward.body)).toBe("for[if{then=[s1] else=[s2]} s3]");
  });

  it("maps a try's try block to body and its catch block to handler", () => {
    const nodes = [
      flow("try:12:2", "flow.try", [12, 2, 16, 3], { hasFinally: false }),
      flow("block:12:6", "flow.block", [12, 6, 14, 3], { label: "try" }),
      flow("block:14:10", "flow.block", [14, 10, 16, 3], { label: "catch" }),
    ];
    const edges = [call(DRV, stageId("s1"), 13, 4, 6), call(DRV, stageId("s2"), 15, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("try[s1]catch[s2]");
  });
});

describe("stage graph: local helpers", () => {
  it("inlines a named helper nested in the driver under its call", () => {
    const H = `${F}#run.helper`;
    const nodes = [fn(H, "helper", F, DRV)];
    const edges = [call(DRV, H, 8, 2, 8), call(H, stageId("s1"), 22, 4, 6), call(H, stageId("s2"), 23, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("helper{s1 s2}");
    const helper = g.body[0];
    expect(helper?.kind === "call" && helper.fn).toBe(H);
  });

  it("marks a second inline of the same helper repeatOf the first call, with no body", () => {
    const H = `${F}#run.helper`;
    const nodes = [fn(H, "helper", F, DRV)];
    const edges = [call(DRV, H, 8, 2, 8), call(DRV, H, 9, 2, 8), call(H, stageId("s1"), 22, 4, 6), call(H, stageId("s2"), 23, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("helper{s1 s2} helper↺");
    const [first, second] = g.body;
    expect(first?.kind === "call" && first.body?.length).toBe(2);
    expect(second).toMatchObject({ kind: "call", name: "helper", repeatOf: first?.kind === "call" ? first.id : undefined });
    expect(second?.kind === "call" && second.body).toBeUndefined();
  });

  it("guards against a helper cycle: the call back into an active helper keeps no body", () => {
    const HA = `${F}#run.ha`;
    const HB = `${F}#run.hb`;
    const nodes = [fn(HA, "ha", F, DRV), fn(HB, "hb", F, DRV)];
    const edges = [
      call(DRV, HA, 8, 2, 4),
      call(HA, stageId("s1"), 22, 4, 6),
      call(HA, HB, 23, 4, 6),
      call(HB, stageId("s2"), 25, 4, 6),
      call(HB, HA, 26, 4, 6),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("ha{s1 hb{s2 ha}}");
  });
});

describe("stage graph: interface fan-out and ambiguous calls", () => {
  it("fans out an interface call to each candidate, a registry call too, and shows a candidate call without how once", () => {
    const edges = [
      call(DRV, [1, 2, 3, 4, 5].map((i) => stageId(`s${i}`)), 4, 2, 6, { how: "interface", callee: "detect" }),
      call(DRV, [stageId("s3"), stageId("s4")], 6, 2, 8, { how: "registry", callee: "reg" }),
      call(DRV, [stageId("s5"), stageId("s6")], 7, 2, 6, { callee: "amb" }),
    ];
    const g = graphOf(doc({ edges }));
    expect(show(g.body)).toBe("detect[5] reg[2] amb?");
    const detect = g.body[0];
    expect(detect?.kind === "call" && detect.fanout?.how).toBe("interface");
    expect(detect?.kind === "call" && detect.fanout?.targets.map((t) => t.component)).toEqual(["b", "b", "c", "c", "c"]);
    expect(g.coverage).toContain("1 calls with several possible targets shown once");
    // The ambiguous call carries how many distinct targets it could be.
    const amb = g.body[2];
    expect(amb?.kind === "call" && amb.candidates).toBe(2);
  });
});

describe("stage graph: minor marking", () => {
  it("marks a leaf with no exact targets minor, and a callee with more than 25 folded callers minor", () => {
    const hub = `${F}#hub`;
    const nodes = [fn(`${F}#leaf`, "leaf", F, F), fn(hub, "hub", F, F)];
    const edges: IREdge[] = [call(DRV, `${F}#leaf`, 10), call(DRV, hub, 12), call(hub, stageId("s1"), 3), call(hub, stageId("s2"), 4)];
    for (let i = 0; i < 26; i++) {
      nodes.push(fn(`${F}#c${i}`, `c${i}`, F, F));
      edges.push(call(`${F}#c${i}`, hub, 3));
    }
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("leaf~ hub~");
  });
});

describe("stage graph: pruning", () => {
  it("drops containers with only minor calls, keeps those with a stage, and keeps an empty sibling arm beside a kept one", () => {
    const nodes = [
      flow("loop:20:2", "flow.loop", [20, 2, 22, 3], { variant: "for-of", condition: "x" }),
      flow("loop:24:2", "flow.loop", [24, 2, 26, 3], { variant: "while", condition: "more()" }),
      flow("if:28:2", "flow.branch", [28, 2, 29, 3], { condition: "never" }),
      flow("arm:28:20", "flow.branch-arm", [28, 20, 29, 3], { label: "then" }),
      flow("if:30:2", "flow.branch", [30, 2, 33, 3], { condition: "ok" }),
      flow("arm:30:20", "flow.branch-arm", [30, 20, 32, 3], { label: "then" }),
      flow("arm:32:9", "flow.branch-arm", [32, 9, 33, 3], { label: "else" }),
    ];
    const edges = [call(DRV, `${F}#leaf`, 21, 4, 8), call(DRV, stageId("s1"), 25, 4, 6), call(DRV, stageId("s2"), 31, 4, 6)];
    const d = doc({ nodes: [...nodes, fn(`${F}#leaf`, "leaf", F, F)], edges });
    expect(show(graphOf(d).body)).toBe("for[s1] if{then=[s2] else=[]}");
  });
});

describe("stage graph: exits", () => {
  it("keeps a continue inside a branch arm of a loop and a continue in a catch of a try in a loop, and drops return at the top level", () => {
    const nodes = [
      flow("loop:40:2", "flow.loop", [40, 2, 46, 3], { variant: "for-of", condition: "const x of xs" }),
      flow("block:40:30", "flow.block", [40, 30, 46, 3], { label: "body" }),
      flow("if:41:4", "flow.branch", [41, 4, 43, 5], { condition: "skip" }),
      flow("arm:41:20", "flow.branch-arm", [41, 20, 43, 5], { label: "then" }),
      flow("jump:42:6", "flow.jump", [42, 6, 42, 14], { variant: "continue" }),
      flow("return:50:2", "flow.return", [50, 2, 50, 10]),
      flow("loop:56:2", "flow.loop", [56, 2, 64, 3], { variant: "while", condition: "busy" }),
      flow("block:56:30", "flow.block", [56, 30, 64, 3], { label: "body" }),
      flow("try:57:4", "flow.try", [57, 4, 62, 5], { hasFinally: false }),
      flow("block:57:8", "flow.block", [57, 8, 59, 5], { label: "try" }),
      flow("block:59:10", "flow.block", [59, 10, 62, 5], { label: "catch" }),
      flow("jump:60:6", "flow.jump", [60, 6, 60, 14], { variant: "continue" }),
    ];
    const edges = [call(DRV, stageId("s1"), 45, 4, 6), call(DRV, stageId("s2"), 51, 2, 4), call(DRV, stageId("s3"), 58, 6, 8)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("for[if{then=[exit:continue]} s1] s2 for[try[s3]catch[exit:continue]]");
  });
});

describe("stage graph: coverage notes", () => {
  it("notes approximate call order, missing early exits, and ambiguous calls", () => {
    const nodes = [flow("loop:3:2", "flow.loop", [3, 2, 5, 3], { variant: "for-of", condition: "xs" })];
    const edges = [call(DRV, stageId("s1"), 4, 4, 6, { callEnd: undefined }), call(DRV, [stageId("s5"), stageId("s6")], 6, 2, 6, { callee: "amb" })];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.coverage).toEqual([
      "Nested call order approximate",
      "Early exits not shown",
      "1 calls with several possible targets shown once",
      "No data-flow facts for this language",
    ]);
  });
});

describe("stage drivers", () => {
  it("ranks a loop above a straight line above a router-shaped switch of the same stages", () => {
    const plain = `${F}#plain`;
    const looped = `${F}#looped`;
    const router = `${F}#router`;
    const nodes = [fn(plain, "plain", F, F), fn(looped, "looped", F, F), fn(router, "router", F, F)];
    const stages = ["s1", "s2", "s3", "s4"];
    const edges: IREdge[] = [];
    stages.forEach((s, i) => edges.push(call(plain, stageId(s), 10 + i, 2, 6)));
    stages.forEach((s, i) => edges.push(call(looped, stageId(s), 21 + i, 4, 6)));
    stages.forEach((s, i) => edges.push(call(router, stageId(s), 31 + 2 * i, 4, 6)));
    const flows = [
      flow("loop:20:2", "flow.loop", [20, 2, 25, 3], { variant: "for-of", condition: "items" }, looped),
      flow("if:30:2", "flow.branch", [30, 2, 38, 3], { condition: "kind" }, router),
      flow("arm:30:10", "flow.branch-arm", [30, 10, 32, 3], { label: "case" }, router),
      flow("arm:32:10", "flow.branch-arm", [32, 10, 34, 3], { label: "case" }, router),
      flow("arm:34:10", "flow.branch-arm", [34, 10, 36, 3], { label: "case" }, router),
      flow("arm:36:10", "flow.branch-arm", [36, 10, 38, 3], { label: "case" }, router),
    ];
    const d = doc({ nodes: [...nodes, ...flows], edges });
    const ranked = stageDrivers(buildProjectModel(d), comp, false)
      .map((x) => x.id)
      .filter((id) => id === plain || id === looped || id === router);
    expect(ranked).toEqual([looped, plain, router]);
  });
});

describe("stage graph: else-if ladder router", () => {
  it("counts a whole else-if ladder as arms of one branch, so its stages make a router: score x0.3 of the same stages in sequence", () => {
    const LADDER = `${F}#ladder`;
    const SEQ = `${F}#seq`;
    const nodes: IRNode[] = [fn(LADDER, "ladder", F, F), fn(SEQ, "seq", F, F)];
    const edges: IREdge[] = [];
    const flows: IRNode[] = [];
    // if (k == 0) {s1} else if (k == 1) {s2} else if (k == 2) {s3} else if (k == 3) {s4} else {s5}, each else nesting the next if.
    for (let i = 0; i < 4; i++) {
      const top = 10 + 2 * i;
      flows.push(
        flow(`if:${i}`, "flow.branch", [top, 2, 40, 3], { condition: `kind === ${i}` }, LADDER),
        flow(`then:${i}`, "flow.branch-arm", [top, 10, top + 1, 3], { label: "then" }, LADDER),
        flow(`else:${i}`, "flow.branch-arm", [top + 1, 9, 40, 3], { label: "else" }, LADDER),
      );
      edges.push(call(LADDER, stageId(`s${i + 1}`), top, 12, 14));
    }
    edges.push(call(LADDER, stageId("s5"), 18, 12, 14));
    for (let k = 1; k <= 5; k++) edges.push(call(SEQ, stageId(`s${k}`), 9 + k, 2, 6));

    const model = buildProjectModel(doc({ nodes: [...nodes, ...flows], edges }));
    expect(armShare(stageGraph(model, LADDER, comp, false).body)).toBe(1);
    expect(armShare(stageGraph(model, SEQ, comp, false).body)).toBe(0);
    const scores = new Map(stageDrivers(model, comp, false).map((x) => [x.id, x.score]));
    expect(scores.get(LADDER)).toBeCloseTo((scores.get(SEQ) as number) * 0.3, 1);
  });
});

describe("stage graph: minor helpers", () => {
  it("hides an inlined helper whose body has no non-minor stage", () => {
    const H = `${F}#run.util`;
    const LEAF = `${F}#leaf`;
    const LEAF2 = `${F}#leaf2`;
    // util calls two functions that call nothing: two targets, but no stage inside util.
    const nodes = [fn(H, "util", F, DRV), fn(LEAF, "leaf", F, F), fn(LEAF2, "leaf2", F, F)];
    const edges = [call(DRV, H, 8, 2, 8), call(H, LEAF, 22, 4, 6), call(H, LEAF2, 23, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("util~{leaf~ leaf2~}");
    expect(g.body[0]?.kind === "call" && g.body[0].minor).toBe(true);
  });
});

describe("stage graph: catch exits", () => {
  it("keeps a continue in the catch of a try inside a loop, and drops a continue in the catch of a try outside any loop", () => {
    const nodes = [
      flow("loop:20:2", "flow.loop", [20, 2, 30, 3], { variant: "for-of", condition: "const x of xs" }),
      flow("block:20:30", "flow.block", [20, 30, 30, 3], { label: "body" }),
      flow("try:22:4", "flow.try", [22, 4, 26, 5], { hasFinally: false }),
      flow("block:22:8", "flow.block", [22, 8, 24, 5], { label: "try" }),
      flow("block:24:10", "flow.block", [24, 10, 26, 5], { label: "catch" }),
      flow("jump:25:6", "flow.jump", [25, 6, 25, 14], { variant: "continue" }),
      flow("try:32:2", "flow.try", [32, 2, 36, 3], { hasFinally: false }),
      flow("block:32:6", "flow.block", [32, 6, 34, 3], { label: "try" }),
      flow("block:34:8", "flow.block", [34, 8, 36, 3], { label: "catch" }),
      flow("jump:35:4", "flow.jump", [35, 4, 35, 12], { variant: "continue" }),
    ];
    const edges = [call(DRV, stageId("s1"), 23, 6, 8), call(DRV, stageId("s2"), 33, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("for[try[s1]catch[exit:continue]] try[s2]catch[]");
  });
});

/** The fixture document with extra attributes on the driver function (its `derives`). */
function docWithDriver(attrs: Record<string, unknown>, parts: { nodes?: IRNode[]; edges?: IREdge[] } = {}): IRDocument {
  const d = doc(parts);
  return { ...d, nodes: d.nodes.map((n) => (n.id === DRV ? { ...n, attrs: { ...n.attrs, ...attrs } } : n)) };
}

/** The first stage call named `name`, looking inside loops, branch arms, try blocks and inlined helpers. */
function stageNamed(nodes: StageNode[], name: string): StageNode | undefined {
  for (const n of nodes) {
    if (n.kind === "call" && n.name === name) return n;
    const inner: StageNode[] | undefined =
      n.kind === "call" ? n.body : n.kind === "loop" ? n.body : n.kind === "branch" ? n.arms.flatMap((a) => a.body) : n.kind === "try" ? [...n.body, ...n.handler] : undefined;
    const hit = inner ? stageNamed(inner, name) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
const idOf = (g: StageGraph, name: string): string => stageNamed(g.body, name)?.id ?? `missing:${name}`;

describe("stage graph: data edges", () => {
  it("links a bound local straight to a stage that reads it, with the producer's type", () => {
    const edges = [call(DRV, stageId("s3"), 3, 2, 6, { binds: "scan", bindsType: "ScanResult" }), call(DRV, stageId("s4"), 5, 2, 6, { reads: ["scan"] })];
    const g = graphOf(doc({ edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s3"), to: idOf(g, "s4"), label: "scan", type: "ScanResult" }]);
  });

  it("follows the driver's derives chain to the producer and labels the renamed read", () => {
    const edges = [call(DRV, stageId("s1"), 3, 2, 6, { binds: "scan" }), call(DRV, stageId("s2"), 5, 2, 6, { reads: ["files"] })];
    const g = graphOf(docWithDriver({ derives: { files: ["allFiles"], allFiles: ["scan"] } }, { edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: idOf(g, "s2"), label: "scan→files" }]);
  });

  it("stops at the first producer: a local bound by a stage is not traced into that stage's own inputs", () => {
    const edges = [
      call(DRV, stageId("s3"), 3, 2, 6, { binds: "cfg" }),
      call(DRV, stageId("s4"), 5, 2, 6, { binds: "scan", reads: ["cfg"] }),
      call(DRV, stageId("s5"), 7, 2, 6, { reads: ["scan"] }),
    ];
    const g = graphOf(docWithDriver({ derives: { scan: ["cfg"] } }, { edges }));
    expect(g.edges).toEqual([
      { from: idOf(g, "s3"), to: idOf(g, "s4"), label: "cfg" },
      { from: idOf(g, "s4"), to: idOf(g, "s5"), label: "scan" },
    ]);
  });

  it("gives a loop an edge from the producer of the local its range reads", () => {
    const nodes = [flow("loop:5:2", "flow.loop", [5, 2, 9, 3], { variant: "for-of", condition: "const p of plugins", reads: ["plugins"] })];
    // s4 reads nothing, but its empty `reads` key says the frontend emitted call reads (so the data-flow facts are present).
    const edges = [call(DRV, stageId("s3"), 3, 2, 6, { binds: "plugins" }), call(DRV, stageId("s4"), 6, 4, 6, { reads: [] })];
    const g = graphOf(doc({ nodes, edges }));
    const loop = g.body.find((n) => n.kind === "loop");
    expect(loop?.kind).toBe("loop");
    expect(g.edges).toEqual([{ from: idOf(g, "s3"), to: loop?.id ?? "", label: "plugins" }]);
  });

  it("follows a captured local from an inlined helper to the driver's producer", () => {
    const H = `${F}#run.helper`;
    const nodes = [fn(H, "helper", F, DRV, { derives: { x: ["scan"] }, params: [] })];
    const edges = [
      call(DRV, stageId("s3"), 2, 2, 6, { binds: "scan" }),
      call(DRV, H, 8, 2, 8),
      call(H, stageId("s4"), 22, 4, 6, { reads: ["x"] }),
      call(H, stageId("s5"), 23, 4, 6),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s3"), to: idOf(g, "s4"), label: "scan→x" }]);
  });

  it("keeps one edge per producer and at most three incoming edges, nearest producers first", () => {
    const edges = [
      call(DRV, stageId("s3"), 2, 2, 6, { binds: ["x", "y"] }),
      call(DRV, stageId("s4"), 3, 2, 6, { binds: "b" }),
      call(DRV, stageId("s5"), 4, 2, 6, { binds: "c" }),
      call(DRV, stageId("s6"), 5, 2, 6, { binds: "d" }),
      call(DRV, stageId("s1"), 8, 2, 6, { reads: ["a", "b", "c", "d", "x", "y"] }),
    ];
    const g = graphOf(doc({ edges }));
    const into = g.edges.filter((e) => e.to === idOf(g, "s1"));
    expect(into.map((e) => e.from)).toEqual([idOf(g, "s6"), idOf(g, "s5"), idOf(g, "s4")]);
    expect(g.edges.filter((e) => e.from === idOf(g, "s3")).length).toBe(0);
  });

  it("maps a helper parameter to its own argument, not the union of the call's arguments", () => {
    // digestFor(lf, prior) reads frontend and prior inside; frontend is argument 0 (lf), prior is argument 1 (prior).
    const H = `${F}#run.digestFor`;
    const nodes = [fn(H, "digestFor", F, DRV, { params: ["frontend", "prior"] })];
    const edges = [
      call(DRV, stageId("s3"), 2, 2, 6, { binds: "lf" }),
      call(DRV, stageId("s4"), 3, 2, 6, { binds: "prior" }),
      call(DRV, H, 8, 2, 8, { reads: ["lf", "prior"], argReads: [["lf"], ["prior"]] }),
      call(H, stageId("s5"), 22, 4, 6, { reads: ["frontend"] }),
      call(H, stageId("s6"), 23, 4, 6, { reads: ["prior"] }),
    ];
    const g = graphOf(doc({ nodes, edges }));
    // Edges into the helper's own call stage are the call's reads; the inner stages are the ones under test.
    const inner = g.edges.filter((e) => e.to.includes("digestFor@"));
    expect(inner).toHaveLength(2);
    expect(inner).toContainEqual({ from: idOf(g, "s3"), to: expect.stringContaining("digestFor@22:4"), label: "lf→frontend" });
    expect(inner).toContainEqual({ from: idOf(g, "s4"), to: expect.stringContaining("digestFor@23:4"), label: "prior" });
    expect(g.coverage).not.toContain("Helper arguments approximate");
  });

  it("falls back to the union of the call's reads, and says so, when the call has no argReads", () => {
    const H = `${F}#run.digestFor`;
    const nodes = [fn(H, "digestFor", F, DRV, { params: ["frontend", "prior"] })];
    const edges = [
      call(DRV, stageId("s3"), 2, 2, 6, { binds: "lf" }),
      call(DRV, stageId("s4"), 3, 2, 6, { binds: "prior" }),
      call(DRV, H, 8, 2, 8, { reads: ["lf", "prior"] }),
      call(H, stageId("s5"), 22, 4, 6, { reads: ["frontend"] }),
      call(H, stageId("s6"), 23, 4, 6, { reads: ["prior"] }),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.coverage).toContain("Helper arguments approximate");
    expect(g.edges.some((e) => e.from === idOf(g, "s4") && e.to.includes("digestFor@22:4"))).toBe(true);
  });

  it("has no edges, and says so, when the frontend gave no data-flow facts", () => {
    const g = graphOf(doc(nestingParts()));
    expect(g.edges).toEqual([]);
    expect(g.coverage).toContain("No data-flow facts for this language");
  });
});

describe("stage graph: review fixes", () => {
  it("nests an else-if inside the outer else arm when the arm and the inner if have the same span, as the TS frontend emits them", () => {
    // if (k === 0) { s1 } else if (k === 1) { s2 } else { s3 }: the outer else arm's span is the inner if statement's span.
    const nodes = [
      flow("if:4:2", "flow.branch", [4, 2, 10, 3], { condition: "k === 0" }),
      flow("arm:4:15", "flow.branch-arm", [4, 15, 6, 3], { label: "then" }),
      flow("arm:6:8", "flow.branch-arm", [6, 8, 10, 3], { label: "else" }),
      flow("if:6:8", "flow.branch", [6, 8, 10, 3], { condition: "k === 1" }),
      flow("arm:6:22", "flow.branch-arm", [6, 22, 8, 3], { label: "then" }),
      flow("arm:8:9", "flow.branch-arm", [8, 9, 10, 3], { label: "else" }),
    ];
    const edges = [call(DRV, stageId("s1"), 5, 4, 6), call(DRV, stageId("s2"), 7, 4, 6), call(DRV, stageId("s3"), 9, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("if{then=[s1] else=[if{then=[s2] else=[s3]}]}");
  });

  it("gives no exit pills for unlabelled case breaks of a switch inside a for-of loop", () => {
    const nodes = [
      flow("loop:20:2", "flow.loop", [20, 2, 30, 3], { variant: "for-of", condition: "const x of xs" }),
      flow("block:20:30", "flow.block", [20, 30, 30, 3], { label: "body" }),
      flow("switch:21:4", "flow.switch", [21, 4, 29, 5], { hasDefault: false }),
      flow("arm:22:6", "flow.branch-arm", [22, 6, 24, 7], { label: "case 1" }),
      flow("jump:23:8", "flow.jump", [23, 8, 23, 14], { variant: "break" }),
      flow("arm:25:6", "flow.branch-arm", [25, 6, 29, 5], { label: "case 2" }),
      flow("jump:27:8", "flow.jump", [27, 8, 27, 14], { variant: "break" }),
    ];
    const edges = [call(DRV, stageId("s1"), 26, 8, 10)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("for[if{case 1=[] case 2=[s1]}]");
    expect(show(g.body)).not.toContain("exit:");
  });

  it("keeps a labelled break that leaves the loop from inside a switch", () => {
    const nodes = [
      flow("loop:20:2", "flow.loop", [20, 2, 30, 3], { variant: "for-of", condition: "const x of xs" }),
      flow("block:20:30", "flow.block", [20, 30, 30, 3], { label: "body" }),
      flow("switch:21:4", "flow.switch", [21, 4, 29, 5], { hasDefault: false }),
      flow("arm:22:6", "flow.branch-arm", [22, 6, 24, 7], { label: "case 1" }),
      flow("jump:23:8", "flow.jump", [23, 8, 23, 14], { variant: "break" }),
      flow("arm:25:6", "flow.branch-arm", [25, 6, 29, 5], { label: "case 2" }),
      flow("jump:27:8", "flow.jump", [27, 8, 27, 22], { variant: "break", label: "outer" }),
    ];
    const edges = [call(DRV, stageId("s1"), 28, 8, 10)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("for[if{case 1=[] case 2=[exit:break s1]}]");
  });

  it("follows the derives of a const-arrow driver to the producer, giving the s1 to s2 edge", () => {
    // export const viaConst = () => { const x = s1(); const y = x; s2(y); }
    const edges = [call(DRV, stageId("s1"), 2, 2, 6, { binds: "x" }), call(DRV, stageId("s2"), 4, 2, 6, { reads: ["y"] })];
    const g = graphOf(docWithDriver({ derives: { y: ["x"] } }, { edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: idOf(g, "s2"), label: "x→y" }]);
  });

  it("says there are no data-flow facts when only binds and condition reads are present, and draws no edges", () => {
    // C++-shaped: a call binds a local and a loop's condition reads it, but no call carries reads and no function derives.
    const nodes = [flow("loop:5:2", "flow.loop", [5, 2, 9, 3], { variant: "for-of", condition: "const p of plugins", reads: ["plugins"] })];
    const edges = [call(DRV, stageId("s3"), 3, 2, 6, { binds: "plugins" }), call(DRV, stageId("s4"), 6, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.edges).toEqual([]);
    expect(g.coverage).toContain("No data-flow facts for this language");
  });

  it("takes the producer from the arm the consumer is in, not from the other arm of the same branch", () => {
    // let ast = s1(); if (c) { ast = s2(); } else { s3(ast); }
    const nodes = [
      flow("if:4:2", "flow.branch", [4, 2, 8, 3], { condition: "c" }),
      flow("arm:4:10", "flow.branch-arm", [4, 10, 6, 3], { label: "then" }),
      flow("arm:6:8", "flow.branch-arm", [6, 8, 8, 3], { label: "else" }),
    ];
    const edges = [
      call(DRV, stageId("s1"), 2, 2, 6, { binds: "ast" }),
      call(DRV, stageId("s2"), 5, 4, 6, { binds: "ast" }),
      call(DRV, stageId("s3"), 7, 4, 6, { reads: ["ast"] }),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: idOf(g, "s3"), label: "ast" }]);
  });

  it("orders a branch inside an anonymous callback after the call the callback is passed to", () => {
    // s1(); withLock(() => { if (x) s2(); else s3(); }); s4();
    const WL = `${F}#withLock`;
    const LAM = `${F}#run.lambda`;
    const nodes: IRNode[] = [
      fn(WL, "withLock", F, F),
      fx.node(LAM, "structure", "structure.function", { attrs: { name: "λ3:11", anonymous: true }, parent: DRV, span: fx.span(F, 3, 11, 6, 3) }),
      flow("if:4:4", "flow.branch", [4, 4, 5, 15], { condition: "x" }, LAM),
      flow("arm:4:10", "flow.branch-arm", [4, 10, 4, 16], { label: "then" }, LAM),
      flow("arm:5:4", "flow.branch-arm", [5, 4, 5, 15], { label: "else" }, LAM),
    ];
    const edges = [
      call(DRV, stageId("s1"), 2, 2, 4),
      call(DRV, WL, 3, 2, 10, { callEnd: [6, 3] }),
      call(LAM, stageId("s2"), 4, 10, 12),
      call(LAM, stageId("s3"), 5, 9, 11),
      call(DRV, stageId("s4"), 7, 2, 4),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("s1 withLock~ if{then=[s2] else=[s3]} s4");
  });

  it("shows an inlined helper whose body has a stage, even when the helper alone would be minor", () => {
    // const step = (f) => { s3(f) }; step(other): step calls one target, so it is minor before inlining, but s3 is a stage.
    const H = `${F}#run.step`;
    const nodes = [fn(H, "step", F, DRV, { params: ["f"] })];
    const edges = [call(DRV, H, 8, 2, 8, { reads: ["other"] }), call(H, stageId("s3"), 22, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(g.body)).toBe("step{s3}");
    expect(g.body[0]?.kind === "call" && g.body[0].minor).toBeFalsy();
  });

  it("maps an inlined helper's parameter to the call-site reads, never to a driver local of the same name", () => {
    // const files = s1(); const other = s2(); const step = (files) => { s3(files) }; step(other): s3 gets s2's value, not s1's.
    const H = `${F}#run.step`;
    const nodes = [fn(H, "step", F, DRV, { params: ["files"] })];
    const edges = [
      call(DRV, stageId("s1"), 2, 2, 6, { binds: "files" }),
      call(DRV, stageId("s2"), 3, 2, 6, { binds: "other" }),
      call(DRV, H, 8, 2, 8, { reads: ["other"] }),
      call(H, stageId("s3"), 22, 4, 6, { reads: ["files"] }),
    ];
    const g = graphOf(doc({ nodes, edges }));
    // The helper call itself also reads `other` (an s2 to step edge); the edge into s3 is the one under test.
    expect(g.edges.filter((e) => e.to === idOf(g, "s3"))).toEqual([{ from: idOf(g, "s2"), to: idOf(g, "s3"), label: "other→files" }]);
  });

  it("gives a for-of loop variable the iterable's producer, in addition to the loop's own edge", () => {
    // const items = s4(); for (const it of items) s5(it);  The frontend's derives: { it: ["items"] }.
    const nodes = [flow("loop:5:2", "flow.loop", [5, 2, 8, 3], { variant: "for-of", condition: "const it of items", reads: ["items"] })];
    const edges = [call(DRV, stageId("s4"), 3, 2, 6, { binds: "items" }), call(DRV, stageId("s5"), 6, 4, 6, { reads: ["it"] })];
    const g = graphOf(docWithDriver({ derives: { it: ["items"] } }, { nodes, edges }));
    expect(g.edges).toEqual([
      { from: idOf(g, "s4"), to: g.body.find((n) => n.kind === "loop")?.id ?? "", label: "items" },
      { from: idOf(g, "s4"), to: idOf(g, "s5"), label: "items→it" },
    ]);
  });
});

/** The stages a reader sees by default: minor calls dropped, and containers left empty by that dropped. */
function shownOf(nodes: StageNode[]): StageNode[] {
  const out: StageNode[] = [];
  for (const n of nodes) {
    if (n.kind === "call") {
      if (n.minor === true) continue;
      out.push(n.body ? { ...n, body: shownOf(n.body) } : n);
    } else if (n.kind === "exit") out.push(n);
    else if (n.kind === "loop") {
      const body = shownOf(n.body);
      if (body.length > 0) out.push({ ...n, body });
    } else if (n.kind === "try") {
      const body = shownOf(n.body);
      const handler = shownOf(n.handler);
      if (body.length + handler.length > 0) out.push({ ...n, body, handler });
    } else {
      const arms = n.arms.map((a) => ({ ...a, body: shownOf(a.body) }));
      if (arms.some((a) => a.body.length > 0)) out.push({ ...n, arms });
    }
  }
  return out;
}

describe("stage graph: exits inside inlined helpers", () => {
  it("keeps no exit for a return in a helper's own loop, while the helper's stages stay", () => {
    // helper() loops over its items, returns early from inside the loop (as depsCurrent does), and calls two stages.
    const H = `${F}#run.helper`;
    const nodes = [
      fn(H, "helper", F, DRV),
      flow("loop:22:2", "flow.loop", [22, 2, 27, 3], { variant: "for-of", condition: "const p of items" }, H),
      flow("if:23:4", "flow.branch", [23, 4, 25, 5], { condition: "bad(p)" }, H),
      flow("arm:23:20", "flow.branch-arm", [23, 20, 25, 5], { label: "then" }, H),
      flow("return:24:6", "flow.return", [24, 6, 24, 14], {}, H),
    ];
    const edges = [call(DRV, H, 8, 2, 8), call(H, stageId("s1"), 26, 4, 6), call(H, stageId("s2"), 28, 4, 6)];
    const g = graphOf(doc({ nodes, edges }));
    expect(JSON.stringify(g.body)).not.toContain('"kind":"exit"');
    expect(show(g.body)).toContain("s1");
    expect(show(g.body)).toContain("s2");
  });
});

describe("stage graph: callback scopes", () => {
  // A callback folded into the driver: its parameters and locals belong to it, and a driver local of the same name is shadowed.
  const L = `${F}#run.λ136:17`;
  const lambda = (params: string[]): IRNode => fn(L, "λ136:17", F, DRV, { anonymous: true, params });

  it("gives a callback parameter no producer, so it does not shadow-link to the driver's same-named local", () => {
    // const file = s1(); s2(file); paths.forEach((file) => s3(file)); s4()
    const nodes = [lambda(["file"])];
    const edges = [
      call(DRV, stageId("s1"), 2, 2, 6, { binds: "file" }),
      call(DRV, stageId("s2"), 3, 2, 6, { reads: ["file"] }),
      call(L, stageId("s3"), 4, 4, 6, { reads: ["file"] }),
      call(DRV, stageId("s4"), 6, 2, 6),
    ];
    const g = graphOf(docWithDriver({ params: ["paths"] }, { nodes, edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: idOf(g, "s2"), label: "file" }]);
  });

  it("links a producer and a consumer inside one callback through the callback's own local", () => {
    // xs.map((x) => { const y = s1(x); s2(y); })
    const nodes = [lambda(["x"])];
    const edges = [
      call(L, stageId("s1"), 31, 4, 9, { binds: "y", reads: ["x"] }),
      call(L, stageId("s2"), 32, 4, 9, { reads: ["y"] }),
      call(DRV, stageId("s3"), 33, 2, 6),
    ];
    const g = graphOf(docWithDriver({ params: ["xs"] }, { nodes, edges }));
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: idOf(g, "s2"), label: "y" }]);
  });

  it("drops a return inside a callback as the driver's exit, but keeps a throw there", () => {
    // for (const x of xs) { s1(); xs.forEach((y) => { if (!y) return; s2(y); }) } s3()
    const bodyNodes = (kind: string): IRNode[] => [
      lambda(["y"]),
      flow("loop:5:2", "flow.loop", [5, 2, 12, 3], { variant: "for-of", condition: "const x of xs" }),
      flow("if:7:6", "flow.branch", [7, 6, 9, 7], { condition: "!y" }, L),
      flow("arm:7:14", "flow.branch-arm", [7, 14, 9, 7], { label: "then" }, L),
      flow(`${kind}:8:8`, kind, [8, 8, 8, 14], {}, L),
    ];
    const edges = [call(DRV, stageId("s1"), 6, 4, 8), call(L, stageId("s2"), 10, 4, 8, {}), call(DRV, stageId("s3"), 13, 2, 6)];
    const ret = graphOf(docWithDriver({ params: ["xs"] }, { nodes: bodyNodes("flow.return"), edges }));
    expect(JSON.stringify(ret.body)).not.toContain('"kind":"exit"');
    const thr = graphOf(docWithDriver({ params: ["xs"] }, { nodes: bodyNodes("flow.throw"), edges }));
    expect(JSON.stringify(thr.body)).toContain('"how":"throw"');
  });
});

describe("stage graph: missing params (an older frontend)", () => {
  const H = `${F}#run.digestFor`;

  it("takes a helper's undeclared name as its parameter, approximately, and does not walk outward to a shadowed local", () => {
    // The driver binds x (s3) and scan (s2). digestFor reads x, but its params are unknown, so x may be its parameter.
    const nodes = [fn(H, "digestFor", F, DRV)];
    const edges = [
      call(DRV, stageId("s2"), 2, 2, 6, { binds: "scan" }),
      call(DRV, stageId("s3"), 3, 2, 6, { binds: "x" }),
      call(DRV, H, 8, 2, 8, { reads: ["scan"] }),
      call(H, stageId("s4"), 22, 4, 6, { reads: ["x"] }),
      call(H, stageId("s5"), 23, 4, 6),
    ];
    const g = graphOf(doc({ nodes, edges }));
    // Edges into digestFor's own call stage are the call's reads (scan feeds it); the inner stages are the ones under test.
    expect(g.edges.filter((e) => e.to.includes("digestFor@"))).toEqual([{ from: idOf(g, "s2"), to: idOf(g, "s4"), label: "scan→x" }]);
    expect(g.coverage).toContain("Helper arguments approximate");
  });

  it("with params known, the same undeclared name is not a parameter and resolves to the driver's local", () => {
    const nodes = [fn(H, "digestFor", F, DRV, { params: [] })];
    const edges = [
      call(DRV, stageId("s2"), 2, 2, 6, { binds: "scan" }),
      call(DRV, stageId("s3"), 3, 2, 6, { binds: "x" }),
      call(DRV, H, 8, 2, 8, { reads: ["scan"] }),
      call(H, stageId("s4"), 22, 4, 6, { reads: ["x"] }),
      call(H, stageId("s5"), 23, 4, 6),
    ];
    const g = graphOf(doc({ nodes, edges }));
    expect(g.edges.filter((e) => e.to.includes("digestFor@"))).toEqual([{ from: idOf(g, "s3"), to: idOf(g, "s4"), label: "x" }]);
    expect(g.coverage).not.toContain("Helper arguments approximate");
  });
});

describe("stage graph: callback slots on the driver's options (runIndex shape)", () => {
  // runIndex(opts, plugins): say and phase are const-arrow helpers that call opts.onProgress / opts.onPhase, a single-candidate
  // interface fan-out into a lambda elsewhere. Three real stages s1 to s3, one loop of frontends with s2 and say, and a loop of
  // disabled plugins with only say.
  const SAY = `${F}#run.say`;
  const PHASE = `${F}#run.phase`;
  const CB = "apps/server/src/jobs.ts#JobRunner.execute.λ221:21";
  const CB2 = "apps/server/src/jobs.ts#JobRunner.execute.λ222:18";
  function slotParts(): { nodes: IRNode[]; edges: IREdge[] } {
    const stages = stageParts();
    const nodes: IRNode[] = [
      ...stages.nodes,
      fn(SAY, "say", F, DRV, { params: ["line"] }),
      fn(PHASE, "phase", F, DRV, { params: ["p"] }),
      fn(CB, "λ221:21", "apps/server/src/jobs.ts", "apps/server/src/jobs.ts"),
      fn(CB2, "λ222:18", "apps/server/src/jobs.ts", "apps/server/src/jobs.ts"),
      flow("loop:5:2", "flow.loop", [5, 2, 7, 3], { variant: "for-of", condition: "const d of plugins.disabled" }),
      flow("loop:11:2", "flow.loop", [11, 2, 14, 3], { variant: "for-of", condition: "const lf of plugins.frontends" }),
    ];
    const edges: IREdge[] = [
      ...stages.edges,
      call(SAY, [CB], 3, 2, 14, { how: "interface", callee: "opts.onProgress" }),
      call(PHASE, [CB2], 3, 2, 14, { how: "interface", callee: "opts.onPhase" }),
      call(DRV, SAY, 2, 2, 6),
      call(DRV, PHASE, 3, 2, 6),
      call(DRV, SAY, 6, 4, 8),
      call(DRV, stageId("s1"), 9, 2, 6),
      call(DRV, stageId("s2"), 12, 4, 8),
      call(DRV, PHASE, 12, 20, 25),
      call(DRV, SAY, 13, 4, 8),
      call(DRV, stageId("s3"), 16, 2, 6),
      call(DRV, SAY, 17, 2, 8),
      call(DRV, PHASE, 18, 2, 8),
    ];
    return { nodes, edges };
  }

  it("shows the three stages and the frontends loop by default, and none of the callback helpers", () => {
    const g = graphOf(docWithDriver({ params: ["opts", "plugins"] }, slotParts()));
    const visible = show(shownOf(g.body));
    // Golden: the default outline. Show all (show(g.body)) keeps the callbacks and the say-only loop, marked `~`.
    expect(visible).toBe("s1 for[s2] s3");
    const all = show(g.body);
    // The callback slots are dropped, so say and phase are helpers with no calls left: minor, and their callee is gone.
    expect(all).not.toContain("opts.onProgress");
    expect(all).not.toContain("opts.onPhase");
    expect(all).toContain("for[s2 phase~ say~]");
  });

  it("keeps a single named-candidate interface call as a stage, whatever its receiver", () => {
    const H = `${F}#run.handler`;
    const IMPL = `${F}#Handler.handle`;
    const nodes = [fn(H, "handler", F, DRV), fn(IMPL, "handle", F, DRV)];
    const edges = [call(DRV, [IMPL], 20, 2, 12, { how: "interface", callee: "reg.handle" })];
    const g = graphOf(doc({ nodes, edges }));
    expect(show(shownOf(g.body))).toBe("reg.handle[1]");
  });

  it("keeps an injected parser's interface call as a stage when its candidates are named functions (di.ts shape)", () => {
    const P1 = `${F}#JsonParser.parse`;
    const P2 = `${F}#YamlParser.parse`;
    const nodes = [fn(P1, "parse", F, DRV), fn(P2, "parse", F, DRV)];
    const edges = [call(DRV, [P1, P2], 3, 2, 14, { how: "interface", callee: "parser.parse" })];
    const g = graphOf(docWithDriver({ params: ["parser"] }, { nodes, edges }));
    expect(show(shownOf(g.body))).toContain("parser.parse[2]");
    expect(show(g.body)).not.toContain("~");
  });
});


describe("stage graph: named property arrows and callback marks (review r3)", () => {
  // const ast = parser.parse(text); store.save(ast). parser is a factory's returned literal `{ parse: (t) => … }`: its arrow is a named member.
  const PARSE = `${F}#makeParser.λ3:10`;
  const parseCall = (): IREdge => call(DRV, [PARSE], 2, 2, 20, { how: "interface", callee: "parser.parse", binds: "ast" });
  const saveCall = (): IREdge => call(DRV, stageId("s4"), 3, 2, 14, { reads: ["ast"] });
  // A call whose result is not bound: a fire-and-forget callback (`opts.onProgress?.(line)`).
  const fireAndForgetCall = (): IREdge => call(DRV, [PARSE], 2, 2, 20, { how: "interface", callee: "parser.parse" });
  const parseNode = (attrs: Record<string, unknown>): IRNode => fn(PARSE, "λ3:10", F, F, { params: ["t"], ...attrs });

  it("keeps a named property arrow as a stage, with its ast edge into the next stage", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({ anonymous: false })], edges: [parseCall(), saveCall()] }));
    const parse = stageNamed(g.body, "parser.parse");
    expect(parse).toBeDefined();
    expect(g.edges).toEqual([{ from: parse?.id, to: idOf(g, "s4"), label: "ast" }]);
  });

  it("drops a candidate that is a callback slot whose result is not bound", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({ anonymous: true, callbackSlot: true })], edges: [fireAndForgetCall(), saveCall()] }));
    expect(stageNamed(g.body, "parser.parse")).toBeUndefined();
  });

  it("keeps an anonymous member arrow that is not a callback slot as a stage (callbackSlot false)", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({ anonymous: true, callbackSlot: false })], edges: [parseCall(), saveCall()] }));
    const parse = stageNamed(g.body, "parser.parse");
    expect(parse).toBeDefined();
    expect(g.edges).toEqual([{ from: parse?.id, to: idOf(g, "s4"), label: "ast" }]);
  });

  it("keeps a bound callback slot as one ambiguous stage, so its ast edge survives", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({ anonymous: true, callbackSlot: true })], edges: [parseCall(), saveCall()] }));
    const parse = stageNamed(g.body, "parser.parse");
    expect(parse).toBeDefined();
    expect(parse?.ambiguous).toBe(true);
    expect(g.edges).toEqual([{ from: parse?.id, to: idOf(g, "s4"), label: "ast" }]);
  });

  it("drops an unbound callback slot (a fire-and-forget call such as opts.onProgress)", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({ anonymous: true, callbackSlot: true })], edges: [fireAndForgetCall(), saveCall()] }));
    expect(stageNamed(g.body, "parser.parse")).toBeUndefined();
  });

  it("drops a lambda with no callbackSlot attribute by its lambda id (an older frontend)", () => {
    const g = graphOf(docWithDriver({ params: [] }, { nodes: [parseNode({})], edges: [fireAndForgetCall(), saveCall()] }));
    expect(stageNamed(g.body, "parser.parse")).toBeUndefined();
  });

  it("shows a throw outside any loop as an exit between the stages (a top-level guard)", () => {
    // s1(); if (!k) throw; s2(); s3()
    const nodes = [
      flow("if:3:2", "flow.branch", [3, 2, 5, 3], { condition: "!k" }),
      flow("arm:3:12", "flow.branch-arm", [3, 12, 5, 3], { label: "then" }),
      flow("throw:3:14", "flow.throw", [3, 14, 3, 20], {}),
    ];
    const edges = [call(DRV, stageId("s1"), 2, 2, 6), call(DRV, stageId("s2"), 6, 2, 6), call(DRV, stageId("s3"), 7, 2, 6)];
    const g = graphOf(docWithDriver({ params: [] }, { nodes, edges }));
    expect(show(g.body)).toBe("s1 if{then=[exit:throw]} s2 s3");
  });

  it("keeps a loop inside a callback in the callback's scope, so a callback local reaches it", () => {
    // items.forEach((it) => { const ast = s1(it); for (const n of ast) s2(n); }); s3()
    const L = `${F}#run.λ4:17`;
    const nodes = [
      fn(L, "λ4:17", F, DRV, { anonymous: true, params: ["it"] }),
      flow("loop:5:4", "flow.loop", [5, 4, 6, 5], { variant: "for-of", condition: "const n of ast", reads: ["ast"] }, L),
    ];
    const edges = [
      call(L, stageId("s1"), 4, 16, 20, { binds: "ast", reads: ["it"] }),
      call(L, stageId("s2"), 5, 24, 28, { reads: ["n"] }),
      call(DRV, stageId("s3"), 8, 2, 6),
    ];
    const g = graphOf(docWithDriver({ params: ["items"] }, { nodes, edges }));
    const loop = g.body.find((n) => n.kind === "loop");
    expect(loop).toBeDefined();
    expect(g.edges).toEqual([{ from: idOf(g, "s1"), to: loop?.id, label: "ast" }]);
  });
});
