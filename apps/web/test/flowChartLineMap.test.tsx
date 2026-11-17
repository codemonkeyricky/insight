import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { layoutFunction, relayout, type FunctionFlow } from "@insight/flow";
import { FlowChart } from "../src/components/FlowChart";

type Items = Parameters<typeof layoutFunction>[0]["items"];
const call = (label: string, target?: string) => ({ t: "step" as const, role: "call" as const, label, ...(target ? { target } : {}) });
const ret = { t: "term" as const, role: "return" as const, label: "return" };
const items: Items = [
  call("prep()"),
  {
    t: "fork",
    role: "branch",
    label: "a > 0",
    complete: true,
    arms: [
      { label: "then", kind: "true", body: [call("t1()")] },
      { label: "else", kind: "false", body: [call("e1()"), call("e2()")] },
    ],
  },
  { t: "loop", label: "for x of xs", body: [call("use(x)")] },
  call("leaf()", "f#leaf"),
  ret,
];
const flow = (): FunctionFlow => layoutFunction({ id: "f#main", name: "main", async: false, items });
const render = (fn: FunctionFlow) => renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="" />);

describe("FlowChart line map", () => {
  const fn = flow();
  const html = render(fn);

  it("renders one row per node with its label", () => {
    for (const n of fn.nodes) {
      expect(html).toContain(`data-node="${n.id}"`);
      expect(html).toContain(n.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
  });

  it("puts an arrowhead on back edges only", () => {
    const paths = [...html.matchAll(/<path[^>]*data-edge="(\d+)"[^>]*>/g)];
    expect(paths.length).toBe(fn.edges.length);
    for (const [tag] of paths) {
      const back = tag.includes("flow-edge back");
      expect(tag.includes("marker-end")).toBe(back);
    }
    expect(paths.some(([t]) => t.includes("marker-end"))).toBe(true);
  });

  it("gives skip edges the dotted class and colours by lane", () => {
    expect(fn.edges.some((e) => e.style === "skip" || e.style === "done")).toBe(true);
    fn.edges.forEach((e, i) => {
      const m = new RegExp(`<path[^>]*class="([^"]*)"[^>]*data-edge="${i}"`).exec(html);
      expect(m).not.toBeNull();
      expect(m![1]).toContain(`flow-edge ${e.style}`);
      expect(m![1]).toContain(`c${(e.lane ?? 0) % 5}`);
    });
  });

  it("renders the else tag, and a row with its callee box open shows ▾ where a closed one shows ▸", () => {
    expect(html).toContain("else ");
    expect(html).toContain("▸");
    const open = renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="" onNodeOpen={() => true} openOf={(n) => n.label === "leaf()"} />);
    expect(open).toContain("▾");
    expect(open).toContain('aria-label="Fold leaf()"');
    expect(open).not.toContain('aria-label="Open leaf()"');
  });

  it("gives an openable call a chevron button and a focusable row, and a plain step neither", () => {
    const h = renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="" onNodeOpen={() => true} />);
    const rowOf = (label: string) => {
      const id = fn.nodes.find((n) => n.label === label)!.id;
      const start = h.lastIndexOf("<a ", h.indexOf(`data-node="${id}"`));
      const from = start === -1 ? h.lastIndexOf("<g ", h.indexOf(`data-node="${id}"`)) : start;
      const next = h.indexOf("data-node=", h.indexOf(`data-node="${id}"`) + 10);
      return h.slice(from, next === -1 ? undefined : next);
    };
    const leaf = rowOf("leaf()");
    expect(leaf).toContain('class="flow-chevron"');
    expect(leaf).toContain('role="button"');
    expect(leaf).toContain('aria-label="Open leaf()"');
    expect(leaf).toMatch(/tabindex="0"[^>]*data-node|data-node[^>]*tabindex="0"/);
    const plain = rowOf("prep()");
    expect(plain).not.toContain("flow-chevron");
    expect(plain).not.toContain("tabindex");
  });

  it("the chevron of a row with its callee box open is a button that folds it", () => {
    const open = renderToStaticMarkup(<FlowChart id="p" fn={fn} scope="" onNodeOpen={() => true} openOf={(n) => n.label === "leaf()"} />);
    expect(open).toContain('class="flow-chevron"');
    expect(open).toContain('role="button"');
    expect(open).toContain('aria-label="Fold leaf()"');
  });
});

describe("FlowChart parallel line", () => {
  const spawn = { t: "step" as const, role: "spawn" as const, label: "spawn process job", target: "f#job" };
  const root = layoutFunction({ id: "f#main", name: "main", async: false, items: [call("a()"), spawn, call("b()")] });
  const job = layoutFunction({ id: "f#job", name: "job", async: false, items: [call("work()")] });
  const id = root.nodes.find((n) => n.role === "spawn")!.id;
  const open = (kind: "thread" | "process") => relayout(root, new Map([[id, { flow: job, runtime: { kind, label: `Process · ${kind}` } }]]));

  it("draws a double fork bar, a square header and a band for a process", () => {
    const html = render(open("process"));
    expect(html).toContain("st dbar");
    expect(html).toContain("flow-band");
    expect(html).toMatch(/<rect class="st head"/);
    expect(html).toContain("Process · process");
    expect(html).toContain('aria-label="Fold spawn process job"');
  });

  it("draws a single fork bar, a round header and no band for a thread", () => {
    const html = render(open("thread"));
    expect(html).toContain("st bar");
    expect(html).not.toContain("flow-band");
    expect(html).toMatch(/<circle class="st head"/);
  });
});
