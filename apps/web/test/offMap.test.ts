import { describe, expect, it } from "vitest";
import { offMapSelected } from "../src/zoom/offMap.js";

describe("offMapSelected", () => {
  it("takes the name, file and 1-based start line from the chart's span", () => {
    const sel = offMapSelected("src/lib/math.ts#Counter.increment", {
      name: "Counter.increment",
      span: { file: "src/lib/math.ts", start: [4, 0], end: [9, 1] },
    });
    expect(sel).toEqual({
      ref: "src/lib/math.ts#Counter.increment",
      name: "Counter.increment",
      file: "src/lib/math.ts",
      line: 5,
      runtime: "none",
      placements: [],
    });
  });

  it("takes the file from the id when the chart has no span, and line 0", () => {
    const sel = offMapSelected("src/lib/math.ts#add", { name: "add" });
    expect(sel.file).toBe("src/lib/math.ts");
    expect(sel.line).toBe(0);
    expect(sel.runtime).toBe("none");
    expect(sel.placements).toEqual([]);
  });
});
