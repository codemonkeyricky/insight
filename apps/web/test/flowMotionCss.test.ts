import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom cannot compute the cascade, so this reads the stylesheet.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const ruleBody = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
};

describe("flow line map CSS", () => {
  it("defines the five lane colours in the light, dark-media and dark-attribute blocks", () => {
    expect(css.match(/--lane-0:/g)?.length).toBe(3);
    for (let n = 0; n < 5; n++) expect(css.match(new RegExp(`--lane-${n}:`, "g"))?.length).toBe(3);
  });

  it("draws solid edges at 2.5 and skip/done edges dotted and faint", () => {
    expect(ruleBody(".flow-edge")).toContain("stroke-width: 2.5");
    const dotted = ruleBody(".flow-edge:is(.skip, .done)");
    expect(dotted).toContain("stroke-dasharray: 1 6");
    expect(dotted).toContain("opacity");
  });

  it("dashes the back edge and marches only it", () => {
    expect(ruleBody(".flow-edge.back")).toContain("stroke-dasharray: 4 5");
    expect(ruleBody(".flow-edge.back.marching")).toContain("animation: flow-march");
    expect(css).not.toContain("flow-pulse");
    expect(css).not.toMatch(/\.flow-edge path/);
  });

  it("draws throwing edges dashed in the error colour", () => {
    const r = ruleBody(".flow-edge.throws");
    expect(r).toContain("var(--red-text)");
    expect(r).toContain("stroke-dasharray");
  });

  it("stops the march and hides the token under reduced motion", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain(".flow-edge.marching");
    expect(block).toContain(".flow-token");
  });
});
