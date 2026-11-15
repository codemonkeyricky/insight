import { describe, expect, it } from "vitest";
import * as fx from "@insight/sdk/testing";
import { moduleMap } from "@insight/flow";
import { archModel } from "../src/index.js";

const file = (path: string) => fx.node(path, "structure", "structure.file");
const pkg = (dir: string) => file(`${dir}/package.json`);

describe("module map agrees with archModel", () => {
  it("assigns every file to a package archModel knows", () => {
    const nodes = [
      pkg("packages/alpha"),
      file("packages/alpha/src/a.ts"),
      file("packages/alpha/src/nested/b.ts"),
      pkg("packages/beta"),
      file("packages/beta/src/c.ts"),
      pkg("apps/web"),
      file("apps/web/src/d.ts"),
    ];
    const model = archModel(fx.view({ nodes }));
    const ids = new Set(model.packages.map((p) => p.id));
    const map = moduleMap(nodes);
    for (const n of nodes) {
      if (n.kind !== "structure.file") continue;
      expect(ids.has(map.moduleOfFile(n.id))).toBe(true);
    }
    expect(map.moduleOfFile("packages/alpha/src/nested/b.ts")).toBe("packages/alpha");
    expect(map.moduleOfFile("packages/beta/src/c.ts")).toBe("packages/beta");
    expect(map.moduleOfFile("apps/web/src/d.ts")).toBe("apps/web");
  });
});
