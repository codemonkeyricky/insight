import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { layoutFunction, relayout } from "@insight/flow";
import { FlowChart } from "../src/components/FlowChart";

const step = (label: string, target?: string) => ({ t: "step" as const, role: "call" as const, label, ...(target ? { target } : {}) });

describe("FlowChart nest frames", () => {
  it("draws a frame with the callee's name around its steps, and nothing for a plain chart", () => {
    const leaf = layoutFunction({ id: "f#leaf", name: "leaf", async: false, items: [step("a()")] });
    const root = layoutFunction({ id: "f#root", name: "root", async: false, items: [step("leaf()", "f#leaf")] });
    const plain = renderToStaticMarkup(<FlowChart id="p" fn={root} scope="" />);
    expect(plain).not.toContain("data-nest");
    const id = root.nodes.find((n) => n.label === "leaf()")!.id;
    const nested = relayout(root, new Map([[id, { flow: leaf }]]));
    const html = renderToStaticMarkup(<FlowChart id="p" fn={nested} scope="" />);
    expect(html).toContain("data-nest");
    expect(html).toContain("leaf");
    expect(html).toContain("a()");
  });
});
