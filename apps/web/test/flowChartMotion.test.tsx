import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FlowEdge, FlowNode, FunctionFlow } from "@insight/flow";
import { FlowChart } from "../src/components/FlowChart.js";
import { ExpansionShape } from "../src/components/zoom/Expansion.js";
import type { Expansion } from "../src/zoom/expand.js";

// A for-of loop: the head (a loop) feeds its body, the body returns to the head, and the head exits.
const node = (id: string, shape: FlowNode["shape"], y: number, extra: Partial<FlowNode> = {}): FlowNode =>
  ({ id, role: "step", shape, label: id, x: 20, y, w: 120, h: 30, ...extra }) as FlowNode;
const edge = (from: string, to: string, kind: FlowEdge["kind"]): FlowEdge => ({ from, to, kind, points: [[80, 0], [80, 10]] });
const fn: FunctionFlow = {
  id: "walk",
  name: "walk",
  async: false,
  stats: { steps: 2, decisions: 0, loops: 1, tries: 0, exits: 1 } as FunctionFlow["stats"],
  width: 200,
  height: 240,
  nodes: [node("head", "loop", 20), node("body", "process", 90), node("done", "terminator", 170)],
  edges: [edge("head", "body", "each"), edge("body", "head", "back"), edge("head", "done", "exit")],
};

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

describe("FlowChart motion", () => {
  it("with motion on, every edge marches and the back-edge carries a pulse", () => {
    const html = render(<FlowChart id="p" fn={fn} scope="." motion />);
    expect(html.match(/flow-march/g)?.length).toBe(3);
    expect(html).toContain("back-edge");
    expect(html).toContain("animateMotion");
    expect(html.match(/flow-pulse/g)?.length).toBe(1);
  });

  it("with Flow motion off, no overlays or pulses are drawn", () => {
    const html = render(<FlowChart id="p" fn={fn} scope="." motion={false} />);
    expect(html).not.toContain("flow-march");
    expect(html).not.toContain("flow-pulse");
    expect(html).not.toContain("animateMotion");
    expect(html).toContain("back-edge");
  });

  it("under reduced motion, no overlays or pulses are drawn", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
    const html = render(<FlowChart id="p" fn={fn} scope="." motion />);
    expect(html).not.toContain("flow-march");
    expect(html).not.toContain("animateMotion");
  });

  it("marks the selected step", () => {
    const html = render(<FlowChart id="p" fn={fn} scope="." selectedId="body" />);
    expect(html).toMatch(/flow-node[^"]*process[^"]*selected/);
  });
});

describe("ExpansionShape", () => {
  const expansion = { fnId: "walk", anchor: { kind: "box", nodeId: "n", rect: { x: 0, y: 0, w: 10, h: 10 } }, chart: fn, x: 0, y: 0, w: 260, h: 280, index: 0, pivot: 0 } as unknown as Expansion;

  it("titles the detail with the function's name, without a letter prefix", () => {
    const html = render(
      <ExpansionShape id="p" scope="." expansion={expansion} k={1} onNodeClick={() => false} onSelect={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain(">walk<");
    expect(html).not.toMatch(/class="zm-label">Detail/);
    expect(html).toContain('aria-label="Detail A: walk"');
    expect(html).not.toContain("zm-bubble");
    expect(html).not.toContain("zm-callout");
  });
});
