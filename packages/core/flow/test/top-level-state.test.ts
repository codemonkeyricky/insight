import { describe, expect, it } from "vitest";
import { buildFileFlow, couplingIndex } from "../src/index.js";
import { indexFixture } from "./coupling-fixture.js";

// Top-level code of a module runs on load. Its calls and its state rows (the module-level counter it writes) must share one
// flow: the module entry src/counters.ts#(module). A state row filed under the bare file id would make a second flow with the
// same name, and that flow has no IR function.
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "top-level-sample", private: true }),
  "src/counters.ts": `let hits = 0;
function helper(): void {
  console.log("helper");
}
helper();
hits++;
`,
};
const FILE = "src/counters.ts";

describe("top-level state rows from real TS frontend output", () => {
  it("puts the helper() call and the ▲ hits row in the one (module) flow", async () => {
    const { nodes, edges } = await indexFixture(FILES);
    const flow = buildFileFlow(FILE, nodes, edges, { coupling: couplingIndex(nodes, edges) });
    const top = flow.functions.filter((f) => f.name === "counters.ts · top level");
    expect(top.map((f) => f.id)).toEqual([`${FILE}#(module)`]);
    const labels = top[0]!.nodes.map((n) => n.label);
    expect(labels).toContain("helper()");
    expect(labels).toContain("▲ hits");
  });
});
