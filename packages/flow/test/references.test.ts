import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import frontend from "@insight/frontend-typescript";
import type { IREdge, IRNode } from "@insight/ir";
import { summarizeScope, type ScopeFlow } from "../src/index.js";
import { callEdge, flowOfScope, fnNode, PROVENANCE } from "./synthetic.js";

const FILES: Record<string, string> = {
  "src/ui/widgets.tsx": `export function Button(props: { label: string }) {
  return <span>{props.label}</span>;
}

export function helper(n: number): number {
  return n + 1;
}

export function declaredOnly(): void {}
`,
  "src/app/main.tsx": `import { Button, helper } from "../ui/widgets.js";

export function render() {
  return <Button label="x" />;
}

export function pass() {
  return [1, 2].map(helper);
}

export function selfRef(): unknown {
  const again = selfRef;
  return again;
}
`,
};
const FILE_LIST = Object.keys(FILES);
const RENDER = "src/app/main.tsx#render";
const PASS = "src/app/main.tsx#pass";
const SELF_REF = "src/app/main.tsx#selfRef";
const DECLARED_ONLY = "src/ui/widgets.tsx#declaredOnly";

let nodes: IRNode[] = [];
let edges: IREdge[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "insight-references-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "references-sample", type: "module" }));
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    const ctx = {
      root: { path: dir, name: "references-sample", allowBuildTools: false },
      files: FILE_LIST,
      listFiles: () => FILE_LIST,
      readFile: async (rel: string) => FILES[rel] ?? "",
      log: () => undefined,
    };
    for await (const batch of frontend.extract(ctx)) {
      for (const r of batch.records) {
        if ("node" in r) nodes.push(r.node);
        else if ("edge" in r) edges.push(r.edge);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withoutRefs = (): IREdge[] => edges.filter((e) => e.kind !== "calls.reference");
const whole = (es: IREdge[] = edges): ScopeFlow => flowOfScope(nodes, es, FILE_LIST, "");
const names = (flow: ScopeFlow): string[] => flow.unreferenced.map((f) => f.name).sort();

/** A reference edge: `from` refers to `to` on `line` of `file`, without calling it. */
function ref(from: string, to: string, file: string, line: number, how: "new" | "jsx" | "value"): IREdge {
  return {
    from,
    to,
    facet: "calls",
    kind: "calls.reference",
    span: { file, start: [line, 2], end: [line, 8] },
    attrs: { how },
    provenance: PROVENANCE,
  };
}

describe("calls.reference in the scope flow of a project", () => {
  it("makes a referred-to function referenced, so it leaves the unreferenced list and the entries", () => {
    const flow = whole();
    expect(names(flow)).toEqual(["declaredOnly", "pass", "render", "selfRef"]);
    expect([...flow.entries].sort()).toEqual([DECLARED_ONLY, PASS, RENDER, SELF_REF].sort());

    const before = whole(withoutRefs());
    expect(names(before)).toEqual(["Button", "declaredOnly", "helper", "pass", "render", "selfRef"]);
  });

  it("keeps a function that only refers to itself unreferenced, with reach 0", () => {
    const self = whole().unreferenced.find((f) => f.id === SELF_REF);
    expect(self).toMatchObject({ reach: 0 });
  });

  it("counts a reference as reach: what a referring function reaches through it", () => {
    const flow = whole();
    expect(flow.unreferenced.find((f) => f.id === RENDER)).toMatchObject({ reach: 1 });
    expect(flow.unreferenced.find((f) => f.id === PASS)).toMatchObject({ reach: 1 });
  });

  it("adds no call rows: the payload calls are the same with and without references", () => {
    expect(whole().calls).toEqual(whole(withoutRefs()).calls);
  });

  it("marks a function referred to only from outside the scope as called from outside", () => {
    const flow = flowOfScope(nodes, edges, FILE_LIST, "src/ui");
    expect(flow.unreferenced.find((f) => f.name === "Button")?.calledFromOutside).toBe(true);
    expect(flow.unreferenced.find((f) => f.name === "helper")?.calledFromOutside).toBe(true);
    expect(flow.entries).toEqual([DECLARED_ONLY]);
    expect(flow.stats.unreferencedOutside).toBe(2);
  });

  it("only shrinks the unreferenced set as the scope widens", () => {
    const wide = whole();
    for (const scope of ["src/ui", "src/app"]) {
      const narrow = flowOfScope(nodes, edges, FILE_LIST, scope);
      const narrowUnreferenced = new Set(narrow.unreferenced.map((f) => f.id));
      for (const f of wide.unreferenced) {
        if (f.file.startsWith(`${scope}/`)) expect(narrowUnreferenced.has(f.id)).toBe(true);
      }
    }
  });
});

describe("calls.reference on synthetic IR", () => {
  const nodesAB = [fnNode("src/a.ts", "f", 0), fnNode("src/a.ts", "g", 4), fnNode("src/a.ts", "h", 8)];

  it("counts a reference and everything it reaches through calls", () => {
    const flow = summarizeScope(nodesAB, [ref("src/a.ts#f", "src/a.ts#g", "src/a.ts", 1, "value"), callEdge("src/a.ts#g", "src/a.ts#h", "src/a.ts", 5)], ["src/a.ts"]);
    expect(flow.unreferenced.map((f) => [f.name, f.reach])).toEqual([["f", 2]]);
    expect(flow.entries).toEqual(["src/a.ts#f"]);
  });

  it("ignores a self-reference when deciding whether a function is referenced", () => {
    const flow = summarizeScope(nodesAB, [ref("src/a.ts#g", "src/a.ts#g", "src/a.ts", 5, "value")], ["src/a.ts"]);
    expect(flow.unreferenced.find((f) => f.name === "g")).toMatchObject({ reach: 0 });
  });

  it("marks a function referred to from outside the scope as called from outside", () => {
    const flow = summarizeScope([fnNode("src/b.ts", "k", 0)], [ref("src/a.ts#f", "src/b.ts#k", "src/a.ts", 1, "new")], ["src/b.ts"]);
    expect(flow.unreferenced.map((f) => [f.name, f.calledFromOutside])).toEqual([["k", true]]);
    expect(flow.stats).toMatchObject({ unreferenced: 1, unreferencedOutside: 1, entries: 0, calls: 0 });
  });
});
