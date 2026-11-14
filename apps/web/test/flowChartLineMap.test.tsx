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

  it("renders one row per non-nest node with its label", () => {
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

  it("renders the else tag and a fold mark on an opened call", () => {
    expect(html).toContain("else ");
    const leaf = layoutFunction({ id: "f#leaf", name: "leaf", async: false, items: [call("a()")] });
    const id = fn.nodes.find((n) => n.label === "leaf()")!.id;
    const nested = renderToStaticMarkup(<FlowChart id="p" fn={relayout(fn, new Map([[id, { flow: leaf }]]))} scope="" />);
    expect(nested).toContain("data-nest");
    expect(nested).toContain("▾");
    expect(html).toContain("▸");
  });
});
