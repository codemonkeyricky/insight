import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom cannot compute the cascade, so this reads the stylesheet: the march overlay must be named with a selector more
// specific than the edge's own rule (`.flow-edge path`, 0,1,1), or the edge's grey stroke hides it on plain edges.
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const ruleBody = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
};

describe("flow march overlay CSS", () => {
  it("names the overlay as an edge's path, so it beats the edge's stroke", () => {
    const base = ruleBody(".flow-edge path");
    expect(base).toContain("stroke: color-mix(in srgb, var(--graphite) 70%, transparent)");
    const march = ruleBody(".flow-edge path.flow-march");
    expect(march).toContain("stroke: var(--accent)");
    expect(march).toContain("stroke-dasharray: 3 9");
  });

  it("keeps the back-edge overlay in the loop colour and a little stronger", () => {
    const back = ruleBody(".flow-edge path.flow-march.back");
    expect(back).toContain("stroke: var(--coroutine)");
    expect(back).toContain("stroke-width: 1.75");
  });

  it("keeps branch edges in their own tones", () => {
    expect(ruleBody(".flow-edge.true path.flow-march")).toContain("stroke: var(--ok)");
    expect(ruleBody(".flow-edge.false path.flow-march")).toContain("stroke: var(--warn)");
  });

  it("never styles the overlay with a bare .flow-march rule, which the edge's stroke outranks", () => {
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    const styled = [...css.matchAll(rule)].filter(([, sel, body]) => sel.includes(".flow-march") && /stroke|animation/.test(body));
    expect(styled.length).toBeGreaterThan(0);
    for (const [, sel] of styled) expect(sel).toContain(".flow-edge");
  });

  it("hides the overlay and the token under reduced motion", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toContain(".flow-march");
    expect(block).toContain(".flow-token");
  });
});
